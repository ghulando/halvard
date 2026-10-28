import type { TestContext } from 'node:test';
import type { ProjectConfig } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { loadProject, git } from '../core/project.ts';
import { eligibleReviewers, reviewerChoices } from '../core/config/reviewers.ts';
import { flowConfig, personalSettings } from '../core/config/workflow.ts';
import { handoffTask, readTask, taskWorkspace } from '../core/workflow/tasks.ts';
import {
  parseVerdict,
  runReview as rawReview,
  reviewSnapshot,
  hasReview,
  reviewCommand,
  reviewKey,
} from '../core/workflow/review.ts';
import { fingerprint, sessionKey, withState } from '../core/state.ts';
import { handle } from '../core/runtime.ts';
import { runGate } from '../core/workflow/gate.ts';
import { fixture, runReview, fakeReviewers, start } from './review-fixture.ts';

for (const [author, choices] of Object.entries(reviewerChoices)) {
  for (const reviewer of choices) {
    test(`${author} to ${reviewer}: two independent subprocess rounds produce a tree-bound receipt`, async (t) => {
      const root = fixture(t);
      const task = start(root, author);
      const log = fakeReviewers(t);
      writeFileSync(join(root, 'source.txt'), 'implementation change');
      const before = fingerprint(root);
      // A preexisting alias at the summary path must be replaced, not written through.
      const workspace = taskWorkspace(root, basename(task.task, '.md'));
      const victim = join(mkdtempSync(join(tmpdir(), 'workflow-victim-')), 'victim.txt');
      t.after(() => rmSync(join(victim, '..'), { recursive: true, force: true }));
      writeFileSync(victim, 'untouched');
      symlinkSync(victim, join(workspace, `${reviewer}-review-round1.md`));
      const first = await runReview(root, task.task, { author, reviewer, round: 1 });
      assert.equal(first.verdict, 'pass');
      assert.equal(readFileSync(victim, 'utf8'), 'untouched');
      assert.equal(lstatSync(join(workspace, `${reviewer}-review-round1.md`)).isFile(), true);
      assert.equal(await hasReview(loadProject(root), task.task, before), true);
      const second = await runReview(root, task.task, { author, reviewer, round: 2 });
      assert.equal(second.verdict, 'pass');
      assert.equal(await hasReview(loadProject(root), task.task, before), true);
      assert.match(
        readFileSync(join(workspace, `${reviewer}-review-round2.md`), 'utf8'),
        /^# Review round 2 by .*\n\nVerdict: pass\./,
      );
      const invocation = JSON.parse(readFileSync(log, 'utf8')) as {
        name: string;
        args: string[];
        input: string;
        cwd: string;
      };
      assert.notEqual(invocation.cwd, root);
      assert.match(invocation.input, /original/);
      if (reviewer === 'claude') {
        assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], '');
      }
      if (reviewer === 'codex') {
        assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'read-only');
      }
      if (reviewer === 'cursor') {
        assert.equal(invocation.args[invocation.args.indexOf('--mode') + 1], 'ask');
      }
      if (reviewer === 'grok') {
        assert.match(
          invocation.args[invocation.args.indexOf('--disallowed-tools') + 1]!,
          /search_replace.*run_terminal_command/,
        );
      }
      assert.equal(fingerprint(root), before);
      writeFileSync(join(root, 'source.txt'), 'changed after review');
      assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), false);
      await assert.rejects(
        runReview(root, task.task, { author, reviewer, round: 2 }),
        /already recorded/,
      );
    });
  }
}

test('a re-review receives the preceding findings and the first review does not', async (t) => {
  const root = fixture(t);
  const task = start(root);
  const log = fakeReviewers(t, 'blocked');
  writeFileSync(join(root, 'source.txt'), 'implementation change');
  const input = () => (JSON.parse(readFileSync(log, 'utf8')) as { input: string }).input;
  await runReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 1 });
  const first = input();
  assert.match(first, /Report every finding you can establish/);
  assert.match(first, /only access to the repository/);
  assert.doesNotMatch(first, /PREVIOUS FINDINGS/);
  await runReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 2 });
  const second = input();
  assert.match(second, /This is a re-review\. Round 1 by claude/);
  assert.match(second, /PREVIOUS FINDINGS \[\{"severity":"blocking","location":"source\.txt:1"/);
  assert.match(second, /"Follow-up:"/);
});

test('an assigned reviewer is the only one accepted and its model reaches the command', async (t) => {
  const root = fixture(t, {
    reviewers: { codex: { reviewer: 'claude', model: 'opus' }, ollama: { model: 'test-model' } },
  });
  const workflow = loadProject(root).config.workflow;
  assert.deepEqual(eligibleReviewers(workflow, 'codex'), ['claude']);
  // Unassigned authors choose only among entries without an assignment.
  assert.deepEqual(eligibleReviewers(workflow, 'claude'), ['ollama']);
  assert.deepEqual(eligibleReviewers(workflow, 'pi'), []);
  const task = start(root);
  const log = fakeReviewers(t);
  writeFileSync(join(root, 'source.txt'), 'implementation change');
  for (const reviewer of ['ollama', 'codex']) {
    await assert.rejects(
      runReview(root, task.task, { author: 'codex', reviewer, round: 1 }),
      /claude is the configured reviewer for codex/,
    );
  }
  const result = await runReview(root, task.task, {
    author: 'codex',
    reviewer: 'claude',
    round: 1,
  });
  assert.equal(result.requestedModel, 'opus');
  const { args } = JSON.parse(readFileSync(log, 'utf8')) as { args: string[] };
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
  assert.match(
    readFileSync(join(task.workspace, 'claude-review-round1.md'), 'utf8'),
    /Author: codex\. Model: opus\./,
  );
});

test('a same-harness reviewer needs an explicit model and never reviews in a pane', async (t) => {
  assert.throws(
    () => flowConfig({ reviewers: { claude: { reviewer: 'claude' } } }),
    /claude reviewing its own work requires an explicit model/,
  );
  const root = fixture(t, { reviewers: { claude: { reviewer: 'claude', model: 'opus' } } });
  const task = start(root, 'claude');
  const log = fakeReviewers(t);
  writeFileSync(join(root, 'source.txt'), 'implementation change');
  const gateSession = sessionKey(root, 'claude', 'review-test');
  await runGate(root, gateSession);
  await assert.rejects(
    rawReview(root, task.task, {
      author: 'claude',
      reviewer: 'claude',
      round: 1,
      gateSession,
      pane: true,
    }),
    /is not independent of author claude/,
  );
  const result = await runReview(root, task.task, {
    author: 'claude',
    reviewer: 'claude',
    round: 1,
  });
  assert.equal(result.verdict, 'pass');
  const { name, args } = JSON.parse(readFileSync(log, 'utf8')) as { name: string; args: string[] };
  assert.equal(name, 'claude');
  assert.equal(args[args.indexOf('--model') + 1], 'opus');
});

test('a re-review must use the reviewer of the preceding round', async (t) => {
  const root = fixture(t);
  const task = start(root);
  fakeReviewers(t, 'blocked');
  writeFileSync(join(root, 'source.txt'), 'implementation change');
  await runReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 1 });
  await assert.rejects(
    runReview(root, task.task, { author: 'codex', reviewer: 'ollama', round: 2 }),
    /round 1 was reviewed by claude; re-review with the same reviewer/,
  );
  const second = await runReview(root, task.task, {
    author: 'codex',
    reviewer: 'claude',
    round: 2,
  });
  assert.equal(second.reviewer, 'claude');
  const paneRoot = fixture(t);
  const paneTask = start(paneRoot);
  const paneSession = sessionKey(paneRoot, 'codex', 'review-test');
  await runGate(paneRoot, paneSession);
  writeFileSync(
    join(paneTask.workspace, 'pi-verdict-round1.json'),
    JSON.stringify({
      verdict: 'blocked',
      standards: 'Checked project rules and concrete source.',
      spec: 'Checked the stated acceptance criteria.',
      findings: [
        { severity: 'blocking', location: 'source.txt:1', problem: 'Wrong', suggestion: 'Fix' },
      ],
    }),
  );
  const pane = (reviewer: string, round: number) =>
    rawReview(paneRoot, paneTask.task, {
      author: 'codex',
      reviewer,
      round,
      gateSession: paneSession,
      pane: true,
    });
  await pane('pi', 1);
  await assert.rejects(pane('claude', 2), /round 1 was reviewed by pi/);
});

test('reviewer assignments are validated and a project assignment replaces a personal one', (t) => {
  const bad: [unknown, RegExp][] = [
    [{ ollama: { reviewer: 'claude' } }, /reviewer assignment for unknown author ollama/],
    [{ claude: { reviewer: 'pi' } }, /invalid reviewer for author claude/],
    [{ pi: { reviewer: 'ollama', model: 'm' } }, /ollama cannot review work by pi/],
    [{ claude: { reviewer: 'codex', transport: 'pi' } }, /invalid codex reviewer settings/],
    [{ claude: { reviewer: 'codex', command: 'evil' } }, /invalid codex reviewer settings/],
    [{ codex: { reviewer: 'ollama' } }, /Ollama requires an explicit model/],
  ];
  for (const [reviewers, error] of bad) {
    assert.throws(() => flowConfig({ reviewers }), error);
  }
  flowConfig({ reviewers: { codex: { reviewer: 'ollama', model: 'm', transport: 'pi' } } });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-personal-')));
  const previous = process.env.HALVARD_HOME;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.HALVARD_HOME;
    } else {
      process.env.HALVARD_HOME = previous;
    }
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HALVARD_HOME = home;
  writeFileSync(
    join(home, 'personal.json'),
    JSON.stringify({
      reviewers: { claude: { reviewer: 'codex' }, pi: { reviewer: 'codex' } },
    }),
  );
  const root = fixture(t, { reviewers: { claude: { reviewer: 'ollama', model: 'm' } } });
  const workflow = loadProject(root).config.workflow;
  assert.deepEqual(eligibleReviewers(workflow, 'claude'), ['ollama']);
  assert.deepEqual(eligibleReviewers(workflow, 'pi'), ['codex']);
});

test('a pane review records only the independent reviewer own verdict file', async (t) => {
  const root = fixture(t);
  const task = start(root);
  const gateSession = sessionKey(root, 'codex', 'review-test');
  await runGate(root, gateSession);
  const review = (reviewer: string) =>
    rawReview(root, task.task, { author: 'codex', reviewer, round: 1, gateSession, pane: true });
  for (const reviewer of ['codex', 'ollama']) {
    await assert.rejects(review(reviewer), /is not independent of author codex/);
  }
  await assert.rejects(review('pi'), /pane reviewer has not written/);
  const verdict = join(task.workspace, 'pi-verdict-round1.json');
  const elsewhere = join(root, 'elsewhere.json');
  symlinkSync(elsewhere, verdict);
  await assert.rejects(review('pi'), /pane reviewer has not written/);
  rmSync(verdict);
  writeFileSync(
    verdict,
    JSON.stringify({
      verdict: 'pass',
      standards: 'Checked project rules and concrete source.',
      spec: 'Checked the stated acceptance criteria.',
      findings: [],
    }),
  );
  const result = await review('pi');
  assert.equal(result.verdict, 'pass');
  assert.equal(result.transport, 'pane');
  assert.equal(result.model, 'pane session');
  assert.ok(existsSync(join(task.workspace, 'pi-review-round1.md')));
  assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), true);
});

test('completion uses a passing current-tree review from either round and rejects blocked or stale reviews', async (t) => {
  for (const scenario of ['pass', 'blocked', 'changed', 'fixed', 'later blocked']) {
    await t.test(scenario, async (t) => {
      const root = fixture(t);
      const task = start(root);
      const reviewer = 'claude';
      fakeReviewers(t, scenario === 'blocked' || scenario === 'fixed' ? 'blocked' : 'pass');
      const first = await runReview(root, task.task, { author: 'codex', reviewer, round: 1 });
      assert.equal(
        first.verdict,
        scenario === 'blocked' || scenario === 'fixed' ? 'blocked' : 'pass',
      );
      if (scenario === 'changed' || scenario === 'fixed') {
        writeFileSync(join(root, 'source.txt'), 'changed after first review');
      }
      if (scenario === 'fixed' || scenario === 'later blocked') {
        fakeReviewers(t, scenario === 'fixed' ? 'pass' : 'blocked');
        const second = await runReview(root, task.task, { author: 'codex', reviewer, round: 2 });
        assert.equal(second.verdict, scenario === 'fixed' ? 'pass' : 'blocked');
      }
      const accepted = scenario === 'pass' || scenario === 'fixed';
      const project = loadProject(root);
      assert.equal(await hasReview(project, task.task, fingerprint(root)), accepted);
      const metadata = readTask(project, task.task).metadata;
      const receipt = await withState(
        root,
        reviewKey(readTask(project, task.task)),
        (state) => state.pass,
      );
      if (accepted) assert.equal(receipt!.base, metadata.base);
      if (scenario === 'blocked' || scenario === 'later blocked') assert.equal(receipt, null);
      const key = sessionKey(root, 'codex', 'completion-test');
      // A fresh gate isolates review rejection from a stale gate, including after a tree change.
      await runGate(root, key);
      const content = readFileSync(join(root, task.task), 'utf8').replace(
        '**Status:** open.',
        '**Status:** done.',
      );
      const result = await handle('codex', {
        cwd: root,
        session_id: 'completion-test',
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: task.task, content },
      });
      assert.equal(result.decision, accepted ? undefined : 'deny');
      if (!accepted) assert.match(result.reason!, /passing.*review/);
    });
  }
});

test('review snapshot contains branch, staged, unstaged and untracked changes without index mutation', (t) => {
  const root = fixture(t);
  const created = start(root);
  const task = readTask(loadProject(root), created.task);
  writeFileSync(join(root, 'source.txt'), 'staged version');
  git(root, ['add', 'source.txt']);
  writeFileSync(join(root, 'source.txt'), 'unstaged final version');
  writeFileSync(join(root, 'new.txt'), 'untracked evidence');
  const before = fingerprint(root);
  const snapshot = reviewSnapshot(loadProject(root), task);
  assert.match(snapshot!, /unstaged final version/);
  assert.match(snapshot!, /untracked evidence/);
  assert.match(snapshot!, /-original/);
  assert.equal(fingerprint(root), before);
});

test('nonzero reviewer exits report only a bounded trimmed stderr tail and grant no receipt', async (t) => {
  for (const [name, stderr, expected] of [
    ['diagnostic', '  reviewer authentication failed\n', 'reviewer authentication failed'],
    [
      'bounded tail',
      'discarded prefix\n' + 'x'.repeat(1978) + '\nAUTHENTICATION_ERROR\n',
      'x'.repeat(1978) + '\nAUTHENTICATION_ERROR',
    ],
    ['empty stderr', '', ''],
    ['whitespace stderr', ' \n\t ', ''],
  ]) {
    await t.test(name!, async (t) => {
      const root = fixture(t);
      const task = start(root);
      const log = fakeReviewers(t);
      writeFileSync(
        join(log, '..', 'claude'),
        `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(1));
});
`,
      );
      const prefix = 'reviewer exited 1; no review receipt recorded';
      await assert.rejects(
        runReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 1 }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message, expected ? `${prefix}: ${expected}` : prefix);
          return true;
        },
      );
      assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), false);
    });
  }
});

test('failed, malformed, timed-out, and concurrently mutated reviews never grant a receipt', async (t) => {
  for (const mode of ['malformed', 'timeout', 'mutate']) {
    await t.test(mode, async (t) => {
      const root = fixture(t, { reviewTimeout: 1 });
      const task = start(root);
      if (mode === 'mutate') writeFileSync(join(root, 'source.txt'), `MUTATE_ROOT=${root}\n`);
      fakeReviewers(t, mode);
      await assert.rejects(
        runReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 1 }),
      );
      assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), false);
    });
  }
});

test('scratch creation and chmod failures clear running review state and allow retry', async (t) => {
  for (const method of ['mkdtempSync', 'chmodSync'] as const) {
    await t.test(method, async (t) => {
      const root = fixture(t);
      const task = start(root);
      const key = reviewKey(readTask(loadProject(root), task.task));
      fakeReviewers(t);
      const original = fs[method];
      const failure = new Error(`injected ${method} failure`);
      let scratch: fs.PathLike | undefined;
      t.after(() => {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      });
      const mock = t.mock.method(
        fs,
        method,
        (...args: [fs.PathLike, (fs.MakeDirectoryOptions | fs.Mode)?]) => {
          if (String(args[0]).includes('workflow-review-')) {
            if (method === 'chmodSync') scratch = args[0];
            throw failure;
          }
          return (
            original as (...args: [fs.PathLike, (fs.MakeDirectoryOptions | fs.Mode)?]) => unknown
          )(...args);
        },
      );
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          runReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 1 }),
          (error) => error === failure,
        );
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
      }
      // Leaving scratch setup outside finally strands a running marker before any reviewer starts.
      assert.equal(await withState(root, key, (state) => state.running), null);
      assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), false);
      if (scratch) assert.equal(existsSync(scratch), false);
      assert.equal(
        (await runReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 1 }))
          .verdict,
        'pass',
      );
    });
  }
});

test('self-review, wrong author, re-review first, and contradictory verdicts fail closed', async (t) => {
  const root = fixture(t);
  const task = start(root);
  await assert.rejects(
    runReview(root, task.task, { author: 'codex', reviewer: 'codex', round: 1 }),
    /independent/,
  );
  await assert.rejects(
    runReview(root, task.task, { author: 'pi', reviewer: 'claude', round: 1 }),
    /author/,
  );
  await assert.rejects(
    runReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 2 }),
    /first/,
  );
  assert.throws(
    () =>
      parseVerdict(
        JSON.stringify({
          verdict: 'pass',
          standards: 'rules',
          spec: 'spec',
          findings: [{ severity: 'blocking', location: 'x:1', problem: 'bug', suggestion: 'fix' }],
        }),
      ),
    /unresolved/,
  );
  assert.throws(() => parseVerdict('{"verdict":"pass","findings":[]}'), /standards/);
});

// An Ollama stand-in that returns whatever verdict the test sets and keeps the last prompt.
function scriptedReviewer(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-scripted-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  writeFileSync(
    join(dir, 'ollama'),
    `#!${process.execPath}
const fs = require('fs');
let input = '';
process.stdin.on('data', (bytes) => (input += bytes));
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(join(dir, 'prompt.txt'))}, input);
  process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, 'verdict.json'))}, 'utf8'));
});
`,
  );
  chmodSync(join(dir, 'ollama'), 0o755);
  return {
    returns: (verdict: string, findings: Record<string, string>[]) =>
      writeFileSync(
        join(dir, 'verdict.json'),
        JSON.stringify({ verdict, standards: 'Walked the rules.', spec: 'Checked.', findings }),
      ),
    prompt: () => readFileSync(join(dir, 'prompt.txt'), 'utf8'),
  };
}

function defer(root: string, task: string, deferrals: Record<string, unknown>[]) {
  const file = join(root, '.halvard.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as { workflow: Record<string, unknown> };
  config.workflow.reviewDeferrals = { [task]: deferrals };
  writeFileSync(file, JSON.stringify(config));
}

const finding = (severity: string, problem: string) => ({
  severity,
  location: 'source.txt:1',
  problem,
  suggestion: 'Fix it.',
});

test('a user-approved deferral of a should-fix finding lets the re-review pass', async (t) => {
  const root = fixture(t);
  const task = start(root);
  const reviewer = scriptedReviewer(t);
  writeFileSync(join(root, 'source.txt'), 'implementation change');
  reviewer.returns('blocked', [finding('should-fix', 'Missing retry.'), finding('nit', 'Name.')]);
  const args = { author: 'codex', reviewer: 'ollama' };
  assert.equal((await runReview(root, task.task, { ...args, round: 1 })).verdict, 'blocked');
  const workspace = taskWorkspace(root, basename(task.task, '.md'));
  assert.match(
    readFileSync(join(workspace, 'ollama-review-round1.md'), 'utf8'),
    /\n1\. should-fix at source\.txt:1: Missing retry\. .*\n2\. nit at /,
  );
  defer(root, task.task, [
    { finding: 'round1#1', approvedBy: 'Andranik', reason: 'Moved to the retry task.' },
  ]);
  // A should-fix deferral cannot excuse a blocking finding or cover two findings.
  reviewer.returns('pass', [{ ...finding('blocking', 'Unrelated crash.'), deferral: 'round1#1' }]);
  await assert.rejects(
    runReview(root, task.task, { ...args, round: 2 }),
    /cites deferral round1#1 at another severity/,
  );
  reviewer.returns('pass', [{ ...finding('should-fix', 'Unrelated leak.'), deferral: 'round1#1' }]);
  await assert.rejects(
    runReview(root, task.task, { ...args, round: 2 }),
    /cites deferral round1#1 but is not the deferred finding/,
  );
  reviewer.returns('pass', [
    { ...finding('should-fix', 'Missing retry.'), deferral: 'round1#1' },
    { ...finding('should-fix', 'Missing retry.'), deferral: 'round1#1' },
  ]);
  await assert.rejects(
    runReview(root, task.task, { ...args, round: 2 }),
    /cites one deferral for more than one finding/,
  );
  assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), false);
  reviewer.returns('pass', [{ ...finding('should-fix', 'Missing retry.'), deferral: 'round1#1' }]);
  const second = await runReview(root, task.task, { ...args, round: 2 });
  assert.equal(second.verdict, 'pass');
  assert.deepEqual(second.deferrals, [
    {
      finding: 'round1#1',
      approvedBy: 'Andranik',
      reason: 'Moved to the retry task.',
      severity: 'should-fix',
      location: 'source.txt:1',
      problem: 'Missing retry.',
    },
  ]);
  assert.match(reviewer.prompt(), /DEFERRED FINDINGS[^]*"finding":"round1#1"/);
  assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), true);
  assert.match(
    readFileSync(join(workspace, 'ollama-review-round2.md'), 'utf8'),
    /1\. should-fix \(deferred as round1#1\)[^]*## Deferred\n\n- round1#1, should-fix, approved by Andranik: Moved to the retry task\.\n$/,
  );
});

test('a deferred blocking finding still blocks unless the user records an override', async (t) => {
  const root = fixture(t);
  const task = start(root);
  const reviewer = scriptedReviewer(t);
  writeFileSync(join(root, 'source.txt'), 'implementation change');
  reviewer.returns('blocked', [finding('blocking', 'Data loss.')]);
  const args = { author: 'codex', reviewer: 'ollama' };
  await runReview(root, task.task, { ...args, round: 1 });
  defer(root, task.task, [{ finding: 'round1#1', approvedBy: 'Andranik', reason: 'Later.' }]);
  reviewer.returns('pass', [{ ...finding('blocking', 'Data loss.'), deferral: 'round1#1' }]);
  await assert.rejects(
    runReview(root, task.task, { ...args, round: 2 }),
    /cites a deferral the user has not approved/,
  );
  assert.doesNotMatch(reviewer.prompt(), /DEFERRED FINDINGS/);
  assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), false);
  defer(root, task.task, [
    { finding: 'round1#1', approvedBy: 'Andranik', reason: 'Later.', override: true },
  ]);
  // An overridden blocking deferral covers only its own finding.
  reviewer.returns('pass', [{ ...finding('blocking', 'Other crash.'), deferral: 'round1#1' }]);
  await assert.rejects(
    runReview(root, task.task, { ...args, round: 2 }),
    /is not the deferred finding/,
  );
  reviewer.returns('pass', [{ ...finding('blocking', 'Data loss.'), deferral: 'round1#1' }]);
  const second = await runReview(root, task.task, { ...args, round: 2 });
  assert.equal(second.verdict, 'pass');
  assert.equal(second.deferrals![0]!.override, true);
  assert.equal(second.deferrals![0]!.severity, 'blocking');
});

test('deferrals must name a recorded finding and stay out of personal settings', async (t) => {
  for (const deferral of [
    { finding: 'round1', approvedBy: 'A', reason: 'r' },
    { finding: 'round1#0', approvedBy: 'A', reason: 'r' },
    { finding: 'round1#1', approvedBy: ' ', reason: 'r' },
    { finding: 'round1#1', approvedBy: 'A', reason: 'r', override: false },
    { finding: 'round1#1', approvedBy: 'A', reason: 'r', extra: 1 },
  ]) {
    assert.throws(
      () => flowConfig({ reviewDeferrals: { 'docs/tasks/a.md': [deferral] } }),
      /invalid task review deferral/,
      JSON.stringify(deferral),
    );
  }
  const twice = { finding: 'round1#1', approvedBy: 'A', reason: 'r' };
  assert.throws(
    () => flowConfig({ reviewDeferrals: { 'docs/tasks/a.md': [twice, twice] } }),
    /invalid task review deferral/,
  );
  assert.throws(
    () => personalSettings({ reviewDeferrals: { 'docs/tasks/a.md': [twice] } }),
    /belong in project configuration/,
  );
  const root = fixture(t);
  const task = start(root);
  scriptedReviewer(t).returns('blocked', [finding('should-fix', 'Missing retry.')]);
  writeFileSync(join(root, 'source.txt'), 'implementation change');
  const args = { author: 'codex', reviewer: 'ollama' };
  await runReview(root, task.task, { ...args, round: 1 });
  defer(root, task.task, [{ finding: 'round1#2', approvedBy: 'A', reason: 'r' }]);
  await assert.rejects(
    runReview(root, task.task, { ...args, round: 2 }),
    /deferral round1#2 names no recorded review finding/,
  );
});

for (const harness of ['pi', 'codex', 'claude']) {
  test(`${harness}: done requires review plus gate; handoff stales review`, async (t) => {
    const root = fixture(t);
    const task = start(root, harness);
    const key = sessionKey(root, harness, 'pack-test');
    const reviewer = reviewerChoices[harness]![0]!;
    fakeReviewers(t);
    const content = readFileSync(join(root, task.task), 'utf8');
    const done = content.replace('**Status:** open.', '**Status:** done.');
    const payload = {
      cwd: root,
      session_id: 'pack-test',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: task.task, content: done },
    };
    assert.equal((await handle(harness, payload)).decision, 'deny');
    await runGate(root, key);
    assert.equal((await handle(harness, payload)).decision, 'deny');
    await runReview(root, task.task, { author: harness, reviewer, round: 1 });
    await runReview(root, task.task, { author: harness, reviewer, round: 2 });
    await runGate(root, key);
    assert.equal(
      (
        await handle(harness, {
          ...payload,
          tool_input: {
            ...payload.tool_input,
            content: done.replace('Build example', 'Different scope'),
          },
        })
      ).decision,
      'deny',
    );
    assert.equal((await handle(harness, payload)).decision, undefined);
    handoffTask(root, task.task, harness === 'codex' ? 'claude' : 'codex');
    assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), false);
  });
}

test('explicit Pi Ollama transport disables tools and all discovery', () => {
  const command = reviewCommand(
    'ollama',
    { model: 'example:cloud', transport: 'pi' },
    '/tmp/output',
    '/tmp/input.md',
  );
  assert.equal(command[0], 'pi');
  for (const option of ['--no-tools', '--no-extensions', '--no-skills', '--no-context-files']) {
    assert.ok(command.includes(option));
  }
  assert.equal(command.at(-1), '@/tmp/input.md');
  assert.equal(command[command.indexOf('--model') + 1], 'example:cloud');
});

test('explicit generated exclusions are disclosed and still stale receipts', (t) => {
  const root = fixture(t, { reviewExclude: ['generated/**'] });
  const created = start(root);
  mkdirSync(join(root, 'generated'));
  writeFileSync(join(root, 'generated/large.json'), 'generated-content');
  writeFileSync(join(root, 'source.txt'), 'reviewed-source');
  const before = fingerprint(root);
  const snapshot = reviewSnapshot(loadProject(root), readTask(loadProject(root), created.task));
  assert.match(snapshot!, /generated/);
  assert.doesNotMatch(snapshot!, /generated-content/);
  assert.match(snapshot!, /reviewed-source/);
  writeFileSync(join(root, 'generated/large.json'), 'changed-generated-content');
  assert.notEqual(fingerprint(root), before);
});

test('review cannot start with a missing or stale gate receipt', async (t) => {
  const root = fixture(t);
  const task = start(root);
  await assert.rejects(
    rawReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 1 }),
    /gate session/,
  );
  const gateSession = sessionKey(root, 'codex', 'gate-required');
  await runGate(root, gateSession);
  writeFileSync(join(root, 'source.txt'), 'changed after gate');
  await assert.rejects(
    rawReview(root, task.task, { author: 'codex', reviewer: 'claude', round: 1, gateSession }),
    /full session gate/,
  );
});

test('review snapshot includes required bundled skills outside the repository', (t) => {
  const root = fixture(t);
  const created = start(root);
  const config = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8')) as ProjectConfig;
  config.requiredSkills = ['halvard'];
  writeFileSync(join(root, '.halvard.json'), JSON.stringify(config));
  const project = loadProject(root);
  const snapshot = reviewSnapshot(project, readTask(project, created.task));
  assert.match(snapshot!, /name: halvard/);
  assert.match(snapshot!, /Never approve your own workflow request/);
});

test('review context includes unchanged dependencies and required project skills', (t) => {
  const root = fixture(t, { reviewContext: ['source.txt'] });
  const created = start(root);
  mkdirSync(join(root, '.agents/skills/local-review'), { recursive: true });
  writeFileSync(
    join(root, '.agents/skills/local-review/SKILL.md'),
    '---\nname: local-review\ndescription: Project review\n---\nCheck actual acceptance evidence.\n',
  );
  const config = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8')) as ProjectConfig;
  config.requiredSkills = ['local-review'];
  writeFileSync(join(root, '.halvard.json'), JSON.stringify(config));
  const snapshot = reviewSnapshot(loadProject(root), readTask(loadProject(root), created.task));
  assert.match(snapshot!, /FILE source.txt\noriginal/);
  assert.match(snapshot!, /Check actual acceptance evidence/);
});

test('review survives native pre/post hooks', async (t) => {
  fakeReviewers(t);
  for (const author of ['pi', 'codex', 'claude']) {
    const root = fixture(t);
    const task = start(root, author);
    const key = sessionKey(root, author, 'review-test');
    const reviewer = author === 'claude' ? 'codex' : 'claude';
    const { pluginRoot, quote } = await import('../core/shared/plugin.ts');
    const command = `node ${quote(pluginRoot + 'bin/halvard.ts')} review ${task.task} --author ${author} --reviewer ${reviewer} --round 1 --gate-session ${key}`;
    const payload = {
      cwd: root,
      session_id: 'review-test',
      tool_name: 'Bash',
      tool_input: { command },
    };
    const config = JSON.parse(
      readFileSync(join(root, '.halvard.json')).toString('utf8'),
    ) as ProjectConfig;
    config.review = ['scripts/review.sh'];
    writeFileSync(join(root, '.halvard.json'), JSON.stringify(config));
    const wrapper = {
      ...payload,
      tool_input: {
        command: `REVIEW_GATE_SESSION=${key} scripts/review.sh ${task.task} ${author} ${reviewer} 1`,
      },
    };
    await runGate(root, key);
    assert.equal(
      (await handle(author, { ...payload, hook_event_name: 'PreToolUse' })).decision,
      undefined,
    );
    assert.equal(
      (await handle(author, { ...wrapper, hook_event_name: 'PreToolUse' })).decision,
      undefined,
    );
    assert.equal(
      (await rawReview(root, task.task, { author, reviewer, round: 1, gateSession: key })).verdict,
      'pass',
    );
    await handle(author, { ...wrapper, hook_event_name: 'PostToolUse' });
    await handle(author, { ...payload, hook_event_name: 'PostToolUse' });
    assert.equal(
      (await rawReview(root, task.task, { author, reviewer, round: 2, gateSession: key })).verdict,
      'pass',
    );
  }
});

test('additional rounds require an exact-task exception and retain preceding reports', async (t) => {
  fakeReviewers(t);
  const root = fixture(t);
  const task = start(root);
  const args = { author: 'codex', reviewer: 'claude' };
  await assert.rejects(runReview(root, task.task, { ...args, round: 3 }), /configured task limit/);
  const file = join(root, '.halvard.json');
  const config = JSON.parse(readFileSync(file).toString('utf8')) as ProjectConfig;
  config.workflow.reviewExceptions = {
    [task.task]: { maxRound: 3, reason: 'Explicit test user authorization' },
  };
  writeFileSync(file, JSON.stringify(config));
  await assert.rejects(runReview(root, task.task, { ...args, round: 3 }), /preceding review/);
  await runReview(root, task.task, { ...args, round: 1 });
  await runReview(root, task.task, { ...args, round: 2 });
  const extra = await runReview(root, task.task, { ...args, round: 3 });
  assert.equal(extra.authorization, 'Explicit test user authorization');
  const { withState } = await import('../core/state.ts');
  const { reviewKey } = await import('../core/workflow/review.ts');
  const state = await withState(root, reviewKey(readTask(loadProject(root), task.task)), (s) => s);
  assert.equal(state.first!.round, 1);
  assert.equal(state.second!.round, 2);
  assert.equal(state.extraReviews![0]!.round, 3);
  assert.equal(await hasReview(loadProject(root), task.task, fingerprint(root)), true);
  await assert.rejects(runReview(root, task.task, { ...args, round: 3 }), /already recorded/);
  await assert.rejects(runReview(root, task.task, { ...args, round: 4 }), /configured task limit/);
  for (const entry of [
    { maxRound: 3.5, reason: 'x' },
    { maxRound: 3, reason: '' },
    { maxRound: 11, reason: 'x' },
  ]) {
    assert.throws(() => flowConfig({ reviewExceptions: { 'task.md': entry } }), /exception/);
  }
  assert.throws(
    () => flowConfig({ reviewExceptions: { '../escape': { maxRound: 3, reason: 'x' } } }),
    /exception/,
  );
});
