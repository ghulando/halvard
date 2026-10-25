import type { HistoryHarness, RetroCount, RetroEvents, RetroHarnessEvents } from '../types.ts';
import { createReadStream, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { transcriptFiles } from './clean-history.ts';
import { workspaceRoot } from '../flow-config.ts';
import { inside, loadProject } from '../project.ts';

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
// Each harness reports a hook denial in its own shape; reason text elsewhere is not a denial.
const CLAUDE_DENIAL = /^PreToolUse:[\w.-]+ hook error: ([\s\S]*)$/;
const CODEX_DENIAL = 'Command blocked by PreToolUse hook: ';
const CODEX_SCRIPT_ERROR = `Script error:\n${CODEX_DENIAL}`;
const PI_DENIAL = 'halvard blocked: ';

interface Item {
  cwd?: unknown;
  time?: unknown;
  prompts: string[];
  results: { texts: string[]; denials: string[] }[];
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function texts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    const text = object(block).text;
    return typeof text === 'string' ? [text] : [];
  });
}

// Codex code-mode output nests command results inside JSON strings. A rejected entry
// holds the blocked command, which never ran, so its text is not command output.
function unwrap(text: string, depth = 0): string[] {
  if (depth > 3 || !/^\s*[[{]/.test(text)) return [text];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [text];
  }
  const leaves: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      leaves.push(...unwrap(value, depth + 1));
    } else if (value && typeof value === 'object' && object(value).status !== 'rejected') {
      Object.values(value).forEach(walk);
    }
  };
  walk(parsed);
  return leaves;
}

function claudeItem(record: Record<string, unknown>): Item {
  const item: Item = { cwd: record.cwd, time: record.timestamp, prompts: [], results: [] };
  if (record.type !== 'user' || record.isMeta) return item;
  const content = object(record.message).content;
  if (typeof content === 'string') item.prompts.push(content);
  if (!Array.isArray(content)) return item;
  for (const block of content.map(object)) {
    if (block.type === 'tool_result') {
      const output = texts(block.content);
      item.results.push({
        texts: output,
        denials:
          block.is_error === true
            ? output.flatMap((text) => text.match(CLAUDE_DENIAL)?.slice(1) ?? [])
            : [],
      });
    } else if (block.type === 'text' && typeof block.text === 'string') {
      item.prompts.push(block.text);
    }
  }
  return item;
}

// Codex rejects a call as a script error block or as a rejected entry at the top of its
// result envelope, alone or in a parallel-call array. Nothing below that is searched,
// since command output can hold any value. Codex appends the blocked command, which
// can carry anything the agent typed.
function codexDenials(text: string): string[] {
  const reason = (value: string) => value.slice(CODEX_DENIAL.length).split(/\.? Command: /)[0]!;
  if (text.startsWith(CODEX_SCRIPT_ERROR)) return [reason(text.slice('Script error:\n'.length))];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map(object)
    .flatMap((entry) =>
      entry.status === 'rejected' &&
      typeof entry.reason === 'string' &&
      entry.reason.startsWith(CODEX_DENIAL)
        ? [reason(entry.reason)]
        : [],
    );
}

function codexItem(record: Record<string, unknown>): Item {
  const payload = object(record.payload);
  const item: Item = { time: record.timestamp, prompts: [], results: [] };
  if (['session_meta', 'turn_context'].includes(record.type as string)) item.cwd = payload.cwd;
  if (
    record.type === 'event_msg' &&
    payload.type === 'user_message' &&
    typeof payload.message === 'string'
  ) {
    item.prompts.push(payload.message);
  }
  if (
    record.type === 'response_item' &&
    ['function_call_output', 'custom_tool_call_output'].includes(payload.type as string)
  ) {
    const output = texts(payload.output);
    item.results.push({
      texts: output
        .filter((text) => !text.startsWith(CODEX_SCRIPT_ERROR))
        .flatMap((text) => unwrap(text)),
      denials: output.flatMap(codexDenials),
    });
  }
  return item;
}

function piItem(record: Record<string, unknown>): Item {
  const message = object(record.message);
  const item: Item = { time: record.timestamp, prompts: [], results: [] };
  if (record.type === 'session') item.cwd = record.cwd;
  if (record.type !== 'message') return item;
  if (message.role === 'user') item.prompts.push(...texts(message.content));
  if (message.role === 'toolResult') {
    const output = texts(message.content);
    item.results.push({
      texts: output,
      denials:
        message.isError === true
          ? output
              .filter((text) => text.startsWith(PI_DENIAL))
              .map((text) => text.slice(PI_DENIAL.length))
          : [],
    });
  }
  return item;
}

const parsers = { claude: claudeItem, codex: codexItem, pi: piItem };

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
      const item = parsers[harness](record);
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
