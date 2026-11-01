import type { Project } from '../types.ts';
import type { Mode } from '../events.ts';
import { basename } from 'node:path';
import { writeEvent } from '../events.ts';
import { currentBranch } from '../project.ts';
import { branchTaskFile, readTask } from './tasks.ts';

// Records an event in the run log with the branch, and the task and mode found from the
// current branch, or from `task` when the caller names it. Never throws.
export function logEvent(
  project: Project,
  kind: string,
  fields: {
    harness?: string | null;
    session?: string | null;
    task?: string | null;
    repoLevel?: boolean;
    [field: string]: unknown;
  } = {},
) {
  const { task: given, ...rest } = fields;
  let branch: string | null = null;
  let task: string | null = null;
  let mode: Mode | null = null;
  try {
    branch = currentBranch(project.root);
    const file = given === undefined ? branchTaskFile(project) : null;
    task = given ?? (file ? basename(file, '.md') : null);
    if (task) {
      const path = file ?? `${project.config.workflow.taskDirectory}/${task}.md`;
      mode = readTask(project, path).metadata.mode ?? 'solo';
    }
  } catch {}
  writeEvent(project.root, kind, { ...rest, branch, task, mode });
}
