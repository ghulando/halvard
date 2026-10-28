import './environment.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { HistoryProcess } from '../core/types.ts';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  applyClean,
  digestHistory,
  historyHarnesses,
  planClean,
  saveCleanPlan,
} from '../core/workflow/clean-history.ts';
import { skills } from '../core/context.ts';
import { loadProject } from '../core/project.ts';
import { pluginRoot } from '../core/shared/plugin.ts';

test('running harness prompt appends and new live children do not expand reviewed deletion', (t) => {
  const { put } = fixture(t);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  process.env.CLAUDE_CODE_SESSION_ID = id;
  const claude = put('.claude/history.jsonl');
  const codex = put('.codex/history.jsonl');
  const processes = [
    { pid: 1, comm: 'claude' },
    { pid: 2, comm: 'codex' },
  ];
  const file = saveCleanPlan(planClean({ harnesses: ['claude', 'codex'], processes }));
  for (const path of [claude, codex]) writeFileSync(path, 'history\nDELETE\n');
  const live = put(`.claude/session-env/${id}/data`);
  const newHistory = put('.claude/plans/new.md');
  const result = applyClean(file, 'DELETE', { processes });
  for (const path of [claude, codex]) assert.equal(existsSync(path), false);
  for (const path of [live, newHistory]) assert.equal(existsSync(path), true);
  assert.ok(result.appeared.some((entry) => entry.path.includes(id)));
  assert.ok(result.appeared.some((entry) => entry.path === newHistory));
  rmSync(file);
});

test('append-tolerant history still refuses truncation and replacement', (t) => {
  const { put } = fixture(t);
  for (const harness of ['claude', 'codex'] as const) {
    for (const replace of [false, true]) {
      const path = put(`.${harness}/history.jsonl`, 'original history');
      const processes = [{ pid: 1, comm: harness }];
      const file = saveCleanPlan(planClean({ harnesses: [harness], processes }));
      if (replace) {
        const replacement = put(`.${harness}/replacement`, 'longer replacement history');
        fs.renameSync(replacement, path);
      } else {
        writeFileSync(path, 'short');
      }
      const result = applyClean(file, 'DELETE', { processes });
      assert.ok(
        result.skipped.some((entry) => entry.path === path && /Changed/.test(entry.reason)),
      );
      assert.equal(existsSync(path), true);
      rmSync(file);
    }
  }
});

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'history-home-'));
  const keys = [
    'HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'HALVARD_WORKSPACE',
    'HALVARD_HOME',
    'CLAUDE_CODE_SESSION_ID',
    'PI_CODING_AGENT_DIR',
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  const values = [
    home,
    join(home, '.claude'),
    join(home, '.codex'),
    join(home, '.halvard'),
    join(home, '.config/halvard'),
  ];
  keys.forEach((key, i) => {
    if (values[i] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[i]!;
    }
  });
  t.after(() => {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[i];
      }
    });
    rmSync(home, { recursive: true, force: true });
  });
  const put = (path: string, content = 'history') => {
    const file = join(home, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  return { home, put };
}

test('live Claude preserves non-ID sidecars since the oldest mapped start or PID mtime', (t) => {
  const { put } = fixture(t);
  const now = Date.now();
  const oldest = now - 600000;
  put('.claude/sessions/123.json', JSON.stringify({ sessionId: 'live-one', startedAt: oldest }));
  const pid = put('.claude/sessions/456.json', JSON.stringify({ sessionId: 'live-two' }));
  utimesSync(pid, new Date(now - 300000), new Date(now - 300000));
  const old = ['shell-snapshots/snapshot-old.sh', 'plans/old.md'].map((part) =>
    put(`.claude/${part}`),
  );
  const recent = ['shell-snapshots/snapshot-recent.sh', 'plans/recent.md'].map((part) =>
    put(`.claude/${part}`),
  );
  for (const path of old) utimesSync(path, new Date(oldest - 1000), new Date(oldest - 1000));
  for (const path of recent) utimesSync(path, new Date(oldest), new Date(oldest));
  const processes = [
    { pid: 123, comm: 'claude' },
    { pid: 456, comm: 'claude' },
  ];
  const plan = planClean({ harnesses: ['claude'], processes });
  for (const path of recent) assert.ok(plan.keptLive.some((entry) => entry.path === path));
  const file = saveCleanPlan(plan);
  applyClean(file, 'DELETE', { processes });
  rmSync(file);
  for (const path of old) assert.equal(existsSync(path), false);
  for (const path of recent) assert.equal(existsSync(path), true);
  rmSync(put('.claude/sessions/123.json'));
  for (const path of recent) utimesSync(path, new Date(now - 400000), new Date(now - 400000));
  assert.equal(
    planClean({ harnesses: ['claude'], processes: [{ pid: 456, comm: 'claude' }] }).keptLive.filter(
      (entry) => recent.includes(entry.path),
    ).length,
    0,
  );
  const unmapped = planClean({ harnesses: ['claude'], processes: [{ pid: 999, comm: 'claude' }] });
  for (const path of recent) assert.ok(unmapped.keptLive.some((entry) => entry.path === path));
});

test('Pi override is used for cleanup and digest and unsafe overridden roots refuse', async (t) => {
  const { home, put } = fixture(t);
  const defaultFile = put('.pi/agent/sessions/default.jsonl');
  process.env.PI_CODING_AGENT_DIR = join(home, 'custom-pi');
  const custom = put(
    'custom-pi/sessions/custom.jsonl',
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'Custom prompt' } }),
  );
  assert.equal((await digestHistory({ harnesses: ['pi'] }))[0]!.firstPrompt, 'Custom prompt');
  const file = saveCleanPlan(planClean({ harnesses: ['pi'], processes: [] }));
  applyClean(file, 'DELETE', { processes: [] });
  rmSync(file);
  assert.equal(existsSync(defaultFile), true);
  assert.equal(existsSync(custom), false);
  process.env.PI_CODING_AGENT_DIR = home;
  assert.throws(() => planClean({ harnesses: ['pi'], processes: [] }), /Unsafe/);
  process.env.PI_CODING_AGENT_DIR = process.env.CODEX_HOME;
  assert.throws(() => planClean({ harnesses: ['pi'], processes: [] }), /overlap/);
});

test('Claude digest ignores subagents and sidechains and merges main transcript fragments', async (t) => {
  const { put } = fixture(t);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const record = (text: string, timestamp: string, extra = {}) =>
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: '/invented',
      timestamp,
      message: { content: text },
      ...extra,
    });
  put(
    `.claude/projects/repo/${id}/subagents/agent.jsonl`,
    record('Subagent task', '2026-01-01T00:00:00Z'),
  );
  put(
    `.claude/projects/repo/${id}.jsonl`,
    [
      record('Main prompt', '2026-01-02T00:00:00Z'),
      record('Sidechain', '2026-01-01T00:00:00Z', { isSidechain: true }),
    ].join('\n'),
  );
  put('.claude/projects/repo/fragment.jsonl', record('Main followup', '2026-01-03T00:00:00Z'));
  const digests = await digestHistory({ harnesses: ['claude'] });
  assert.equal(digests.length, 1);
  assert.equal(digests[0]!.firstPrompt, 'Main prompt');
  assert.equal(digests[0]!.promptCount, 2);
});

test('Codex digest filters injected native-shaped items and prefers real user events', async (t) => {
  const { put } = fixture(t);
  const item = (text: string) => ({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: { turn_id: 'invented', content_item_kinds: [] },
    },
  });
  const injected = [
    item('<environment_context>invented</environment_context>'),
    item('<user_instructions>invented</user_instructions>'),
    item('# AGENTS.md instructions for /invented'),
  ];
  const write = (name: string, records: unknown[]) =>
    put(
      `.codex/sessions/${name}.jsonl`,
      records.map((record) => JSON.stringify(record)).join('\n'),
    );
  write('fallback', [...injected, item('Fallback real prompt')]);
  write('events', [
    ...injected,
    item('Response duplicate'),
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Real event prompt', images: [] },
    },
    item('Second response duplicate'),
    {
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Real event followup', images: [] },
    },
  ]);
  const digests = await digestHistory({ harnesses: ['codex'] });
  const fallback = digests.find((value) => value.id === 'fallback')!;
  const events = digests.find((value) => value.id === 'events')!;
  assert.equal(fallback.firstPrompt, 'Fallback real prompt');
  assert.equal(fallback.promptCount, 1);
  assert.equal(events.firstPrompt, 'Real event prompt');
  assert.equal(events.promptCount, 2);
});

test('Codex protects thread sidecars with locks and all sidecars without identity', (t) => {
  const { put } = fixture(t);
  const live = '11111111-2222-3333-4444-555555555555';
  const stale = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const processes = [{ pid: 42, comm: 'codex' }];
  const lock = put(`.codex/thread-writer-locks/${live}.lock`);
  const liveFiles = [
    put(`.codex/shell_snapshots/${live}.0.sh`),
    put(`.codex/tui-thread-reference-capabilities/${live}`),
  ];
  const staleFiles = [
    put(`.codex/shell_snapshots/${stale}.1.sh`),
    put(`.codex/tui-thread-reference-capabilities/${stale}`),
  ];
  const plan = planClean({ harnesses: ['codex'], processes });
  for (const path of liveFiles) {
    assert.ok(
      plan.keptLive.some((entry) => entry.path === path && entry.reason === 'Live Codex thread'),
    );
  }
  const file = saveCleanPlan(plan);
  applyClean(file, 'DELETE', { processes });
  rmSync(file);
  for (const path of liveFiles) assert.equal(existsSync(path), true);
  for (const path of staleFiles) assert.equal(existsSync(path), false);
  rmSync(lock);
  const unknown = [
    put('.codex/shell_snapshots/unknown.sh'),
    put('.codex/tui-thread-reference-capabilities/unknown'),
  ];
  const withoutLock = planClean({ harnesses: ['codex'], processes });
  for (const path of [...liveFiles, ...unknown]) {
    assert.ok(
      withoutLock.keptLive.some(
        (entry) => entry.path === path && /identity unavailable/.test(entry.reason),
      ),
    );
  }
  const noIdentity = saveCleanPlan(withoutLock);
  applyClean(noIdentity, 'DELETE', { processes });
  rmSync(noIdentity);
  for (const path of [...liveFiles, ...unknown]) assert.equal(existsSync(path), true);
});

test('digest refuses the same unsafe and overlapping roots as planning', async (t) => {
  const { home } = fixture(t);
  const original = process.env.CLAUDE_CONFIG_DIR!;
  process.env.CLAUDE_CONFIG_DIR = home;
  await assert.rejects(digestHistory({ harnesses: ['claude'] }), /Unsafe/);
  process.env.CLAUDE_CONFIG_DIR = process.env.CODEX_HOME;
  await assert.rejects(digestHistory({ harnesses: ['claude'] }), /overlap/);
  process.env.CLAUDE_CONFIG_DIR = original;
  process.env.PI_CODING_AGENT_DIR = home;
  await assert.rejects(digestHistory({ harnesses: ['pi'] }), /Unsafe/);
});

test('history cleaning removes only chosen harnesses and always team workspaces', (t) => {
  const { home, put } = fixture(t);
  const history = put('.claude/projects/repo/session.jsonl');
  const memory = put('.claude/projects/repo/memory/MEMORY.md');
  const auth = put('.claude/.credentials.json');
  const globalMemory = put('.claude/memory/MEMORY.md');
  const cache = put('.claude/cache/data');
  const pi = put('.pi/agent/sessions/repo/session.jsonl');
  const team = put('.halvard/repo/task/codex-report.md');
  const plan = planClean({ harnesses: ['claude'], processes: [] });
  assert.ok(plan.entries.some((entry) => entry.path === join(home, '.claude/projects/repo')));
  const file = saveCleanPlan(plan);
  assert.throws(() => applyClean(file, 'yes', { processes: [] }), /DELETE/);
  applyClean(file, 'DELETE', { processes: [] });
  for (const removed of [history, memory, cache, team]) assert.equal(existsSync(removed), false);
  for (const kept of [auth, globalMemory, pi]) assert.equal(existsSync(kept), true);
  rmSync(file);
});

test('every allowlisted category is removed and unrelated payloads survive', (t) => {
  const { put } = fixture(t);
  const paths = [
    '.claude/history.jsonl',
    ...[
      'file-history',
      'shell-snapshots',
      'paste-cache',
      'plans',
      'session-env',
      'tasks',
      'todos',
      'debug',
      'cache',
      'image-cache',
      'backups',
      'telemetry',
      'downloads',
      'monitor',
      'jobs',
      'teams',
      'feedback',
      'ide',
    ].map((dir) => `.claude/${dir}/old/data`),
    ...[
      'mcp-needs-auth-cache.json',
      'stats-cache.json',
      'gh-pr-status-cache.json',
      'policy-limits.json',
      'policy-limits.json.stamp.json',
      'remote-settings.json',
      '.last-cleanup',
      '.last-update-result.json',
      '.DS_Store',
    ].map((file) => `.claude/${file}`),
    '.claude/cache/bin/data',
    '.claude/cache/settings.json',
    '.claude/backups/memory/data',
    '.codex/.tmp/plugins/data',
    '.codex/cache/skills/data',
    '.claude/ide/settings.json',
    '.claude/ide/bin/data',
    '.claude/file-history/old/settings.json',
    '.claude/security/security_warnings_state_old',
    '.claude/security/security_warnings_state_old.tmp',
    '.claude/security/log.txt',
    '.claude/security/agent-sdk-venv/bin/python',
    '.claude/security/security_warnings_state_1.json',
    '.claude/sessions/999999.json',
    '.claude/sessions/999999.hash.key',
    '.claude/sessions/999999.key',
    '.claude/projects/repo/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/subagents/agent.jsonl',
    '.claude/projects/repo/MEMORY.md',
    '.claude/projects/repo/memory/MEMORY.md',
    '.claude/projects/repo/unknown.txt',
    '.pi/agent/sessions/repo/old.jsonl',
    '.pi/agent/sessions/.DS_Store',
    '.pi/agent/.DS_Store',
    ...[
      'sessions',
      'archived_sessions',
      'shell_snapshots',
      'thread-writer-locks',
      'tui-thread-reference-capabilities',
      'cache',
      '.tmp',
      'tmp',
    ].map((dir) => `.codex/${dir}/old/data`),
    '.codex/history.jsonl',
    '.codex/session_index.jsonl',
    '.codex/models_cache.json',
    ...['logs_2', 'thread_history_1', 'state_5', 'goals_1', 'queue_1'].flatMap((db) =>
      ['', '-wal', '-shm'].map((suffix) => `.codex/${db}.sqlite${suffix}`),
    ),
    '.halvard/repo/task/.repo',
    '.halvard/repo/skills/codex-report.md',
  ];
  const removed = paths.map((path) => put(path));
  const kept = [
    '.claude/settings.json',
    '.claude/CLAUDE.md',
    '.claude/memory/MEMORY.md',
    '.claude/plugins/data',
    '.claude/plugins/cache/data',
    '.claude/skills/data',
    '.claude/hooks/data',
    '.claude/output-styles/data',
    '.claude/daemon/data',
    '.claude/security/other.json',
    '.claude/sessions/not-a-pid.json',
    '.pi/agent/auth.json',
    '.pi/agent/settings.json',
    '.pi/agent/bin/pi',
    '.codex/auth.json',
    '.codex/config.toml',
    '.codex/memories_1.sqlite',
    '.codex/memories_1.sqlite-wal',
    '.codex/memories_1.sqlite-shm',
    '.codex/packages/data',
    '.codex/unknown/data',
    '.config/halvard/personal.json',
  ].map((path) => put(path, path.endsWith('settings.json') ? '{}' : 'keep'));
  const file = saveCleanPlan(planClean({ harnesses: historyHarnesses('all'), processes: [] }));
  applyClean(file, 'DELETE', { processes: [] });
  for (const path of removed) assert.equal(existsSync(path), false, path);
  for (const path of kept) assert.equal(existsSync(path), true, path);
  rmSync(file);
});

test('Claude PID metadata and Codex writer locks protect live sessions and defer databases', (t) => {
  const { put } = fixture(t);
  const claudeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const codexId = '11111111-2222-3333-4444-555555555555';
  const live = [
    put(`.claude/projects/repo/${claudeId}.jsonl`),
    put(`.claude/projects/repo/${claudeId}/subagents/agent.jsonl`),
    ...['file-history', 'session-env', 'tasks', 'todos'].map((dir) =>
      put(`.claude/${dir}/${claudeId}/data`),
    ),
    put('.claude/sessions/123.json', JSON.stringify({ sessionId: claudeId })),
    put('.claude/sessions/123.hash.key'),
    put(`.codex/thread-writer-locks/${codexId}.lock`),
    put('.codex/thread-writer-locks/.coordination.lock'),
    put(`.codex/sessions/year/rollout-${codexId}.jsonl`),
    put(`.codex/tui-thread-reference-capabilities/${codexId}`),
  ];
  const db = put('.codex/state_5.sqlite');
  const stale = put('.codex/sessions/year/rollout-old.jsonl');
  const processes = [
    { pid: 123, comm: '/bin/claude' },
    { pid: 456, comm: 'codex' },
  ];
  const plan = planClean({ harnesses: ['claude', 'codex'], processes });
  assert.ok(plan.deferred.some((entry) => entry.path === db));
  const file = saveCleanPlan(plan);
  applyClean(file, 'DELETE', { processes });
  for (const path of live) assert.equal(existsSync(path), true, path);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(db), true);
  rmSync(file);
});

test('idle Pi keeps the newest stale transcript in each project and removes older history', (t) => {
  const { put } = fixture(t);
  const now = Date.now();
  const old = put('.pi/agent/sessions/repo/old.jsonl');
  const newest = put('.pi/agent/sessions/repo/newest.jsonl');
  const other = put('.pi/agent/sessions/another/only.jsonl');
  for (const path of [old, newest, other]) {
    const age = path === old ? 1200000 : 900000;
    utimesSync(path, new Date(now - age), new Date(now - age));
  }
  const processes = [{ pid: 42, comm: 'pi' }];
  const plan = planClean({ harnesses: ['pi'], processes, now });
  for (const path of [newest, other]) {
    assert.ok(plan.keptLive.some((entry) => entry.path === path && /newest/i.test(entry.reason)));
  }
  assert.ok(plan.entries.some((entry) => entry.path === old));
  const file = saveCleanPlan(plan);
  applyClean(file, 'DELETE', { processes, now });
  rmSync(file);
  assert.equal(existsSync(old), false);
  for (const path of [newest, other]) assert.equal(existsSync(path), true);
  const stopped = saveCleanPlan(planClean({ harnesses: ['pi'], processes: [], now }));
  applyClean(stopped, 'DELETE', { processes: [], now });
  rmSync(stopped);
  for (const path of [newest, other]) assert.equal(existsSync(path), false);
});

test('Pi retains recently modified sessions only while Pi runs', (t) => {
  const { put } = fixture(t);
  const recent = put('.pi/agent/sessions/repo/recent.jsonl');
  const old = put('.pi/agent/sessions/repo/old.jsonl');
  const now = Date.now();
  utimesSync(old, new Date(now - 700000), new Date(now - 700000));
  const plan = planClean({ harnesses: ['pi'], processes: [{ pid: 1, comm: 'pi' }], now });
  assert.ok(plan.keptLive.some((entry) => entry.path === recent));
  assert.ok(plan.entries.some((entry) => entry.path === old));
  assert.equal(planClean({ harnesses: ['pi'], processes: [], now }).keptLive.length, 0);
});

test('matched links are removed without following targets; linked roots are refused', (t) => {
  const { home, put } = fixture(t);
  const outside = put('outside/treasure.txt');
  const link = join(home, '.claude/projects/repo/link.jsonl');
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(outside, link);
  const dir = join(home, '.codex/sessions');
  mkdirSync(dirname(dir), { recursive: true });
  symlinkSync(join(home, 'outside'), dir);
  const file = saveCleanPlan(planClean({ harnesses: ['claude', 'codex'], processes: [] }));
  applyClean(file, 'DELETE', { processes: [] });
  assert.equal(existsSync(link), false);
  assert.equal(existsSync(dir), false);
  assert.equal(readFileSync(outside, 'utf8'), 'history');
  rmSync(file);
  process.env.CLAUDE_CONFIG_DIR = join(home, 'alias');
  symlinkSync(join(home, '.claude'), process.env.CLAUDE_CONFIG_DIR);
  assert.throws(() => planClean({ harnesses: ['claude'], processes: [] }), /symlink/);
});

test('overlapping personal data and configured global memory cannot be swept', (t) => {
  const { home, put } = fixture(t);
  process.env.HALVARD_HOME = join(home, '.claude/plans/personal');
  const personal = put('.claude/plans/personal/personal.json');
  const report = put('.halvard/repo/task/codex-report.md');
  put(
    '.claude/settings.json',
    JSON.stringify({ autoMemoryDirectory: join(home, '.claude/paste-cache/global-memory') }),
  );
  const memory = put('.claude/paste-cache/global-memory/facts.md');
  const stale = put('.claude/paste-cache/old.txt');
  const file = saveCleanPlan(planClean({ harnesses: ['claude'], processes: [] }));
  applyClean(file, 'DELETE', { processes: [] });
  for (const path of [personal, memory]) assert.equal(existsSync(path), true);
  for (const path of [report, stale]) assert.equal(existsSync(path), false);
  rmSync(file);
});

test('changed and newly live entries are skipped while the rest are removed', (t) => {
  const { put } = fixture(t);
  const child = put('.pi/agent/sessions/repo/old.jsonl');
  const other = put('.pi/agent/sessions/other/old.jsonl');
  const file = saveCleanPlan(planClean({ harnesses: ['pi'], processes: [] }));
  assert.equal(lstatSync(file).mode & 0o077, 0);
  writeFileSync(child, 'changed history');
  const result = applyClean(file, 'DELETE', { processes: [] });
  assert.deepEqual(
    result.skipped.map((entry) => [entry.path, entry.reason]),
    [[dirname(child), 'Changed since preview']],
  );
  assert.equal(existsSync(child), true);
  assert.equal(existsSync(other), false);
  rmSync(file);
  const liveFile = saveCleanPlan(planClean({ harnesses: ['pi'], processes: [] }));
  const live = applyClean(liveFile, 'DELETE', { processes: [{ pid: 42, comm: 'pi' }] });
  assert.ok(live.skipped.some((entry) => /Now live/.test(entry.reason)));
  assert.equal(existsSync(child), true);
  rmSync(liveFile);
});

test('a new transcript skips only its own Pi project and Claude project folders go whole', (t) => {
  const { home, put } = fixture(t);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  process.env.CLAUDE_CODE_SESSION_ID = id;
  const busy = put('.pi/agent/sessions/busy/old.jsonl');
  const idle = put('.pi/agent/sessions/idle/old.jsonl');
  const live = put(`.claude/projects/repo/${id}.jsonl`);
  const stale = [
    put('.claude/projects/repo/old.jsonl'),
    put('.claude/projects/repo/memory/MEMORY.md'),
    put('.claude/projects/gone/memory/MEMORY.md'),
  ];
  const file = saveCleanPlan(planClean({ harnesses: ['claude', 'pi'], processes: [] }));
  const fresh = put('.pi/agent/sessions/busy/new.jsonl');
  const result = applyClean(file, 'DELETE', { processes: [] });
  assert.deepEqual(
    result.skipped.map((entry) => entry.path),
    [dirname(busy)],
  );
  for (const path of [busy, fresh, live]) assert.equal(existsSync(path), true, path);
  for (const path of [idle, ...stale]) assert.equal(existsSync(path), false, path);
  assert.equal(existsSync(join(home, '.claude/projects/gone')), false);
  rmSync(file);
});

test('IDE locks stay while their recorded process runs', (t) => {
  const { put } = fixture(t);
  const held = put('.claude/ide/1111.lock', JSON.stringify({ pid: 77 }));
  const stale = put('.claude/ide/2222.lock', JSON.stringify({ pid: 78 }));
  const garbled = put('.claude/ide/3333.lock', 'not json');
  const processes = [{ pid: 77, comm: 'Code Helper' }];
  const plan = planClean({ harnesses: ['claude'], processes });
  assert.ok(plan.keptLive.some((entry) => entry.path === held && /IDE lock/.test(entry.reason)));
  const file = saveCleanPlan(plan);
  applyClean(file, 'DELETE', { processes });
  rmSync(file);
  assert.equal(existsSync(held), true);
  for (const path of [stale, garbled]) assert.equal(existsSync(path), false);
});

test('overridden workspace roots do not bypass harness allowlists or database deferral', (t) => {
  const { home, put } = fixture(t);
  process.env.HALVARD_WORKSPACE = join(home, '.codex');
  const db = put('.codex/state_5.sqlite');
  const config = put('.codex/config.toml');
  const data = put('.codex/sessions/year/old.jsonl');
  assert.throws(
    () => planClean({ harnesses: ['pi'], processes: [{ pid: 123, comm: 'codex' }] }),
    /overlap/,
  );
  for (const path of [db, config, data]) assert.equal(existsSync(path), true);
});

test('unsafe roots, ancestors and overlapping roots are refused before planning', (t) => {
  const { home } = fixture(t);
  const originalClaude = process.env.CLAUDE_CONFIG_DIR!;
  const originalWorkspace = process.env.HALVARD_WORKSPACE!;
  for (const unsafe of [home, dirname(home), '/']) {
    process.env.CLAUDE_CONFIG_DIR = unsafe;
    assert.throws(
      () => planClean({ harnesses: ['claude'], processes: [] }),
      /unsafe|home|ancestor/i,
    );
    process.env.CLAUDE_CONFIG_DIR = originalClaude;
    process.env.HALVARD_WORKSPACE = unsafe;
    assert.throws(() => planClean({ harnesses: ['pi'], processes: [] }), /unsafe|home|ancestor/i);
    process.env.HALVARD_WORKSPACE = originalWorkspace;
  }
  process.env.CLAUDE_CONFIG_DIR = process.env.CODEX_HOME;
  assert.throws(() => planClean({ harnesses: ['claude', 'codex'], processes: [] }), /overlap/);
  process.env.CLAUDE_CONFIG_DIR = join(process.env.CODEX_HOME!, 'nested');
  assert.throws(() => planClean({ harnesses: ['claude'], processes: [] }), /overlap/);
  process.env.CLAUDE_CONFIG_DIR = originalClaude;
  process.env.HALVARD_WORKSPACE = dirname(process.env.HALVARD_HOME!);
  assert.throws(() => planClean({ harnesses: ['pi'], processes: [] }), /personal/i);
  process.env.HALVARD_WORKSPACE = process.env.HALVARD_HOME;
  assert.throws(() => planClean({ harnesses: ['pi'], processes: [] }), /personal/i);
  process.env.HALVARD_WORKSPACE = originalWorkspace;
  const alias = join(home, 'home-alias');
  symlinkSync(home, alias);
  process.env.CLAUDE_CONFIG_DIR = join(alias, 'missing', '..');
  assert.throws(() => planClean({ harnesses: ['claude'], processes: [] }), /unsafe|home|ancestor/i);
});

test('summary folders and their real paths may never lie inside cleanup roots', (t) => {
  const { home } = fixture(t);
  const summary = join(home, 'agent-history-summaries');
  process.env.CLAUDE_CONFIG_DIR = summary;
  assert.throws(() => planClean({ harnesses: ['claude'], processes: [] }), /summar/i);
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  const inside = join(home, '.claude/plans/summaries');
  mkdirSync(inside, { recursive: true });
  symlinkSync(inside, summary);
  assert.throws(() => planClean({ harnesses: ['claude'], processes: [] }), /summar/i);
  rmSync(summary);
  process.env.HALVARD_WORKSPACE = summary;
  assert.throws(() => planClean({ harnesses: ['pi'], processes: [] }), /summar/i);
});

test('Codex companion hosts defer databases and keep writer locks and rollouts', (t) => {
  const { put } = fixture(t);
  const id = '11111111-2222-3333-4444-555555555555';
  const lock = put(`.codex/thread-writer-locks/${id}.lock`);
  const rollout = put(`.codex/sessions/rollout-${id}.jsonl`);
  const db = put('.codex/state_5.sqlite');
  const plan = planClean({
    harnesses: ['codex'],
    processes: [{ pid: 42, comm: '/tools/codex-code-mode-host' }],
  });
  assert.ok(plan.deferred.some((entry) => entry.path === db));
  for (const path of [lock, rollout]) assert.ok(plan.keptLive.some((entry) => entry.path === path));
});

test('CLAUDE_CODE_SESSION_ID retains its transcript and sidecars without PID metadata', (t) => {
  const { put } = fixture(t);
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  process.env.CLAUDE_CODE_SESSION_ID = id;
  const transcript = put(`.claude/projects/repo/${id}.jsonl`);
  const child = put(`.claude/projects/repo/${id}/subagents/agent.jsonl`);
  const plan = planClean({ harnesses: ['claude'], processes: [] });
  assert.ok(plan.keptLive.some((entry) => entry.path === transcript));
  assert.ok(plan.keptLive.some((entry) => entry.path === dirname(dirname(child))));
  assert.equal(plan.entries.length, 0);
});

test('apply filesystem work grows linearly with the number of selected transcripts', (t) => {
  const { home, put } = fixture(t);
  const inspect = fs.lstatSync;
  const measure = (count: number) => {
    for (let i = 0; i < count; i++) put(`.claude/projects/repo/session-${i}.jsonl`);
    const file = saveCleanPlan(planClean({ harnesses: ['claude'], processes: [] }));
    let calls = 0;
    t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
      calls++;
      return inspect(...args);
    });
    syncBuiltinESMExports();
    try {
      applyClean(file, 'DELETE', { processes: [] });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(file);
    }
    return calls;
  };
  const small = measure(20);
  const large = measure(80);
  t.diagnostic(`Metadata checks for 20/80 entries: ${small}/${large}`);
  assert.ok(large <= small * 6, `metadata checks grew from ${small} to ${large}`);
  assert.equal(existsSync(join(home, '.claude/projects/repo/session-79.jsonl')), false);
});

test('apply takes one process snapshot for non-database entries', (t) => {
  const { put } = fixture(t);
  for (let i = 0; i < 20; i++) put(`.claude/projects/repo/session-${i}.jsonl`);
  const file = saveCleanPlan(planClean({ harnesses: ['claude'], processes: [] }));
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', () => {
    calls++;
    return { status: 0, stdout: '' };
  });
  syncBuiltinESMExports();
  try {
    applyClean(file, 'DELETE');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(file);
  }
  assert.equal(calls, 1);
});

test('Codex runtime state started mid-apply is skipped and removal errors are reported', (t) => {
  const { put } = fixture(t);
  const first = put('.codex/logs_2.sqlite');
  const second = put('.codex/state_5.sqlite');
  const third = put('.codex/thread_history_1.sqlite');
  const stuck = put('.codex/sessions/stuck/old.jsonl');
  const processes: HistoryProcess[] = [];
  const remove = fs.rmSync;
  const file = saveCleanPlan(planClean({ harnesses: ['codex'], processes }));
  let result: ReturnType<typeof applyClean>;
  t.mock.method(fs, 'rmSync', (path: fs.PathLike, options?: fs.RmOptions) => {
    if (String(path) === dirname(stuck)) throw new Error('EBUSY');
    remove(path, options);
    if (String(path) === first) processes.push({ pid: 42, comm: 'codex-code-mode-host' });
  });
  syncBuiltinESMExports();
  try {
    result = applyClean(file, 'DELETE', { processes });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(file);
  }
  assert.equal(existsSync(first), false);
  for (const path of [second, third, stuck]) assert.equal(existsSync(path), true);
  assert.deepEqual(result.failed, [{ path: dirname(stuck), reason: 'EBUSY' }]);
  for (const path of [second, third]) {
    assert.ok(result.skipped.some((entry) => entry.path === path && /runtime/.test(entry.reason)));
  }
});

test('running Codex defers its caches and names the processes to stop', (t) => {
  const { home, put } = fixture(t);
  for (const path of ['cache/data', '.tmp/plugins.sha', 'tmp/arg0/x', 'models_cache.json']) {
    put(`.codex/${path}`);
  }
  const plan = planClean({
    harnesses: ['codex'],
    processes: [
      { pid: 47305, comm: 'codex' },
      { pid: 57462, comm: 'app-server' },
    ],
  });
  assert.deepEqual(
    plan.deferred.map((entry) => entry.path),
    ['cache', '.tmp', 'tmp', 'models_cache.json'].map((part) => join(home, '.codex', part)),
  );
  for (const entry of plan.deferred) assert.match(entry.reason, /PIDs 47305, 57462/);
  assert.equal(plan.entries.length, 0);
});

test('malformed or edited plans cannot authorize additional paths', (t) => {
  const { put } = fixture(t);
  const history = put('.pi/agent/sessions/repo/old.jsonl');
  const auth = put('.pi/agent/auth.json');
  const plan = planClean({ harnesses: ['pi'], processes: [] });
  const file = saveCleanPlan(plan);
  plan.entries.push({
    harness: 'pi',
    path: auth,
    bytes: 7,
    mtimeMs: 0,
    rule: 'forged',
    snapshot: 'forged',
  });
  writeFileSync(file, JSON.stringify(plan));
  const result = applyClean(file, 'DELETE', { processes: [] });
  assert.ok(result.skipped.some((entry) => entry.path === auth));
  assert.equal(existsSync(auth), true);
  assert.equal(existsSync(history), false);
  plan.entries.push(plan.entries[0]!);
  writeFileSync(file, JSON.stringify(plan));
  assert.throws(() => applyClean(file, 'DELETE', { processes: [] }), /changed/);
  rmSync(file);
});

test('an escaping saved path stops the run before any removal', (t) => {
  const { home, put } = fixture(t);
  const history = put('.pi/agent/sessions/repo/old.jsonl');
  const outside = put('outside/treasure.txt');
  for (const path of [outside, join(home, '.pi/agent/sessions/../../../outside/treasure.txt')]) {
    const plan = planClean({ harnesses: ['pi'], processes: [] });
    plan.entries.push({ ...plan.entries[0]!, path });
    const file = saveCleanPlan(plan);
    assert.throws(() => applyClean(file, 'DELETE', { processes: [] }), /escapes root/);
    rmSync(file);
    for (const kept of [history, outside]) assert.equal(existsSync(kept), true);
  }
});

test('a reviewed file is still removed when its live sibling ends before apply', (t) => {
  const { home, put } = fixture(t);
  for (const ended of ['removed', 'stale'] as const) {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    process.env.CLAUDE_CODE_SESSION_ID = id;
    const live = put(`.claude/projects/repo/${id}.jsonl`);
    const old = put('.claude/projects/repo/old.jsonl');
    const file = saveCleanPlan(planClean({ harnesses: ['claude'], processes: [] }));
    delete process.env.CLAUDE_CODE_SESSION_ID;
    if (ended === 'removed') rmSync(live);
    const result = applyClean(file, 'DELETE', { processes: [] });
    rmSync(file);
    assert.equal(existsSync(old), false, ended);
    assert.deepEqual(result.skipped, [], ended);
    if (ended === 'stale') {
      assert.equal(existsSync(live), true);
      assert.ok(
        result.appeared.some((entry) => entry.path === join(home, '.claude/projects/repo')),
      );
      rmSync(live);
    }
  }
});

test('a parent removed during apply skips its entry and the run continues', (t) => {
  const { home, put } = fixture(t);
  const first = put('.claude/file-history/x/data');
  const gone = put('.claude/plans/y.md');
  const last = put('.claude/session-env/z/data');
  const file = saveCleanPlan(planClean({ harnesses: ['claude'], processes: [] }));
  const remove = fs.rmSync;
  let result: ReturnType<typeof applyClean>;
  t.mock.method(fs, 'rmSync', (path: fs.PathLike, options?: fs.RmOptions) => {
    remove(path, options);
    if (String(path) === dirname(first)) remove(join(home, '.claude/plans'), { recursive: true });
  });
  syncBuiltinESMExports();
  try {
    result = applyClean(file, 'DELETE', { processes: [] });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(file);
  }
  assert.deepEqual(result.skipped, [{ path: gone, reason: 'Gone during apply' }]);
  for (const path of [first, last]) assert.equal(existsSync(path), false);
});

test('a category swapped for an outside symlink after preview stops the run', (t) => {
  const { home, put } = fixture(t);
  const reviewed = put('.claude/projects/repo/old.jsonl');
  const unrelated = put('.claude/plans/old.md');
  const outside = put('outside/repo/old.jsonl');
  const file = saveCleanPlan(planClean({ harnesses: ['claude'], processes: [] }));
  rmSync(join(home, '.claude/projects'), { recursive: true });
  symlinkSync(join(home, 'outside'), join(home, '.claude/projects'));
  assert.throws(() => applyClean(file, 'DELETE', { processes: [] }), /escapes root/);
  rmSync(file);
  for (const path of [unrelated, outside]) assert.equal(existsSync(path), true);
  assert.equal(existsSync(reviewed), true);
});

test('a change inside a Codex cache skips only that child', (t) => {
  const { put } = fixture(t);
  const changed = put('.codex/cache/a/data');
  const sibling = put('.codex/cache/b/data');
  const file = saveCleanPlan(planClean({ harnesses: ['codex'], processes: [] }));
  writeFileSync(changed, 'changed cache');
  const result = applyClean(file, 'DELETE', { processes: [] });
  assert.deepEqual(
    result.skipped.map((entry) => entry.path),
    [dirname(changed)],
  );
  assert.equal(existsSync(changed), true);
  assert.equal(existsSync(sibling), false);
  rmSync(file);
});

test('CLI plans, digests and applies only a fixture home using an injected process executable', (t) => {
  const { home, put } = fixture(t);
  const ps = put('tools/ps', `#!${process.execPath}\nprocess.stdout.write('');\n`);
  chmodSync(ps, 0o700);
  const transcript = put(
    '.pi/agent/sessions/repo/old.jsonl',
    [
      JSON.stringify({
        type: 'session',
        id: 'summary-fixture',
        cwd: '/invented/project',
        timestamp: '2026-01-01T00:00:00Z',
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-01-02T00:00:00Z',
        message: { role: 'user', content: 'fixture prompt' },
      }),
    ].join('\n') + '\n',
  );
  const env = { ...process.env, PATH: dirname(ps) + ':' + process.env.PATH };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [join(pluginRoot, 'bin/halvard.ts'), ...args], {
      cwd: home,
      env,
      encoding: 'utf8',
    });
  const preview = run('history-plan', '--harness', 'pi');
  assert.equal(preview.status, 0, preview.stderr);
  const value: unknown = JSON.parse(preview.stdout);
  assert.ok(
    value && typeof value === 'object' && 'planFile' in value && typeof value.planFile === 'string',
  );
  const digest = run('history-digest', '--harness', 'pi');
  assert.equal(digest.status, 0, digest.stderr);
  assert.match(digest.stdout, /fixture prompt/);
  assert.deepEqual(JSON.parse(digest.stdout), [
    {
      harness: 'pi',
      project: '/invented/project',
      id: 'summary-fixture',
      firstTimestamp: '2026-01-01T00:00:00.000Z',
      lastTimestamp: '2026-01-02T00:00:00.000Z',
      promptCount: 1,
      firstPrompt: 'fixture prompt',
    },
  ]);
  assert.equal(existsSync(transcript), true, 'summary inputs are available before deletion');
  const refusal = run('history-clean', value.planFile, '--confirm', 'yes');
  assert.equal(refusal.status, 1);
  assert.equal(existsSync(transcript), true);
  const result = run('history-clean', value.planFile, '--confirm', 'DELETE');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(transcript), false);
  assert.match(result.stdout, /removedBytes/);
  rmSync(value.planFile);
});

test('digest streams harness formats and exposes only compact session fields', async (t) => {
  const { put } = fixture(t);
  const long = 'x'.repeat(400);
  const lines = (records: unknown[]) =>
    records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  put(
    '.claude/projects/repo/session.jsonl',
    lines([
      {
        type: 'user',
        sessionId: 'claude-session',
        cwd: '/repo',
        timestamp: '2026-01-01T00:00:00Z',
        message: { content: long },
      },
      {
        type: 'user',
        sessionId: 'claude-session',
        timestamp: '2026-01-02T00:00:00Z',
        message: { content: [{ type: 'tool_result', content: 'secret' }] },
      },
    ]),
  );
  put(
    '.pi/agent/sessions/repo/file.jsonl',
    lines([
      { type: 'session', id: 'pi-session', cwd: '/pi', timestamp: '2026-01-01T00:00:00Z' },
      {
        type: 'message',
        timestamp: '2026-01-02T00:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Pi prompt' }] },
      },
    ]),
  );
  put(
    '.codex/sessions/year/file.jsonl',
    lines([
      { type: 'session_meta', payload: { id: 'codex-session', cwd: '/codex' } },
      {
        type: 'response_item',
        timestamp: '2026-01-01T00:00:00Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Codex prompt' }],
        },
      },
    ]),
  );
  put(
    '.codex/history.jsonl',
    lines([{ session_id: 'recall-only', ts: 1767225600, text: 'Recall prompt' }]),
  );
  const digests = await digestHistory({ harnesses: ['claude', 'pi', 'codex'] });
  const claude = digests.find((digest) => digest.id === 'claude-session')!;
  assert.equal(claude.firstPrompt, 'x'.repeat(300));
  assert.equal(claude.promptCount, 1);
  assert.equal(claude.project, '/repo');
  assert.equal(claude.lastTimestamp, '2026-01-02T00:00:00.000Z');
  assert.equal(digests.find((digest) => digest.id === 'pi-session')!.firstPrompt, 'Pi prompt');
  assert.equal(
    digests.find((digest) => digest.id === 'codex-session')!.firstPrompt,
    'Codex prompt',
  );
  assert.equal(
    digests.find((digest) => digest.id === 'recall-only')!.firstTimestamp,
    '2026-01-01T00:00:00.000Z',
  );
  assert.deepEqual(
    Object.keys(claude).sort(),
    [
      'harness',
      'project',
      'id',
      'firstTimestamp',
      'lastTimestamp',
      'promptCount',
      'firstPrompt',
    ].sort(),
  );
});

test('the skill ships in the catalog with user-only metadata and CLI grammar', (t) => {
  const { home } = fixture(t);
  spawnSync('git', ['init', '-q', home]);
  const skill = skills(loadProject(home)).find((skill) => skill.name === 'clean-history')!;
  assert.equal(skill.bundled, true);
  assert.match(skill.content, /disable-model-invocation: true/);
  assert.match(skill.content, /Refuse unless the user explicitly invoked/);
  const help = spawnSync(process.execPath, [join(pluginRoot, 'bin/halvard.ts'), '--help'], {
    encoding: 'utf8',
  });
  assert.match(help.stdout, /history-plan/);
  assert.match(help.stdout, /history-clean/);
  for (const selection of ['', 'all,pi', 'pi,pi', 'other']) {
    assert.throws(() => historyHarnesses(selection));
  }
});
