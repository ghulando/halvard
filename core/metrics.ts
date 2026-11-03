import type { WorkflowEvent } from './events.ts';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dataRoot, makeDataDir } from './config/paths.ts';
import { eventFile, existingLogDirectory, readEvents, taskLogs } from './events.ts';

// Numbers from the run log, worked out on demand. Rates are percentages with one decimal,
// or null when nothing was measured.
export type MetricsMode = 'solo' | 'team' | 'factory';

export interface ReasonCount {
  reason: string;
  count: number;
}

export interface AskCount extends ReasonCount {
  // `count` is distinct operations asked. An agent retrying while a request waits repeats
  // it, and an expired request issued again refreshes it; neither adds to the count.
  // `approved` is operations a trusted answer approved: friction when it is near 100%.
  approved: number;
  approvedRate: number | null;
  rejected: number;
  // Declined in a dialog, by the user or by the host's approval policy.
  declined: number;
  cancelled: number;
  expired: number;
  // The host ran the exact asked call after its own dialog; not a verified user approval.
  hostAllowed: number;
  // No outcome reached the log.
  unknown: number;
  repeats: number;
  refreshed: number;
  // Asks from logs written before requests were recorded, matched by session as before.
  legacy: number;
}

type Outcome = 'approved' | 'rejected' | 'declined' | 'cancelled' | 'expired' | 'hostAllowed';
// When one operation saw several outcomes, the strongest counts.
const OUTCOMES: Outcome[] = [
  'approved',
  'hostAllowed',
  'rejected',
  'declined',
  'cancelled',
  'expired',
];
const OUTCOME_NAMES: Record<string, Outcome> = {
  approved: 'approved',
  rejected: 'rejected',
  declined: 'declined',
  cancelled: 'cancelled',
  expired: 'expired',
  'host-allowed': 'hostAllowed',
};

const DAY = 24 * 3600 * 1000;

const rate = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) / 10 : null;

function count<T extends ReasonCount>(list: T[], reason: string, make: () => T) {
  const found = list.find((entry) => entry.reason === reason);
  if (found) return found;
  const entry = make();
  list.push(entry);
  return entry;
}

export function runMetrics(
  root: string,
  { mode, since, now = new Date() }: { mode?: MetricsMode; since?: number; now?: Date } = {},
) {
  const from = since === undefined ? null : now.getTime() - since * DAY;
  const keep = (event: WorkflowEvent) =>
    (from === null || Date.parse(event.at) >= from) &&
    // Events without a task, such as denials on main, have no mode and count for all.
    (mode === undefined || event.mode == null || event.mode === mode);
  const work = mode !== 'factory';
  const dir = work ? existingLogDirectory(root) : null;
  const tasks = dir
    ? taskLogs(dir).map(({ task, file }) => ({ task, events: readEvents(file) }))
    : [];
  const loose = dir ? readEvents(eventFile(dir, null)) : [];

  let started = 0;
  let done = 0;
  let gated = 0;
  let firstGatePassed = 0;
  let reviewed = 0;
  let firstRoundBlocked = 0;
  let reReviewed = 0;
  const byMode: Record<string, number> = {};
  // A task counts once, for the mode and window it started in; its first gate and first
  // review are its real firsts, even when they fall after the window.
  for (const { events } of tasks) {
    const start = events.find((event) => event.kind === 'task-start');
    if (!start || (from !== null && Date.parse(start.at) < from)) continue;
    if (mode && start.mode !== mode) continue;
    started++;
    byMode[start.mode ?? 'solo'] = (byMode[start.mode ?? 'solo'] ?? 0) + 1;
    if (events.some((event) => event.kind === 'task-done')) done++;
    const gate = events.find((event) => event.kind === 'gate');
    if (gate) {
      gated++;
      if (gate.passed === true) firstGatePassed++;
    }
    const first = events.find((event) => event.kind === 'review' && event.round === 1);
    if (first) {
      reviewed++;
      if (first.verdict !== 'pass') firstRoundBlocked++;
      if (events.some((event) => event.kind === 'review' && Number(event.round) >= 2)) {
        reReviewed++;
      }
    }
  }

  const denials: ReasonCount[] = [];
  const asks: AskCount[] = [];
  let hookErrors = 0;
  const all = [...loose, ...tasks.flatMap(({ events }) => events)]
    .filter(keep)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Each asked operation with the outcomes its requests received. An operation is keyed
  // by its op digest and first request: the same op asked again after an earlier request
  // finished is a new operation, while a reissue after expiry continues the last one.
  const operations = new Map<string, { entry: AskCount; outcomes: Set<Outcome> }>();
  const requests = new Map<string, string>();
  const latest = new Map<string, string>();
  // Legacy: the ask a session is waiting on, until its next approval or ask.
  const waiting = new Map<string, AskCount>();
  const askEntry = (reason: string) =>
    count(asks, reason, () => ({
      reason,
      count: 0,
      approved: 0,
      approvedRate: null,
      rejected: 0,
      declined: 0,
      cancelled: 0,
      expired: 0,
      hostAllowed: 0,
      unknown: 0,
      repeats: 0,
      refreshed: 0,
      legacy: 0,
    }));
  for (const event of all) {
    const reason = String(event.reason ?? '');
    if (event.kind === 'deny') {
      if (reason === 'hook error') hookErrors++;
      count(denials, reason, () => ({ reason, count: 0 })).count++;
    } else if (event.kind === 'ask' && typeof event.request === 'string') {
      const entry = askEntry(reason);
      const op = typeof event.op === 'string' ? event.op : event.request;
      const known = requests.get(event.request) ?? latest.get(op);
      if (event.repeat === true && requests.has(event.request)) {
        entry.repeats++;
      } else if (event.refreshed === true && known && operations.has(known)) {
        entry.refreshed++;
        requests.set(event.request, known);
      } else {
        const key = `${op}:${event.request}`;
        entry.count++;
        operations.set(key, { entry, outcomes: new Set() });
        requests.set(event.request, key);
        latest.set(op, key);
      }
    } else if (event.kind === 'ask') {
      const entry = askEntry(reason);
      entry.count++;
      entry.legacy++;
      if (typeof event.session === 'string') waiting.set(event.session, entry);
    } else if (event.kind === 'outcome' && typeof event.request === 'string') {
      const op = requests.get(event.request);
      const outcome = OUTCOME_NAMES[String(event.outcome)];
      if (op && outcome) operations.get(op)?.outcomes.add(outcome);
    } else if (event.kind === 'approval' && typeof event.session === 'string') {
      const entry = waiting.get(event.session);
      if (entry) entry.approved++;
      waiting.delete(event.session);
    }
  }
  for (const { entry, outcomes } of operations.values()) {
    const outcome = OUTCOMES.find((name) => outcomes.has(name));
    if (outcome) entry[outcome]++;
    else entry.unknown++;
  }
  for (const entry of asks) entry.approvedRate = rate(entry.approved, entry.count);
  const byCount = (a: ReasonCount, b: ReasonCount) => b.count - a.count;

  return {
    repo: root,
    mode: mode ?? 'all',
    since: from === null ? null : new Date(from).toISOString(),
    tasks: work ? { started, done, byMode } : null,
    gate: work ? { tasks: gated, firstPassRate: rate(firstGatePassed, gated) } : null,
    review: work
      ? {
          tasks: reviewed,
          firstRoundBlockRate: rate(firstRoundBlocked, reviewed),
          reReviewRate: rate(reReviewed, reviewed),
        }
      : null,
    guard: work ? { denials: denials.sort(byCount), asks: asks.sort(byCount), hookErrors } : null,
    // The CLI adds the factory's numbers; core/factory sits above this layer.
    factory: null as unknown,
  };
}

// Saves a result under ~/.halvard/metrics, so numbers can be compared over time. The log
// stays the source; a snapshot can be deleted and worked out again.
export function saveMetrics(result: ReturnType<typeof runMetrics>, now = new Date()) {
  const dir = makeDataDir(join(dataRoot(), 'metrics'));
  const file = join(
    dir,
    `${basename(result.repo)}-${createHash('sha256').update(result.repo).digest('hex').slice(0, 8)}-${result.mode}-${now.toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}
