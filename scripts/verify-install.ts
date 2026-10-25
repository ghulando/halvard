import type {
  PackedArchive,
  PackageMetadata,
  HarnessSettings,
  Marketplace,
} from '../core/types.ts';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'halvard-packed-'));
const previous = process.env.HALVARD_HOME;

process.env.HALVARD_HOME = join(temporary, 'personal');

const metadata: unknown = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const expected = (metadata as PackageMetadata).version;

try {
  const packOutput: unknown = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', temporary], {
      cwd: source,
      encoding: 'utf8',
    }),
  );
  const packed = (packOutput as PackedArchive[])[0]!;
  for (const { path } of packed.files) {
    assert.equal(/^dist\//.test(path), false, `compiled output shipped: ${path}`);
    assert.equal(
      /(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(path),
      false,
      `compiler config shipped: ${path}`,
    );
    assert.equal(/(?:^|\/)node_modules\//.test(path), false, `dependency code shipped: ${path}`);
  }
  execFileSync('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary]);
  const app = join(temporary, 'app');
  mkdirSync(app);
  execFileSync('git', ['init', '-q', '--initial-branch=main', app]);
  execFileSync(process.execPath, [join(temporary, 'package/bin/halvard.ts'), 'install', app]);
  const installed = join(app, 'plugins/halvard');
  const rawInstalled: unknown = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const installedMetadata = rawInstalled as PackageMetadata;
  assert.equal(installedMetadata.version, expected);
  assert.equal(
    Object.hasOwn(installedMetadata, 'dependencies'),
    false,
    'package has runtime dependencies',
  );
  for (const manifest of [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    '.grok-plugin/plugin.json',
  ]) {
    assert.equal(
      (JSON.parse(readFileSync(join(installed, manifest), 'utf8')) as PackageMetadata).version,
      expected,
    );
  }
  // A renamed entry point passes the suites but fails on every user machine.
  const manifest = (path: string) =>
    JSON.parse(readFileSync(join(installed, path), 'utf8')) as Record<string, unknown>;
  const packaged = installedMetadata as PackageMetadata & {
    pi?: { extensions?: string[]; skills?: string[] };
    bin?: Record<string, string>;
  };
  const codexPlugin = manifest('.codex-plugin/plugin.json') as { skills?: string; hooks?: string };
  const grokPlugin = manifest('.grok-plugin/plugin.json') as { skills?: string; hooks?: string };
  const marketplace = manifest('.claude-plugin/marketplace.json') as {
    plugins?: { source?: string }[];
  };
  const targets = [
    ...(packaged.pi?.extensions ?? []),
    ...(packaged.pi?.skills ?? []),
    ...Object.values(packaged.bin ?? {}),
    ...(marketplace.plugins ?? []).map((plugin) => plugin.source!),
    codexPlugin.skills!,
    codexPlugin.hooks!,
    grokPlugin.skills!,
    grokPlugin.hooks!,
  ];
  for (const hooks of [
    'hooks/hooks.json',
    'hooks/codex.json',
    'hooks/grok.json',
    'hooks/cursor.json',
  ]) {
    for (const match of readFileSync(join(installed, hooks), 'utf8').matchAll(
      /\$\{(?:CLAUDE_|GROK_)?(?:PLUGIN|HALVARD)_ROOT\}\/([\w./-]+)/g,
    )) {
      targets.push(match[1]!);
    }
  }
  assert.ok(targets.length >= 8 && targets.every(Boolean), 'native manifests name no entry points');
  for (const target of targets) {
    assert.ok(
      existsSync(resolve(installed, target)),
      `manifest target missing from the package: ${target}`,
    );
  }
  for (const doc of [
    'README.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'docs/architecture.md',
    'docs/flow.md',
    'docs/configuration.md',
    'docs/factory.md',
    'docs/troubleshooting.md',
    'UPSTREAM.md',
  ]) {
    const content = readFileSync(join(installed, doc), 'utf8');
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!.split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(
        existsSync(resolve(installed, doc, '..', target)),
        `packed documentation link missing: ${doc} -> ${target}`,
      );
    }
  }

  const pi = JSON.parse(readFileSync(join(app, '.pi/settings.json'), 'utf8')) as HarnessSettings;
  const claude = JSON.parse(
    readFileSync(join(app, '.claude/settings.json'), 'utf8'),
  ) as HarnessSettings;
  const codex = JSON.parse(
    readFileSync(join(app, '.agents/plugins/marketplace.json'), 'utf8'),
  ) as Marketplace;
  assert.equal(resolve(app, '.pi', pi.packages![0]!), installed);
  assert.equal(resolve(app, claude.extraKnownMarketplaces!['ghulando']!.source.path), installed);
  assert.equal(resolve(app, codex.plugins[0]!.source.path), installed);
  const { handle } = (await import(
    join(installed, 'core/runtime.ts')
  )) as typeof import('../core/runtime.ts');
  for (const harness of ['pi', 'claude', 'codex', 'grok', 'cursor']) {
    const result = await handle(harness, {
      cwd: app,
      session_id: 'packed-verification',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'source.txt', content: 'change' },
    });
    assert.equal(result.decision, 'deny');
    const context = await handle(harness, {
      cwd: app,
      session_id: 'packed-verification',
      hook_event_name: 'SessionStart',
    });
    assert.match(context.context!, /skills\/halvard\/SKILL\.md/);
  }
  const suite = spawnSync(
    process.execPath,
    [
      '--test',
      ...readdirSync(join(installed, 'tests'))
        .filter((name) => name.endsWith('.test.ts'))
        .sort()
        .map((name) => join(installed, 'tests', name)),
    ],
    { cwd: app, encoding: 'utf8' },
  );
  if (suite.status !== 0) throw new Error(suite.stdout + suite.stderr);
  console.log(
    'Packed TypeScript installed in a fresh Git repo; all project configurations and every harness guard passed; installed package tests passed.',
  );
} finally {
  if (previous === undefined) {
    delete process.env.HALVARD_HOME;
  } else {
    process.env.HALVARD_HOME = previous;
  }
  rmSync(temporary, { recursive: true, force: true });
}
