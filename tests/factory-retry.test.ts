import type { TestContext } from 'node:test';
import type { Context } from '../core/factory/context.ts';
import type { FactoryJob } from '../core/factory/store.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { factoryConfig, RETRYABLE } from '../core/config/factory.ts';
import { createJob, loadJob, recordEvent } from '../core/factory/store.ts';
import { autoRetryDue } from '../core/factory/serve.ts';
import { NEXT_STEP } from '../core/factory/jobs.ts';

test('the retry policy takes counts for retryable reasons only', () => {
  assert.deepEqual(factoryConfig({ retryPolicy: { infra: 1, conflict: 2 } }).retryPolicy, {
    infra: 1,
    conflict: 2,
  });
  assert.deepEqual(factoryConfig({}).retryPolicy, {});
  for (const reason of ['tampered', 'stopped-by-human', 'out-of-scope', 'plan-changed']) {
    assert.throws(
      () => factoryConfig({ retryPolicy: { [reason]: 1 } }),
      /cannot retry .*; a person decides/,
    );
  }
  assert.throws(() => factoryConfig({ retryPolicy: { nonsense: 1 } }), /unknown park reason/);
  for (const reason of ['budget-time', 'budget-usd']) {
    assert.throws(
      () => factoryConfig({ retryPolicy: { [reason]: 1 } }),
      /the same budget runs out again/,
    );
  }
  assert.throws(() => factoryConfig({ retryPolicy: { infra: 3 } }), /must be 0\.\.2/);
  assert.throws(() => factoryConfig({ retryPolicy: [] }), /must map park reasons/);
});

test('every park reason has a next step for the issue comment', () => {
  for (const reason of [
    ...RETRYABLE,
    'budget-time',
    'budget-usd',
    'tampered',
    'stopped-by-human',
    'out-of-scope',
    'plan-changed',
  ]) {
    assert.ok(NEXT_STEP[reason], reason);
  }
});

function parkedJob(t: TestContext, reason: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-retry-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const job: Omit<FactoryJob, 'created' | 'updated'> = {
    version: 1,
    id: 'issue-7',
    repo: root,
    title: 'Job',
    issue: { number: 7, url: 'https://github.com/example/repo/issues/7' },
    small: true,
    fix: false,
    author: 'claude',
    stage: 'parked',
    worktree: null,
    branch: null,
    task: null,
    plan: null,
    reviewer: null,
    round: 0,
    fixPasses: 0,
    parked: { reason, detail: 'x', at: new Date().toISOString() },
    pr: null,
    costUsd: 0,
  };
  createJob(root, job);
  return root;
}

const context = (root: string, retryPolicy: Record<string, number>) =>
  ({ root, factory: { retryPolicy } }) as unknown as Context;

test('serve retries a covered reason up to its count, then waits for a person', (t) => {
  const root = parkedJob(t, 'infra');
  const ctx = context(root, { infra: 1 });
  assert.equal(autoRetryDue(ctx, loadJob(root, 'issue-7')), true);
  recordEvent(root, 'issue-7', 'auto-retry', { reason: 'infra' });
  assert.equal(autoRetryDue(ctx, loadJob(root, 'issue-7')), false);
});

test('serve does not retry a reason the policy leaves out', (t) => {
  const root = parkedJob(t, 'agent-blocked');
  assert.equal(autoRetryDue(context(root, { infra: 2 }), loadJob(root, 'issue-7')), false);
  assert.equal(autoRetryDue(context(root, {}), loadJob(root, 'issue-7')), false);
});

test('retries for one reason do not use up another reason', (t) => {
  const root = parkedJob(t, 'conflict');
  recordEvent(root, 'issue-7', 'auto-retry', { reason: 'infra' });
  assert.equal(
    autoRetryDue(context(root, { infra: 1, conflict: 1 }), loadJob(root, 'issue-7')),
    true,
  );
});
