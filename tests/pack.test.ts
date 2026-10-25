import type { TestContext } from 'node:test';
import type { ProjectConfig, HarnessSettings, PackageMetadata } from '../core/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import {
  eligibleReviewers,
  flowConfig,
  personalSettings,
  reviewerChoices,
} from '../core/flow-config.ts';
import {
  startTask,
  resumeTask,
  handoffTask,
  readTask,
  taskWorkspace,
} from '../core/workflow/tasks.ts';
import { proposeSetup, applySetup } from '../core/setup/setup.ts';
import { installPersonal, personalInstallPlan } from '../core/install/personal.ts';
import {
  parseVerdict,
  runReview as rawReview,
  reviewSnapshot,
  hasReview,
  reviewCommand,
  reviewKey,
} from '../core/workflow/review.ts';
import { fingerprint, sessionKey, withState } from '../core/state.ts';
import { handle, runGate } from '../core/runtime.ts';

function fixture(t: TestContext, workflow = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-pack-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({
      version: 1,
      gate: [process.execPath, '-e', 'process.exit(0)'],
      workflow: {
        reviewers: {
          claude: {},
          codex: {},
          grok: {},
          cursor: {},
          ollama: { model: 'test-model' },
        },
        ...workflow,
      },
    }),
  );
  writeFileSync(join(root, 'source.txt'), 'original\n');
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  return root;
}

async function runReview(
  root: string,
  path: string,
  args: { author: string; reviewer: string; round: number },
) {
  const gateSession = sessionKey(root, args.author, 'review-test');
  await runGate(root, gateSession);
  return rawReview(root, path, { ...args, gateSession });
}

function fakeReviewers(t: TestContext, mode = 'pass') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-review-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  const record = join(dir, 'invocation.json');
  const script = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.on('data', bytes => input += bytes);
process.stdin.on('end', () => {
 const name = path.basename(process.argv[1]), args = process.argv.slice(2);
 fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({name,args,input,cwd:process.cwd()}));
 const result = JSON.stringify({verdict:'${mode === 'blocked' ? 'blocked' : 'pass'}', standards:'Checked project rules and concrete source.',spec:'Checked the stated acceptance criteria.',findings:${mode === 'blocked' ? "[{severity:'blocking',location:'source.txt:1',problem:'Wrong behavior',suggestion:'Fix it'}]" : '[]'}});
 ${mode === 'timeout' ? 'setInterval(() => {}, 1000); return;' : ''}
 ${mode === 'mutate' ? "const root = input.match(/MUTATE_ROOT=(.+)/)[1]; fs.writeFileSync(path.join(root,'source.txt'),'outside edit');" : ''}
 if (name === 'codex') fs.writeFileSync(args[args.indexOf('-o')+1], result);
 else if (name === 'claude' || name === 'cursor-agent') process.stdout.write(JSON.stringify({result:${mode === 'malformed' ? "'not-json'" : 'result'},is_error:false}));
 else if (name === 'grok') process.stdout.write(JSON.stringify({text:fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8').includes('original') ? result : 'missing evidence'}));
 else process.stdout.write(result);
});
`;
  for (const name of ['claude', 'codex', 'ollama', 'grok', 'cursor-agent']) {
    const file = join(dir, name);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return record;
}

const start = (root: string, author = 'codex') =>
  startTask(root, { id: 'example', title: 'Build example', author });

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

test('personal install preview preserves unrelated plugins and permissions without writing files', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-user-install-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude'));
  writeFileSync(
    join(home, '.claude/settings.json'),
    JSON.stringify({
      enabledPlugins: { 'example-plugin@example-marketplace': true },
      permissions: { deny: ['Read(.env)'] },
    }),
  );
  const plan = personalInstallPlan(home, join(home, '.config/halvard'));
  const settings = JSON.parse(
    plan.writes.find((w) => w.path.endsWith('.claude/settings.json'))!.content,
  ) as HarnessSettings & { permissions?: unknown };
  assert.equal(settings.enabledPlugins!['example-plugin@example-marketplace'], true);
  assert.deepEqual(settings.permissions, { deny: ['Read(.env)'] });
  assert.equal(settings.enabledPlugins!['halvard@ghulando'], true);
  assert.equal(existsSync(join(home, '.pi')), false);
  assert.equal(existsSync(plan.copy!.destination), false);
});

test('personal install commands register Claude for fresh and existing installations', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-claude-install-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const destination = join(home, '.config/halvard');
  const source = join(destination, 'package');
  const expected = [
    ['claude', 'plugin', 'marketplace', 'add', source],
    ['claude', 'plugin', 'install', 'halvard@ghulando'],
  ];
  assert.deepEqual(
    personalInstallPlan(home, destination).commands.filter((command) => command[0] === 'claude'),
    expected,
  );
  installPersonal(home, destination);
  assert.deepEqual(
    personalInstallPlan(home, destination).commands.filter((command) => command[0] === 'claude'),
    expected,
  );
});

test('personal upgrades stage a replacement and preserve preferences; same versions skip copying', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-upgrade-')));
  const destination = join(home, '.config/halvard');
  const target = join(destination, 'package');
  const previous = process.env.HALVARD_HOME;
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  process.env.HALVARD_HOME = destination;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.HALVARD_HOME;
    } else {
      process.env.HALVARD_HOME = previous;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  });
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify({ name: 'halvard', version: '0.2.2' }),
  );
  writeFileSync(join(target, 'obsolete.txt'), 'old package');
  const personal = '{"reviewTimeout":120,"readCommands":[["inspect"]]}\n';
  writeFileSync(join(destination, 'personal.json'), personal);
  const plan = personalInstallPlan(home, destination);
  assert.deepEqual(plan.upgrade, { from: '0.2.2', to: '0.0.1' });
  assert.equal(readFileSync(join(target, 'obsolete.txt'), 'utf8'), 'old package');
  assert.ok(plan.copy);
  assert.deepEqual(plan.commands, [
    ['claude', 'plugin', 'marketplace', 'add', target],
    ['claude', 'plugin', 'install', 'halvard@ghulando'],
    ['codex', 'plugin', 'marketplace', 'add', destination],
    ['codex', 'plugin', 'remove', 'halvard@ghulando'],
    ['codex', 'plugin', 'add', 'halvard@ghulando'],
  ]);
  installPersonal();
  assert.equal(
    (JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')) as PackageMetadata).version,
    '0.0.1',
  );
  for (const manifest of [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    '.grok-plugin/plugin.json',
  ]) {
    assert.equal(
      (JSON.parse(readFileSync(join(target, manifest), 'utf8')) as PackageMetadata).version,
      '0.0.1',
    );
  }
  assert.equal(existsSync(join(target, 'core/guard/shell.ts')), true);
  assert.equal(existsSync(join(target, 'obsolete.txt')), false);
  assert.equal(readFileSync(join(destination, 'personal.json'), 'utf8'), personal);
  assert.equal(personalInstallPlan(home, destination).copy, null);
  writeFileSync(join(target, 'README.md'), 'same-version sentinel');
  t.mock.method(fs, 'cpSync', () => {
    throw new Error('must not copy');
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installPersonal(home, destination), /--repair/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'same-version sentinel');
  assert.equal(personalInstallPlan(home, destination).drift!.matches, false);
  assert.ok(personalInstallPlan(home, destination, { repair: true }).copy);
  installPersonal(home, destination, { repair: true });
  assert.equal(personalInstallPlan(home, destination).drift!.matches, true);
  writeFileSync(
    join(target, 'package.json'),
    JSON.stringify({ name: 'another-package', version: '0.2.2' }),
  );
  assert.throws(() => personalInstallPlan(home, destination), /another package|package name/);
});

test('a failed staged personal upgrade leaves the installed package and settings intact', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-upgrade-failure-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const destination = join(home, '.config/halvard');
  const target = join(destination, 'package');
  mkdirSync(target, { recursive: true });
  const old = '{"name":"halvard","version":"0.2.2"}\n';
  writeFileSync(join(target, 'package.json'), old);
  writeFileSync(join(target, 'working.txt'), 'still working');
  writeFileSync(join(destination, 'personal.json'), '{}\n');
  const copy = fs.cpSync;
  let copies = 0;
  t.mock.method(fs, 'cpSync', (...args: Parameters<typeof fs.cpSync>) => {
    if (++copies === 2) throw new Error('copy failed');
    return copy(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installPersonal(home, destination), /copy failed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(copies, 2);
  assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), old);
  assert.equal(readFileSync(join(target, 'working.txt'), 'utf8'), 'still working');
  assert.equal(readFileSync(join(destination, 'personal.json'), 'utf8'), '{}\n');
  assert.equal(existsSync(join(home, '.claude/settings.json')), false);
  assert.deepEqual(fs.readdirSync(destination).sort(), ['package', 'personal.json']);
});

test('a failed personal package swap restores the previous directory', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-upgrade-swap-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const destination = join(home, '.config/halvard');
  const target = join(destination, 'package');
  mkdirSync(target, { recursive: true });
  const old = '{"name":"halvard","version":"0.2.2"}\n';
  writeFileSync(join(target, 'package.json'), old);
  const rename = fs.renameSync;
  let renames = 0;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (++renames === 2) throw new Error('swap failed');
    return rename(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => installPersonal(home, destination), /swap failed/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(renames, 3);
  assert.equal(readFileSync(join(target, 'package.json'), 'utf8'), old);
  assert.deepEqual(fs.readdirSync(destination), ['package']);
});

test('personal installation recognizes an equivalent single-quoted Codex plugin table', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-user-toml-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.codex'));
  const toml = "[plugins.'halvard@ghulando']\nenabled = true\n";
  writeFileSync(join(home, '.codex/config.toml'), toml);
  const plan = personalInstallPlan(home, join(home, '.config/halvard'));
  assert.equal(
    plan.writes.some((write) => write.path.endsWith('.codex/config.toml')),
    false,
  );
  writeFileSync(join(home, '.codex/config.toml'), toml.replace('true', 'false'));
  assert.throws(() => personalInstallPlan(home, join(home, '.config/halvard')), /disabled/);
});

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
    const { pluginRoot, quote } = await import('../core/runtime.ts');
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

test('personal install names the workspace settings and the session restart without changing permissions', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-user-workspace-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const plan = personalInstallPlan(home, join(home, '.config/halvard'));
  assert.equal(plan.workspace.path, process.env.HALVARD_WORKSPACE);
  assert.match(plan.workspace.claude, /permissions\.additionalDirectories/);
  assert.match(plan.workspace.codex, /\[sandbox_workspace_write\]/);
  assert.match(plan.instruction, /restart every open Claude Code and Codex session/);
  const settings = JSON.parse(
    plan.writes.find((w) => w.path.endsWith('.claude/settings.json'))!.content,
  ) as HarnessSettings;
  assert.equal(settings.permissions, undefined);
});
