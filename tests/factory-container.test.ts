import type { TestContext } from 'node:test';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
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
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { factoryConfig } from '../core/flow-config.ts';
import { boxCommand } from '../core/factory/container.ts';
import { factoryCommand } from '../core/factory/pipeline.ts';
import { jobEvents } from '../core/factory/board.ts';
import { loadJob } from '../core/factory/store.ts';
import { pluginRoot } from '../core/runtime.ts';
import { env, repo, stubs } from './factory-stubs.ts';

const STUB_ENV = [
  'STUB_LOG',
  'STUB_AGENT',
  'STUB_REVIEW',
  'STUB_TESTS',
  'STUB_SLEEP',
  'STUB_VICTIM',
];

function containerRepo(
  t: TestContext,
  container: Record<string, unknown> = {},
  factory = {},
  config = {},
) {
  return repo(t, {
    ...config,
    factory: {
      author: 'claude',
      reviewers: ['grok'],
      container: {
        image: 'halvard-factory-test',
        runner: join(pluginRoot, 'bin/halvard.ts'),
        env: STUB_ENV,
        ...container,
      },
      ...factory,
    },
  });
}

const brief = (t: TestContext, root: string) => {
  const file = join(root, '..', `brief-${basename(root)}.md`);
  writeFileSync(file, 'Make source.txt say implemented.');
  t.after(() => rmSync(file, { force: true }));
  return file;
};

test('the container block validates strictly', () => {
  const config = factoryConfig({ container: { image: 'example/factory:1' } }).container!;
  assert.equal(config.network, 'none');
  assert.equal(config.runner, '/opt/halvard/bin/halvard.ts');
  assert.ok(config.env.includes('ANTHROPIC_API_KEY'));
  assert.deepEqual(
    factoryConfig({
      container: {
        image: 'x',
        mounts: ['/home/me/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro'],
      },
    }).container!.mounts,
    [
      {
        host: '/home/me/.claude/.credentials.json',
        container: '/home/node/.claude/.credentials.json',
        readonly: true,
      },
    ],
  );
  for (const bad of [
    {},
    { image: 'Bad Image' },
    { image: 'x', network: 'host' },
    { image: 'x', env: ['GH TOKEN'] },
    { image: 'x', mounts: ['relative:/x'] },
    { image: 'x', mounts: ['/a:/b:rw'] },
    { image: 'x', runner: 'bin/halvard.ts' },
    { image: 'x', memory: 'lots' },
    { image: 'x', unknown: 1 },
  ]) {
    assert.throws(
      () => factoryConfig({ container: bad }),
      /factory container/,
      JSON.stringify(bad),
    );
  }
  assert.throws(() => factoryConfig({ concurrency: 5 }), /concurrency/);
});

test('docker run drops capabilities, keeps paths, and passes variables by name only', () => {
  const config = factoryConfig({
    container: {
      image: 'img',
      network: 'factory-egress',
      memory: '4g',
      cpus: 2,
      env: ['XAI_API_KEY'],
    },
  }).container!;
  const argv = boxCommand(
    config,
    'halvard-x',
    {
      workdir: '/w/repo',
      mounts: [
        { path: '/w/repo', readonly: false },
        { path: '/p', readonly: true },
      ],
      env: ['TMPDIR'],
    },
    ['node', 'run.ts'],
  );
  const after = (flag: string) => argv[argv.indexOf(flag) + 1];
  assert.equal(argv[0], 'docker');
  assert.ok(argv.includes('type=bind,src=/w/repo,dst=/w/repo'));
  assert.ok(argv.includes('type=bind,src=/p,dst=/p,readonly'));
  assert.equal(after('--cap-drop'), 'ALL');
  assert.equal(after('--security-opt'), 'no-new-privileges');
  assert.equal(after('--network'), 'factory-egress');
  assert.equal(after('--memory'), '4g');
  assert.equal(after('-w'), '/w/repo');
  assert.deepEqual(
    argv.flatMap((arg, i) => (argv[i - 1] === '-e' ? [arg] : [])),
    ['TMPDIR', 'XAI_API_KEY'],
  );
  // Names only: a value never appears on the command line.
  assert.equal(
    argv.some((arg, i) => argv[i - 1] === '-e' && arg.includes('=')),
    false,
  );
  assert.deepEqual(argv.slice(-3), ['img', 'node', 'run.ts']);
});

test('container mode runs every step in a container on a standalone clone', async (t) => {
  const root = containerRepo(t);
  const calls = stubs(t);
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Boxed',
    '--id',
    'boxed',
    '--no-push',
  ]);
  const job = loadJob(root, 'boxed');
  assert.equal(job.stage, 'committed', JSON.stringify(job.parked));
  // A clone, not a worktree: its Git directory is its own.
  assert.equal(lstatSync(join(job.worktree!, '.git')).isDirectory(), true);
  assert.match(
    execFileSync('git', ['log', '-1', '--format=%s'], { cwd: job.worktree!, encoding: 'utf8' }),
    /Boxed/,
  );
  assert.equal(
    execFileSync('git', ['remote'], { cwd: job.worktree!, encoding: 'utf8' }).trim(),
    '',
  );
  const runs = calls.docker().filter((args) => args[0] === 'run' && args.includes('--name'));
  // Every step runs the image by the id whose Halvard version was checked.
  const steps = runs.map((args) => args.slice(args.indexOf('sha256:stub') + 1));
  assert.ok(
    runs.every((args) => args.includes('sha256:stub') && !args.includes('halvard-factory-test')),
  );
  for (const step of ['gate', 'review', 'task-done']) {
    assert.ok(
      steps.some((argv) => argv[2] === step),
      `${step} ran in a container`,
    );
  }
  assert.ok(
    steps.some((argv) => argv[0] === 'claude'),
    'the agent ran in a container',
  );
  for (const args of runs) {
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  }
  // The agent's container gets neither the receipts folder nor the runner's GitHub token.
  const agentRun = runs.find((args) => args.includes('claude'))!;
  const state = join(process.env.HALVARD_FACTORY_HOME!, basename(root), 'jobs/boxed/state');
  assert.equal(
    agentRun.some((arg) => arg.startsWith(state)),
    false,
  );
  const gateRun = runs.find((args) => args.includes('gate'))!;
  assert.ok(gateRun.includes(`type=bind,src=${state},dst=${state}`));
  // Every container gets the clone's Git directory read-only.
  for (const args of runs.filter((args) => !args.includes('--version'))) {
    assert.ok(
      args.some(
        (arg) => arg === `type=bind,src=${job.worktree}/.git,dst=${job.worktree}/.git,readonly`,
      ),
      args.join(' '),
    );
  }
  const agent = calls().find((call) => !call.reviewer)!;
  assert.equal(agent.ghToken, null);
  assert.equal(agent.unattended, '1');
  assert.equal(realpathSync(agent.cwd), realpathSync(job.worktree!));
});

test('a different Halvard in the image parks the job before any agent runs', async (t) => {
  const root = containerRepo(t, { runner: '/elsewhere/bin/halvard.ts' });
  const calls = stubs(t);
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Old',
    '--id',
    'old',
    '--no-push',
  ]);
  const job = loadJob(root, 'old');
  assert.equal(job.parked!.reason, 'infra');
  assert.match(job.parked!.detail, /cannot run its Halvard runner/);
  assert.equal(calls().length, 0);
});

test('serve runs jobs side by side up to its concurrency', async (t) => {
  const root = repo(t, { factory: { author: 'claude', reviewers: ['grok'], concurrency: 2 } });
  const calls = stubs(t);
  calls.github.permission('maintainer', 'write');
  for (const number of [1, 2]) {
    calls.github.issue(number, `Small ${number}`);
    calls.github.label(number, 'factory', 'maintainer');
    calls.github.label(number, 'factory:small', 'maintainer');
  }
  env(t, { STUB_SLEEP: '1500' });
  await factoryCommand(root, ['serve', '--once']);
  const one = jobEvents(root, 'issue-1');
  const two = jobEvents(root, 'issue-2');
  assert.equal(loadJob(root, 'issue-1').stage, 'committed');
  assert.equal(loadJob(root, 'issue-2').stage, 'committed');
  // The second job started before the first one committed.
  const started = Date.parse(two.find((event) => event.event === 'started')!.at);
  const committed = Date.parse(one.find((event) => event.event === 'committed')!.at);
  assert.ok(started < committed, `${started} < ${committed}`);
});

// Runs a job in real containers. Needs a running Docker daemon and the node:22 image,
// which carries Git; set HALVARD_DOCKER_TEST=1 to run it.
test(
  'a job runs in real Docker containers',
  { skip: process.env.HALVARD_DOCKER_TEST !== '1' },
  async (t) => {
    const calls = stubs(t);
    const context = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-factory-image-')));
    t.after(() => rmSync(context, { recursive: true, force: true }));
    cpSync(pluginRoot, join(context, 'halvard'), {
      recursive: true,
      filter: (path) => !/node_modules|\.git$/.test(path),
    });
    mkdirSync(join(context, 'bin'));
    for (const name of ['claude', 'grok']) {
      writeFileSync(
        join(context, 'bin', name),
        calls.script.replace(/^#!.*/, '#!/usr/bin/env node'),
        {
          mode: 0o755,
        },
      );
    }
    writeFileSync(
      join(context, 'Dockerfile'),
      'FROM node:22\nCOPY halvard /opt/halvard\nCOPY bin/ /usr/local/bin/\n',
    );
    const built = spawnSync('docker', ['build', '-q', '-t', 'halvard-factory-test', context], {
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH!.split(':').slice(1).join(':') },
    });
    assert.equal(built.status, 0, built.stderr);
    // The real docker CLI, not the stub, from here on.
    env(t, { PATH: process.env.PATH!.split(':').slice(1).join(':') });
    // A linked personal settings file and a personal excludes file exist only on the host;
    // the fingerprints on both sides must still agree.
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-factory-personal-')));
    t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
    writeFileSync(join(elsewhere, 'personal.json'), '{"readCommands": []}');
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-factory-halvard-home-')));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    execFileSync('ln', ['-s', join(elsewhere, 'personal.json'), join(home, 'personal.json')]);
    writeFileSync(
      join(elsewhere, 'gitconfig'),
      `[core]\n\texcludesFile = ${join(elsewhere, 'ignore')}\n`,
    );
    writeFileSync(join(elsewhere, 'ignore'), '*.log\n');
    env(t, {
      HALVARD_HOME: home,
      GIT_CONFIG_GLOBAL: join(elsewhere, 'gitconfig'),
      STUB_AGENT: 'log',
    });
    // The gate runs in the image, so it names the image's node.
    const root = containerRepo(
      t,
      { runner: '/opt/halvard/bin/halvard.ts', env: ['STUB_AGENT'] },
      {},
      { gate: ['node', '-e', 'process.exit(0)'] },
    );
    await factoryCommand(root, [
      'run',
      '--brief',
      brief(t, root),
      '--title',
      'Real',
      '--id',
      'real',
      '--no-push',
    ]);
    const job = loadJob(root, 'real');
    assert.equal(job.stage, 'committed', JSON.stringify(job.parked));
    assert.equal(
      readFileSync(join(job.worktree!, 'source.txt'), 'utf8'),
      'original\nimplemented\n',
    );
    assert.equal(existsSync(join(job.worktree!, '.git', 'config')), true);
  },
);

test('container mode works with an origin remote and pushes from the host', async (t) => {
  const root = containerRepo(t);
  const origin = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-factory-origin-')));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: root });
  // The main checkout sits on another branch; the job still starts from origin/main.
  execFileSync('git', ['switch', '-qc', 'elsewhere'], { cwd: root });
  stubs(t);
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Pushed',
    '--id',
    'pushed',
  ]);
  const job = loadJob(root, 'pushed');
  assert.equal(job.stage, 'pr-open', JSON.stringify(job.parked));
  assert.match(
    execFileSync('git', ['show', 'feature/pushed:source.txt'], { cwd: origin, encoding: 'utf8' }),
    /implemented/,
  );
  assert.equal(
    execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
    'elsewhere',
  );
});

test("a link left in the clone's Git directory parks the job before Git runs on the host", async (t) => {
  const root = containerRepo(t);
  stubs(t);
  const victim = join(root, '..', `victim-${basename(root)}`);
  writeFileSync(victim, 'untouched\n');
  t.after(() => rmSync(victim, { force: true }));
  env(t, { STUB_AGENT: 'gitlink', STUB_VICTIM: victim });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Escape',
    '--id',
    'escape',
    '--no-push',
  ]);
  const job = loadJob(root, 'escape');
  assert.equal(job.parked!.reason, 'tampered');
  assert.match(job.parked!.detail, /COMMIT_EDITMSG in the clone's Git directory/);
  assert.equal(readFileSync(victim, 'utf8'), 'untouched\n');
});

test('docker failing the gate parks the job as infrastructure, not as a gate failure', async (t) => {
  const root = containerRepo(t);
  const calls = stubs(t);
  env(t, { STUB_DOCKER_FAIL: 'gate' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Daemon',
    '--id',
    'daemon',
    '--no-push',
  ]);
  const job = loadJob(root, 'daemon');
  assert.equal(job.parked!.reason, 'infra');
  assert.match(job.parked!.detail, /gate container did not run/);
  assert.equal(job.fixPasses, 0);
  assert.equal(calls().filter((call) => !call.reviewer).length, 1);
});

test('mounts that reach runner-owned paths are refused, and listed variables reach the agent', async (t) => {
  const calls = stubs(t);
  const owned = containerRepo(t, { mounts: [`${process.env.HALVARD_FACTORY_HOME}:/factory`] });
  await assert.rejects(factoryCommand(owned, ['status']), /overlaps .* which the runner owns/);
  await assert.rejects(
    factoryCommand(containerRepo(t, { mounts: ['/var/run/docker.sock:/var/run/docker.sock'] }), [
      'status',
    ]),
    /overlaps \/var\/run/,
  );
  // A link under an owned folder reaches it by its name even when it points elsewhere, as
  // Docker Desktop's /var/run/docker.sock does.
  const elsewhere = mkdtempSync(join(tmpdir(), 'halvard-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  mkdirSync(process.env.HALVARD_FACTORY_HOME!, { recursive: true });
  const link = join(process.env.HALVARD_FACTORY_HOME!, 'elsewhere');
  symlinkSync(elsewhere, link);
  await assert.rejects(
    factoryCommand(containerRepo(t, { mounts: [`${link}:/elsewhere`] }), ['status']),
    /overlaps .* which the runner owns/,
  );
  // A link further up the name hides the owned folder just the same, also when the last
  // name is itself a link.
  mkdirSync(join(elsewhere, 'sub'));
  const other = mkdtempSync(join(tmpdir(), 'halvard-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  symlinkSync(other, join(elsewhere, 'sub', 'out'));
  await assert.rejects(
    factoryCommand(containerRepo(t, { mounts: [`${link}/sub/out:/out`] }), ['status']),
    /overlaps .* which the runner owns/,
  );
  assert.throws(
    () => factoryConfig({ container: { image: 'x', env: ['PATH'] } }),
    /other than PATH/,
  );
  const root = containerRepo(t, { env: [...STUB_ENV, 'NPM_TOKEN'] });
  env(t, { NPM_TOKEN: 'listed-token' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Listed',
    '--id',
    'listed',
    '--no-push',
  ]);
  assert.equal(loadJob(root, 'listed').stage, 'committed');
  assert.equal(calls().find((call) => !call.reviewer)!.npmToken, 'listed-token');
});

test('a retry in container mode leaves a branch of the same name in the main checkout alone', async (t) => {
  const root = containerRepo(t);
  stubs(t);
  env(t, { STUB_AGENT: 'blocked' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Mine',
    '--id',
    'mine',
    '--no-push',
  ]);
  execFileSync('git', ['branch', 'feature/mine'], { cwd: root });
  env(t, { STUB_AGENT: undefined });
  await factoryCommand(root, ['build', 'mine', '--retry', '--no-push']);
  assert.equal(loadJob(root, 'mine').stage, 'committed');
  assert.equal(
    execFileSync('git', ['branch', '--list', 'feature/mine'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    'feature/mine',
  );
});

test('a nested repository in the clone parks the job before host Git can run its hooks', async (t) => {
  const root = containerRepo(t);
  stubs(t);
  const marker = join(root, '..', `fsmonitor-${basename(root)}`);
  t.after(() => rmSync(marker, { force: true }));
  env(t, { STUB_AGENT: 'nested', STUB_VICTIM: marker });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Nested',
    '--id',
    'nested',
    '--no-push',
  ]);
  const job = loadJob(root, 'nested');
  assert.equal(job.parked!.reason, 'tampered');
  assert.match(job.parked!.detail, /sub\/\.git is a nested repository/);
  assert.equal(existsSync(marker), false);
});

test('a repository in an ignored folder is no nested repository', async (t) => {
  const root = containerRepo(t);
  stubs(t);
  env(t, { STUB_AGENT: 'ignored-nested' });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Ignored',
    '--id',
    'ignored',
    '--no-push',
  ]);
  const job = loadJob(root, 'ignored');
  assert.equal(job.stage, 'committed', job.parked?.detail);
});

test('a base with a submodule parks as infra before any agent runs', async (t) => {
  const root = containerRepo(t);
  const calls = stubs(t);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${head},lib`], {
    cwd: root,
  });
  execFileSync('git', ['commit', '-qm', 'add a submodule'], { cwd: root });
  await factoryCommand(root, [
    'run',
    '--brief',
    brief(t, root),
    '--title',
    'Submodule',
    '--id',
    'submodule',
    '--no-push',
  ]);
  const job = loadJob(root, 'submodule');
  assert.equal(job.parked!.reason, 'infra');
  assert.match(job.parked!.detail, /submodule lib/);
  assert.equal(calls().length, 0);
});

test('GitHub and SSH variables never reach a container, and linked mounts are resolved', async (t) => {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) {
    assert.throws(
      () => factoryConfig({ container: { image: 'x', env: [name] } }),
      /GH_, GITHUB_ or SSH_/,
    );
  }
  stubs(t);
  const root = containerRepo(t);
  const link = join(root, '..', `link-${basename(root)}`);
  execFileSync('ln', ['-s', root, link]);
  t.after(() => rmSync(link, { force: true }));
  const config = JSON.parse(readFileSync(join(root, '.halvard.json'), 'utf8')) as {
    factory: { container: Record<string, unknown> };
  };
  config.factory.container.mounts = [`${link}:/work`];
  writeFileSync(join(root, '.halvard.json'), JSON.stringify(config));
  await assert.rejects(factoryCommand(root, ['status']), /overlaps .* which the runner owns/);
});
