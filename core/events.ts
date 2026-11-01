import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { logRoot, makeDataDir, rootIsCurrent } from './config/paths.ts';
import { privateDirectory } from './state.ts';

// The run log: one JSON line per workflow event, kept for good under ~/.halvard/logs, where
// agents can read but not write. Solo and team runs write it from the hook and the CLI;
// a factory run keeps its own event log in its job folder.
//
//   logs/<repo>/events.jsonl          events with no task on the branch, and session starts
//   logs/<repo>/<task>/events.jsonl   events on a task's branch

export type Mode = 'solo' | 'team';

export interface WorkflowEvent {
  at: string;
  kind: string;
  mode: Mode | null;
  harness: string | null;
  // The session key, a digest; the harness's own session id is never written.
  session: string | null;
  branch: string | null;
  task: string | null;
  [field: string]: unknown;
}

// Bytes per line: one O_APPEND write of this size lands whole between concurrent writers.
const LINE_LIMIT = 8 * 1024;
// A task id as task-start accepts it; anything else is not used as a folder name.
const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEXT_LIMIT = 500;

// A factory run has nobody watching this log and its own job log instead.
const factoryRun = () =>
  process.env.HALVARD_UNATTENDED === '1' || process.env.HALVARD_READONLY === '1';

// One folder per repository. A marker names the repository, so two with the same folder
// name get separate logs; the second gets a suffix from its path.
export function repoLogDirectory(root: string) {
  const name = basename(root);
  for (const folder of [name, `${name}-${digest(root).slice(0, 8)}`]) {
    const dir = resolve(logRoot(), folder);
    const marker = join(dir, '.repo');
    if (!existsSync(dir)) {
      makeDataDir(dir);
      try {
        writeFileSync(marker, root + '\n', { flag: 'wx', mode: 0o600 });
        return dir;
      } catch (err) {
        // Another writer created it first; the check below reads its marker.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    if (
      lstatSync(dir).isDirectory() &&
      existsSync(marker) &&
      readFileSync(marker, 'utf8').trim() === root
    ) {
      return dir;
    }
  }
  throw new Error(`no log folder for ${root}`);
}

// The log folder of a repository that already has one, without creating it.
export function existingLogDirectory(root: string) {
  const name = basename(root);
  for (const folder of [name, `${name}-${digest(root).slice(0, 8)}`]) {
    const marker = resolve(logRoot(), folder, '.repo');
    if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === root) {
      return resolve(logRoot(), folder);
    }
  }
  return null;
}

export const eventFile = (dir: string, task: string | null) =>
  task ? join(dir, task, 'events.jsonl') : join(dir, 'events.jsonl');

const clip = (value: unknown): unknown => {
  if (typeof value === 'string')
    return value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(clip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  }
  return value;
};

// Records one event and never throws: a log that cannot be written must not change a
// hook's decision or fail a command. The caller names the task and its mode; see
// workflow/log.ts for the lookup from the current branch.
export function writeEvent(
  root: string,
  kind: string,
  fields: {
    harness?: string | null;
    session?: string | null;
    branch?: string | null;
    task?: string | null;
    mode?: Mode | null;
    repoLevel?: boolean;
    [field: string]: unknown;
  } = {},
) {
  try {
    if (factoryRun() || !rootIsCurrent()) return;
    const { harness, session, branch, task, mode, repoLevel = false, ...rest } = fields;
    const text = (value: unknown) => (typeof value === 'string' ? (clip(value) as string) : null);
    // Task metadata is agent-editable; a task id that is not a slug never becomes a path.
    const id = typeof task === 'string' && TASK_ID.test(task) && task.length <= 64 ? task : null;
    const event: WorkflowEvent = {
      at: new Date().toISOString(),
      kind,
      mode: mode === 'solo' || mode === 'team' ? mode : null,
      harness: text(harness),
      session: text(session),
      branch: text(branch),
      task: id,
      ...(clip(rest) as Record<string, unknown>),
    };
    let line = JSON.stringify(event);
    if (Buffer.byteLength(line) >= LINE_LIMIT) {
      line = JSON.stringify({
        ...event,
        ...Object.fromEntries(Object.keys(rest).map((k) => [k, '[clipped]'])),
      });
    }
    if (Buffer.byteLength(line) >= LINE_LIMIT) return;
    const dir = repoLogDirectory(root);
    const file = eventFile(dir, repoLevel ? null : id);
    // A folder or file planted as a symlink is refused rather than written through.
    privateDirectory(resolve(file, '..'));
    const fd = openSync(
      file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, line + '\n');
    } finally {
      closeSync(fd);
    }
  } catch {}
}

// Every event in a log file, skipping lines that do not parse.
export function readEvents(file: string): WorkflowEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line) return [];
      try {
        const event = JSON.parse(line) as WorkflowEvent;
        return event && typeof event.kind === 'string' ? [event] : [];
      } catch {
        return [];
      }
    });
}

// The task logs of one repository's log folder, by task id.
export function taskLogs(dir: string) {
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'events.jsonl')))
    .map((name) => ({ task: name, file: join(dir, name, 'events.jsonl') }));
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
