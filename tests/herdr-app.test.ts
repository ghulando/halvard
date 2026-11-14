import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { teamConfig } from '../core/config/team.ts';

// The watchtower's modules that import nothing from Herdr. The npm package ships the tests
// but not herdr-app/.
const watch = resolve(import.meta.dirname, '../herdr-app/mods/halvard-watch');
const skip = existsSync(watch) ? false : 'herdr-app/ is not packaged';

interface Event {
  kind: string;
  time: number;
  [field: string]: unknown;
}
interface Parsed {
  end: number;
  tail: string;
  events: Event[];
}
interface Verdict {
  gate?: { passed: boolean; at: number };
  review?: { verdict: string; round: number | null };
}
interface Summary {
  mood: string;
  open: number;
  streak: number;
  score: Record<string, number>;
  skills: { name: string; count: number }[];
}
interface Log {
  parseEvents(text: string): Event[];
  summarize(events: Event[], now: number, task: string | null): Summary;
  verdicts(events: Event[]): Record<string, Verdict>;
  appendEvents(before: Parsed | null, text: string): Parsed;
}
interface Rules {
  validTeam(team: unknown): Record<string, string | null> | null;
  parseTask(
    source: unknown,
    branch: string | null,
    name: string,
  ): { title: string; status: string | null; next: string | null } | null;
}

const load = async () => ({
  log: (await import(`${watch}/log.js`)) as Log,
  rules: (await import(`${watch}/rules.js`)) as Rules,
});

const NOW = Date.parse('2026-11-14T12:00:00Z');
const line = (minutesAgo: number, kind: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ at: new Date(NOW - minutesAgo * 60000).toISOString(), kind, ...fields }) + '\n';

test('the watchtower accepts exactly the teams Halvard accepts', { skip }, async () => {
  const { rules } = await load();
  const teams: unknown[] = [
    { lead: 'claude', dev: 'codex', reviewer: 'pi' },
    { lead: 'claude', dev: 'codex', reviewer: 'claude', investigator: 'pi' },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', investigator: null },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', monitor: { watch: false, approve: 'none' } },
    { lead: 'cursor', dev: 'grok', reviewer: 'codex', monitor: {} },
    { lead: 'claude', dev: 'claude', reviewer: 'pi' },
    { lead: 'claude', dev: 'codex', reviewer: 'codex' },
    { lead: 'claude', dev: 'codex' },
    { lead: 'claude', dev: 'codex', reviewer: 'vim' },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', investigator: 'vim' },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', extra: true },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', monitor: { watch: 'yes' } },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', monitor: { approve: 'all' } },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', monitor: { other: true } },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', monitor: null },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', monitor: [] },
    { lead: 'claude', dev: 'codex', reviewer: 'pi', __proto__: { x: 1 } },
    [],
    null,
    'claude',
  ];
  for (const team of teams) {
    let accepted = true;
    try {
      teamConfig(team);
    } catch {
      accepted = false;
    }
    assert.equal(rules.validTeam(team) !== null, accepted, JSON.stringify(team));
  }
  assert.deepEqual(rules.validTeam({ lead: 'claude', dev: 'codex', reviewer: 'pi' }), {
    lead: 'claude',
    dev: 'codex',
    reviewer: 'pi',
    investigator: null,
  });
});

test('a task card shows only a task whose metadata Halvard accepts', { skip }, async () => {
  const { rules } = await load();
  const base = 'a'.repeat(40);
  const file = (metadata: Record<string, unknown>, end = '\n') =>
    [
      `# Fix the gate`,
      ``,
      `<!-- halvard ${JSON.stringify({ version: 1, author: 'codex', branch: 'fix/gate', base, title: 'Fix the gate', ...metadata })} -->`,
      ``,
      `**Status:** implementing.`,
      ``,
      `## Next step`,
      ``,
      `Run the`,
      `gate.`,
      ``,
      `Later text.`,
      ``,
    ].join(end);
  assert.deepEqual(rules.parseTask(file({}), 'fix/gate', 'fix-gate.md'), {
    title: 'Fix the gate',
    status: 'implementing',
    next: 'Run the gate.',
  });
  assert.equal(rules.parseTask(file({}), 'main', 'fix-gate.md'), null);
  for (const metadata of [
    { version: 2 },
    { author: 'vim' },
    { base: 'main' },
    { title: 7 },
    { plan: { digest: 'x', approvedBy: 'you', at: 'now' } },
  ]) {
    assert.equal(
      rules.parseTask(file(metadata), 'fix/gate', 'f.md'),
      null,
      JSON.stringify(metadata),
    );
  }
  const plan = { digest: 'b'.repeat(64), approvedBy: 'you', at: '2026-11-14' };
  assert.notEqual(rules.parseTask(file({ plan }), 'fix/gate', 'f.md'), null);
  // Halvard's metadata pattern also matches a line ending in \r\n; its sections still read.
  assert.deepEqual(rules.parseTask(file({}, '\r\n'), 'fix/gate', 'f.md'), {
    title: 'Fix the gate',
    status: 'implementing',
    next: 'Run the gate.',
  });
  assert.equal(rules.parseTask('<!-- halvard {not json} -->', 'fix/gate', 'f.md'), null);
});

test('the run log skips torn and timeless lines and sorts by time', { skip }, async () => {
  const { log } = await load();
  const events = log.parseEvents(
    line(1, 'deny') +
      '{"at":"2026' +
      '\n' +
      line(5, 'ask') +
      '{"kind":"gate"}\n[1]\n{"at":"2026-11-14T11:00:00Z","kind":7}\n',
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ['ask', 'deny'],
  );
});

test(
  'the mascot is alarmed by a recent denial and watchful while a request waits',
  { skip },
  async () => {
    const { log } = await load();
    const mood = (text: string) => log.summarize(log.parseEvents(text), NOW, null).mood;
    assert.equal(mood(line(2, 'deny')), 'alarmed');
    assert.equal(mood(line(2, 'gate', { passed: false })), 'alarmed');
    assert.equal(mood(line(2, 'review', { verdict: 'blocked' })), 'alarmed');
    assert.equal(mood(line(20, 'deny')), 'calm');
    assert.equal(mood(line(2, 'ask', { request: 'r1' })), 'watchful');
    assert.equal(
      mood(
        line(2, 'ask', { request: 'r1' }) +
          line(1, 'outcome', { request: 'r1', outcome: 'expired' }),
      ),
      'calm',
    );
    assert.equal(mood(line(20, 'ask', { request: 'r1' })), 'calm');
  },
);

test('the scoreboard counts today, the streak and the runes of the task', { skip }, async () => {
  const { log } = await load();
  const text =
    line(60 * 30, 'gate', { passed: true }) +
    line(50, 'gate', { passed: false }) +
    line(40, 'gate', { passed: true }) +
    line(30, 'gate', { passed: true }) +
    line(25, 'review', { verdict: 'pass', round: 1 }) +
    line(24, 'review', { verdict: 'pass', round: 2 }) +
    line(20, 'skill', { skill: 'halvard-debug', task: 'fix-gate' }) +
    line(19, 'skill', { skill: 'halvard-debug', task: 'fix-gate' }) +
    line(18, 'skill', { skill: 'halvard-understand', task: 'fix-gate' }) +
    line(17, 'skill', { skill: 'halvard-spec', task: 'other' });
  const s = log.summarize(log.parseEvents(text), NOW, 'fix-gate');
  assert.equal(s.streak, 2);
  assert.equal(s.score.held, 2);
  assert.equal(s.score.fell, 1);
  assert.equal(s.score.firstRound, 1);
  assert.equal(s.score.reReviews, 1);
  assert.deepEqual(s.skills, [
    { name: 'halvard-debug', count: 2 },
    { name: 'halvard-understand', count: 1 },
  ]);
  assert.equal(log.summarize(log.parseEvents(text), NOW, null).skills.length, 3);
});

test('the latest verdict per branch treats every branch name as a name', { skip }, async () => {
  const { log } = await load();
  const v = log.verdicts(
    log.parseEvents(
      line(3, 'gate', { branch: '__proto__', passed: false }) +
        line(2, 'gate', { branch: '__proto__', passed: true }) +
        line(1, 'review', { branch: 'constructor', verdict: 'blocked', round: 1 }) +
        line(1, 'gate', { passed: true }),
    ),
  );
  assert.equal(Object.getPrototypeOf(v), null);
  assert.deepEqual(Object.keys(v), ['__proto__', 'constructor']);
  assert.equal(v['__proto__']!.gate!.passed, true);
  assert.equal(v['constructor']!.review!.verdict, 'blocked');
});

test('a log read parses only appended lines and rereads a rewritten file', { skip }, async () => {
  const { log } = await load();
  const torn = line(5, 'gate', { passed: true }) + '{"at":"2026-11-14T11:59';
  const first = log.appendEvents(null, torn);
  assert.deepEqual(
    first.events.map((e) => e.kind),
    ['gate'],
  );
  // The torn line, once whole, is read in full.
  const whole = line(5, 'gate', { passed: true }) + line(1, 'deny');
  const second = log.appendEvents(first, whole);
  assert.deepEqual(
    second.events.map((e) => e.kind),
    ['gate', 'deny'],
  );
  assert.equal(log.appendEvents(second, whole), second);
  const rewritten = log.appendEvents(second, line(1, 'ask'));
  assert.deepEqual(
    rewritten.events.map((e) => e.kind),
    ['ask'],
  );
});
