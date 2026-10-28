import type {
  HarnessSettings,
  Marketplace,
  PackageMetadata,
  ProjectInstallPlan,
  SettingsWrite,
  CopyPlan,
  PackageStatus,
  LinkPlan,
  InstallOptions,
} from '../types.ts';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { CONFIG, inside, projectPath } from '../project.ts';
import { applyInstallation } from './transaction.ts';
import { packageStatus } from './package.ts';
import { pluginRoot } from '../shared/plugin.ts';

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
  const pi = json<HarnessSettings>(resolve(root, '.pi/settings.json'));
  const source = relative(resolve(root, '.pi'), installedRoot).split('\\').join('/');
  if (pi.packages !== undefined && !Array.isArray(pi.packages)) {
    throw new Error('Pi packages must be an array');
  }
  pi.packages = [...(pi.packages ?? [])];
  if (!pi.packages.includes(source)) pi.packages.push(source);
  stageJSON('.pi/settings.json', pi);

  const claude = json<HarnessSettings>(resolve(root, '.claude/settings.json'));
  claude.extraKnownMarketplaces ??= {};
  const market = 'ghulando';
  const existing = claude.extraKnownMarketplaces[market];
  const location = './' + relative(root, installedRoot).replace(/\/$/, '');
  const directory = { source: { source: 'directory', path: location } };
  if (existing && JSON.stringify(existing) !== JSON.stringify(directory)) {
    throw new Error('Claude marketplace name already belongs to another source');
  }
  claude.extraKnownMarketplaces[market] = directory;
  claude.enabledPlugins ??= {};
  claude.enabledPlugins[`halvard@${market}`] = true;
  stageJSON('.claude/settings.json', claude);
  if (!existsSync(resolve(root, 'CLAUDE.md')) && existsSync(resolve(root, 'AGENTS.md'))) {
    stage('CLAUDE.md', '@AGENTS.md\n');
  }

  const codexPath = '.agents/plugins/marketplace.json';
  const codex = json<Marketplace>(resolve(root, codexPath), { name: market, plugins: [] });
  if (typeof codex.name !== 'string' || !Array.isArray(codex.plugins)) {
    throw new Error('invalid Codex marketplace');
  }
  const local = './' + relative(root, installedRoot).split('\\').join('/').replace(/\/$/, '');
  const entry = {
    name: 'halvard',
    source: { source: 'local', path: local },
    interface: {
      displayName: 'Halvard',
      shortDescription: 'Shared repository workflow guards',
    },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  };
  const found = codex.plugins.find((plugin) => plugin.name === entry.name);
  if (found && JSON.stringify(found.source) !== JSON.stringify(entry.source)) {
    throw new Error('Codex plugin name already belongs to another source');
  }
  if (!found) {
    codex.plugins.push(entry);
  } else {
    Object.assign(found, { policy: entry.policy, category: entry.category });
  }
  stageJSON(codexPath, codex);
  const configPath = resolve(root, '.codex/config.toml');
  const toml = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const heading = `[plugins."halvard@${codex.name}"]`;
  const headings = [heading, `[plugins.'halvard@${codex.name}']`];
  const tables = toml.split(/(?=^\s*\[)/m);
  const table = tables.find((part) => headings.some((key) => part.trimStart().startsWith(key)));
  if (table && !/^\s*enabled\s*=\s*true\s*(?:#.*)?$/m.test(table)) {
    throw new Error(
      'Codex plugin table already exists without enabled = true; resolve it before installing',
    );
  }
  if (!table) stage('.codex/config.toml', toml + `\n${heading}\nenabled = true\n`);

  const linkPath = resolve(root, '.claude/skills');
  const skillsPath = resolve(root, '.agents/skills');
  const stat = lstatSync(linkPath, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() && !existsSync(linkPath)) {
    throw new Error('.claude/skills is a dangling symlink; resolve it before installing');
  }
  let link: LinkPlan | undefined;
  if (existsSync(skillsPath) && !stat) {
    projectPath(root, root, linkPath);
    link = { path: '.claude/skills', target: '../.agents/skills' };
  }
  if (stat && !stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new Error('.claude/skills is not a directory');
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
