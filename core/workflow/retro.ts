import type { Harness } from '../types.ts';
import type { HistoryHarness } from './clean-history.ts';
import { HARNESSES } from '../types.ts';
import { existingLogDirectory, eventFile, readEvents } from '../events.ts';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { transcriptFiles } from './clean-history.ts';
import { makeDataDir, retroLogRoot, workspaceRoot } from '../config/paths.ts';
import { inside, loadProject } from '../project.ts';
import { driver } from '../harnesses/index.ts';
import { object } from '../harnesses/transcript.ts';

export interface RetroCount {
  reason: string;
  count: number;
}

export interface RetroHarnessEvents {
  sessions: string[];
  denials: RetroCount[];
  asks: RetroCount[];
  approvals: number;
  gatePasses: number;
  gateFailures: RetroCount[];
}

export interface RetroEvents {
  task: string;
  repo: string;
  workspace: string;
  window: { from: string; to: string };
  files: { name: string; bytes: number; modified: string }[];
  reviews: { reviewer: string; round: number; verdict: string }[];
  retroLogs: string[];
  // Where the events came from: Halvard's run log, which covers every harness, or harness
  // transcripts, which cover Claude, Codex and Pi, for a task older than the log.
  source: 'log' | 'transcripts';
  // The folder this retro appends its harness's log to; created, with the root's marker.
  retroLogDir: string;
  events: Partial<Record<Harness, RetroHarnessEvents>>;
}

const harnesses: HistoryHarness[] = ['claude', 'codex', 'pi'];
// The workspace marker is written at task-start and the last report near done.
const BEFORE = 10 * 60 * 1000;
const AFTER = 60 * 60 * 1000;
const REASON_LIMIT = 300;
const APPROVAL = /^approve halvard [a-f0-9]{64}$/;
const ASK = /\n(?:To approve this one operation, send exactly|Send): approve halvard [a-f0-9]{64}/;
const GATE_PASSED = /^workflow: gate passed on the current tree$/m;
const GATE_FAILED = /^halvard: gate failed: (.+?)(?:; fix the cause and rerun)?$/gm;
// Only runGate's own failure reasons are reported; other text after the marker stays out.
const GATE_REASONS = [
  'checks failed or timed out',
  'source tree changed during checks',
  'overlapped a guarded mutation or unclassified tool',
];
function add(counts: RetroCount[], reason: string) {
  const existing = counts.find((entry) => entry.reason === reason);
  if (existing) {
    existing.count++;
  } else {
    counts.push({ reason, count: 1 });
  }
}

function timestamp(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const time = new Date(typeof value === 'number' && value < 1e11 ? value * 1000 : value).getTime();
  return Number.isNaN(time) ? null : time;
}

function inRepo(root: string, cwd: string) {
  if (!isAbsolute(cwd)) return false;
  try {
    return inside(root, realpathSync(cwd));
  } catch {
    return inside(root, cwd);
  }
}

export async function retroEvents(cwd: string, id: string): Promise<RetroEvents> {
  const { root } = loadProject(cwd);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id ?? '') || id.length > 64) {
    throw new Error('task id must be a short lowercase slug');
  }
  const base = workspaceRoot();
  const workspace = resolve(base, basename(root), id);
  if (!lstatSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`no task workspace at ${workspace}`);
  }
  const marker = join(workspace, '.repo');
  if (
    !lstatSync(marker, { throwIfNoEntry: false })?.isFile() ||
    readFileSync(marker, 'utf8').trim() !== root
  ) {
    throw new Error(`task workspace ${workspace} belongs to another repository`);
  }
  const entries = readdirSync(workspace)
    .sort()
    .map((name) => ({ name, stat: lstatSync(join(workspace, name)) }))
    .filter((entry) => entry.stat.isFile());
  const times = entries.map((entry) => entry.stat.mtimeMs);
  const from = Math.min(...times) - BEFORE;
  const to = Math.max(...times) + AFTER;
  const reviews = entries.flatMap(({ name }) => {
    const match = name.match(/^([a-z]+)-review-round(\d+)\.md$/);
    if (!match) return [];
    const verdict = readFileSync(join(workspace, name), 'utf8').match(/^Verdict: (\w+)\./m);
    return [{ reviewer: match[1]!, round: Number(match[2]), verdict: verdict?.[1] ?? 'unknown' }];
  });
  // Logs not yet moved by migrate still sit at the top of the workspace.
  const retroLogs = [...new Set([retroLogRoot(), base])].flatMap((logs) =>
    existsSync(logs)
      ? readdirSync(logs)
          .filter((name) => name.endsWith('-retro-log.md'))
          .filter((name) => lstatSync(join(logs, name)).isFile())
          .sort()
          .map((name) => join(logs, name))
      : [],
  );
  const empty = (): RetroHarnessEvents => ({
    sessions: [],
    denials: [],
    asks: [],
    approvals: 0,
    gatePasses: 0,
    gateFailures: [],
  });
  const result = (source: RetroEvents['source'], events: RetroEvents['events']): RetroEvents => ({
    task: id,
    repo: root,
    workspace,
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    files: entries.map(({ name, stat }) => ({
      name,
      bytes: stat.size,
      modified: new Date(stat.mtimeMs).toISOString(),
    })),
    reviews,
    retroLogs,
    source,
    retroLogDir: makeDataDir(retroLogRoot()),
    events,
  });
  const logs = existingLogDirectory(root);
  const log = logs ? eventFile(logs, id) : null;
  if (log && existsSync(log)) {
    const recorded = readEvents(log);
    const events = Object.fromEntries(HARNESSES.map((h) => [h, empty()])) as Record<
      Harness,
      RetroHarnessEvents
    >;
    // Gate runs name only their session key; session starts and hook events name its harness.
    const owner = new Map<string, Harness>();
    for (const event of [...readEvents(eventFile(logs!, null)), ...recorded]) {
      if (typeof event.session === 'string' && HARNESSES.includes(event.harness as Harness)) {
        owner.set(event.session, event.harness as Harness);
      }
    }
    for (const event of recorded) {
      const harness =
        (HARNESSES.includes(event.harness as Harness) ? (event.harness as Harness) : null) ??
        (typeof event.session === 'string' ? owner.get(event.session) : undefined);
      if (!harness) continue;
      const summary = events[harness];
      if (typeof event.session === 'string' && !summary.sessions.includes(event.session)) {
        summary.sessions.push(event.session);
      }
      const reason = String(event.reason ?? '').slice(0, REASON_LIMIT);
      if (event.kind === 'deny') add(summary.denials, reason);
      else if (event.kind === 'ask') add(summary.asks, reason);
      else if (event.kind === 'approval') summary.approvals++;
      else if (event.kind === 'gate' && event.passed === true) summary.gatePasses++;
      else if (event.kind === 'gate') add(summary.gateFailures, reason || 'other');
    }
    return result('log', events);
  }
  const events = Object.fromEntries(harnesses.map((harness) => [harness, empty()])) as Record<
    HistoryHarness,
    RetroHarnessEvents
  >;
  for (const { harness, file, history } of transcriptFiles(harnesses)) {
    if (history) continue;
    const summary = events[harness];
    let session = basename(file, '.jsonl');
    let location: unknown;
    for await (const line of createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })) {
      let record: Record<string, unknown>;
      try {
        record = object(JSON.parse(line));
      } catch {
        continue;
      }
      const payload = object(record.payload);
      if (harness === 'claude' && typeof record.sessionId === 'string') session = record.sessionId;
      if (record.type === 'session' && typeof record.id === 'string') session = record.id;
      if (record.type === 'session_meta' && typeof payload.id === 'string') session = payload.id;
      const item = driver(harness)!.history!.item(record);
      if (typeof item.cwd === 'string') location = item.cwd;
      const time = timestamp(item.time);
      if (typeof location !== 'string' || !inRepo(root, location)) continue;
      if (time === null || time < from || time > to) continue;
      if (!summary.sessions.includes(session)) summary.sessions.push(session);
      for (const prompt of item.prompts) {
        if (APPROVAL.test(prompt.trim())) summary.approvals++;
      }
      for (const result of item.results) {
        for (const text of result.texts) {
          if (GATE_PASSED.test(text)) summary.gatePasses++;
          for (const match of text.matchAll(GATE_FAILED)) {
            add(summary.gateFailures, GATE_REASONS.includes(match[1]!) ? match[1]! : 'other');
          }
        }
        for (const denial of result.denials) {
          const reason = denial.split(ASK)[0]!.split('\n')[0]!.trim().slice(0, REASON_LIMIT);
          add(ASK.test(denial) ? summary.asks : summary.denials, reason);
        }
      }
    }
  }
  return result('transcripts', events);
}
