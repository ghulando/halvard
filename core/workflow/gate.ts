import type { Project } from '../types.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { currentBranch, gateSteps, loadProject } from '../project.ts';
import { invalidate, privateDirectory, fingerprint, withState } from '../state.ts';
import { workspaceRoot } from '../flow-config.ts';
import { readTask, taskWorkspace } from './tasks.ts';

const GATE_TIMEOUT = 20 * 60 * 1000;
const GATE_TAIL = 40;

// The log sits with the task's team files; a branch without a task uses the repository folder.
function gateLogDirectory(project: Project) {
  const { root, config } = project;
  const branch = currentBranch(root);
  const dir = resolve(root, config.workflow.taskDirectory);
  const tasks = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((name) => name.endsWith('.md'))
    .flatMap((name) => {
      // A hand-written file without workflow metadata names no branch.
      try {
        const task = readTask(project, `${config.workflow.taskDirectory}/${name}`);
        return task.metadata.branch === branch ? [task.file] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => statSync(resolve(root, b)).mtimeMs - statSync(resolve(root, a)).mtimeMs);
  if (tasks.length) return taskWorkspace(root, basename(tasks[0]!, '.md'));
  mkdirSync(workspaceRoot(), { recursive: true, mode: 0o700 });
  return privateDirectory(resolve(workspaceRoot(), basename(root)));
}

// Reads backward from the end of the file to the step's start until it holds count whole
// lines. Output is kept as written except for the final line break.
function lastLines(file: string, from: number, count: number) {
  const fd = openSync(file, 'r');
  const split = (text: Buffer) => text.toString('utf8').replace(/\n$/, '').split('\n');
  try {
    let end = fstatSync(fd).size;
    let text = Buffer.alloc(0);
    while (end > from && split(text).length <= count) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, end - from));
      end -= chunk.length;
      readSync(fd, chunk, 0, chunk.length, end);
      text = Buffer.concat([chunk, text]);
    }
    return split(text).slice(-count).join('\n');
  } finally {
    closeSync(fd);
  }
}

export async function runGate(cwd: string, key: string) {
  const project = loadProject(cwd);
  const { root, config } = project;
  if (!config.gate) throw new Error('no project gate configured');
  const directory = gateLogDirectory(project);
  const before = fingerprint(root);
  const run = randomUUID();
  const revision = await withState(root, key, (state) => {
    invalidate(state);
    state.gate = run;
    return state.revision;
  });
  // The full output goes to the log; the agent gets one line per step and the failing tail.
  // Each run creates its own file, so overlapping runs keep both logs and an existing
  // link is never written through.
  const log = join(directory, `gate-${key.slice(0, 12)}-${run.slice(0, 8)}.log`);
  const fd = openSync(log, 'wx', 0o600);
  const deadline = Date.now() + GATE_TIMEOUT;
  const lines: string[] = [];
  let failed: { label: string; offset: number } | null = null;
  try {
    for (const step of gateSteps(config.gate)) {
      const label = step.join(' ');
      if (failed) {
        lines.push(`  skip  ${label}`);
        continue;
      }
      const offset = fstatSync(fd).size;
      writeSync(fd, `$ ${label}\n`);
      const started = Date.now();
      const result = spawnSync(step[0]!, step.slice(1), {
        cwd: root,
        stdio: ['inherit', fd, fd],
        timeout: Math.max(1, deadline - started),
        shell: false,
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.status === 0 && !result.error) {
        lines.push(`  pass  ${label} (${seconds}s)`);
        continue;
      }
      const why = result.error
        ? result.error.message
        : result.signal
          ? `signal ${result.signal}`
          : `exit ${result.status}`;
      lines.push(`  FAIL  ${label} (${why}, ${seconds}s)`);
      failed = { label, offset };
    }
  } finally {
    closeSync(fd);
  }
  const summary = [`workflow: gate steps`, ...lines];
  if (failed) {
    summary.push(
      `workflow: last ${GATE_TAIL} lines of ${failed.label}`,
      lastLines(log, failed.offset, GATE_TAIL),
    );
  }
  summary.push(`workflow: full gate log ${log}`);
  process.stdout.write(summary.join('\n') + '\n');
  const after = fingerprint(root);
  const passed = await withState(root, key, (state) => {
    if (failed) return 'checks failed or timed out';
    if (before !== after) return 'source tree changed during checks';
    if (state.revision !== revision || state.gate !== run) {
      return 'overlapped a guarded mutation or unclassified tool';
    }
    state.pass = { tree: after, command: config.gate!, at: new Date().toISOString() };
    state.gate = null;
    return true;
  });
  if (passed !== true) throw new Error(`gate failed: ${passed}; fix the cause and rerun`);
  process.stdout.write('workflow: gate passed on the current tree\n');
}
