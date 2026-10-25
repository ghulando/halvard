import type { FlowConfig, ProjectConfig, StackStamp } from '../types.ts';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  CONFIG,
  currentBranch,
  git,
  loadProject,
  projectPath,
  readText,
  singleLink,
} from '../project.ts';
import { fingerprint } from '../state.ts';
import { skills } from '../context.ts';
import { proposeSetup } from './setup.ts';

const AGENTS = 'AGENTS.md';
const START = '<!-- halvard stack -->';
const END = '<!-- /halvard stack -->';
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export const HEADINGS = [
  'Summary',
  'Architecture',
  'Libraries',
  'Data',
  'Messaging',
  'Errors',
  'Naming',
  'Testing',
  'Gate',
  'Open choices',
  'Concerns',
];

export function stacksDirectory(workflow: FlowConfig) {
  if (!workflow.stacks) return null;
  return workflow.stacks.startsWith('~/')
    ? resolve(homedir(), workflow.stacks.slice(2))
    : resolve(workflow.stacks);
}

export function parseRecord(name: string, text: string) {
  const sections = new Map<string, string[]>();
  const problems: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^## (.+?)\s*$/);
    if (heading) {
      if (sections.has(heading[1]!)) problems.push(`repeated heading: ${heading[1]!}`);
      current = [];
      sections.set(heading[1]!, current);
    } else {
      current?.push(line);
    }
  }
  const body = (heading: string) => (sections.get(heading) ?? []).join('\n').trim();
  for (const heading of HEADINGS) {
    if (!body(heading)) problems.push(`missing or empty heading: ${heading}`);
  }
  for (const heading of sections.keys()) {
    if (!HEADINGS.includes(heading)) problems.push(`unknown heading: ${heading}`);
  }
  if (text.match(/^# \S/gm)?.length !== 1) problems.push('needs exactly one level-one title');
  const kinds = [...text.matchAll(/^Kind:\s*(.*?)\s*$/gm)].map((match) => match[1]!);
  const kind = kinds.length === 1 && ['backend', 'frontend'].includes(kinds[0]!) ? kinds[0]! : null;
  if (!kind) problems.push('needs exactly one Kind: backend or Kind: frontend line');
  // Structured sections hold only list lines, so a malformed line cannot pass as prose.
  const items = (heading: string, pattern: RegExp) => {
    const lines = (sections.get(heading) ?? []).filter((line) => line.trim());
    if (heading !== 'Concerns' && lines.length === 1 && lines[0]!.trim() === 'None.') return [];
    return lines.flatMap((line) => {
      const match = line.match(/^- (.+)$/)?.[1]!.match(pattern);
      if (!match) problems.push(`invalid ${heading} line: ${line.trim()}`);
      return match ? [match] : [];
    });
  };
  const concerns = items('Concerns', /^([a-z0-9][a-z0-9-]*) \((always-on|on-demand)\): (.+)$/).map(
    (match) => ({ name: match[1]!, required: match[2] === 'always-on', when: match[3]! }),
  );
  const names = concerns.map((concern) => concern.name);
  for (const repeated of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
    problems.push(`repeated concern: ${repeated}`);
  }
  const gate = items('Gate', /^[^:]+: (\S.*)$/).map((match) => match[1]!.trim().split(/\s+/));
  const openChoices = items('Open choices', /^([a-z0-9][a-z0-9-]*): (.+) \(default (.+)\)$/).map(
    (match) => ({ name: match[1]!, options: match[2]!, default: match[3]! }),
  );
  return {
    name,
    kind,
    summary: body('Summary').split('\n\n')[0]!.replace(/\s+/g, ' '),
    concerns,
    openChoices,
    gate,
    problems,
  };
}

function readRecords(directory: string) {
  const records = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    const file = resolve(directory, entry.name, 'stack.md');
    if (!existsSync(file)) continue;
    if (statSync(file).size > 256 * 1024) throw new Error(`stack record is oversized: ${file}`);
    records.push({ file, ...parseRecord(entry.name, readFileSync(file, 'utf8')) });
  }
  return records;
}

function files(directory: string, prefix = ''): string[] {
  return readdirSync(resolve(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return files(directory, path);
    return entry.isFile() ? [path] : [];
  });
}

// Only plumbing commands that never refresh the index: a stacks clone's own
// configuration could otherwise run an fsmonitor hook or a clean filter during a read.
function stacksCommit(directory: string) {
  try {
    return git(directory, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).trim();
  } catch {
    return null;
  }
}

function recordModified(directory: string, commit: string | null, name: string) {
  if (!commit) return true;
  const tracked = git(directory, ['ls-tree', '-r', '-z', '--name-only', commit, '--', `${name}/`])
    .split('\0')
    .filter(Boolean)
    .sort();
  const present = files(directory, name).sort();
  return (
    tracked.join('\0') !== present.join('\0') ||
    present.some(
      (path) =>
        git(directory, ['cat-file', 'blob', `${commit}:./${path}`]) !==
        readFileSync(resolve(directory, path), 'utf8'),
    )
  );
}

function stackSection(text: string) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 && end === -1) return null;
  if (
    start === -1 ||
    end < start ||
    text.indexOf(START, start + 1) !== -1 ||
    text.indexOf(END, end + 1) !== -1
  ) {
    throw new Error(`${AGENTS} has unmatched or repeated stack section markers`);
  }
  return { start, end: end + END.length };
}

export function bootstrapReport(cwd: string) {
  const project = loadProject(cwd);
  const { root, config } = project;
  const directory = stacksDirectory(config.workflow);
  let stacks = null;
  if (directory) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      throw new Error(`stacks directory not found: ${directory}`);
    }
    const commit = stacksCommit(directory);
    const records = readRecords(directory).map((record) => ({
      ...record,
      modified: recordModified(directory, commit, record.name),
    }));
    stacks = {
      directory,
      commit,
      records: records.filter((record) => !record.problems.length),
      invalid: records
        .filter((record) => record.problems.length)
        .map(({ file, problems }) => ({ file, problems })),
    };
  }
  const agents = readText(root, projectPath(root, root, AGENTS));
  const section = stackSection(agents);
  return {
    version: 1,
    root,
    tree: fingerprint(root),
    stacks,
    detected: proposeSetup(root).projects.map(({ path, stacks }) => ({ path, stacks })),
    branch: currentBranch(root),
    protectedBranch: config.protectedBranches.includes(currentBranch(root) ?? ''),
    stamp: config.stack,
    agentsSection: section ? agents.slice(section.start, section.end) : null,
    skillRoot: config.skillRoots[0] ?? null,
    skills: skills(project)
      .filter((skill) => !skill.bundled)
      .map((skill) => skill.name),
    requiredSkills: config.requiredSkills,
    instruction:
      'This report is read-only. Write a plan file outside the repository and apply it with bootstrap-apply after the user confirms.',
  };
}

interface PlanSkill {
  name: string;
  content: string;
  required: boolean;
}

export function applyBootstrap(cwd: string, planFile: string) {
  const { root, config } = loadProject(cwd);
  if (statSync(planFile).size > 1024 * 1024) throw new Error('bootstrap plan exceeds 1 MiB');
  const parsed: unknown = JSON.parse(readFileSync(planFile, 'utf8'));
  const plan = parsed as {
    version?: unknown;
    root?: unknown;
    tree?: unknown;
    stack?: unknown;
    agents?: unknown;
    skills?: unknown;
    overwrite?: unknown;
  };
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('invalid bootstrap plan');
  }
  if (plan.version !== 1 || plan.root !== root || plan.tree !== fingerprint(root)) {
    throw new Error('bootstrap plan belongs to another repo or is stale; run bootstrap again');
  }
  // A null section leaves AGENTS.md as it is, for a skills-only bootstrap.
  if (
    plan.agents !== null &&
    (typeof plan.agents !== 'string' ||
      !plan.agents.trim() ||
      plan.agents.includes(START) ||
      plan.agents.includes(END))
  ) {
    throw new Error('plan agents must be null or nonempty Markdown without section markers');
  }
  if (!Array.isArray(plan.skills) || !plan.skills.length) {
    throw new Error('plan skills must be a nonempty array');
  }
  const planSkills = plan.skills as PlanSkill[];
  for (const skill of planSkills) {
    if (
      !skill ||
      typeof skill !== 'object' ||
      Object.keys(skill).some((key) => !['name', 'content', 'required'].includes(key)) ||
      typeof skill.name !== 'string' ||
      !NAME.test(skill.name) ||
      typeof skill.content !== 'string' ||
      typeof skill.required !== 'boolean'
    ) {
      throw new Error('invalid plan skill');
    }
    const frontmatter = skill.content.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    if (
      frontmatter?.match(/^name:\s*(.+)$/m)?.[1]!.trim() !== skill.name ||
      !frontmatter.match(/^description:\s*\S/m)
    ) {
      throw new Error(`skill ${skill.name} needs frontmatter with its own name and a description`);
    }
    if (Buffer.byteLength(skill.content) > 128 * 1024) {
      throw new Error(`skill ${skill.name} is oversized`);
    }
  }
  const names = planSkills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) throw new Error('plan names a skill twice');
  const overwrite = plan.overwrite ?? [];
  if (
    !Array.isArray(overwrite) ||
    overwrite.some((name) => typeof name !== 'string' || !names.includes(name))
  ) {
    throw new Error('plan overwrite must list skills in the plan');
  }
  const skillRoot = config.skillRoots[0];
  if (!skillRoot) throw new Error('no skill root is configured');
  if (projectPath(root, root, skillRoot) !== skillRoot.replace(/^\.\/|\/+$/g, '')) {
    throw new Error(`skill root ${skillRoot} resolves through a symlink`);
  }
  const targets = planSkills.map((skill) => {
    const directory = projectPath(root, root, `${skillRoot}/${skill.name}`);
    if (existsSync(resolve(root, directory)) && !overwrite.includes(skill.name)) {
      throw new Error(`skill ${skill.name} already exists; list it in overwrite to replace it`);
    }
    // A symlinked skill directory or file could redirect the write into application code.
    const folder = lstatSync(resolve(root, skillRoot, skill.name), { throwIfNoEntry: false });
    const entry = folder?.isDirectory()
      ? lstatSync(resolve(root, skillRoot, skill.name, 'SKILL.md'), { throwIfNoEntry: false })
      : undefined;
    if ((folder && !folder.isDirectory()) || (entry && !entry.isFile())) {
      throw new Error(`skill ${skill.name} target is not a plain directory and file`);
    }
    const file = projectPath(root, root, `${directory}/SKILL.md`);
    singleLink(resolve(root, file));
    return { directory, file, skill };
  });

  // These are written in place, so a symlink would carry the write to its target.
  for (const name of [AGENTS, 'CLAUDE.md', CONFIG]) {
    if (lstatSync(resolve(root, name), { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`${name} is a symlink; bootstrap writes only plain files`);
    }
  }
  const agentsPath = projectPath(root, root, AGENTS);
  const agents = readText(root, agentsPath);
  const existing = stackSection(agents);
  let nextAgents = null;
  if (plan.agents !== null) {
    const section = `${START}\n${plan.agents.trim()}\n${END}`;
    nextAgents = existing
      ? agents.slice(0, existing.start) + section + agents.slice(existing.end)
      : agents
        ? `${agents.endsWith('\n') ? agents : agents + '\n'}\n${section}\n`
        : `${section}\n`;
  }
  // Claude Code reads CLAUDE.md, not AGENTS.md; the installer adds this bridge
  // only when AGENTS.md already exists, so a later bootstrap must add it too.
  const claudePath = projectPath(root, root, 'CLAUDE.md');
  const claude = readText(root, claudePath);
  const bridge = (nextAgents ?? agents) !== '' && !existsSync(resolve(root, claudePath));

  const configPath = projectPath(root, root, CONFIG);
  singleLink(resolve(root, configPath));
  const paths = [...targets.map((target) => target.file), agentsPath, claudePath, configPath];
  if (new Set(paths).size !== paths.length) throw new Error('bootstrap targets overlap');
  const raw = (
    existsSync(resolve(root, configPath))
      ? JSON.parse(readFileSync(resolve(root, configPath), 'utf8'))
      : { version: 1 }
  ) as Partial<ProjectConfig>;
  const required = planSkills.filter((skill) => skill.required).map((skill) => skill.name);
  // A replaced skill that is now on-demand stops loading at session start.
  const demoted = planSkills.filter((skill) => !skill.required).map((skill) => skill.name);
  const nextConfig = {
    ...raw,
    requiredSkills: [
      ...new Set([
        ...(raw.requiredSkills ?? []).filter((name) => !demoted.includes(name)),
        ...required,
      ]),
    ],
    stack: plan.stack as StackStamp,
  };
  // Validate the stamp and every other option before anything is written.
  loadProject(root, nextConfig);

  for (const { directory, file, skill } of targets) {
    mkdirSync(resolve(root, directory), { recursive: true });
    writeFileSync(
      resolve(root, file),
      skill.content.endsWith('\n') ? skill.content : skill.content + '\n',
    );
  }
  if (nextAgents !== null) writeFileSync(resolve(root, agentsPath), nextAgents);
  if (bridge) writeFileSync(resolve(root, claudePath), '@AGENTS.md\n');
  writeFileSync(resolve(root, configPath), JSON.stringify(nextConfig, null, 2) + '\n');
  return {
    agents: nextAgents === null ? null : agentsPath,
    claude: bridge
      ? 'CLAUDE.md created with @AGENTS.md'
      : claude && !/^@AGENTS\.md\s*$/m.test(claude)
        ? 'CLAUDE.md does not import AGENTS.md; add an @AGENTS.md line so Claude Code loads the stack section'
        : null,
    skills: targets.map((target) => target.file),
    requiredSkills: nextConfig.requiredSkills,
    configured: configPath,
    instruction: 'Run setup to propose the gate, review it, and apply it with setup-apply.',
  };
}
