import type { ProjectConfig } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pluginRoot, quote } from '../core/shared/plugin.ts';
import { sessionKey } from '../core/state.ts';
import { loadProject } from '../core/project.ts';
import { skills } from '../core/context.ts';
import { fixture, call } from './hook-fixture.ts';

test('skills that commit stage code by name and ask before including workflow files', () => {
  for (const skill of ['halvard', 'halvard-team']) {
    const text = readFileSync(new URL(`../skills/${skill}/SKILL.md`, import.meta.url), 'utf8');
    for (const required of [
      /stage[^.]*code and tests by name/i,
      /never `git add -A`, `git add \.`/,
      /taskDirectory/,
      /`\.halvard\.json`/,
      /reviewExceptions/,
      /reviewDeferrals/,
    ]) {
      assert.match(text, required, skill);
    }
  }
});

test('required bundled skills load and project overrides retain precedence', async (t) => {
  const root = fixture(t, { requiredSkills: ['halvard-test'] });
  // Validating before bundled discovery rejects a required skill shipped with the package.
  for (const harness of ['pi', 'claude', 'codex']) {
    const { context } = await call(root, harness, 'SessionStart');
    assert.match(context!, /Loaded required skill: .*skills\/halvard-test\/SKILL\.md/);
    assert.match(context!, /Choose the interface where real callers observe behavior/);
  }
  mkdirSync(join(root, '.agents/skills/halvard-test'), { recursive: true });
  writeFileSync(
    join(root, '.agents/skills/halvard-test/SKILL.md'),
    '---\nname: halvard-test\ndescription: Project testing\n---\nProject testing override.\n',
  );
  const { context } = await call(root, 'claude', 'SessionStart');
  assert.match(context!, /Project testing override/);
  assert.doesNotMatch(context!, /Choose the interface where real callers observe behavior/);
  const config = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8')) as ProjectConfig;
  config.requiredSkills = ['missing-skill'];
  writeFileSync(join(root, '.halvard.json'), JSON.stringify(config));
  await assert.rejects(
    call(root, 'claude', 'SessionStart'),
    /required skill not found: missing-skill/,
  );
});

test('startup context reports defaults when the project configuration is absent', async (t) => {
  const root = fixture(t);
  rmSync(join(root, '.halvard.json'));
  for (const harness of ['pi', 'claude', 'codex']) {
    const { context } = await call(root, harness, 'SessionStart');
    // Unconditionally naming the file sends agents to a nonexistent configuration.
    assert.match(context!, /Project configuration: defaults \(no \.halvard\.json\)/);
    assert.doesNotMatch(context!, /Project configuration: \.halvard\.json\./);
  }
  writeFileSync(join(root, '.halvard.json'), '{"version":1}');
  const { context } = await call(root, 'claude', 'SessionStart');
  assert.match(context!, /Project configuration: \.halvard\.json\./);
});

test('startup context stays inside the native preview and points to the halvard skill', async (t) => {
  const root = fixture(t);
  const { context } = await call(root, 'claude', 'SessionStart');
  assert.ok(
    Buffer.byteLength(context!) < 2000,
    `startup context is ${Buffer.byteLength(context!)} bytes`,
  );
  assert.match(context!, /skills\/halvard\/SKILL\.md/);
  assert.doesNotMatch(context!, /halvard-review/);
  assert.doesNotMatch(context!, /Adapted from Pstack poteto-mode/);
});

test('startup context prints the session review command only when review is required', async (t) => {
  const runner = quote(resolve(pluginRoot, 'bin/halvard.ts'));
  assert.doesNotMatch(
    (await call(fixture(t), 'claude', 'SessionStart')).context!,
    /Run independent review/,
  );
  const root = realpathSync(
    fixture(t, { workflow: { requireReview: true, reviewers: { codex: {} } } }),
  );
  const key = sessionKey(root, 'claude', 'test-session');
  assert.ok(
    (await call(root, 'claude', 'SessionStart')).context!.includes(
      `Run independent review with: node ${runner} review <task-file> --author claude --reviewer <reviewer> --round <n> --gate-session ${key}`,
    ),
  );
  const config = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8'));
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({ ...config, review: ['scripts/review.sh'] }),
  );
  assert.ok(
    (await call(root, 'claude', 'SessionStart')).context!.includes(
      `Run independent review with: REVIEW_GATE_SESSION=${key} HALVARD_RUNNER=${runner} 'scripts/review.sh' <task-file> claude <reviewer> [round]`,
    ),
  );
});

test('startup context names the reviewer assigned to the session harness', async (t) => {
  const root = realpathSync(
    fixture(t, { workflow: { requireReview: true, reviewers: { claude: { reviewer: 'codex' } } } }),
  );
  assert.match(
    (await call(root, 'claude', 'SessionStart')).context!,
    /review <task-file> --author claude --reviewer codex --round <n>/,
  );
  assert.match(
    (await call(root, 'codex', 'SessionStart')).context!,
    /No configured independent reviewer for codex/,
  );
});

test('Herdr team skill is discoverable as a bundled skill without requiredSkills', (t) => {
  const root = fixture(t);
  const team = skills(loadProject(root)).find((skill) => skill.name === 'halvard-team');
  assert.ok(team);
  assert.equal(team.bundled, true);
  assert.match(team.description, /only when the user explicitly asks/);
  assert.match(team.content, /The lead approves teammates' requests by default/);
});
