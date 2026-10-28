import type { TestContext } from 'node:test';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import test from 'node:test';
import { factoryCommand } from '../core/factory/command.ts';
import { loadJob, listJobs } from '../core/factory/store.ts';
import { boardHtml, metrics } from '../core/factory/board.ts';
import { env, repo, stubs } from './factory-stubs.ts';

const serveOnce = (root: string) => factoryCommand(root, ['serve', '--once']);
const jobDir = (root: string, id: string) =>
  join(process.env.HALVARD_FACTORY_HOME!, basename(root), 'jobs', id);
const show = (root: string, ref: string) =>
  execFileSync('git', ['show', ref], { cwd: root, encoding: 'utf8' });

function setup(t: TestContext, factory: Record<string, unknown> = {}) {
  const root = repo(t, {
    factory: { author: 'claude', reviewers: ['grok', 'cursor'], ...factory },
  });
  const calls = stubs(t);
  calls.github.permission('maintainer', 'write');
  calls.github.permission('triager', 'triage');
  return { root, calls, github: calls.github };
}

test('serve claims issues labeled by a writer: small ones build, others get a plan', async (t) => {
  const { root, github } = setup(t);
  github.issue(1, 'Small change');
  github.label(1, 'factory', 'maintainer');
  github.label(1, 'factory:small', 'maintainer');
  github.issue(2, 'Planned change');
  github.label(2, 'factory', 'maintainer');
  github.issue(3, 'Triaged only');
  github.label(3, 'factory', 'triager');
  await serveOnce(root);

  const small = loadJob(root, 'issue-1');
  assert.equal(small.stage, 'committed', JSON.stringify(small.parked));
  assert.match(show(root, `${small.branch}:source.txt`), /implemented/);
  assert.equal(loadJob(root, 'issue-2').stage, 'awaiting-approval');
  assert.equal(existsSync(jobDir(root, 'issue-3')), false);
  const comments = github.read().comments;
  assert.ok(comments.some((c) => c.issue === 2 && /proposes this plan/.test(c.body)));

  // A triager's approval label counts for nothing; a writer's, added after the plan, does.
  github.label(2, 'factory:approved', 'triager');
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-2').stage, 'awaiting-approval');
  github.label(2, 'factory:approved', 'maintainer');
  await serveOnce(root);
  const planned = loadJob(root, 'issue-2');
  assert.equal(planned.stage, 'committed', JSON.stringify(planned.parked));
  assert.match(planned.plan!.approvedBy!, /^maintainer/);

  const board = readFileSync(
    join(process.env.HALVARD_FACTORY_HOME!, basename(root), 'board.html'),
    'utf8',
  );
  assert.match(board, /issue-1/);
  assert.match(board, /issue-2/);
});

test('serve stops claiming work at 90% of the monthly budget', async (t) => {
  const { root, github } = setup(t, { monthlyUsd: 0.25 });
  for (const number of [1, 2]) {
    github.issue(number, `Small ${number}`);
    github.label(number, 'factory', 'maintainer');
    github.label(number, 'factory:small', 'maintainer');
  }
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-1').stage, 'committed');
  assert.equal(existsSync(jobDir(root, 'issue-2')), false);
  assert.equal(metrics(root).monthSpendUsd, 0.25);
});

test('stop and retry labels park and restart jobs', async (t) => {
  const { root, github } = setup(t);
  github.issue(5, 'Stop me');
  github.label(5, 'factory', 'maintainer');
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-5').stage, 'awaiting-approval');
  github.label(5, 'factory:stop', 'maintainer');
  await serveOnce(root);
  const stopped = loadJob(root, 'issue-5');
  assert.equal(stopped.stage, 'parked');
  assert.equal(stopped.parked!.reason, 'stopped-by-human');
  assert.ok(github.read().issues[0]!.labels.includes('factory:parked'));

  github.issue(6, 'Blocked first');
  github.label(6, 'factory', 'maintainer');
  github.label(6, 'factory:small', 'maintainer');
  env(t, { STUB_AGENT: 'blocked' });
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-6').parked!.reason, 'agent-blocked');
  env(t, { STUB_AGENT: undefined });
  github.label(6, 'factory:retry', 'maintainer');
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-6').stage, 'committed');
  const labels = github.read().issues.find((issue) => issue.number === 6)!.labels;
  assert.equal(labels.includes('factory:retry'), false);
  assert.equal(labels.includes('factory:parked'), false);
});

test('factory stop parks a waiting job and a stop file halts a build', async (t) => {
  const { root } = setup(t);
  const brief = join(root, '..', `brief-stop-${Date.now()}.md`);
  writeFileSync(brief, 'Anything.');
  t.after(() => execFileSync('rm', ['-f', brief]));
  await factoryCommand(root, ['plan', '--brief', brief, '--title', 'Waits', '--id', 'waits']);
  await factoryCommand(root, ['stop', 'waits']);
  assert.equal(loadJob(root, 'waits').parked!.reason, 'stopped-by-human');
  await assert.rejects(factoryCommand(root, ['stop', 'waits']), /nothing to stop/);

  await factoryCommand(root, ['plan', '--brief', brief, '--title', 'Approved', '--id', 'approved']);
  await factoryCommand(root, ['approve', 'approved', '--by', 'Maintainer']);
  writeFileSync(join(jobDir(root, 'approved'), 'stop'), 'now\n');
  await factoryCommand(root, ['build', 'approved', '--no-push']);
  const job = loadJob(root, 'approved');
  assert.equal(job.parked!.reason, 'stopped-by-human');
  assert.match(job.parked!.detail, /factory stop/);
});

test('rework sends a note to the agent and replan recovers a dead plan run', async (t) => {
  const { root, calls } = setup(t);
  const brief = join(root, '..', `brief-rework-${Date.now()}.md`);
  const note = join(root, '..', `note-${Date.now()}.md`);
  writeFileSync(brief, 'Anything.');
  writeFileSync(note, 'Use the word implemented, not done.');
  t.after(() => execFileSync('rm', ['-f', brief, note]));
  env(t, { STUB_AGENT: 'blocked' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    'Rework',
    '--id',
    'rework',
    '--no-push',
  ]);
  assert.equal(loadJob(root, 'rework').stage, 'parked');
  env(t, { STUB_AGENT: undefined });
  await factoryCommand(root, ['rework', 'rework', '--note', note, '--no-push']);
  assert.equal(loadJob(root, 'rework').stage, 'committed');
  const prompt = calls()
    .filter((call) => !call.reviewer)
    .at(-1)!.prompt;
  assert.match(prompt, /A human sent this job back with a note/);
  assert.match(prompt, /Use the word implemented, not done\./);

  // A plan run whose runner died leaves the job in planning; replan runs it again.
  await factoryCommand(root, [
    'plan',
    '--brief',
    brief,
    '--title',
    'Dead plan',
    '--id',
    'dead-plan',
  ]);
  const file = join(jobDir(root, 'dead-plan'), 'job.json');
  const job = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...job, stage: 'planning', plan: null }));
  await factoryCommand(root, ['replan', 'dead-plan']);
  assert.equal(loadJob(root, 'dead-plan').stage, 'awaiting-approval');
  await assert.rejects(factoryCommand(root, ['replan', 'rework']), /without an approved plan/);
});

test('a second harness writes frozen acceptance tests the builder must not change', async (t) => {
  const { root, calls } = setup(t, { tests: { by: 'grok', dir: 'tests/acceptance' } });
  const brief = join(root, '..', `brief-tests-${Date.now()}.md`);
  writeFileSync(brief, 'Make source.txt say implemented.');
  t.after(() => execFileSync('rm', ['-f', brief]));
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    'Tested',
    '--id',
    'tested',
    '--no-push',
  ]);
  const job = loadJob(root, 'tested');
  assert.equal(job.stage, 'committed', JSON.stringify(job.parked));
  assert.equal(job.tests!.dir, 'tests/acceptance/tested');
  assert.match(show(root, `${job.branch}:tests/acceptance/tested/acceptance.txt`), /implemented/);
  const writer = calls().find((call) => /test-writing agent/.test(call.prompt))!;
  assert.equal(writer.name, 'grok');
  assert.equal(writer.unattended, '1');
  const builder = calls().find((call) => call.name === 'claude' && !call.reviewer)!;
  assert.match(builder.prompt, /tests\/acceptance\/tested\/ were written by another agent/);
});

test('changed frozen tests or a test writer outside its folder park the job', async (t) => {
  for (const [mode, pattern] of [
    ['STUB_AGENT', /frozen acceptance tests/],
    ['STUB_TESTS', /outside tests\/acceptance\/guarded/],
  ] as const) {
    const { root } = setup(t, { tests: { by: 'grok', dir: 'tests/acceptance' } });
    const brief = join(root, '..', `brief-guard-${Date.now()}.md`);
    writeFileSync(brief, 'Anything.');
    t.after(() => execFileSync('rm', ['-f', brief]));
    env(t, {
      STUB_AGENT: mode === 'STUB_AGENT' ? 'edit-tests' : undefined,
      STUB_TESTS: mode === 'STUB_TESTS' ? 'outside' : undefined,
    });
    await factoryCommand(root, [
      'run',
      '--brief',
      brief,
      '--title',
      'Guarded',
      '--id',
      'guarded',
      '--no-push',
    ]);
    const job = loadJob(root, 'guarded');
    assert.equal(job.parked!.reason, 'tampered', mode);
    assert.match(job.parked!.detail, pattern);
  }
});

test('metrics and the board report every job, with titles escaped', async (t) => {
  const { root } = setup(t);
  const brief = join(root, '..', `brief-board-${Date.now()}.md`);
  writeFileSync(brief, 'Anything.');
  t.after(() => execFileSync('rm', ['-f', brief]));
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    '<script>x</script>',
    '--id',
    'shipped',
    '--no-push',
  ]);
  env(t, { STUB_AGENT: 'blocked' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief,
    '--title',
    'Blocked',
    '--id',
    'stuck',
    '--no-push',
  ]);
  const numbers = metrics(root);
  assert.equal(numbers.jobs, 2);
  assert.deepEqual(numbers.parked, { 'agent-blocked': 1 });
  assert.equal(numbers.firstGatePassRate, 100);
  assert.equal(numbers.firstReviewBlockRate, 0);
  assert.equal(numbers.parkRate, 50);
  assert.equal(numbers.meanCostPerFinishedUsd, 0.25);
  const html = boardHtml(root);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /Parked \(1\)/);
  assert.match(html, /Done \(1\)/);
  assert.equal(listJobs(root).length, 2);
  await factoryCommand(root, ['board', '--out', join(root, '..', `board-${basename(root)}.html`)]);
  assert.ok(existsSync(join(root, '..', `board-${basename(root)}.html`)));
  t.after(() => execFileSync('rm', ['-f', join(root, '..', `board-${basename(root)}.html`)]));
});

test('an approval made over budget builds once the budget allows', async (t) => {
  const { root, github } = setup(t, { monthlyUsd: 0.05 });
  github.issue(1, 'Planned');
  github.label(1, 'factory', 'maintainer');
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-1').stage, 'awaiting-approval');
  github.label(1, 'factory:approved', 'maintainer');
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-1').stage, 'awaiting-approval');
  // Approved from the terminal, then the budget is raised: the next pass builds it.
  await factoryCommand(root, ['approve', 'issue-1', '--by', 'Maintainer']);
  const file = join(root, '.halvard.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as { factory: Record<string, unknown> };
  config.factory.monthlyUsd = 100;
  writeFileSync(file, JSON.stringify(config));
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-1').stage, 'committed');
});

test('serve survives a broken job file and a failing approval, and starts nothing new', async (t) => {
  const { root, github } = setup(t);
  github.issue(1, 'Planned');
  github.label(1, 'factory', 'maintainer');
  await serveOnce(root);
  // plan.md changed after the plan run: the approval fails, the pass goes on.
  writeFileSync(join(jobDir(root, 'issue-1'), 'plan.md'), 'something else\n');
  github.label(1, 'factory:approved', 'maintainer');
  github.issue(2, 'Small');
  github.label(2, 'factory', 'maintainer');
  github.label(2, 'factory:small', 'maintainer');
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-1').stage, 'awaiting-approval');
  assert.equal(loadJob(root, 'issue-2').stage, 'committed');
  // An unreadable job file stops new work but not the daemon.
  writeFileSync(join(jobDir(root, 'issue-2'), 'job.json'), '{"version": 2}');
  github.issue(3, 'Small');
  github.label(3, 'factory', 'maintainer');
  github.label(3, 'factory:small', 'maintainer');
  await serveOnce(root);
  assert.equal(existsSync(jobDir(root, 'issue-3')), false);
  await assert.rejects(factoryCommand(root, ['replan', 'issue-1']), /unreadable or invalid/);
});

test('an issue already worked under another id is not claimed again', async (t) => {
  const { root, github } = setup(t);
  github.issue(7, 'Custom id');
  await factoryCommand(root, ['plan', '--issue', '7', '--id', 'custom']);
  github.label(7, 'factory', 'maintainer');
  await serveOnce(root);
  assert.deepEqual(
    listJobs(root).map((job) => job.id),
    ['custom'],
  );
});

test('a retry label restarts a job whose runner died mid-build', async (t) => {
  const { root, github } = setup(t);
  github.issue(4, 'Crashed');
  github.label(4, 'factory', 'maintainer');
  github.label(4, 'factory:small', 'maintainer');
  env(t, { STUB_AGENT: 'blocked' });
  await serveOnce(root);
  env(t, { STUB_AGENT: undefined });
  // Leave the job as a runner killed mid-build would: active stage, no live lock.
  const file = join(jobDir(root, 'issue-4'), 'job.json');
  const job = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...job, stage: 'building', parked: null }));
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-4').stage, 'building');
  github.label(4, 'factory:retry', 'maintainer');
  await serveOnce(root);
  assert.equal(loadJob(root, 'issue-4').stage, 'committed');
});

test('a pipe or a link in the frozen tests parks the job as tampered without hanging', async (t) => {
  for (const mode of ['fifo', 'symlink', 'parent-link']) {
    const { root } = setup(t, { tests: { by: 'grok', dir: 'tests/acceptance/' } });
    const brief = join(root, '..', `brief-${mode}-${Date.now()}.md`);
    writeFileSync(brief, 'Anything.');
    t.after(() => execFileSync('rm', ['-f', brief]));
    env(t, { STUB_AGENT: mode });
    await factoryCommand(root, [
      'run',
      '--brief',
      brief,
      '--title',
      'Odd',
      '--id',
      'odd',
      '--no-push',
    ]);
    const job = loadJob(root, 'odd');
    assert.equal(job.parked!.reason, 'tampered', mode);
    assert.match(job.parked!.detail, /frozen acceptance tests/);
    await assert.rejects(
      factoryCommand(root, [
        'run',
        '--brief',
        brief,
        '--title',
        'Next',
        '--id',
        'next',
        '--no-push',
      ]),
      /parked after tampering/,
    );
  }
});
