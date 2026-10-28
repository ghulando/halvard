import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentBranch, loadProject } from '../project.ts';
import { fingerprint, withState } from '../state.ts';
import { hasReview } from './review.ts';
import { completionStatus } from './status.ts';
import { planIntact, readTask } from './tasks.ts';

export const PLAN_CHANGED =
  'The Approved plan section changed after approval, so the approval no longer holds. Restore it, or ask the user for a new approval.';

// The completion checks the hook applies to a done edit, for a runner that marks the task
// done itself: the session's gate receipt and the independent review cover this tree. The
// task file is agent-editable, so a runner passes the plan digest it holds itself, or null
// for a task without an approved plan; the hook can only compare the file with itself.
export async function completeTask(
  cwd: string,
  path: string,
  gateSession: string,
  expected?: { plan: string | null },
) {
  const project = loadProject(cwd);
  const { root, config } = project;
  const task = readTask(project, path);
  if (currentBranch(root) !== task.metadata.branch) {
    throw new Error('task belongs to another branch');
  }
  if (!planIntact(task)) throw new Error(PLAN_CHANGED);
  if (expected && (task.metadata.plan?.digest ?? null) !== expected.plan) {
    throw new Error(PLAN_CHANGED);
  }
  const status = completionStatus(config.doneMarker);
  const line = task.content.match(/^\*\*Status:\*\*[^\n]*$/m);
  if (!line) throw new Error('task has no **Status:** line');
  if (line[0].trimEnd() === status) throw new Error('task is already done');
  const after = task.content.replace(/^\*\*Status:\*\*[^\n]*$/m, () => status);
  const tree = fingerprint(root);
  const gate = await withState(root, gateSession, (state) => state.pass);
  if (gate?.tree !== tree) throw new Error('run the full configured gate on this tree first');
  if (config.workflow.requireReview && !(await hasReview(project, task.file, tree))) {
    throw new Error('get a passing independent review on this tree before marking done');
  }
  writeFileSync(resolve(root, task.file), after);
  // The tree the runner commits: the reviewed tree plus the status line.
  return { task: task.file, tree, gate, final: fingerprint(root) };
}
