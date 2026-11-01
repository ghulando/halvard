import type { TestContext } from 'node:test';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  dataRoot,
  factoryHome,
  legacyData,
  makeDataDir,
  personalRoot,
  protectedRoots,
  retroLogRoot,
  rootIsCurrent,
  workspaceRoot,
} from '../core/config/paths.ts';
import { migrate, migrationPlan } from '../core/setup/migrate.ts';
import { handle } from '../core/runtime.ts';
import { shellKind } from '../core/guard/shell.ts';

const VARIABLES = ['HALVARD_DATA', 'HALVARD_HOME', 'HALVARD_WORKSPACE', 'HALVARD_FACTORY_HOME'];

// The variables as tests/environment.ts set them, restored after each bare home.
const SUITE = VARIABLES.map((name) => process.env[name]);

// A home folder with no Halvard variables set, so every path takes its default.
function bareHome(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-layout-')));
  for (const name of VARIABLES) delete process.env[name];
  t.after(() => {
    VARIABLES.forEach((name, i) => {
      if (SUITE[i] === undefined) delete process.env[name];
      else process.env[name] = SUITE[i];
    });
    rmSync(home, { recursive: true, force: true });
  });
  const put = (path: string, content = 'x') => {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  return { home, put };
}

test('a fresh home uses one data folder with config, workspace and factory', (t) => {
  const { home } = bareHome(t);
  const root = join(home, '.halvard');
  assert.equal(dataRoot(home), root);
  assert.equal(rootIsCurrent(home), true);
  assert.equal(personalRoot(home), join(root, 'config'));
  assert.equal(workspaceRoot(home), join(root, 'workspace'));
  assert.equal(factoryHome(home), join(root, 'factory'));
  assert.equal(retroLogRoot(home), join(root, 'workspace/retro-logs'));
  assert.deepEqual(legacyData(home), []);
  // Creating the first folder writes the marker, so the root is never taken for an
  // earlier workspace later.
  makeDataDir(join(root, 'workspace/repo'), home);
  assert.equal(existsSync(join(root, '.layout')), true);
  mkdirSync(join(root, 'workspace/repo/task'), { recursive: true });
  assert.equal(workspaceRoot(home), join(root, 'workspace'));
});

test('the earlier layout stays in use until migrate, and nothing new lands inside it', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard/repo/task/claude-report.md');
  const root = join(home, '.halvard');
  assert.equal(rootIsCurrent(home), false);
  assert.equal(workspaceRoot(home), root);
  // No ~/.config/halvard yet, but config/ must not appear inside the earlier workspace.
  assert.equal(personalRoot(home), join(home, '.config/halvard'));
  assert.equal(factoryHome(home), join(home, '.halvard-factory'));
  assert.deepEqual(legacyData(home), [root]);
  makeDataDir(join(root, 'repo/other'), home);
  assert.equal(existsSync(join(root, '.layout')), false);
});

test('environment variables still move each part', (t) => {
  const { home } = bareHome(t);
  process.env.HALVARD_DATA = join(home, 'data');
  process.env.HALVARD_WORKSPACE = join(home, 'ws');
  process.env.HALVARD_HOME = join(home, 'settings');
  process.env.HALVARD_FACTORY_HOME = join(home, 'jobs');
  assert.equal(dataRoot(home), join(home, 'data'));
  assert.equal(workspaceRoot(home), join(home, 'ws'));
  assert.equal(personalRoot(home), join(home, 'settings'));
  assert.equal(factoryHome(home), join(home, 'jobs'));
  assert.deepEqual(protectedRoots(home), [
    join(home, 'data'),
    join(home, 'settings'),
    join(home, 'jobs'),
  ]);
});

test('migrate moves the earlier folders into the data folder and runs once', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard/repo/task/claude-report.md', 'report');
  // A repository named like a new folder moves with the rest of the workspace.
  put('.halvard/factory/task/codex-report.md', 'same name');
  put('.halvard/claude-retro-log.md', 'claude log');
  put('.halvard/notes.md', 'notes');
  put('.config/halvard/personal.json', '{"version":1}');
  put('.config/halvard/package/package.json', '{}');
  put('.halvard-factory/repo/jobs/one/job.json', JSON.stringify({ worktree: null }));
  const root = join(home, '.halvard');

  const preview = migrate(home);
  assert.equal(preview.applied, false);
  assert.deepEqual(
    preview.steps.map((step) => step.what),
    ['workspace', 'factory', 'config'],
  );
  assert.equal(existsSync(join(root, 'workspace')), false);

  const result = migrate(home, true);
  assert.equal(result.applied, true);
  const workspace = join(root, 'workspace');
  assert.equal(readFileSync(join(workspace, 'repo/task/claude-report.md'), 'utf8'), 'report');
  assert.equal(readFileSync(join(workspace, 'factory/task/codex-report.md'), 'utf8'), 'same name');
  assert.equal(readFileSync(join(workspace, 'notes.md'), 'utf8'), 'notes');
  assert.equal(
    readFileSync(join(workspace, 'retro-logs/claude-retro-log.md'), 'utf8'),
    'claude log',
  );
  assert.equal(existsSync(join(root, 'factory/repo/jobs/one/job.json')), true);
  assert.equal(existsSync(join(home, '.halvard-factory')), false);
  assert.equal(readFileSync(join(root, 'config/personal.json'), 'utf8'), '{"version":1}');
  // The installed copy stays where the harnesses still load it until the installer runs.
  assert.equal(existsSync(join(home, '.config/halvard/package/package.json')), true);
  assert.equal(existsSync(join(root, '.layout')), true);

  assert.equal(workspaceRoot(home), workspace);
  assert.equal(personalRoot(home), join(root, 'config'));
  assert.equal(factoryHome(home), join(root, 'factory'));
  assert.deepEqual(legacyData(home), []);
  assert.deepEqual(migrationPlan(home), []);
  assert.deepEqual(migrate(home, true).notes, ['Nothing to migrate.']);
});

test('migrate rewrites factory worktree paths and repairs linked worktrees', (t) => {
  const { home, put } = bareHome(t);
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '--initial-branch=main');
  git(
    '-c',
    'user.name=F',
    '-c',
    'user.email=f@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  );
  const old = join(home, '.halvard-factory/repo/worktrees/repo-one');
  mkdirSync(dirname(old), { recursive: true });
  git('worktree', 'add', '-q', '-b', 'factory/one', old);
  put(
    '.halvard-factory/repo/jobs/one/job.json',
    JSON.stringify({ id: 'one', repo, worktree: old }),
  );
  migrate(home, true);
  const moved = join(home, '.halvard/factory/repo/worktrees/repo-one');
  const job = JSON.parse(
    readFileSync(join(home, '.halvard/factory/repo/jobs/one/job.json'), 'utf8'),
  ) as { worktree: string };
  assert.equal(job.worktree, moved);
  assert.match(git('worktree', 'list', '--porcelain'), new RegExp(`worktree ${moved}\\n`));
  assert.equal(
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: moved,
      encoding: 'utf8',
    }).trim(),
    'factory/one',
  );
});

test('migrate refuses while a factory process runs and leaves everything in place', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard-factory/repo/serve.lock', String(process.pid));
  assert.throws(() => migrate(home, true), /a factory process holds .*serve\.lock/);
  assert.equal(existsSync(join(home, '.halvard-factory/repo/serve.lock')), true);
  assert.equal(existsSync(join(home, '.halvard/.migrate.lock')), false);
});

test('a migration that stopped half way finishes on the next run', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard/.workspace.next/repo/task/claude-report.md', 'moved');
  put('.halvard/other/task/claude-report.md', 'left');
  assert.equal(rootIsCurrent(home), false);
  migrate(home, true);
  const workspace = join(home, '.halvard/workspace');
  assert.equal(readFileSync(join(workspace, 'repo/task/claude-report.md'), 'utf8'), 'moved');
  assert.equal(readFileSync(join(workspace, 'other/task/claude-report.md'), 'utf8'), 'left');
  assert.equal(rootIsCurrent(home), true);
});

function repository(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-layout-repo-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=feature/layout'], { cwd: root });
  writeFileSync(join(root, '.halvard.json'), JSON.stringify({ version: 1 }));
  return root;
}

test('agents may not write Halvard data outside the workspace', async (t) => {
  const root = repository(t);
  const data = process.env.HALVARD_DATA!;
  const call = (harness: string, tool: string, input: Record<string, unknown>) =>
    handle(harness, {
      cwd: root,
      session_id: 'layout',
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: input,
    });
  const targets = [
    join(process.env.HALVARD_HOME!, 'personal.json'),
    join(data, 'factory/repo/jobs/one/job.json'),
    join(data, 'claude-notes.md'),
  ];
  for (const target of targets) {
    const write = await call('claude', 'Write', { file_path: target, content: 'x' });
    assert.equal(write.decision, 'deny', target);
    assert.match(write.reason!, /is Halvard's own data/);
    const patch = await call('codex', 'apply_patch', {
      command: `*** Begin Patch\n*** Add File: ${target}\n+x\n*** End Patch`,
    });
    assert.equal(patch.decision, 'deny', target);
  }
  // The workspace stays writable under its one-writer rule.
  const own = join(process.env.HALVARD_WORKSPACE!, 'claude-notes.md');
  assert.equal(
    (await call('claude', 'Write', { file_path: own, content: 'x' })).decision,
    undefined,
  );
  // Reading Halvard's data stays allowed.
  assert.equal((await call('claude', 'Read', { file_path: targets[0] })).decision, undefined);
});

test('a shell redirect into Halvard data stops for approval', (t) => {
  const root = repository(t);
  const target = join(process.env.HALVARD_HOME!, 'personal.json');
  assert.equal(shellKind(`echo x > ${target}`, [], root, root), 'opaque');
  assert.equal(
    shellKind(`echo x > ${join(process.env.HALVARD_WORKSPACE!, 'claude-a.md')}`, [], root, root),
    'mutation',
  );
});

test('agents may not run migrate', async (t) => {
  const root = repository(t);
  const result = await handle('claude', {
    cwd: root,
    session_id: 'layout',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node /opt/halvard/bin/halvard.ts migrate --apply' },
  });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason!, /run only from your own terminal/);
});

test('a lone folder named like a new part is an earlier workspace until marked', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard/config/task/claude-report.md');
  assert.equal(rootIsCurrent(home), false);
  assert.equal(personalRoot(home), join(home, '.config/halvard'));
  assert.equal(workspaceRoot(home), join(home, '.halvard'));
});

test('migrate merges retro logs written before it, and refuses to overwrite one', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard/repo/task/claude-report.md');
  put('.halvard/claude-retro-log.md', 'top');
  // Before migrate, a retro writes beside the earlier logs, at the top of the workspace.
  assert.equal(retroLogRoot(home), join(home, '.halvard'));
  put('.halvard/retro-logs/pi-retro-log.md', 'nested');
  migrate(home, true);
  const logs = join(home, '.halvard/workspace/retro-logs');
  assert.equal(readFileSync(join(logs, 'claude-retro-log.md'), 'utf8'), 'top');
  assert.equal(readFileSync(join(logs, 'pi-retro-log.md'), 'utf8'), 'nested');

  const second = bareHome(t);
  second.put('.halvard/repo/task/claude-report.md');
  second.put('.halvard/claude-retro-log.md', 'top');
  second.put('.halvard/retro-logs/claude-retro-log.md', 'other');
  assert.throws(() => migrate(second.home, true), /merge them by hand/);
  assert.equal(
    readFileSync(join(second.home, '.halvard/retro-logs/claude-retro-log.md'), 'utf8'),
    'other',
  );
});

test('migrate refuses a workspace override that holds the data root', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard/repo/task/claude-report.md');
  put('.halvard-factory/repo/jobs/one/job.json', '{}');
  process.env.HALVARD_WORKSPACE = join(home, '.halvard');
  assert.throws(() => migrate(home, true), /HALVARD_WORKSPACE is .* or holds it/);
  assert.equal(existsSync(join(home, '.halvard-factory/repo/jobs/one/job.json')), true);
  assert.equal(existsSync(join(home, '.halvard/factory')), false);
});

test('migrate refuses to move parts into a root holding unknown files', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard/stray.txt');
  put('.config/halvard/personal.json', '{}');
  process.env.HALVARD_WORKSPACE = join(home, 'ws');
  assert.throws(() => migrate(home), /not Halvard's new layout/);
  assert.equal(existsSync(join(home, '.halvard/config')), false);
});

test('a stop between the marker and the last move finishes on the next run', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard/.layout', '2\n');
  put('.halvard/.workspace.next/workspace/task/claude-report.md', 'repo named workspace');
  assert.equal(rootIsCurrent(home), false);
  migrate(home, true);
  assert.equal(
    readFileSync(join(home, '.halvard/workspace/workspace/task/claude-report.md'), 'utf8'),
    'repo named workspace',
  );
  assert.equal(rootIsCurrent(home), true);
  assert.deepEqual(migrationPlan(home), []);
});

test('a factory worktree under the factory folder stays writable as project files', async (t) => {
  const factory = join(process.env.HALVARD_DATA!, 'factory/repo/worktrees');
  mkdirSync(factory, { recursive: true });
  const root = realpathSync(mkdtempSync(join(factory, 'repo-one-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=feature/job'], { cwd: root });
  writeFileSync(join(root, '.halvard.json'), JSON.stringify({ version: 1 }));
  const patch = await handle('codex', {
    cwd: root,
    session_id: 'worktree',
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch' },
  });
  assert.notEqual(patch.decision, 'deny', patch.reason);
  assert.equal(shellKind(`echo x > ${join(root, 'a.ts')}`, [], root, root), 'mutation');
});

test('a relative shell redirect into Halvard data stops for approval', (t) => {
  const root = repository(t);
  const settings = process.env.HALVARD_HOME!;
  const relative = join('..', settings.split('/').pop()!, 'personal.json');
  // The repository and the settings folder both sit in the temp directory.
  assert.equal(dirname(root), dirname(settings));
  assert.equal(shellKind(`echo x > ${relative}`, [], root, root), 'opaque');
});

test('a retro log clash stops migrate before anything moves', (t) => {
  const { home, put } = bareHome(t);
  put('.halvard/repo/task/claude-report.md');
  put('.halvard/claude-retro-log.md', 'top');
  put('.halvard/retro-logs/claude-retro-log.md', 'nested');
  assert.throws(() => migrate(home, true), /merge them by hand/);
  assert.equal(existsSync(join(home, '.halvard/.workspace.next')), false);
  assert.equal(existsSync(join(home, '.halvard/repo/task/claude-report.md')), true);
  assert.equal(workspaceRoot(home), join(home, '.halvard'));
});

test('a repository that holds the data folder does not make it project files', (t) => {
  const { home } = bareHome(t);
  process.env.HALVARD_DATA = join(home, '.halvard');
  execFileSync('git', ['init', '-q', '--initial-branch=feature/home'], { cwd: home });
  writeFileSync(join(home, '.halvard.json'), JSON.stringify({ version: 1 }));
  const target = join(home, '.halvard/config/personal.json');
  assert.equal(shellKind(`echo x > ${target}`, [], home, home), 'opaque');
  return handle('claude', {
    cwd: home,
    session_id: 'home',
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: target, content: 'x' },
  }).then((result) => assert.equal(result.decision, 'deny'));
});
