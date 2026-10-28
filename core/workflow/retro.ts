import type { HistoryHarness } from './clean-history.ts';
import { createReadStream, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { transcriptFiles } from './clean-history.ts';
import { workspaceRoot } from '../config/paths.ts';
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
  events: Record<HistoryHarness, RetroHarnessEvents>;
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
  const retroLogs = readdirSync(base)
    .filter((name) => name.endsWith('-retro-log.md'))
    .filter((name) => lstatSync(join(base, name)).isFile())
    .sort()
    .map((name) => join(base, name));
  const events = Object.fromEntries(
    harnesses.map((harness) => [
      harness,
      { sessions: [], denials: [], asks: [], approvals: 0, gatePasses: 0, gateFailures: [] },
    ]),
  ) as unknown as Record<HistoryHarness, RetroHarnessEvents>;
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
  return {
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
    events,
  };
}
