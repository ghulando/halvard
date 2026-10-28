import type {
  PackageMetadata,
  ProjectInstallPlan,
  SettingsWrite,
  CopyPlan,
  PackageStatus,
  LinkPlan,
  InstallOptions,
} from './types.ts';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG, inside, projectPath } from '../project.ts';
import { applyInstallation } from './transaction.ts';
import { packageStatus } from './package.ts';
import { pluginRoot } from '../shared/plugin.ts';
import { drivers } from '../harnesses/index.ts';

function json<T>(path: string, fallback: T = {} as T): T {
  const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  return parsed as T;
}

// Plan all configuration changes before writing so conflicts do not leave a
// partly migrated project. Existing hooks, permissions and models are retained.
export function installPlan(
  repo: string,
  { repair = false }: InstallOptions = {},
): ProjectInstallPlan {
  const root = realpathSync(repo);
  const writes: SettingsWrite[] = [];
  const installedRoot = inside(root, pluginRoot) ? pluginRoot : resolve(root, 'plugins/halvard');
  const packageFiles = [
    ...json<PackageMetadata>(resolve(pluginRoot, 'package.json')).files,
    'package.json',
  ];
  let copy: CopyPlan | undefined;
  let drift: PackageStatus | undefined;
  let replace = false;
  if (!inside(root, pluginRoot)) {
    projectPath(root, root, installedRoot);
    if (existsSync(installedRoot)) {
      const metadata = json<PackageMetadata>(resolve(installedRoot, 'package.json'));
      if (
        metadata.name !== 'halvard' ||
        metadata.version !== json<PackageMetadata>(resolve(pluginRoot, 'package.json')).version
      ) {
        throw new Error(
          'plugins/halvard already exists; version or package name differs; repair requires the same version; review and update it before installing',
        );
      }
      drift = packageStatus(pluginRoot, installedRoot);
      if (repair && !drift.matches) {
        copy = { destination: installedRoot, files: packageFiles };
        replace = true;
      }
    } else {
      copy = { destination: installedRoot, files: packageFiles };
    }
  }
  const stage = (path: string, content: string) => {
    projectPath(root, root, path);
    const absolute = resolve(root, path);
    writes.push({ path, content, before: existsSync(absolute) ? readFileSync(absolute) : null });
  };
  const stageJSON = (path: string, value: unknown) =>
    stage(path, JSON.stringify(value, null, 2) + '\n');
  if (!existsSync(resolve(root, CONFIG))) {
    stageJSON(CONFIG, { version: 1, gate: null, requiredSkills: [] });
  }
  // The source marketplace name is stable across project and personal installs.
  const market = 'ghulando';
  let link: LinkPlan | undefined;
  for (const { install } of drivers) {
    install?.project?.({
      root,
      installedRoot,
      market,
      json,
      stage,
      stageJSON,
      link: (path, target) => {
        projectPath(root, root, resolve(root, path));
        link = { path, target };
      },
    });
  }
  return { root, writes, link, copy, drift, replace };
}

export function install(repo: string, options: InstallOptions = {}) {
  const plan = installPlan(repo, options);
  if (plan.drift && !plan.drift.matches && !options.repair) {
    throw new Error(
      'vendored package content differs; preview install-plan --repair and apply install --repair',
    );
  }
  applyInstallation({
    source: pluginRoot,
    copy: plan.copy,
    replace: plan.replace,
    writes: plan.writes.map((write) => ({ ...write, path: resolve(plan.root, write.path) })),
    link: plan.link && { ...plan.link, path: resolve(plan.root, plan.link.path) },
  });
  process.stdout.write(
    'Workflow configured. Restart each harness and trust the project/plugin hooks. Existing guards were retained; remove superseded guards only after reviewing the migration.\n',
  );
}
