import type { Project, Task, TaskMetadata } from './types.ts';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { AUTHOR_ERROR, authors, eligibleReviewers, workspaceRoot } from './flow-config.ts';
import { currentBranch, git, loadProject, projectPath, readText } from './project.ts';
import { privateDirectory } from './state.ts';

// The marker keeps two repositories with the same name from sharing a folder.
export function taskWorkspace(root: string, id: string) {
  const dir = resolve(workspaceRoot(), basename(root), id);
  const marker = resolve(dir, '.repo');
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  privateDirectory(dir);
  if (lstatSync(marker, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`task workspace marker ${marker} is a symlink`);
  }
  try {
    writeFileSync(marker, root + '\n', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if (readFileSync(marker, 'utf8').trim() !== root) {
    throw new Error(
      `task workspace ${dir} belongs to another repository; set HALVARD_WORKSPACE or use another task id`,
    );
  }
  return dir;
}

const taskId = (file: string) => basename(file, '.md');

export function readTask(project: Project, path: string): Task {
  const file = projectPath(project.root, project.root, path);
  const content = readText(project.root, file);
  const match = content.match(/^<!-- halvard (.+) -->$/m);
  if (!match) throw new Error('task has no workflow metadata; use task-start for portable tasks');
  const parsed: unknown = JSON.parse(match[1]!);
  const metadata = parsed as TaskMetadata;
  if (
    metadata.version !== 1 ||
    !authors.includes(metadata.author) ||
    typeof metadata.branch !== 'string' ||
    !/^[a-f0-9]{40,64}$/.test(metadata.base) ||
    typeof metadata.title !== 'string' ||
    (metadata.plan !== undefined &&
      (!metadata.plan ||
        typeof metadata.plan !== 'object' ||
        !/^[a-f0-9]{64}$/.test(String(metadata.plan.digest)) ||
        typeof metadata.plan.approvedBy !== 'string' ||
        typeof metadata.plan.at !== 'string'))
  ) {
    throw new Error('invalid task metadata');
  }
  git(project.root, ['cat-file', '-e', `${metadata.base}^{commit}`]);
  return { file, content, metadata };
}

// Brief and plan text sit under the task's own level-two headings. Their headings move down
// two levels, so no line of theirs can open or close a task section.
export const nested = (text: string) => text.trim().replace(/^(#{1,4}) /gm, '##$1 ');

export const planDigest = (text: string) => createHash('sha256').update(text).digest('hex');

// The text of the task's Approved plan section, or null when it has none or more than one.
export function approvedPlan(content: string) {
  if ((content.match(/^## Approved plan$/gm) ?? []).length !== 1) return null;
  const match = content.match(/(?:^|\n)## Approved plan\n\n([\s\S]*?)(?=\n## |$)/);
  return match ? match[1]!.replace(/\n+$/, '') : null;
}

// A recorded approval holds only while the Approved plan section is unchanged.
export function planIntact(task: Task) {
  const plan = task.metadata.plan;
  if (!plan) return true;
  const text = approvedPlan(task.content);
  return text !== null && planDigest(text) === plan.digest;
}

const sectionText = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 64 * 1024 ||
    value.includes('\0')
  ) {
    throw new Error(`${name} must be nonempty text up to 64 KiB`);
  }
  return nested(value);
};

export function startTask(
  cwd: string,
  {
    id,
    title,
    author,
    fix = false,
    small = false,
    brief,
    base: baseRef,
    plan,
    approvedBy,
  }: {
    id: string;
    title: string;
    author: string;
    fix?: boolean;
    small?: boolean;
    // Text of the brief and of an approved plan; a plan needs the name of its approver.
    brief?: string | undefined;
    base?: string | undefined;
    plan?: string | undefined;
    approvedBy?: string | undefined;
  },
) {
  const project = loadProject(cwd);
  const { root, config } = project;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id ?? '') || id.length > 64) {
    throw new Error('task id must be a short lowercase slug');
  }
  if (typeof title !== 'string' || !title.trim() || title.length > 512 || /[\r\n\0]/.test(title)) {
    throw new Error('invalid task title');
  }
  if (!authors.includes(author)) throw new Error(AUTHOR_ERROR);
  if (config.workflow.requireReview && !eligibleReviewers(config.workflow, author).length) {
    throw new Error(
      `no configured independent reviewer for ${author}; configure Claude/Codex/Ollama as appropriate or explicitly disable required review`,
    );
  }
  const briefText = sectionText(brief, 'brief');
  const planText = sectionText(plan, 'plan');
  if (planText !== undefined) {
    if (typeof approvedBy !== 'string' || !approvedBy.trim() || /[\r\n\0]/.test(approvedBy)) {
      throw new Error('an approved plan needs the name of its approver');
    }
  } else if (approvedBy !== undefined) {
    throw new Error('approved-by needs a plan');
  }
  if (
    baseRef !== undefined &&
    (typeof baseRef !== 'string' || !baseRef || baseRef.startsWith('-'))
  ) {
    throw new Error('invalid base ref');
  }
  const branch = (fix ? config.workflow.fixPrefix : config.workflow.featurePrefix) + id;
  git(root, ['check-ref-format', '--branch', branch]);
  const base = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${baseRef ?? config.workflow.baseBranch}^{commit}`,
  ]).trim();
  if (git(root, ['status', '--porcelain']).trim()) {
    throw new Error(
      'worktree has existing changes; preserve them and resolve task placement before starting a new branch',
    );
  }
  const file = projectPath(root, root, `${config.workflow.taskDirectory}/${id}.md`);
  if (readText(root, file)) throw new Error('task file already exists');
  // Switch only a clean tree, directly to the requested base. No stash, reset,
  // checkout of main, or rewriting of the user's existing branch is needed.
  git(root, ['switch', '-c', branch, base]);
  const metadata = {
    version: 1,
    title,
    author,
    branch,
    base,
    small,
    reviewCycle: randomUUID(),
    ...(planText !== undefined
      ? {
          plan: {
            digest: planDigest(planText),
            approvedBy: approvedBy!.trim(),
            at: new Date().toISOString(),
          },
        }
      : {}),
  };
  const content = `# ${title}\n\n<!-- halvard ${JSON.stringify(metadata)} -->\n\n**Status:** open.\n\n## Goal\n\n${title.replace(/^#/, '\\#')}\n\n${briefText !== undefined ? `## Brief\n\n${briefText}\n\n` : ''}## Acceptance criteria\n\n${planText !== undefined ? 'The Approved plan section holds the approved criteria.' : '- [ ] Describe the observable result before implementation.'}\n\n## Out of scope\n\nNone recorded.\n\n## Assumptions\n\nNone recorded. A product decision found while working goes to the user.\n\n${planText !== undefined ? `## Approved plan\n\n${planText}\n\n` : ''}## Plan\n\n${planText !== undefined ? `Approved by ${approvedBy!.trim()}; implement the Approved plan without stopping for another approval. Changing that section voids the approval.` : small ? 'Small task; implement directly.' : '- [ ] Record the short implementation plan before coding.'}\n\n## Decisions\n\nNone yet.\n\n## Progress\n\nBranch created; implementation has not started.\n\n## Verification\n\nNot run.\n\n## Review\n\nNot run. Record fixes before re-review; reports are kept outside the source tree.\n\n## Next step\n\nRead project instructions and ${planText !== undefined ? 'implement the approved plan.' : `fill the acceptance criteria${small ? '.' : ' and plan.'}`}\n`;
  mkdirSync(dirname(resolve(root, file)), { recursive: true });
  writeFileSync(resolve(root, file), content, { flag: 'wx' });
  return { branch, task: file, base, workspace: taskWorkspace(root, id) };
}

export function resumeTask(cwd: string, path: string) {
  const project = loadProject(cwd);
  const task = readTask(project, path);
  return {
    ...task,
    workspace: taskWorkspace(project.root, taskId(task.file)),
    currentBranch: currentBranch(project.root),
    expectedBranch: task.metadata.branch,
    changes: git(project.root, ['status', '--short']),
    instruction:
      'Read the task, project instructions and relevant skills. Verify recorded progress against the current files. Do not switch branches or discard existing changes automatically.',
  };
}

export function handoffTask(cwd: string, path: string, author: string) {
  const project = loadProject(cwd);
  const task = readTask(project, path);
  if (!authors.includes(author)) throw new Error(AUTHOR_ERROR);
  const metadata = { ...task.metadata, author, reviewCycle: randomUUID() };
  const content = task.content.replace(
    /^<!-- halvard (.+) -->$/m,
    `<!-- halvard ${JSON.stringify(metadata)} -->`,
  );
  writeFileSync(resolve(project.root, task.file), content);
  return {
    task: task.file,
    author,
    workspace: taskWorkspace(project.root, taskId(task.file)),
    instruction:
      'Author updated; review receipts from the earlier author do not transfer. Update progress and next step before leaving.',
  };
}
