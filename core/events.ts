import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { logRoot, makeDataDir, rootIsCurrent } from './config/paths.ts';

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

const LINE_LIMIT = 8 * 1024;
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
      writeFileSync(marker, root + '\n', { flag: 'wx', mode: 0o600 });
      return dir;
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
    const {
      harness = null,
      session = null,
      branch = null,
      task = null,
      mode = null,
      repoLevel = false,
      ...rest
    } = fields;
    const event: WorkflowEvent = {
      at: new Date().toISOString(),
      kind,
      mode,
      harness,
      session,
      branch,
      task,
      ...(clip(rest) as Record<string, unknown>),
    };
    let line = JSON.stringify(event);
    if (line.length > LINE_LIMIT) {
      line = JSON.stringify({
        ...event,
        ...Object.fromEntries(Object.keys(rest).map((k) => [k, '[clipped]'])),
      });
    }
    const dir = repoLogDirectory(root);
    const file = eventFile(dir, repoLevel ? null : task);
    makeDataDir(resolve(file, '..'));
    appendFileSync(file, line + '\n', { mode: 0o600 });
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
