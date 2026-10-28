import type { HarnessSettings } from '../core/harnesses/types.ts';
import './environment.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fingerprint } from '../core/state.ts';
import { install, installPlan } from '../core/install/install.ts';
import { fixture } from './hook-fixture.ts';

test('installation preserves existing settings, is idempotent and preflights conflicts', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.pi'));
  writeFileSync(join(root, '.pi/settings.json'), JSON.stringify({ defaultThinkingLevel: 'high' }));
  mkdirSync(join(root, '.claude'));
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [] } }),
  );
  install(root);
  const first = readFileSync(join(root, '.pi/settings.json'), 'utf8');
  install(root);
  assert.equal(readFileSync(join(root, '.pi/settings.json'), 'utf8'), first);
  const claude = JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  ) as HarnessSettings;
  assert.deepEqual(claude.permissions, { allow: ['Read'] });
  assert.deepEqual(claude.hooks, { Stop: [] });
  const codexConfig = join(root, '.codex/config.toml');
  const enabled = readFileSync(codexConfig, 'utf8');
  writeFileSync(codexConfig, enabled.replace('enabled = true', 'enabled = false'));
  assert.throws(() => installPlan(root), /enabled = true/);
  writeFileSync(codexConfig, enabled);
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({
      extraKnownMarketplaces: { ghulando: { source: { path: 'another' } } },
    }),
  );
  assert.throws(() => installPlan(root), /another source/);
  assert.equal(readFileSync(join(root, '.pi/settings.json'), 'utf8'), first);
});

test('a dangling Claude skills symlink fails installation before any files are written', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.agents/skills'), { recursive: true });
  mkdirSync(join(root, '.claude'));
  symlinkSync('../missing-skills', join(root, '.claude/skills'));
  const before = fingerprint(root);
  // existsSync alone treats the dangling link as absent and installation writes settings before EEXIST.
  assert.throws(() => install(root), /dangling.*symlink/);
  assert.equal(fingerprint(root), before);
});

test('installation preserves an equivalent single-quoted Codex plugin table', (t) => {
  const root = fixture(t);
  mkdirSync(join(root, '.codex'));
  const toml = "[plugins.'halvard@ghulando']\nenabled = true\n";
  writeFileSync(join(root, '.codex/config.toml'), toml);
  install(root);
  // Matching only the generated double-quoted heading appends a duplicate table.
  assert.equal(readFileSync(join(root, '.codex/config.toml'), 'utf8'), toml);
  writeFileSync(join(root, '.codex/config.toml'), toml.replace('true', 'false'));
  assert.throws(() => installPlan(root), /enabled = true/);
});
