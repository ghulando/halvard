import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
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

// The team a task was started with, kept beside its log where agents cannot edit it. The
// task file's own mode field is agent-editable, so the guard trusts only this marker.
export interface TeamMarker {
  lead: string;
  dev: string;
  reviewer: string;
  investigator: string | null;
  // The branch and base the task started on. The guard matches the marker to the checked-out
  // branch, never to a task file, because the lead may edit task files.
  branch: string;
  base: string;
}

export const teamMarkerFile = (dir: string, task: string) => join(dir, task, 'team.json');

function needsCurrentRoot() {
  if (!rootIsCurrent()) {
    throw new Error(
      "team tasks need Halvard's data in ~/.halvard; run halvard migrate in your own terminal first",
    );
  }
}

// Writes the marker or throws: a team task the guard cannot recognise must not start. A
// marker left by an earlier task with this id is replaced.
export function writeTeamMarker(root: string, task: string, team: TeamMarker) {
  needsCurrentRoot();
  if (!TASK_ID.test(task)) throw new Error('task id must be a short lowercase slug');
  const dir = privateDirectory(join(repoLogDirectory(root), task));
  const next = join(dir, `.team.${randomUUID()}.json`);
  const fd = openSync(
    next,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, JSON.stringify(team) + '\n');
  } finally {
    closeSync(fd);
  }
  // A rename replaces a planted link at the destination instead of writing through it.
  renameSync(next, join(dir, 'team.json'));
}

// Removes the marker an earlier task with this id left, so a new solo task is solo.
export function clearTeamMarker(root: string, task: string) {
  if (!TASK_ID.test(task)) return;
  const dir = existingLogDirectory(root);
  if (dir) rmSync(teamMarkerFile(dir, task), { force: true });
}

// Whether any task of the repository was started with --team; a cheap check before the
// marker lookup on every edit.
export function hasTeamTasks(root: string) {
  const dir = existingLogDirectory(root);
  if (!dir) return false;
  return readdirSync(dir).some((task) => existsSync(teamMarkerFile(dir, task)));
}

// The team working on a branch, or null when no team task started on it. A marker that
// does not read stops edits only on a branch named after its task, where it may have been
// the team's; other branches never depended on it.
export function teamOnBranch(root: string, branch: string | null): TeamMarker | null {
  const dir = existingLogDirectory(root);
  if (!dir || !branch) return null;
  let broken: string | null = null;
  for (const task of readdirSync(dir)) {
    const file = teamMarkerFile(dir, task);
    if (!existsSync(file)) continue;
    let value: Partial<TeamMarker> = {};
    try {
      if (!lstatSync(file).isFile()) throw new Error('not a file');
      value = JSON.parse(readFileSync(file, 'utf8')) as Partial<TeamMarker>;
    } catch {}
    if (
      typeof value.lead !== 'string' ||
      typeof value.dev !== 'string' ||
      typeof value.branch !== 'string'
    ) {
      if (branch === task || branch.endsWith(`/${task}`)) broken = file;
      continue;
    }
    if (value.branch !== branch) continue;
    return {
      lead: value.lead,
      dev: value.dev,
      reviewer: typeof value.reviewer === 'string' ? value.reviewer : '',
      investigator: typeof value.investigator === 'string' ? value.investigator : null,
      branch: value.branch,
      base: typeof value.base === 'string' ? value.base : '',
    };
  }
  if (broken) throw new Error(`team marker ${broken} does not read; fix or remove it`);
  return null;
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
