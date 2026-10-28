import type { ProjectConfig } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadProject, git } from '../core/project.ts';
import { flowConfig } from '../core/config/workflow.ts';
import { startTask, resumeTask } from '../core/workflow/tasks.ts';
import { proposeSetup, applySetup } from '../core/setup/setup.ts';
import { personalInstallPlan } from '../core/install/personal.ts';
import { fingerprint } from '../core/state.ts';
import { handle } from '../core/runtime.ts';
import { fixture, start } from './review-fixture.ts';

test('task creation starts from the configured base and dirty trees remain untouched', (t) => {
  const root = fixture(t);
  const base = git(root, ['rev-parse', 'HEAD']).trim();
  const created = start(root);
  assert.equal(created.branch, 'feature/example');
  assert.equal(created.base, base);
  const resumed = resumeTask(root, created.task);
  assert.equal(resumed.metadata.author, 'codex');
  assert.equal(resumed.expectedBranch, 'feature/example');
  assert.match(resumed.content, /Acceptance criteria/);
  const before = fingerprint(root);
  assert.throws(
    () => startTask(root, { id: 'second', title: 'Second', author: 'pi' }),
    /existing changes/,
  );
  assert.equal(fingerprint(root), before);
  assert.throws(() => startTask(root, { id: '../escape', title: 'Escape', author: 'pi' }), /slug/);
});

test('setup detects mixed applications, preserves conventions, and stale proposals cannot apply', (t) => {
  const root = fixture(t);
  const before = fingerprint(root);
  for (const directory of ['web', 'api', 'worker', 'gateway']) mkdirSync(join(root, directory));
  writeFileSync(
    join(root, 'web/package.json'),
    JSON.stringify({
      dependencies: { vue: '3' },
      devDependencies: { typescript: '5' },
      scripts: { build: 'vite build', test: 'vitest run' },
    }),
  );
  writeFileSync(join(root, 'api/Api.csproj'), '<Project/>');
  writeFileSync(join(root, 'worker/pyproject.toml'), '[project]\nname="worker"');
  writeFileSync(join(root, 'gateway/go.mod'), 'module example.invalid/gateway\n');
  const tree = fingerprint(root);
  const proposal = proposeSetup(root);
  assert.deepEqual(
    proposal.projects.map((p) => [p.path, p.stacks]),
    [
      ['api', ['dotnet']],
      ['gateway', ['go']],
      ['web', ['vue', 'typescript']],
      ['worker', ['python']],
    ],
  );
  assert.equal(fingerprint(root), tree);
  assert.notEqual(tree, before);
  assert.equal(proposal.config.workflow.baseBranch, 'main');
  assert.equal(proposal.config.gate![0], process.execPath);
  const file = join(tmpdir(), `proposal-${process.pid}-${Date.now()}.json`);
  t.after(() => rmSync(file, { force: true }));
  proposal.config.workflow.featurePrefix = 'work/';
  writeFileSync(file, JSON.stringify(proposal));
  applySetup(root, file);
  assert.equal(loadProject(root).config.workflow.featurePrefix, 'work/');
  assert.throws(() => applySetup(root, file), /stale/);
});

test('personal defaults are overridden per project and invalid reviewer settings fail closed', (t) => {
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
      shellApproval: 'native',
      featurePrefix: 'personal/',
      taskDirectory: 'tasks',
      reviewers: { claude: { model: 'personal-model' } },
    }),
  );
  const root = fixture(t, { featurePrefix: 'repo/', reviewers: {} });
  const config = loadProject(root).config.workflow;
  assert.equal(config.featurePrefix, 'repo/');
  assert.equal(config.taskDirectory, 'tasks');
  assert.equal(config.reviewers.claude!.model, 'personal-model');
  assert.equal(Object.hasOwn(config, 'shellApproval'), false);
  assert.throws(() => flowConfig({ reviewers: { ollama: {} } }), /explicit model/);
  assert.throws(() => flowConfig({ reviewers: { claude: { command: 'evil' } } }), /settings/);
  assert.throws(() => flowConfig({ taskDirectory: '../outside' }), /relative/);
  assert.throws(() => flowConfig(JSON.parse('{"constructor":false}') as unknown), /unknown/);
  assert.throws(
    () => flowConfig(JSON.parse('{"__proto__":{"requireReview":false}}') as unknown),
    /unknown/,
  );
});

test('setup proposals keep personal defaults out of the repo and personal read commands apply to every repo', async (t) => {
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
    JSON.stringify({ featurePrefix: 'personal/', readCommands: [['graphify', 'query']] }),
  );
  const root = fixture(t);
  const proposal = proposeSetup(root);
  assert.equal(proposal.config.workflow.featurePrefix, undefined);
  assert.equal(proposal.config.workflow.baseBranch, 'main');
  assert.equal(loadProject(root).config.workflow.featurePrefix, 'personal/');
  git(root, ['switch', '-q', '-c', 'feature/read']);
  const bash = (command: string) =>
    handle('claude', {
      cwd: root,
      session_id: 'personal-read',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      permission_mode: 'plan',
    });
  assert.equal((await bash('graphify query "who calls handle"')).decision, undefined);
  assert.equal((await bash('graphify query --write out "x"')).decision, 'deny');
  assert.equal((await bash('graphify build')).decision, 'deny');
  const documentation = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');
  const graphifyExample = documentation
    .split('```json\n')
    .slice(1)
    .map((block) => block.split('\n```')[0]!)
    .find((block) => block.includes('"graphify"'));
  assert.ok(graphifyExample, 'configuration documents graphify typed read commands');
  writeFileSync(join(home, 'personal.json'), graphifyExample);
  assert.equal(loadProject(root).config.readCommands.length, 4);
  for (const command of [
    'graphify query "who calls handle"',
    'graphify query "who calls handle" --budget 1500 --dfs',
    'graphify explain "handle"',
    'graphify path "handle" "startupContext"',
    'graphify affected "handle"',
    'graphify affected "handle" --depth 2',
  ]) {
    assert.equal((await bash(command)).decision, undefined, command);
  }
  for (const command of [
    'graphify update .',
    'graphify build',
    'graphify hook',
    'graphify query "handle" --unknown',
    'graphify query "handle" --graph /etc/passwd',
    'graphify query "handle" --budget abc',
    'graphify query x && rm y',
    'graphify query "handle" --budget 0',
    'graphify query "handle" --budget -1',
    'graphify query "handle" --budget 1.5',
    'graphify query "handle" --budget',
    'graphify query "handle" --budget=1500',
    'graphify affected "handle" --depth 0',
    'graphify affected "handle" --depth nope',
    'graphify query',
    'graphify explain "handle" "extra"',
    'graphify path "handle"',
    'graphify path "handle" "startupContext" "extra"',
  ]) {
    assert.equal((await bash(command)).decision, 'deny', command);
  }
  const entry = {
    prefix: ['herdr', 'agent', 'read'],
    options: { '--lines': 'positiveInteger' },
    positionals: { min: 1, max: 1 },
  };
  writeFileSync(join(home, 'personal.json'), JSON.stringify({ readCommands: [entry] }));
  const project = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8')) as ProjectConfig;
  project.readCommands = [['inspect', '--list']];
  writeFileSync(join(root, '.halvard.json'), JSON.stringify(project));
  assert.deepEqual(loadProject(root).config.readCommands, [['inspect', '--list'], entry]);
  assert.equal((await bash('herdr agent read X --lines 400')).decision, undefined);
  assert.equal((await bash('inspect --list X')).decision, undefined);
  assert.equal((await bash('herdr agent read X --lines=400')).decision, 'deny');
  for (const readCommands of ['graphify', [[]], [['graphify', '']]]) {
    writeFileSync(join(home, 'personal.json'), JSON.stringify({ readCommands }));
    assert.throws(() => loadProject(root), /read command|readCommands/);
  }
  mkdirSync(join(home, 'halvard'));
  writeFileSync(
    join(home, 'halvard/personal.json'),
    JSON.stringify({ readCommands: [['graphify', 'query']] }),
  );
  assert.doesNotThrow(() => personalInstallPlan(home, join(home, 'halvard')));
});
