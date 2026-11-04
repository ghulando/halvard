import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pluginRoot, quote } from '../core/shared/plugin.ts';
import { sessionKey } from '../core/state.ts';
import { hookOutput } from '../core/harnesses/index.ts';
import { fixture, call, writeInput } from './hook-fixture.ts';

test('Codex explicit approval is one-use, operation-bound, session-bound and tree-bound', async (t) => {
  const root = fixture(t);
  const tool = 'apply_patch';
  const input = {
    command: '*** Begin Patch\n*** Add File: .codex/policy.txt\n+policy\n*** End Patch',
  };
  const requested = await call(root, 'codex', 'PreToolUse', tool, input);
  assert.equal(requested.decision, 'ask');
  assert.equal(
    hookOutput('codex', 'PreToolUse', requested).hookSpecificOutput!.permissionDecision,
    'deny',
  );
  assert.equal(
    hookOutput('claude', 'PreToolUse', requested).hookSpecificOutput!.permissionDecision,
    'ask',
  );
  await call(root, 'codex', 'UserPromptSubmit', undefined, undefined, {
    prompt: `approve halvard ${requested.request!}`,
  });
  assert.equal(
    (await call(root, 'codex', 'PreToolUse', tool, input, { session_id: 'another' })).decision,
    'ask',
  );
  assert.equal((await call(root, 'codex', 'PreToolUse', tool, input)).decision, undefined);
  assert.equal((await call(root, 'codex', 'PreToolUse', tool, input)).decision, 'ask');
  const fresh = await call(root, 'codex', 'PreToolUse', tool, input);
  writeFileSync(join(root, 'source.txt'), 'changed');
  assert.match(
    (
      await call(root, 'codex', 'UserPromptSubmit', undefined, undefined, {
        prompt: `approve halvard ${fresh.request!}`,
      })
    ).context!,
    /stale/,
  );
  assert.equal((await call(root, 'codex', 'PreToolUse', tool, input)).decision, 'ask');
});

test('checkout exemption validates branches in the shell execution repository', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['add', 'source.txt'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  execFileSync('git', ['branch', 'source.txt'], { cwd: root });
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const nested = join(root, 'nested');
  mkdirSync(nested);
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: nested });
  writeFileSync(join(nested, 'source.txt'), 'nested original\n');
  execFileSync('git', ['add', 'source.txt'], { cwd: nested });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: nested },
  );
  writeFileSync(join(nested, 'source.txt'), 'nested dirty\n');
  execFileSync('git', ['branch', 'feature/nested'], { cwd: nested });
  for (const harness of ['pi', 'claude', 'codex']) {
    const result = await call(root, harness, 'PreToolUse', 'Bash', {
      command: 'git checkout source.txt',
      workdir: nested,
    });
    assert.equal(result.decision, 'deny', harness);
    assert.equal(readFileSync(join(nested, 'source.txt'), 'utf8'), 'nested dirty\n');
    assert.equal(
      (
        await call(root, harness, 'PreToolUse', 'Bash', {
          command: 'git checkout feature/nested',
          workdir: nested,
        })
      ).decision,
      undefined,
    );
  }
});

test('Claude explicit fallback authorizes the exact retry after native ask', async (t) => {
  const root = fixture(t);
  const input = { file_path: '.claude/policy.txt', content: 'policy' };
  // Hashing the request before revision invalidation makes this retry ask again.
  const requested = await call(root, 'claude', 'PreToolUse', 'Write', input);
  await call(root, 'claude', 'UserPromptSubmit', undefined, undefined, {
    prompt: `approve halvard ${requested.request!}`,
  });
  assert.equal((await call(root, 'claude', 'PreToolUse', 'Write', input)).decision, undefined);
  assert.equal((await call(root, 'claude', 'PreToolUse', 'Write', input)).decision, 'ask');
});

test('the workflow runner task commands work on protected branches', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const runner = `node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))}`;
  for (const command of [
    `${runner} task-start login 'Add login' --author claude --fix`,
    `${runner} task-start login 'Add login' --author codex --small --fix`,
    `${runner} task-resume docs/tasks/task.md`,
    `${runner} review-status docs/tasks/task.md`,
    `${runner} history-plan --harness all`,
    `${runner} history-digest --harness claude`,
    `${runner} retro-events login`,
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      undefined,
      command,
    );
  }
  for (const command of [
    `${runner} task-handoff docs/tasks/task.md --author codex`,
    `${runner} task-start login 'Add login' --author claude --apply`,
    `${runner} task-start login 'Add login' --author claude --fix --fix`,
    `${runner} install-user --apply`,
    `${runner} retro-events login extra`,
    `node other.mjs task-start login 'Add login' --author claude`,
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      'deny',
      command,
    );
  }
  // Starting a task writes files, so a read-only session still refuses it.
  assert.equal(
    (
      await call(
        root,
        'claude',
        'PreToolUse',
        'Bash',
        { command: `${runner} task-start login 'Add login' --author claude` },
        { permission_mode: 'plan' },
      )
    ).decision,
    'deny',
  );
  assert.equal(
    (
      await call(
        root,
        'claude',
        'PreToolUse',
        'Bash',
        { command: `${runner} task-resume docs/tasks/task.md` },
        { permission_mode: 'plan' },
      )
    ).decision,
    undefined,
  );
  assert.equal(
    (
      await call(
        root,
        'claude',
        'PreToolUse',
        'Bash',
        { command: `${runner} history-clean /tmp/plan.json --confirm DELETE` },
        { permission_mode: 'plan' },
      )
    ).decision,
    'deny',
  );
});

test('an agent can leave a protected branch through cd and git -C spellings only', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const other = mkdtempSync(join(tmpdir(), 'workflow-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: other });
  const runner = `node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))}`;
  const start = `${runner} task-start login 'Add login' --author claude --fix --small`;
  // The fixture's files are untracked, which a new branch carries along unharmed.
  for (const command of [
    `cd ${quote(root)} && ${start}`,
    `git -C ${quote(root)} switch -c fix/login`,
    `git -C ${quote(root)} checkout -b feature/login`,
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      undefined,
      command,
    );
  }
  for (const command of [
    `cd ${quote(other)} && ${start}`,
    `cd ${quote(root)} && ${start} --apply`,
    `cd ${quote(root)} && touch new.txt`,
    `git -C ${quote(other)} switch -c fix/login`,
    `git -C ${quote(root)} checkout source.txt`,
    `git -C ${quote(root)} commit -m change`,
    `git -C ${quote(root)} switch -c fix/login && touch new.txt`,
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      'deny',
      command,
    );
  }
  assert.equal(
    (await call(root, 'claude', 'PreToolUse', 'Write', { file_path: 'new.txt', content: 'x' }))
      .decision,
    'deny',
  );
});

test('a protected branch allows reads anywhere, writes outside the project and trusted test runs', async (t) => {
  const root = fixture(t, {
    readCommands: [
      {
        prefix: ['uv', 'run', 'pytest'],
        options: { '-q': 'flag' },
        positionals: { min: 0, max: 0 },
      },
    ],
  });
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-other-')));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  writeFileSync(join(other, 'SKILL.md'), 'skill\n');
  for (const command of [
    `cd ${quote(other)} && cat SKILL.md`,
    `echo '- [Note](note.md) - hook' >> ${quote(other)}/MEMORY.md`,
    `cd ${quote(realpathSync(root))} && git switch -c fix/login`,
    'uv run pytest -q',
  ]) {
    assert.equal(
      (await call(root, 'claude', 'PreToolUse', 'Bash', { command })).decision,
      undefined,
      command,
    );
  }
  for (const command of [
    `echo note >> ${quote(other)}/MEMORY.md`,
    `cd ${quote(other)} && cat SKILL.md`,
  ]) {
    assert.equal(
      (await call(root, 'pi', 'PreToolUse', 'Bash', { command }, { permission_mode: 'plan' }))
        .decision,
      undefined,
      command,
    );
  }
  symlinkSync(realpathSync(root), join(other, 'into'));
  symlinkSync(join(realpathSync(root), 'docs'), join(other, 'sub'));
  symlinkSync(join(realpathSync(root), 'created.md'), join(other, 'dangling'));
  execFileSync('git', ['init', '-q', join(root, 'vendor')]);
  const workspace = realpathSync(process.env.HALVARD_WORKSPACE!);
  for (const command of [
    'echo note >> source.txt',
    `cd ${quote(other)} | echo note > source.txt`,
    `cd ${quote(other)} && true & echo note > source.txt`,
    `cd ${quote(other)} && git status`,
    'uv run pytest -q --cache-clear',
    `echo note > ${quote(other)}/into/source.txt`,
    `echo note > ${quote(other)}/dangling`,
    `echo note > ${quote(other)}/sub/../source.txt`,
    `echo note > ${quote(workspace)}/login/claude-notes.md`,
    'cd vendor && uv run pytest -q',
  ]) {
    for (const extra of [{}, { permission_mode: 'plan' }]) {
      assert.equal(
        (await call(root, 'claude', 'PreToolUse', 'Bash', { command }, extra)).decision,
        'deny',
        command,
      );
    }
  }
  assert.match(
    (await call(root, 'claude', 'PreToolUse', 'Bash', { command: 'uv run cargoo-graph query x' }))
      .reason!,
    /readCommands/,
  );
});

test('history runners work from protected-branch subdirectories without widening other runners', async (t) => {
  for (const harness of ['claude', 'codex', 'pi']) {
    {
      const root = fixture(t);
      execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
      const sub = join(root, 'sub');
      mkdirSync(sub);
      const runner = `node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))}`;
      for (const cwd of [root, sub]) {
        for (const verb of ['history-plan', 'history-digest']) {
          assert.equal(
            (
              await call(
                root,
                harness,
                'PreToolUse',
                'Bash',
                { command: `${runner} ${verb} --harness all` },
                { cwd, permission_mode: 'plan' },
              )
            ).decision,
            undefined,
            `${harness} ${verb} ${cwd}`,
          );
        }
        const command = `${runner} history-clean /tmp/plan.json --confirm DELETE`;
        assert.equal(
          (await call(root, harness, 'PreToolUse', 'Bash', { command }, { cwd })).decision,
          'ask',
          `${harness} ${cwd}`,
        );
        assert.equal(
          (
            await call(
              root,
              harness,
              'PreToolUse',
              'Bash',
              { command },
              { cwd, permission_mode: 'plan' },
            )
          ).decision,
          'deny',
        );
        const previous = process.env.HALVARD_REVIEW;
        process.env.HALVARD_REVIEW = '1';
        try {
          assert.equal(
            (await call(root, harness, 'PreToolUse', 'Bash', { command }, { cwd })).decision,
            'deny',
          );
        } finally {
          if (previous === undefined) {
            delete process.env.HALVARD_REVIEW;
          } else {
            process.env.HALVARD_REVIEW = previous;
          }
        }
      }
      assert.equal(
        (
          await call(
            root,
            harness,
            'PreToolUse',
            'Bash',
            { command: `${runner} setup .` },
            { cwd: sub, permission_mode: 'plan' },
          )
        ).decision,
        'deny',
      );
      assert.equal(
        (
          await call(
            root,
            harness,
            'PreToolUse',
            'Bash',
            { command: `${runner} setup .`, workdir: join(root, 'missing') },
            { permission_mode: 'plan' },
          )
        ).decision,
        'deny',
      );
      const key = sessionKey(root, harness, 'test-session');
      assert.equal(
        (
          await call(
            root,
            harness,
            'PreToolUse',
            'Bash',
            { command: `${runner} gate ${key}` },
            { cwd: sub },
          )
        ).decision,
        'deny',
      );
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command: `${runner} gate ${key}` }))
          .decision,
        undefined,
      );
    }
  }
});

test('a review wrapper on a protected branch is recognised only with the session runner', async (t) => {
  const root = realpathSync(
    fixture(t, {
      review: ['scripts/review.sh'],
      workflow: { requireReview: true, reviewers: { codex: {} } },
    }),
  );
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const key = sessionKey(root, 'claude', 'test-session');
  const wrapper = (runner: string) =>
    call(root, 'claude', 'PreToolUse', 'Bash', {
      command: `REVIEW_GATE_SESSION=${key} ${runner}scripts/review.sh docs/tasks/task.md claude codex 1`,
    });
  const runner = resolve(pluginRoot, 'bin/halvard.ts');
  assert.equal((await wrapper('')).decision, undefined);
  assert.equal((await wrapper(`HALVARD_RUNNER=${quote(runner)} `)).decision, undefined);
  for (const path of ['scripts/review wrapper.sh', "scripts/review's.sh"]) {
    const other = realpathSync(
      fixture(t, {
        review: [path],
        workflow: { requireReview: true, reviewers: { codex: {} } },
      }),
    );
    execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: other });
    const printed = (await call(other, 'claude', 'SessionStart'))
      .context!.match(/Run independent review with: (.+)/)![1]!
      .replace('<task-file>', 'docs/tasks/task.md')
      .replace('<reviewer>', 'codex')
      .replace('[round]', '1');
    assert.equal(
      (await call(other, 'claude', 'PreToolUse', 'Bash', { command: printed })).decision,
      undefined,
      printed,
    );
  }
  for (const other of ['/tmp/halvard.ts', `${runner}x`, '']) {
    assert.equal((await wrapper(`HALVARD_RUNNER=${quote(other)} `)).decision, 'deny', other);
  }
});

test('Git metadata writes require approval in every harness', async (t) => {
  const root = fixture(t);
  for (const harness of ['pi', 'claude', 'codex']) {
    for (const path of ['.git/config', '.git/hooks/pre-commit']) {
      const [tool, input] = writeInput(harness, path, 'unapproved code');
      assert.equal((await call(root, harness, 'PreToolUse', tool, input)).decision, 'ask');
    }
  }
});

test('Pi approval covers one exact shipping operation, once', async (t) => {
  const root = fixture(t);
  const shell = { command: 'git push' };
  const first = await call(root, 'pi', 'PreToolUse', 'bash', shell);
  assert.equal(first.decision, 'ask');
  // A session-wide approval is an ordinary prompt and authorizes nothing.
  assert.deepEqual(
    await call(root, 'pi', 'UserPromptSubmit', undefined, undefined, {
      prompt: `approve halvard ${first.request} for this session`,
    }),
    {},
  );
  assert.equal((await call(root, 'pi', 'PreToolUse', 'bash', shell)).decision, 'ask');
  const second = await call(root, 'pi', 'PreToolUse', 'bash', shell);
  await call(root, 'pi', 'UserPromptSubmit', undefined, undefined, {
    prompt: `approve halvard ${second.request}`,
  });
  assert.equal((await call(root, 'pi', 'PreToolUse', 'bash', shell)).decision, undefined);
  assert.equal((await call(root, 'pi', 'PreToolUse', 'bash', shell)).decision, 'ask');
});

test('merging and deleting a merged branch on a protected branch ask instead of deny', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  for (const harness of ['claude', 'codex', 'pi']) {
    for (const command of [
      'git merge --ff-only feature/x',
      'git branch -d feature/x',
      'git branch -d feature/x feature/y fix/z',
    ]) {
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command })).decision,
        'ask',
        `${harness}: ${command}`,
      );
    }
    for (const command of [
      'git branch -D feature/x',
      'git branch -d feature/x -D feature/y',
      'git branch -d -r origin/x',
      'git branch -d feature/x && touch source.txt',
    ]) {
      assert.equal(
        (await call(root, harness, 'PreToolUse', 'Bash', { command })).decision,
        'deny',
        `${harness}: ${command}`,
      );
    }
  }
});

test('line-numbered reads run on a protected branch; redirected ones do not', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const bash = (command: string) => call(root, 'claude', 'PreToolUse', 'Bash', { command });
  for (const command of ['cat source.txt', 'nl -ba source.txt', 'nl source.txt | head -5']) {
    assert.equal((await bash(command)).decision, undefined, command);
  }
  for (const command of ['nl -ba source.txt > out.txt', 'nl -ba source.txt | tee out.txt']) {
    const result = await bash(command);
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason!, /No work on protected branch main/, command);
  }
});

test('a shipping command denied on a protected branch says how to run it', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const bash = (command: string) => call(root, 'claude', 'PreToolUse', 'Bash', { command });
  assert.equal((await bash('git push origin main')).decision, 'ask');
  for (const command of [
    'git push origin main 2>&1 | tail -5',
    `cd ${root} && git push origin main`,
    'git branch -d feature/x && git branch -d feature/y',
  ]) {
    const result = await bash(command);
    assert.equal(result.decision, 'deny', command);
    assert.match(
      result.reason!,
      /^No work on protected branch main\. Run each shipping command alone and plain, for example git push origin main, without a pipe, chain, cd or redirect; it then asks for approval\.$/,
      command,
    );
  }
  for (const command of [
    'git push "$REMOTE" main',
    'git push origin $(git branch --show-current)',
  ]) {
    const result = await bash(command);
    assert.equal(result.decision, 'deny', command);
    assert.equal(
      result.reason,
      'No work on protected branch main. Run each shipping command alone and plain, for example git push origin main, without a pipe, chain, cd or redirect; it then asks for approval. Write names literally, without variables or substitution.',
      command,
    );
  }
  assert.equal(
    (await bash('touch source.txt')).reason,
    'No work on protected branch main. Create a feature or fix branch first. To trust a test or query command as a read, list it in readCommands.',
  );
});

test('Pi shipping on a protected branch gets only one-time approval', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const push = await call(root, 'pi', 'PreToolUse', 'bash', { command: 'git push' });
  assert.equal(push.decision, 'ask');
  assert.deepEqual(
    await call(root, 'pi', 'UserPromptSubmit', undefined, undefined, {
      prompt: `approve halvard ${push.request} for this session`,
    }),
    {},
  );
  assert.equal(
    (await call(root, 'pi', 'PreToolUse', 'bash', { command: 'git push' })).decision,
    'ask',
  );
});

test('approval expiry: distinct messages, refresh, grant lifetime and single use', async (t) => {
  const root = fixture(t);
  const start = Date.parse('2026-11-03T10:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const at = (minutes: number) => t.mock.timers.setTime(start + minutes * 60 * 1000);
  const tool = 'Bash';
  const input = { command: 'git commit -m "notes"' };
  const ask = () => call(root, 'codex', 'PreToolUse', tool, input);
  const approve = async (id: string, session = 'test-session') =>
    (
      await call(root, 'codex', 'UserPromptSubmit', undefined, undefined, {
        prompt: `approve halvard ${id}`,
        session_id: session,
      })
    ).context!;

  // Nothing waits yet.
  assert.match(await approve('a'.repeat(64)), /no request is waiting/);
  const first = await ask();
  assert.match(first.reason!, /issued at \d\d:\d\d and expires at \d\d:\d\d/);
  // A retry while it waits keeps the same id and expiry.
  at(5);
  const repeat = await ask();
  assert.equal(repeat.request, first.request);
  assert.equal(repeat.reason, first.reason);
  // Another session cannot approve it, and an unknown id is not this one.
  assert.match(await approve(first.request!, 'other-session'), /no request is waiting/);
  assert.match(await approve('b'.repeat(64)), /not the one waiting/);
  // The answer arrives after the request expired: nothing is approved.
  at(11);
  assert.match(await approve(first.request!), /expired at .*nothing was approved/);
  assert.equal((await ask()).decision, 'ask');
  // That retry issued a new request and says the old one expired.
  const second = await ask();
  assert.notEqual(second.request, first.request);
  assert.match(second.reason!, /earlier request for this operation \([a-f0-9]{12}\) expired at/);
  // The old response never applies to the newer request.
  assert.match(await approve(first.request!), /replaced it/);
  assert.equal((await ask()).request, second.request);
  // A timely approval survives a retry after the request's own lifetime.
  at(20);
  assert.match(await approve(second.request!), /Approved workflow request/);
  at(29);
  assert.equal((await ask()).decision, undefined);
  // Single use, and the spent id cannot be replayed.
  assert.equal((await ask()).decision, 'ask');
  assert.match(await approve(second.request!), /not the one waiting/);

  // A grant left unused past its own lifetime lapses.
  const third = await ask();
  assert.match(await approve(third.request!), /Approved/);
  at(29 + 11);
  const lapsed = await ask();
  assert.equal(lapsed.decision, 'ask');
  assert.notEqual(lapsed.request, third.request);
});

test('an older state file with a bare approval grants nothing', async (t) => {
  const root = fixture(t);
  const tool = 'Bash';
  const input = { command: 'git commit -m "notes"' };
  const asked = await call(root, 'codex', 'PreToolUse', tool, input);
  const { withState } = await import('../core/state.ts');
  const key = sessionKey(realpathSync(root), 'codex', 'test-session');
  await withState(realpathSync(root), key, (state) => {
    state.approved = asked.request!;
  });
  assert.equal((await call(root, 'codex', 'PreToolUse', tool, input)).decision, 'ask');
});

test('Claude: the exact asked call reaching PostToolUse is logged as host-allowed', async (t) => {
  const root = fixture(t);
  const { eventFile, readEvents, repoLogDirectory } = await import('../core/events.ts');
  const tool = 'Bash';
  const input = { command: 'git commit -m "notes"' };
  const asked = await call(root, 'claude', 'PreToolUse', tool, input, { tool_use_id: 'toolu_1' });
  assert.equal(asked.decision, 'ask');
  // Another call running proves nothing.
  await call(root, 'claude', 'PostToolUse', tool, input, { tool_use_id: 'toolu_2' });
  const log = () =>
    readEvents(eventFile(repoLogDirectory(realpathSync(root)), null)).filter(
      (event) => event.kind === 'outcome',
    );
  assert.equal(log().length, 0);
  await call(root, 'claude', 'PostToolUse', tool, input, { tool_use_id: 'toolu_1' });
  await call(root, 'claude', 'PostToolUse', tool, input, { tool_use_id: 'toolu_1' });
  const outcomes = log();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.outcome, 'host-allowed');
  assert.equal(outcomes[0]!.via, 'claude-native');
  assert.equal(outcomes[0]!.request, asked.request!.slice(0, 16));
  // The ask that preceded it carries the same request.
  const ask = readEvents(eventFile(repoLogDirectory(realpathSync(root)), null)).find(
    (event) => event.kind === 'ask',
  )!;
  assert.equal(ask.request, outcomes[0]!.request);
  assert.doesNotMatch(JSON.stringify(ask), /git commit/);
});

test('Pi dialog answers: Yes once approves one call; No and a dismissed dialog block', async (t) => {
  const root = realpathSync(fixture(t));
  const { answerDialog } = await import('../core/approval.ts');
  const { loadProject } = await import('../core/project.ts');
  const { eventFile, readEvents, repoLogDirectory } = await import('../core/events.ts');
  const shell = { command: 'git commit -m x' };
  const ask = () => call(root, 'pi', 'PreToolUse', 'bash', shell);
  const answer = async (choice: 'approve' | 'reject' | 'cancel') => {
    const asked = await ask();
    assert.equal(asked.decision, 'ask');
    return answerDialog(
      loadProject(root),
      'pi',
      asked.session!,
      asked.request!,
      choice,
      'pi-dialog',
    );
  };
  assert.equal((await answer('reject')).outcome, 'rejected');
  assert.equal((await answer('cancel')).outcome, 'cancelled');
  assert.equal((await ask()).decision, 'ask');
  assert.equal((await answer('approve')).outcome, 'approved');
  assert.equal((await ask()).decision, undefined);
  assert.equal((await ask()).decision, 'ask');
  assert.deepEqual(
    readEvents(eventFile(repoLogDirectory(root), null))
      .filter((event) => event.kind === 'outcome')
      .map((event) => [event.outcome, event.via]),
    [
      ['rejected', 'pi-dialog'],
      ['cancelled', 'pi-dialog'],
      ['approved', 'pi-dialog'],
    ],
  );
});

test('Claude: a host-allowed request is finished and cannot be approved afterwards', async (t) => {
  const root = fixture(t);
  const tool = 'Bash';
  const input = { command: 'git commit -m "notes"' };
  const first = await call(root, 'claude', 'PreToolUse', tool, input, { tool_use_id: 'c1' });
  await call(root, 'claude', 'PostToolUse', tool, input, { tool_use_id: 'c1' });
  const approval = await call(root, 'claude', 'UserPromptSubmit', undefined, undefined, {
    prompt: `approve halvard ${first.request!}`,
  });
  assert.match(approval.context!, /no request is waiting/);
  const second = await call(root, 'claude', 'PreToolUse', tool, input, { tool_use_id: 'c2' });
  assert.equal(second.decision, 'ask');
  assert.notEqual(second.request, first.request);
});
