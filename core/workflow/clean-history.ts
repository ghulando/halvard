import type {
  HistoryHarness,
  HistoryDigest,
  HistoryEntry,
  HistoryNotice,
  HistoryPlan,
  HistoryProcess,
} from '../types.ts';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { personalRoot, workspaceRoot } from '../flow-config.ts';
import { privateDirectory } from '../state.ts';

const harnessNames: HistoryHarness[] = ['claude', 'pi', 'codex'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const claudeTargets = [
  'history.jsonl',
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
  'mcp-needs-auth-cache.json',
  'stats-cache.json',
  'gh-pr-status-cache.json',
  'policy-limits.json',
  'policy-limits.json.stamp.json',
  'remote-settings.json',
  '.last-cleanup',
  '.last-update-result.json',
  '.DS_Store',
];
const securityTarget = /^(?:agent-sdk-venv|log\.txt|security_warnings_state_.*)$/;
const codexTargets = [
  'sessions',
  'archived_sessions',
  'history.jsonl',
  'session_index.jsonl',
  'shell_snapshots',
  'thread-writer-locks',
  'tui-thread-reference-capabilities',
];
// The running Codex daemon writes these, so they wait until it stops.
const codexRuntime = [
  ...['logs_2', 'thread_history_1', 'state_5', 'goals_1', 'queue_1'].flatMap((db) => [
    `${db}.sqlite`,
    `${db}.sqlite-wal`,
    `${db}.sqlite-shm`,
  ]),
  'cache',
  '.tmp',
  'tmp',
  'models_cache.json',
];

type Detection = { processes?: HistoryProcess[]; now?: number };

const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
};

const children = (path: string) =>
  stat(path)?.isDirectory()
    ? readdirSync(path)
        .sort()
        .map((name) => join(path, name))
    : [];

function processList(): HistoryProcess[] {
  const result = spawnSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('Cannot inspect live harness processes; nothing may be deleted');
  }
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), comm: match[2]! }] : [];
  });
}

export function historyHarnesses(value: string): HistoryHarness[] {
  if (value === 'all') return [...harnessNames];
  const selected = value.split(',');
  if (
    !selected.length ||
    selected.some((name) => !harnessNames.includes(name as HistoryHarness)) ||
    new Set(selected).size !== selected.length
  ) {
    throw new Error('Choose claude, pi, codex or all');
  }
  return harnessNames.filter((name) => selected.includes(name));
}

function roots(): HistoryPlan['roots'] {
  return {
    claude: resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')),
    pi: resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')),
    codex: resolve(process.env.CODEX_HOME || join(homedir(), '.codex')),
    workflow: workspaceRoot(),
  };
}

function resolvedPath(path: string): string {
  if (stat(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(resolvedPath(parent), basename(path));
}

function validateRoots(root: HistoryPlan['roots'], harnesses: HistoryHarness[]) {
  const home = resolvedPath(homedir());
  const selected = [...harnesses, 'workflow'] as const;
  const canonical = Object.fromEntries(
    Object.entries(root).map(([name, path]) => [name, resolvedPath(path)]),
  ) as HistoryPlan['roots'];
  for (const name of selected) {
    if (inside(canonical[name], home)) {
      throw new Error(`Unsafe history root: ${root[name]} is home or an ancestor of home`);
    }
  }
  const paths = Object.values(canonical);
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (inside(paths[i]!, paths[j]!) || inside(paths[j]!, paths[i]!)) {
        throw new Error('History roots overlap');
      }
    }
  }
  if (inside(canonical.workflow, resolvedPath(personalRoot()))) {
    throw new Error('Workspace root contains personal workflow data');
  }
  const summary = join(homedir(), 'agent-history-summaries');
  for (const name of selected) {
    if (inside(root[name], summary) || inside(canonical[name], resolvedPath(summary))) {
      throw new Error('History root contains the summary folder');
    }
  }
  for (const name of selected) {
    if (stat(root[name])?.isSymbolicLink()) {
      throw new Error(`History root is a symlink: ${root[name]}`);
    }
  }
}

function safeParent(path: string, root: string) {
  if (stat(root)?.isSymbolicLink()) throw new Error(`History root is a symlink: ${root}`);
  if (
    !inside(root, path) ||
    path === root ||
    !inside(realpathSync(root), realpathSync(dirname(path)))
  ) {
    throw new Error(`History path escapes root: ${path}`);
  }
}

function tree(
  path: string,
  liveReason?: (path: string) => string | null,
): { bytes: number; snapshot: string } {
  const records: unknown[] = [];
  let bytes = 0;
  const walk = (file: string) => {
    const info = stat(file);
    if (!info) throw new Error(`History path disappeared: ${file}`);
    const reason = liveReason?.(file);
    if (reason) throw new Error(`${reason}: ${file}`);
    records.push([
      relative(path, file),
      info.dev,
      info.ino,
      info.mode,
      info.nlink,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
    ]);
    if (info.isDirectory()) {
      for (const child of children(file)) walk(child);
    } else {
      bytes += info.size;
    }
  };
  walk(path);
  return { bytes, snapshot: createHash('sha256').update(JSON.stringify(records)).digest('hex') };
}

function liveState(root: HistoryPlan['roots'], active: HistoryProcess[], now: number) {
  const pids = (name: HistoryHarness) =>
    active
      .filter((process) => {
        const command = basename(process.comm).toLowerCase();
        return (
          command === name ||
          (name === 'codex' &&
            (command.startsWith('codex') || /^app-server(?:-daemon)?$/.test(command)))
        );
      })
      .map((process) => process.pid);
  const running = (name: HistoryHarness) => pids(name).length > 0;
  const liveClaude = new Set<string>(
    process.env.CLAUDE_CODE_SESSION_ID ? [process.env.CLAUDE_CODE_SESSION_ID] : [],
  );
  const mappedClaudePids = new Set<number>();
  let oldestClaudeStart = Infinity;
  const livePids = new Set(active.map((process) => process.pid));
  const claudeSessions = join(root.claude, 'sessions');
  if (!stat(root.claude)?.isSymbolicLink() && !stat(claudeSessions)?.isSymbolicLink()) {
    for (const file of children(claudeSessions)) {
      const pid = basename(file).match(/^(\d+)\.json$/);
      if (!pid || !livePids.has(Number(pid[1])) || !stat(file)?.isFile()) continue;
      safeParent(file, root.claude);
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (
        value &&
        typeof value === 'object' &&
        'sessionId' in value &&
        typeof value.sessionId === 'string'
      ) {
        liveClaude.add(value.sessionId);
        mappedClaudePids.add(Number(pid[1]));
        if (
          active.some(
            (process) =>
              process.pid === Number(pid[1]) && basename(process.comm).toLowerCase() === 'claude',
          )
        ) {
          const started =
            'startedAt' in value &&
            typeof value.startedAt === 'number' &&
            Number.isFinite(value.startedAt)
              ? value.startedAt
              : Math.round(stat(file)!.mtimeMs);
          oldestClaudeStart = Math.min(oldestClaudeStart, started);
        }
      }
    }
  }
  const locks = join(root.codex, 'thread-writer-locks');
  const liveCodex = new Set<string>();
  if (running('codex') && !stat(root.codex)?.isSymbolicLink() && !stat(locks)?.isSymbolicLink()) {
    for (const lock of children(locks)) {
      const id = basename(lock, '.lock');
      if (uuid.test(id)) liveCodex.add(id);
    }
  }
  const newestPi = new Set<string>();
  const inspectPi = (directory: string) => {
    if (!stat(directory)?.isDirectory()) return;
    const entries = children(directory);
    const transcripts = entries.filter((path) => path.endsWith('.jsonl') && stat(path)?.isFile());
    const newest = Math.max(...transcripts.map((path) => stat(path)!.mtimeMs));
    for (const path of transcripts) if (stat(path)!.mtimeMs === newest) newestPi.add(path);
    for (const path of entries) if (stat(path)?.isDirectory()) inspectPi(path);
  };
  if (running('pi') && !stat(root.pi)?.isSymbolicLink()) inspectPi(join(root.pi, 'sessions'));
  const liveReason = (harness: HistoryEntry['harness'], path: string): string | null => {
    if (harness === 'claude') {
      if (
        running('claude') &&
        ['shell-snapshots', 'plans'].some((part) => inside(join(root.claude, part), path)) &&
        !stat(path)?.isDirectory() &&
        // Linux can report an mtime a fraction of a millisecond below the value it was set to.
        (oldestClaudeStart === Infinity ||
          Math.round(stat(path)?.mtimeMs ?? Infinity) >= oldestClaudeStart)
      ) {
        return 'Claude is running; possible live session sidecar';
      }
      if ([...liveClaude].some((id) => path.includes(id))) return 'Live Claude session';
      if (inside(join(root.claude, 'ide'), path) && stat(path)?.isFile()) {
        let owner: unknown;
        try {
          owner = JSON.parse(readFileSync(path, 'utf8'));
        } catch {
          owner = null;
        }
        if (
          owner &&
          typeof owner === 'object' &&
          'pid' in owner &&
          typeof owner.pid === 'number' &&
          livePids.has(owner.pid)
        ) {
          return 'IDE lock held by a running process';
        }
      }
      const pid = basename(path).match(/^(\d+)\./);
      if (inside(claudeSessions, path) && pid && livePids.has(Number(pid[1]))) {
        return 'Live Claude PID file';
      }
      if (
        path !== join(root.claude, 'history.jsonl') &&
        active.some(
          (process) =>
            basename(process.comm).toLowerCase() === 'claude' && !mappedClaudePids.has(process.pid),
        ) &&
        (path.endsWith('.jsonl') || uuid.test(basename(path)))
      ) {
        return 'Claude is running; session identity unavailable';
      }
    }
    if (harness === 'codex' && running('codex')) {
      if (codexRuntime.some((part) => inside(join(root.codex, part), path))) {
        return 'Codex is running; runtime state kept';
      }
      if (path !== locks && inside(locks, path)) return 'Codex is running; writer lock kept';
      if ([...liveCodex].some((id) => path.includes(id))) return 'Live Codex thread';
      if (
        !liveCodex.size &&
        ['shell_snapshots', 'tui-thread-reference-capabilities'].some((part) =>
          inside(join(root.codex, part), path),
        ) &&
        !stat(path)?.isDirectory()
      ) {
        return 'Codex is running; thread identity unavailable; sidecar kept';
      }
      if (
        !liveCodex.size &&
        path.endsWith('.jsonl') &&
        basename(path) !== 'history.jsonl' &&
        basename(path) !== 'session_index.jsonl'
      ) {
        return 'Codex is running; thread identity unavailable';
      }
    }
    if (
      harness === 'pi' &&
      running('pi') &&
      (stat(path)?.mtimeMs ?? 0) >= now - 600000 &&
      stat(path)?.isFile()
    ) {
      return 'Pi is running; session modified in the last ten minutes';
    }
    if (harness === 'pi' && newestPi.has(path)) {
      return 'Pi is running; newest transcript in this project kept for an idle live session';
    }
    return null;
  };
  return { pids, running, liveReason };
}

export function planClean({
  harnesses,
  processes,
  now = Date.now(),
}: { harnesses: HistoryHarness[] } & Detection): HistoryPlan {
  if (
    !harnesses.length ||
    harnesses.some((name) => !harnessNames.includes(name)) ||
    new Set(harnesses).size !== harnesses.length
  ) {
    throw new Error('Invalid harness selection');
  }
  const root = roots();
  validateRoots(root, harnesses);
  const { pids, running, liveReason } = liveState(root, processes ?? processList(), now);
  const claudeSessions = join(root.claude, 'sessions');
  const plan: HistoryPlan = {
    version: 1,
    harnesses: [...harnesses].sort(),
    roots: root,
    entries: [],
    keptLive: [],
    deferred: [],
  };
  const protectedPaths = [
    personalRoot(),
    join(homedir(), 'agent-history-summaries'),
    resolvedPath(join(homedir(), 'agent-history-summaries')),
    ...harnessNames.flatMap((name) =>
      ['plugins', 'skills', 'hooks', 'memory', 'memories', 'bin', 'packages', 'rules'].map((part) =>
        join(root[name], part),
      ),
    ),
    ...harnessNames.flatMap((name) =>
      [
        'auth.json',
        '.credentials.json',
        'settings.json',
        'config.toml',
        'memories_1.sqlite',
        'memories_1.sqlite-wal',
        'memories_1.sqlite-shm',
      ].map((part) => join(root[name], part)),
    ),
  ];
  const settings = join(root.claude, 'settings.json');
  if (!stat(root.claude)?.isSymbolicLink() && stat(settings)?.isFile()) {
    const configured: unknown = JSON.parse(readFileSync(settings, 'utf8'));
    if (
      configured &&
      typeof configured === 'object' &&
      'autoMemoryDirectory' in configured &&
      typeof configured.autoMemoryDirectory === 'string'
    ) {
      const path = configured.autoMemoryDirectory;
      protectedPaths.push(resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path));
    }
  }
  for (const keep of [...protectedPaths]) if (stat(keep)) protectedPaths.push(realpathSync(keep));
  // An overridden workspace can overlap a harness home: preserve all top-level
  // non-history content, not merely familiar credential names.
  for (const name of harnessNames) {
    if (!stat(root[name])?.isSymbolicLink()) {
      const allowed = new Set(
        name === 'claude'
          ? ['projects', 'sessions', 'security', ...claudeTargets]
          : name === 'pi'
            ? ['sessions', '.DS_Store']
            : [...codexTargets, ...codexRuntime],
      );
      for (const file of children(root[name])) {
        if (!allowed.has(basename(file))) protectedPaths.push(file);
      }
    }
  }
  const security = join(root.claude, 'security');
  if (!stat(root.claude)?.isSymbolicLink() && !stat(security)?.isSymbolicLink()) {
    for (const file of children(security)) {
      if (!securityTarget.test(basename(file))) protectedPaths.push(file);
    }
  }
  const projects = join(root.claude, 'projects');
  // A category root is split into its children, so a change in one child
  // skips only that child at apply time.
  const visit = (
    harness: HistoryEntry['harness'],
    path: string,
    rule: string,
    split = false,
  ): boolean => {
    const info = stat(path);
    if (!info) return false;
    safeParent(path, root[harness]);
    if (protectedPaths.some((keep) => inside(keep, path))) return false;
    // Config names are guarded only at a harness root; inside a target category
    // they are cached or historical copies. protectedPaths still applies there.
    if (
      harness !== 'workflow' &&
      dirname(path) === root[harness] &&
      /^(?:memory|memories|memory\.md|skills|plugins|hooks|packages|bin|auth\.json|\.credentials\.json|settings(?:\.local)?\.json|config\.toml|personal\.json|claude\.md)$/i.test(
        basename(path),
      )
    ) {
      return false;
    }
    const reason = liveReason(harness, path);
    if (reason) {
      plan.keptLive.push({ path, reason });
      return false;
    }
    const start = plan.entries.length;
    let complete = !protectedPaths.some((keep) => inside(path, keep));
    if (info.isDirectory()) {
      for (const child of children(path)) if (!visit(harness, child, rule)) complete = false;
      if (split) return false;
    }
    if (complete) {
      plan.entries.splice(start);
      const appendIdentity =
        (harness === 'claude' || harness === 'codex') &&
        path === join(root[harness], 'history.jsonl') &&
        info.isFile() &&
        running(harness)
          ? { dev: info.dev, ino: info.ino }
          : undefined;
      plan.entries.push({
        harness,
        path,
        rule,
        mtimeMs: info.mtimeMs,
        ...tree(path),
        ...(appendIdentity ? { appendIdentity } : {}),
      });
    }
    return complete;
  };
  const directory = (harness: HistoryHarness, part: string) =>
    visit(harness, join(root[harness], part), part, true);
  if (harnesses.includes('claude')) {
    if (!stat(root.claude)?.isSymbolicLink() && !stat(projects)?.isSymbolicLink()) {
      for (const project of children(projects)) {
        if (!stat(project)?.isSymbolicLink()) visit('claude', project, 'project');
      }
    }
    for (const part of claudeTargets) directory('claude', part);
    if (!stat(root.claude)?.isSymbolicLink() && !stat(security)?.isSymbolicLink()) {
      for (const file of children(security)) visit('claude', file, 'security');
    }
    if (stat(claudeSessions)?.isSymbolicLink()) {
      visit('claude', claudeSessions, 'sessions link');
    } else {
      for (const file of children(claudeSessions)) {
        if (/^\d+\.(?:json|(?:.*\.)?key)$/.test(basename(file))) {
          visit('claude', file, 'PID session file');
        }
      }
    }
  }
  if (harnesses.includes('pi')) {
    for (const part of ['sessions', '.DS_Store']) directory('pi', part);
  }
  if (harnesses.includes('codex')) {
    for (const part of codexTargets) directory('codex', part);
    for (const part of codexRuntime) {
      const path = join(root.codex, part);
      if (!stat(path)) continue;
      if (running('codex')) {
        plan.deferred.push({
          path,
          reason: `Codex is running (PIDs ${pids('codex').join(', ')}); stop those processes and rerun`,
        });
      } else {
        visit('codex', path, 'runtime state', true);
      }
    }
  }
  if (stat(root.workflow)?.isSymbolicLink()) throw new Error('Workspace root is a symlink');
  for (const path of children(root.workflow)) {
    if (stat(path)?.isDirectory() || stat(path)?.isSymbolicLink()) {
      visit('workflow', path, 'team task workspaces');
    }
  }
  plan.entries.sort((a, b) => a.path.localeCompare(b.path));
  // Overridden roots can expose the same history twice. Remove descendants of
  // other selected targets, so each entry is removed only once.
  plan.entries = plan.entries.filter(
    (entry, i, all) =>
      !all.some(
        (other, j) =>
          j !== i && inside(other.path, entry.path) && (other.path !== entry.path || j < i),
      ),
  );
  return plan;
}

export function saveCleanPlan(plan: HistoryPlan) {
  const dir = privateDirectory(join(tmpdir(), `halvard-history-${process.getuid?.() ?? 'user'}`));
  const path = join(dir, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return path;
}

export function applyClean(planFile: string, confirm: string, detection: Detection = {}) {
  if (confirm !== 'DELETE') throw new Error('Type DELETE to confirm history deletion');
  const info = stat(planFile);
  if (
    !info?.isFile() ||
    info.mode & 0o077 ||
    info.size > 32 * 1024 * 1024 ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new Error('Plan must be a private, owned regular file');
  }
  const value: unknown = JSON.parse(readFileSync(planFile, 'utf8'));
  if (
    !value ||
    typeof value !== 'object' ||
    !('harnesses' in value) ||
    !Array.isArray(value.harnesses)
  ) {
    throw new Error('Invalid history plan');
  }
  const processes = [...(detection.processes ?? processList())];
  const plan = planClean({
    harnesses: value.harnesses as HistoryHarness[],
    ...detection,
    processes,
  });
  const saved = value as HistoryPlan;
  const changed = () => new Error('History changed since preview; generate and review a new plan');
  if (
    saved.version !== plan.version ||
    JSON.stringify(saved.roots) !== JSON.stringify(plan.roots) ||
    JSON.stringify(saved.harnesses) !== JSON.stringify(plan.harnesses) ||
    !Array.isArray(saved.entries)
  ) {
    throw changed();
  }
  const matchesEntry = (entry: HistoryEntry, current: HistoryEntry) => {
    if (!entry.appendIdentity) return JSON.stringify(entry) === JSON.stringify(current);
    if (
      !current.appendIdentity ||
      JSON.stringify(entry.appendIdentity) !== JSON.stringify(current.appendIdentity) ||
      current.bytes < entry.bytes
    ) {
      return false;
    }
    return (
      JSON.stringify({
        ...entry,
        bytes: current.bytes,
        mtimeMs: current.mtimeMs,
        snapshot: current.snapshot,
      }) === JSON.stringify(current)
    );
  };
  const paths = saved.entries.map((entry) => entry.path);
  if (paths.some((path) => typeof path !== 'string') || new Set(paths).size !== paths.length) {
    throw changed();
  }
  for (const entry of saved.entries) {
    const root =
      entry.harness === 'workflow' || plan.harnesses.includes(entry.harness)
        ? plan.roots[entry.harness]
        : undefined;
    if (
      !root ||
      resolve(entry.path) !== entry.path ||
      entry.path === root ||
      !inside(root, entry.path)
    ) {
      throw new Error(`History path escapes root: ${entry.path}`);
    }
    // A missing parent is fine (the entry is gone); an existing one must
    // still resolve inside the root, so a swapped-in symlink stops the run.
    let parent = dirname(entry.path);
    while (!stat(parent)) parent = dirname(parent);
    if (stat(root) && !inside(realpathSync(root), realpathSync(parent))) {
      throw new Error(`History path escapes root: ${entry.path}`);
    }
  }
  const current = new Map(plan.entries.map((entry) => [entry.path, entry]));
  const skipped: HistoryNotice[] = [];
  const unchanged = saved.entries.filter((entry) => {
    const now = current.get(entry.path);
    if (now && matchesEntry(entry, now)) return true;
    // A fresh plan may cover a reviewed path through an ancestor once a live
    // sibling ends; the saved snapshot is then checked before removal.
    if (
      !now &&
      !entry.appendIdentity &&
      plan.entries.some(
        (other) => other.harness === entry.harness && inside(other.path, entry.path),
      )
    ) {
      return true;
    }
    const live = plan.keptLive.find((notice) => inside(entry.path, notice.path));
    skipped.push({
      path: entry.path,
      reason: live
        ? `Now live: ${live.reason}`
        : now
          ? 'Changed since preview'
          : 'Gone or no longer eligible since preview',
    });
    return false;
  });
  const previewPaths = new Set(
    [...saved.entries, ...(saved.keptLive ?? []), ...(saved.deferred ?? [])].map(
      (entry) => entry.path,
    ),
  );
  const appeared = [...plan.entries, ...plan.keptLive, ...plan.deferred]
    .filter((entry) => !previewPaths.has(entry.path))
    .map((entry) => ({ path: entry.path, reason: 'Appeared after preview, not deleted' }));
  const live = liveState(plan.roots, processes, detection.now ?? Date.now());
  const removed: HistoryEntry[] = [];
  const failed: HistoryNotice[] = [];
  for (const entry of unchanged) {
    try {
      safeParent(entry.path, plan.roots[entry.harness]);
      validateRoots(roots(), plan.harnesses);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        skipped.push({ path: entry.path, reason: 'Gone during apply' });
        continue;
      }
      throw new Error(
        `Stopped deleting ${entry.path}: ${(error as Error).message}; already removed: ${JSON.stringify(removed)}`,
      );
    }
    const { liveReason } =
      entry.harness === 'codex' && entry.rule === 'runtime state'
        ? liveState(plan.roots, detection.processes ?? processList(), detection.now ?? Date.now())
        : live;
    try {
      const now = tree(entry.path, (path) => liveReason(entry.harness, path));
      const info = stat(entry.path)!;
      if (
        entry.appendIdentity
          ? !info.isFile() ||
            info.dev !== entry.appendIdentity.dev ||
            info.ino !== entry.appendIdentity.ino ||
            info.size < entry.bytes
          : now.snapshot !== entry.snapshot
      ) {
        throw new Error('Changed during apply');
      }
    } catch (error) {
      skipped.push({ path: entry.path, reason: (error as Error).message });
      continue;
    }
    try {
      rmSync(entry.path, { recursive: true });
      removed.push(entry);
    } catch (error) {
      failed.push({ path: entry.path, reason: (error as Error).message });
    }
  }
  return {
    removed,
    removedBytes: removed.reduce((bytes, entry) => bytes + entry.bytes, 0),
    skipped,
    failed,
    keptLive: plan.keptLive,
    deferred: plan.deferred,
    appeared,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function promptText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => object(block))
    .filter((block) => block.type === 'text' || block.type === 'input_text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

// Session transcripts and prompt history, the files digests and retrospectives read.
export function transcriptFiles(harnesses: HistoryHarness[]) {
  historyHarnesses(harnesses.join(','));
  const root = roots();
  validateRoots(root, harnesses);
  const found: { harness: HistoryHarness; file: string; history: boolean }[] = [];
  const files = (dir: string): string[] => {
    const info = stat(dir);
    if (!info || info.isSymbolicLink()) return [];
    if (info.isFile()) return dir.endsWith('.jsonl') ? [dir] : [];
    if (/^(memory|memories|skills|plugins|hooks|subagents)$/i.test(basename(dir))) return [];
    return children(dir).flatMap(files);
  };
  for (const harness of harnesses) {
    if (stat(root[harness])?.isSymbolicLink()) {
      throw new Error(`History root is a symlink: ${root[harness]}`);
    }
    const transcripts = (
      harness === 'claude'
        ? ['projects']
        : harness === 'pi'
          ? ['sessions']
          : ['sessions', 'archived_sessions']
    ).flatMap((part) => files(join(root[harness], part)));
    const sources = [
      ...transcripts,
      ...['history.jsonl']
        .map((part) => join(root[harness], part))
        .filter((file) => stat(file)?.isFile()),
    ];
    for (const file of sources) {
      safeParent(file, root[harness]);
      if (
        inside(personalRoot(), file) ||
        (stat(personalRoot()) && inside(realpathSync(personalRoot()), file)) ||
        stat(file)?.isSymbolicLink()
      ) {
        continue;
      }
      found.push({ harness, file, history: file === join(root[harness], 'history.jsonl') });
    }
  }
  return found;
}

export async function digestHistory({
  harnesses,
}: {
  harnesses: HistoryHarness[];
}): Promise<HistoryDigest[]> {
  const digests: HistoryDigest[] = [];
  for (const { harness, file, history } of transcriptFiles(harnesses)) {
    const sessions = new Map<string, HistoryDigest>();
    const codexEvents = new Set<string>();
    let defaultId = basename(file, '.jsonl');
    let cwd = basename(dirname(file));
    for await (const line of createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = object(parsed);
      const payload = object(record.payload);
      const message = object(record.message);
      if (record.isSidechain === true) continue;
      if (record.type === 'session' && typeof record.id === 'string') defaultId = record.id;
      if (record.type === 'session_meta' && typeof payload.id === 'string') {
        defaultId = payload.id;
      }
      const project = record.cwd ?? record.project ?? payload.cwd;
      if (typeof project === 'string') cwd = project;
      const id = record.sessionId ?? record.session_id ?? defaultId;
      if (typeof id !== 'string') continue;
      let digest = sessions.get(id);
      if (!digest) {
        digest = {
          harness,
          project: cwd,
          id,
          firstTimestamp: null,
          lastTimestamp: null,
          promptCount: 0,
          firstPrompt: '',
        };
        sessions.set(id, digest);
      }
      if (typeof project === 'string') digest.project = project;
      const stamp = record.timestamp ?? record.ts;
      if (typeof stamp === 'string' || typeof stamp === 'number') {
        const date = new Date(typeof stamp === 'number' && stamp < 1e11 ? stamp * 1000 : stamp);
        if (!Number.isNaN(date.getTime())) {
          const iso = date.toISOString();
          if (!digest.firstTimestamp || iso < digest.firstTimestamp) digest.firstTimestamp = iso;
          if (!digest.lastTimestamp || iso > digest.lastTimestamp) digest.lastTimestamp = iso;
        }
      }
      let text = '';
      if (record.type === 'user' || (record.type === 'message' && message.role === 'user')) {
        text = promptText(message.content);
      } else if (
        harness === 'codex' &&
        record.type === 'event_msg' &&
        payload.type === 'user_message' &&
        typeof payload.message === 'string'
      ) {
        if (!codexEvents.has(id)) {
          digest.promptCount = 0;
          digest.firstPrompt = '';
          codexEvents.add(id);
        }
        text = payload.message;
      } else if (
        record.type === 'response_item' &&
        payload.type === 'message' &&
        payload.role === 'user' &&
        !codexEvents.has(id)
      ) {
        const candidate = promptText(payload.content);
        if (
          !/^\s*(?:<environment_context>|<user_instructions>|# AGENTS\.md instructions)/i.test(
            candidate,
          )
        ) {
          text = candidate;
        }
      } else if (typeof record.display === 'string') {
        text = record.display;
      } else if (typeof record.text === 'string' && record.session_id) {
        text = record.text;
      }
      if (text && !record.isMeta) {
        digest.promptCount++;
        if (!digest.firstPrompt) digest.firstPrompt = text.slice(0, 300);
      }
    }
    for (const digest of sessions.values()) {
      const existing = digests.find((value) => value.harness === harness && value.id === digest.id);
      if (!existing) {
        digests.push(digest);
        continue;
      }
      if (history) continue;
      if (
        digest.firstTimestamp &&
        (!existing.firstTimestamp || digest.firstTimestamp < existing.firstTimestamp)
      ) {
        existing.firstTimestamp = digest.firstTimestamp;
        existing.firstPrompt = digest.firstPrompt;
      }
      if (
        digest.lastTimestamp &&
        (!existing.lastTimestamp || digest.lastTimestamp > existing.lastTimestamp)
      ) {
        existing.lastTimestamp = digest.lastTimestamp;
      }
      existing.promptCount += digest.promptCount;
    }
  }
  return digests;
}
