import type { SetupProject, ProjectConfig } from '../types.ts';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CONFIG, currentBranch, git, loadProject, projectPath } from '../project.ts';
import { fingerprint } from '../state.ts';
import { flowConfig } from '../flow-config.ts';

const ignored = new Set([
  '.git',
  'node_modules',
  'vendor',
  'bin',
  'obj',
  'dist',
  '.venv',
  'venv',
  '__pycache__',
  'plugins',
]);

export function proposeSetup(cwd: string) {
  const project = loadProject(cwd);
  const { root } = project;
  const projects: SetupProject[] = [];
  let visited = 0;
  function walk(directory: string, depth: number) {
    if (++visited > 4000) {
      throw new Error('setup scan exceeds 4000 directories; configure this workspace explicitly');
    }
    const entries = readdirSync(directory, { withFileTypes: true });
    const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const path = relative(root, directory) || '.';
    const stacks = [];
    const commands = [];
    if (files.has('package.json')) {
      const file = join(directory, 'package.json');
      if (statSync(file).size > 1024 * 1024) throw new Error('package.json exceeds setup limit');
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const pkg = parsed as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        scripts?: Record<string, unknown>;
      };
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      stacks.push(dependencies.vue ? 'vue' : 'javascript');
      if (dependencies.typescript) stacks.push('typescript');
      const manager = files.has('pnpm-lock.yaml')
        ? 'pnpm'
        : files.has('yarn.lock')
          ? 'yarn'
          : files.has('bun.lock') || files.has('bun.lockb')
            ? 'bun'
            : 'npm';
      for (const name of ['build', 'test', 'lint', 'typecheck', 'check', 'format']) {
        if (typeof pkg.scripts?.[name] === 'string') {
          commands.push({
            purpose: name,
            argv: [manager, 'run', name],
            evidence: `${path}/package.json scripts.${name}`,
          });
        }
      }
    }
    if ([...files].some((f) => f.endsWith('.csproj') || f.endsWith('.fsproj'))) {
      stacks.push('dotnet');
      commands.push(
        {
          purpose: 'build',
          argv: ['dotnet', 'build'],
          evidence: `${path} project file; candidate, not executed`,
        },
        {
          purpose: 'test',
          argv: ['dotnet', 'test'],
          evidence: `${path} project file; confirm test projects`,
        },
      );
    }
    if (files.has('pyproject.toml') || files.has('requirements.txt') || files.has('setup.py')) {
      stacks.push('python');
    }
    if (files.has('go.mod')) {
      stacks.push('go');
      commands.push({
        purpose: 'test',
        argv: ['go', 'test', './...'],
        evidence: `${path}/go.mod; confirm build tags and integration prerequisites`,
      });
    }
    if (stacks.length) projects.push({ path, stacks, commands });
    if (depth < 4) {
      for (const entry of entries) {
        if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.')) {
          walk(join(directory, entry.name), depth + 1);
        }
      }
    }
  }
  walk(root, 0);
  let baseBranch;
  try {
    baseBranch = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      .trim()
      .replace(/^origin\//, '');
  } catch {
    baseBranch =
      ['main', 'master'].find((branch) => {
        try {
          git(root, ['rev-parse', '--verify', `refs/heads/${branch}`]);
          return true;
        } catch {
          return false;
        }
      }) ?? currentBranch(root);
  }
  const rawExisting: unknown = existsSync(resolve(root, CONFIG))
    ? JSON.parse(readFileSync(resolve(root, CONFIG), 'utf8'))
    : {};
  const existing = rawExisting as Partial<ProjectConfig>;
  return {
    version: 1,
    root,
    tree: fingerprint(root),
    projects,
    config: {
      version: 1,
      requiredSkills: [],
      ...existing,
      // A bootstrapped repo proposes its recorded stack gate until a gate is chosen.
      gate: existing.gate ?? (existing.stack?.gate.length ? existing.stack.gate : null),
      // Personal defaults stay personal; only repo-owned settings are proposed.
      workflow: { baseBranch, ...existing.workflow },
    },
    unresolved: [
      'Review project conventions and relevant skills; detection does not prescribe frameworks.',
      'Confirm a full gate command, including all workspace components and required services.',
      'Configure available independent reviewers and model preferences, and optionally assign each author a reviewer with an entry keyed by the author, such as "claude": {"reviewer": "codex"}; a same-harness reviewer needs an explicit model and reviews only headless. Every review round after the first uses the reviewer of the round before it.',
      'Confirm protected branches, branch naming, and task directory.',
    ],
    instruction:
      'This proposal is read-only. Review and edit config, then explicitly apply it. No tools, dependencies, hooks, or framework choices were installed.',
  };
}

export function applySetup(cwd: string, proposalFile: string) {
  const project = loadProject(cwd);
  const { root } = project;
  if (statSync(proposalFile).size > 1024 * 1024) throw new Error('setup proposal exceeds 1 MiB');
  const parsed: unknown = JSON.parse(readFileSync(proposalFile, 'utf8'));
  const proposal = parsed as {
    version?: unknown;
    root?: unknown;
    tree?: unknown;
    config?: unknown;
  };
  if (proposal.version !== 1 || proposal.root !== root || proposal.tree !== fingerprint(root)) {
    throw new Error('setup proposal belongs to another repo or is stale; inspect again');
  }
  const config = proposal.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('invalid proposed configuration');
  }
  flowConfig((config as Partial<ProjectConfig>).workflow);
  // Validate all project options without replacing the live configuration.
  loadProject(root, config);
  projectPath(root, root, CONFIG);
  writeFileSync(resolve(root, CONFIG), JSON.stringify(config, null, 2) + '\n');
  return {
    configured: CONFIG,
    instruction:
      'Install the pack adapters separately, restart each harness, and review hook trust.',
  };
}
