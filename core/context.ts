import type { Project, Skill } from './types.ts';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authors, eligibleReviewers } from './config/reviewers.ts';
import { workspaceRoot } from './config/paths.ts';
import { CONFIG, projectPath } from './project.ts';

export function skills(project: Project) {
  const found: Skill[] = [];
  for (const root of project.config.skillRoots) {
    const path = projectPath(project.root, project.root, root);
    let entries;
    try {
      entries = readdirSync(resolve(project.root, path), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = projectPath(project.root, project.root, `${path}/${entry.name}/SKILL.md`);
      let content;
      try {
        if (statSync(resolve(project.root, file)).size > 128 * 1024) {
          throw new Error(`skill is oversized: ${file}`);
        }
        content = readFileSync(resolve(project.root, file), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      const name = content
        .match(/^name:\s*(.+)$/m)?.[1]!
        .trim()
        .replace(/^['"]|['"]$/g, '');
      const description = content.match(/^description:\s*(.+)$/m)?.[1]!.trim() ?? '';
      if (!name) throw new Error(`skill has no name: ${file}`);
      if (found.some((skill) => skill.name === name)) {
        throw new Error(`duplicate project skill: ${name}`);
      }
      found.push({ name, description, file, content });
    }
  }
  const bundled = fileURLToPath(new URL('../skills/', import.meta.url));
  for (const entry of readdirSync(bundled, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = resolve(bundled, entry.name, 'SKILL.md');
    const content = readFileSync(file, 'utf8');
    const name = content.match(/^name:\s*(.+)$/m)?.[1]!.trim();
    const description = content.match(/^description:\s*(.+)$/m)?.[1]!.trim() ?? '';
    if (!name) throw new Error(`bundled skill has no name: ${file}`);
    if (!found.some((skill) => skill.name === name)) {
      found.push({ name, description, file, content, bundled: true });
    }
  }
  for (const name of project.config.requiredSkills) {
    if (!found.some((skill) => skill.name === name)) {
      throw new Error(`required skill not found: ${name}`);
    }
  }
  return found;
}

export function startupContext(
  project: Project,
  key: string,
  gateCommand: string,
  reviewCall: string,
  author: string,
) {
  const catalog = skills(project);
  const workflow = catalog.find((skill) => skill.name === 'halvard');
  const local = catalog.filter((skill) => !skill.bundled);
  // Every harness lists bundled skills natively, so only the workflow entry
  // point is named. Claude previews only the start of long context.
  const lines = [
    `Halvard is active for ${project.root}. Read AGENTS.md and any task specification before implementation.`,
    'Start work on a feature or fix branch. Do not commit, merge, push or publish without explicit approval.',
    'Use literal paths rather than shell variables in read commands; variables make a command unclassifiable.',
    `Project configuration: ${existsSync(resolve(project.root, CONFIG)) ? CONFIG : `defaults (no ${CONFIG})`}. Session key: ${key}.`,
    project.config.gate
      ? `Run the full configured gate with: ${gateCommand}`
      : 'No gate configured. Task completion markers are blocked until a gate is configured.',
    ...(project.config.workflow.requireReview
      ? [`Run independent review with: ${reviewCall}`]
      : []),
    'An approval request can be approved by sending exactly: approve halvard <request-id>. Only the pending operation is authorized, once, on the same tree.',
    'Report which project skills you loaded. Read applicable on-demand skills before writing code. Follow project review and invariant requirements before marking done.',
    `Read the halvard skill before implementation tasks: ${workflow!.file}. Substantial tasks get a short plan before coding; small clear fixes proceed directly. Keep task progress portable across harnesses.`,
    `Personal workflow: ${JSON.stringify(project.config.workflow)}. Repo settings override personal defaults. Reviewer selection is explicit; never silently use self-review.`,
    ...(project.config.workflow.requireReview
      ? [author]
          .filter(
            (author) =>
              authors.includes(author) &&
              !eligibleReviewers(project.config.workflow, author).length,
          )
          .map(
            (author) =>
              `No configured independent reviewer for ${author}. Run doctor --author ${author} before starting a task.`,
          )
      : []),
    local.length ? 'Project skills:' : 'Project skills: none.',
    ...local.map((skill) => `${skill.name}: ${skill.description} (${skill.file})`),
    `Team files: ${workspaceRoot()}/${basename(project.root)}/<task id>/. Write only ${author}-<topic>.md there.`,
  ];
  for (const skill of catalog.filter((s) => project.config.requiredSkills.includes(s.name))) {
    lines.push(`Loaded required skill: ${skill.file}\n${skill.content}`);
  }
  return lines.join('\n\n');
}
