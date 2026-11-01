import type { TestContext } from 'node:test';
import './environment.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeEvent } from '../core/events.ts';
import { runMetrics, saveMetrics } from '../core/metrics.ts';

function repo(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-metrics-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// Writes events one minute apart from 2026-01-01, in the order given.
function events(t: TestContext, root: string, list: [string, Record<string, unknown>][]) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  for (const [kind, fields] of list) {
    writeEvent(root, kind, fields);
    t.mock.timers.tick(60000);
  }
  t.mock.timers.reset();
}

test('metrics count tasks, first gates, reviews and guard friction', (t) => {
  const root = repo(t);
  const solo = { task: 'one', mode: 'solo' as const };
  const team = { task: 'two', mode: 'team' as const };
  events(t, root, [
    ['task-start', { ...solo, harness: 'claude' }],
    ['gate', { ...solo, session: 's1', passed: false, reason: 'checks failed or timed out' }],
    ['gate', { ...solo, session: 's1', passed: true }],
    ['review', { ...solo, round: 1, verdict: 'blocked' }],
    ['review', { ...solo, round: 2, verdict: 'pass' }],
    ['task-done', { ...solo, harness: 'claude' }],
    ['task-start', { ...team, harness: 'codex' }],
    ['gate', { ...team, session: 's2', passed: true }],
    ['review', { ...team, round: 1, verdict: 'pass' }],
    // An ask the user approved, one they did not, and two denials.
    ['ask', { ...team, session: 's2', reason: 'This command commits' }],
    ['approval', { ...team, session: 's2' }],
    ['ask', { ...team, session: 's2', reason: 'This command commits' }],
    ['deny', { session: 's3', harness: 'grok', reason: 'hook error', repoLevel: true }],
    ['deny', { ...team, session: 's2', reason: 'In this team task' }],
  ]);
  const all = runMetrics(root);
  assert.deepEqual(all.tasks, { started: 2, done: 1, byMode: { solo: 1, team: 1 } });
  assert.deepEqual(all.gate, { tasks: 2, firstPassRate: 50 });
  assert.deepEqual(all.review, { tasks: 2, firstRoundBlockRate: 50, reReviewRate: 50 });
  assert.deepEqual(all.guard!.asks, [
    { reason: 'This command commits', count: 2, approved: 1, approvedRate: 50 },
  ]);
  assert.equal(all.guard!.hookErrors, 1);
  assert.equal(all.guard!.denials.length, 2);
  assert.equal(all.factory, null);

  const onlyTeam = runMetrics(root, { mode: 'team' });
  assert.deepEqual(onlyTeam.tasks, { started: 1, done: 0, byMode: { team: 1 } });
  assert.deepEqual(onlyTeam.gate, { tasks: 1, firstPassRate: 100 });
  // A denial with no task, such as one on main, counts for every mode.
  assert.equal(onlyTeam.guard!.hookErrors, 1);

  const recent = runMetrics(root, { since: 1, now: new Date('2026-06-01T00:00:00Z') });
  assert.deepEqual(recent.tasks, { started: 0, done: 0, byMode: {} });
});

test('a repository with no logs gives empty numbers', (t) => {
  const result = runMetrics(repo(t));
  assert.deepEqual(result.tasks, { started: 0, done: 0, byMode: {} });
  assert.equal(result.gate!.firstPassRate, null);
  assert.deepEqual(result.guard, { denials: [], asks: [], hookErrors: 0 });
});

test('factory mode reads no run log and creates no factory folder', (t) => {
  const root = repo(t);
  const result = runMetrics(root, { mode: 'factory' });
  assert.equal(result.tasks, null);
  assert.equal(result.factory, null);
  assert.equal(existsSync(join(process.env.HALVARD_DATA!, 'factory')), false);
});

test('a snapshot is saved under the data folder', (t) => {
  const root = repo(t);
  const file = saveMetrics(runMetrics(root));
  t.after(() => rmSync(file, { force: true }));
  assert.ok(file.startsWith(join(process.env.HALVARD_DATA!, 'metrics')));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).repo, root);
});

test('a window counts tasks that started in it, with their real first gate', (t) => {
  const root = repo(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  writeEvent(root, 'task-start', { task: 'old', mode: 'solo' });
  writeEvent(root, 'gate', { task: 'old', mode: 'solo', passed: false });
  t.mock.timers.tick(10 * 24 * 3600 * 1000);
  writeEvent(root, 'gate', { task: 'old', mode: 'solo', passed: true });
  writeEvent(root, 'task-start', { task: 'new', mode: 'solo' });
  writeEvent(root, 'gate', { task: 'new', mode: 'solo', passed: false });
  t.mock.timers.tick(1000);
  writeEvent(root, 'gate', { task: 'new', mode: 'solo', passed: true });
  const now = new Date();
  t.mock.timers.reset();
  const result = runMetrics(root, { since: 2, now });
  assert.deepEqual(result.tasks, { started: 1, done: 0, byMode: { solo: 1 } });
  // The new task's real first gate failed.
  assert.deepEqual(result.gate, { tasks: 1, firstPassRate: 0 });
});
