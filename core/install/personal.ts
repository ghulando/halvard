import type { PackageMetadata, SettingsWrite, InstallOptions } from './types.ts';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { flowConfig, personalSettings } from '../config/workflow.ts';
import { personalRoot, workspaceRoot } from '../config/paths.ts';
import { projectPath } from '../project.ts';
import { applyInstallation } from './transaction.ts';
import { packageStatus } from './package.ts';
import { pluginRoot } from '../shared/plugin.ts';
import { drivers } from '../harnesses/index.ts';

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
  const personalFile = resolve(destination, 'personal.json');
  if (!existsSync(personalFile)) {
    stage(personalFile, flowConfig());
  } else {
    personalSettings(json(personalFile));
  }
  // The source marketplace name is stable across project and personal installs.
  const market = 'ghulando';
  const description = packageInfo.description;
  for (const { install } of drivers) {
    install?.personal?.({ home, destination, source, market, description, json, stage });
  }
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
    commands: drivers.flatMap(
      ({ install }) =>
        install?.commands?.({ source, destination, reinstall: Boolean(upgrade || repairing) }) ??
        [],
    ),
    instruction:
      'Review this plan before applying. Existing plugins and project settings are retained. Run native marketplace/install commands, then restart every open Claude Code and Codex session: a running session keeps the old plugin path and its hooks stop working. Explicitly trust hooks. Do not enable the same Pi extension both globally and per repo.',
    // Widening write access stays the user's decision, so the installer only names the settings.
    workspace: {
      path: workspaceRoot(home),
      ...Object.fromEntries(
        drivers.flatMap(({ name, install }) =>
          install?.workspace ? [[name, install.workspace(workspaceRoot(home))]] : [],
        ),
      ),
    } as Record<string, string>,
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
