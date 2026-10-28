import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { pluginRoot, quote } from '../core/shared/plugin.ts';
import { runGate } from '../core/workflow/gate.ts';
import { sessionKey, fingerprint, withState } from '../core/state.ts';
import { loadProject } from '../core/project.ts';
import { startTask } from '../core/workflow/tasks.ts';
import { fixture, call } from './hook-fixture.ts';

test('failed and source-mutating gates never grant a receipt', async (t) => {
  for (const code of ['process.exit(1)', "require('fs').writeFileSync('source.txt','changed')"]) {
    const root = fixture(t, { gate: [process.execPath, '-e', code] });
    await assert.rejects(runGate(root, sessionKey(root, 'codex', randomUUID())), /gate failed/);
  }
});

test('a gate inside a pipeline, chain or redirect is refused before it loses its receipt', async (t) => {
  const root = fixture(t);
  execFileSync('git', ['checkout', '-q', '-b', 'feature/gate'], { cwd: root });
  const runner = `node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))}`;
  const gate = `${runner} gate ${sessionKey(root, 'claude', 'test-session')}`;
  for (const command of [
    `${gate} | tail -8`,
    `${gate} 2>&1 | tail -8`,
    `${gate} && echo done`,
    `${gate} > gate.log`,
  ]) {
    const result = await call(root, 'claude', 'PreToolUse', 'Bash', { command });
    assert.equal(result.decision, 'deny', command);
    assert.match(result.reason!, /plain command on its own/, command);
  }
  for (const command of [gate, `${gate} 2>&1`, 'grep -n "halvard.ts gate" docs/usage.md']) {
    const result = await call(root, 'claude', 'PreToolUse', 'Bash', { command });
    assert.doesNotMatch(result.reason ?? '', /plain command on its own/, command);
  }
});

test('the gate prints one line per step and the failing tail, and logs everything', async (t) => {
  const node = process.execPath;
  const noisy = "for (let i = 0; i < 100; i++) console.log('noisy line ' + i)";
  const failing = "console.log('failing out'); console.error('failing err'); process.exit(3)";
  const root = fixture(t, {
    gate: [
      [node, '-e', noisy],
      [node, '-e', failing],
      [node, '-e', "console.log('never runs')"],
    ],
  });
  const key = sessionKey(root, 'codex', randomUUID());
  const printed: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => printed.push(text));
  await assert.rejects(runGate(root, key), /gate failed: checks failed or timed out/);
  t.mock.restoreAll();
  const output = printed.join('');
  const log = output.match(/^workflow: full gate log (.+)$/m)![1]!;
  assert.match(
    log.slice(join(process.env.HALVARD_WORKSPACE!, basename(root)).length),
    new RegExp(`^/gate-${key.slice(0, 12)}-[0-9a-f]{8}\\.log$`),
  );
  assert.equal(
    output,
    [
      'workflow: gate steps',
      output.match(/^  pass  .+ \(\d+\.\ds\)$/m)![0],
      output.match(/^  FAIL  .+ \(exit 3, \d+\.\ds\)$/m)![0],
      `  skip  ${node} -e console.log('never runs')`,
      `workflow: last 40 lines of ${node} -e ${failing}`,
      `$ ${node} -e ${failing}\nfailing out\nfailing err`,
      `workflow: full gate log ${log}`,
      '',
    ].join('\n'),
  );
  assert.ok(output.includes(`  pass  ${node} -e ${noisy} (`));
  assert.doesNotMatch(output, /noisy line \d/);
  const full = readFileSync(log, 'utf8');
  for (let i = 0; i < 100; i++) assert.ok(full.includes(`noisy line ${i}\n`), `line ${i}`);
  assert.match(full, /failing out\nfailing err\n/);
  assert.doesNotMatch(full, /never runs/);
  assert.equal(await withState(realpathSync(root), key, (state) => state.pass), null);
});

test('a passing step-list gate grants the receipt and logs to the task workspace', async (t) => {
  const root = fixture(t, {
    gate: [
      [process.execPath, '-e', "console.log('first')"],
      [process.execPath, '-e', "console.log('second')"],
    ],
  });
  for (const args of [
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
    ['branch', 'main'],
  ]) {
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { cwd: root },
    );
  }
  const started = startTask(root, { id: 'steps', title: 'Steps', author: 'codex' });
  const key = sessionKey(root, 'codex', randomUUID());
  const printed: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => printed.push(text));
  await runGate(root, key);
  t.mock.restoreAll();
  const output = printed.join('');
  assert.equal(output.match(/^  pass  /gm)?.length, 2);
  assert.match(output, /\nworkflow: gate passed on the current tree\n$/);
  assert.doesNotMatch(output, /last 40 lines/);
  const log = output.match(/^workflow: full gate log (.+)$/m)![1]!;
  assert.ok(log.startsWith(join(started.workspace, `gate-${key.slice(0, 12)}-`)));
  assert.match(readFileSync(log, 'utf8'), /first\n[^]*second\n/);
  assert.equal(
    (await withState(realpathSync(root), key, (state) => state.pass))?.tree,
    fingerprint(root),
  );
});

test('the gate tail holds the last 40 whole lines however long they are', async (t) => {
  const long =
    "for (let i = 0; i < 50; i++) console.log(i + ':' + 'x'.repeat(8000)); process.exit(1)";
  const root = fixture(t, { gate: [[process.execPath, '-e', long]] });
  const printed: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => printed.push(text));
  await assert.rejects(runGate(root, sessionKey(root, 'codex', randomUUID())), /gate failed/);
  t.mock.restoreAll();
  const tail = printed
    .join('')
    .split('\n')
    .filter((line) => /^\d+:x+$/.test(line));
  assert.deepEqual(
    tail.map((line) => line.split(':')[0]),
    Array.from({ length: 40 }, (_, i) => String(i + 10)),
  );
  assert.ok(tail.every((line) => line.length === line.indexOf(':') + 8001));
  // Trailing blank lines and spaces are output too.
  const blank = fixture(t, {
    gate: [
      [
        process.execPath,
        '-e',
        "console.log('keep  '); console.log('\\n'.repeat(38)); process.exit(1)",
      ],
    ],
  });
  const lines: string[] = [];
  t.mock.method(process.stdout, 'write', (text: string) => lines.push(text));
  await assert.rejects(runGate(blank, sessionKey(blank, 'codex', randomUUID())), /gate failed/);
  t.mock.restoreAll();
  assert.ok(lines.join('').includes(`lines of ${process.execPath} -e console.log('keep  ');`));
  assert.ok(lines.join('').includes(`\nkeep  ${'\n'.repeat(39)}\nworkflow: full gate log `));
});

test('overlapping gates keep a log each and an unsafe repository folder is refused', async (t) => {
  const root = fixture(t, {
    gate: [
      [process.execPath, '-e', "console.log('run ' + process.ppid); setTimeout(() => {}, 1500)"],
    ],
  });
  const key = sessionKey(root, 'codex', randomUUID());
  const gate = () =>
    new Promise<string>((done) => {
      const child = spawn(process.execPath, [join(pluginRoot, 'bin/halvard.ts'), 'gate', key], {
        cwd: root,
      });
      let output = '';
      child.stdout.on('data', (bytes: Buffer) => (output += bytes));
      child.on('close', () => done(output));
    });
  const outputs = await Promise.all([gate(), gate()]);
  const logs = outputs.map((output) => output.match(/^workflow: full gate log (.+)$/m)![1]!);
  assert.notEqual(logs[0], logs[1]);
  const runs = logs.map((log) => readFileSync(log, 'utf8').match(/^run (\d+)$/m)![1]);
  assert.notEqual(runs[0], runs[1]);
  const other = fixture(t);
  const elsewhere = mkdtempSync(join(tmpdir(), 'workflow-gate-elsewhere-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  symlinkSync(elsewhere, join(process.env.HALVARD_WORKSPACE!, basename(other)));
  await assert.rejects(runGate(other, sessionKey(other, 'codex', randomUUID())), /unsafe/);
});

test('gate step lists reject empty steps and protect interpreter scripts', (t) => {
  assert.throws(
    () => loadProject(fixture(t, { gate: [['npm', 'test'], []] })),
    /gate step is empty/,
  );
  assert.throws(() => loadProject(fixture(t, { gate: [['npm', 'test'], 'lint'] })), /gate step/);
  const root = fixture(t, {
    gate: [
      ['npm', 'test'],
      [process.execPath, 'check.js'],
    ],
  });
  writeFileSync(join(root, 'check.js'), '');
  assert.deepEqual(loadProject(root).config.gate, [
    ['npm', 'test'],
    [process.execPath, 'check.js'],
  ]);
});
