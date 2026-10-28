import type { HarnessSettings, PackageMetadata, SettingsWrite, InstallOptions } from './types.ts';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { flowConfig, personalSettings } from '../config/workflow.ts';
import { personalRoot, workspaceRoot } from '../config/paths.ts';
import { projectPath } from '../project.ts';
import { applyInstallation } from './transaction.ts';
import { packageStatus } from './package.ts';
import { pluginRoot } from '../shared/plugin.ts';

export function personalInstallPlan(
  home = homedir(),
  destination = personalRoot(),
  { repair = false }: InstallOptions = {},
) {
  const writes: SettingsWrite[] = [];
  const source = resolve(destination, 'package');
  const json = <T>(file: string): T => {
    const parsed: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    return parsed as T;
  };
  const packageInfo = json<PackageMetadata>(resolve(pluginRoot, 'package.json'));
  const stage = (file: string, value: unknown) => {
    projectPath(home, home, file);
    writes.push({
      path: file,
      before: existsSync(file) ? readFileSync(file) : null,
      content: typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
    });
  };
  projectPath(home, home, destination);
  let upgrade = null;
  if (existsSync(source)) {
    const existing = json<PackageMetadata>(resolve(source, 'package.json'));
    if (existing.name !== packageInfo.name) {
      throw new Error('personal package exists with another package name');
    }
    if (repair && existing.version !== packageInfo.version) {
      throw new Error('repair requires the same version; use install-user for a normal upgrade');
    }
    if (existing.version !== packageInfo.version) {
      upgrade = { from: existing.version, to: packageInfo.version };
    }
  }
  const piPath = resolve(home, '.pi/agent/settings.json');
  const pi = json<HarnessSettings>(piPath);
  if (pi.packages !== undefined && !Array.isArray(pi.packages)) {
    throw new Error('Pi packages must be an array');
  }
  pi.packages = [...new Set([...(pi.packages ?? []), source])];
  stage(piPath, pi);
  const claudePath = resolve(home, '.claude/settings.json');
  const claude = json<HarnessSettings>(claudePath);
  claude.extraKnownMarketplaces ??= {};
  const marketplace = { source: { source: 'directory', path: source } };
  // The source marketplace name is stable across project and personal installs.
  const market = 'ghulando';
  const existing = claude.extraKnownMarketplaces[market];
  if (
    existing &&
    JSON.stringify(existing) !== JSON.stringify(marketplace) &&
    !(
      existing.source?.source === 'directory' &&
      resolve(existing.source.path) === resolve(pluginRoot)
    )
  ) {
    throw new Error('user Claude marketplace already belongs to another source');
  }
  claude.extraKnownMarketplaces[market] = marketplace;
  claude.enabledPlugins ??= {};
  claude.enabledPlugins[`halvard@${market}`] = true;
  stage(claudePath, claude);
  const personalFile = resolve(destination, 'personal.json');
  if (!existsSync(personalFile)) {
    stage(personalFile, flowConfig());
  } else {
    personalSettings(json(personalFile));
  }
  stage(resolve(destination, '.agents/plugins/marketplace.json'), {
    name: market,
    plugins: [
      {
        name: 'halvard',
        source: { source: 'local', path: './package' },
        interface: { displayName: 'Halvard', shortDescription: packageInfo.description },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ],
  });
  const codexPath = resolve(home, '.codex/config.toml');
  const toml = existsSync(codexPath) ? readFileSync(codexPath, 'utf8') : '';
  const heading = '[plugins."halvard@ghulando"]';
  const headings = [heading, "[plugins.'halvard@ghulando']"];
  const table = toml
    .split(/(?=^\s*\[)/m)
    .find((part) => headings.some((key) => part.trimStart().startsWith(key)));
  if (table && !/^\s*enabled\s*=\s*true\s*(?:#.*)?$/m.test(table)) {
    throw new Error('personal Codex plugin is disabled; resolve configuration before installing');
  }
  if (!table) stage(codexPath, toml + `\n${heading}\nenabled = true\n`);
  const drift = existsSync(source) && !upgrade ? packageStatus(pluginRoot, source) : null;
  const repairing = repair && drift && !drift.matches;
  return {
    writes,
    upgrade,
    drift,
    repair: repairing,
    copy:
      existsSync(source) && !upgrade && !repairing
        ? null
        : { destination: source, files: [...packageInfo.files, 'package.json'] },
    commands: [
      ['claude', 'plugin', 'marketplace', 'add', source],
      ['claude', 'plugin', 'install', 'halvard@ghulando'],
      ['codex', 'plugin', 'marketplace', 'add', destination],
      ...(upgrade || repairing ? [['codex', 'plugin', 'remove', 'halvard@ghulando']] : []),
      ['codex', 'plugin', 'add', 'halvard@ghulando'],
    ],
    instruction:
      'Review this plan before applying. Existing plugins and project settings are retained. Run native marketplace/install commands, then restart every open Claude Code and Codex session: a running session keeps the old plugin path and its hooks stop working. Explicitly trust hooks. Do not enable the same Pi extension both globally and per repo.',
    // Widening write access stays the user's decision, so the installer only names the settings.
    workspace: {
      path: workspaceRoot(home),
      claude: `Add ${JSON.stringify(workspaceRoot(home))} to permissions.additionalDirectories in ~/.claude/settings.json`,
      codex: `Add ${JSON.stringify(workspaceRoot(home))} to writable_roots under [sandbox_workspace_write] in ~/.codex/config.toml`,
    },
  };
}

export function installPersonal(
  home = homedir(),
  destination = personalRoot(),
  options: InstallOptions = {},
) {
  const plan = personalInstallPlan(home, destination, options);
  if (plan.drift && !plan.drift.matches && !options.repair) {
    throw new Error(
      'installed package content differs; preview install-user --repair, then apply with --repair --apply',
    );
  }
  applyInstallation({
    source: pluginRoot,
    copy: plan.copy,
    writes: plan.writes,
    replace: Boolean(plan.upgrade || plan.repair),
  });
  return {
    upgrade: plan.upgrade,
    repaired: Boolean(plan.repair),
    commands: plan.commands,
    instruction: plan.instruction,
    workspace: plan.workspace,
  };
}
