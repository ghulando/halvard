import type { PackageMetadata } from '../install/types.ts';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { AUTHOR_ERROR, authors, eligibleReviewers } from '../config/reviewers.ts';
import { personalRoot } from '../config/paths.ts';
import { currentBranch, loadProject } from '../project.ts';
import { packageStatus } from '../install/package.ts';
import { pluginRoot } from '../shared/plugin.ts';
import { stacksDirectory } from './bootstrap.ts';
import { drivers } from '../harnesses/index.ts';

export function doctor(cwd: string, author?: string) {
  if (author !== undefined && !authors.includes(author)) {
    throw new Error(AUTHOR_ERROR);
  }
  const { root, config } = loadProject(cwd);
  const issues = [];
  const reviewers = Object.fromEntries(
    (author ? [author] : []).map((name) => [name, eligibleReviewers(config.workflow, name)]),
  );
  if (!config.gate) issues.push('No gate is configured; managed task completion is unavailable.');
  if (config.review) {
    const path = resolve(root, config.review[0]!);
    // existsSync also covers a parent that is a file, where statSync throws ENOTDIR.
    const wrapper = existsSync(path) ? statSync(path) : null;
    if (!wrapper?.isFile() || !(wrapper.mode & 0o111)) {
      issues.push(`Review wrapper ${config.review[0]} is missing or not executable.`);
    }
  }
  const stacks = stacksDirectory(config.workflow);
  if (stacks && !(existsSync(stacks) && statSync(stacks).isDirectory())) {
    issues.push(`Stacks directory ${stacks} is missing or not a directory.`);
  }
  if (config.workflow.requireReview) {
    for (const [name, providers] of Object.entries(reviewers)) {
      if (!providers.length) issues.push(`No configured independent reviewer for ${name}.`);
    }
  }
  const paths = [resolve(personalRoot(), 'package'), resolve(root, 'plugins/halvard')];
  const installations = paths
    .filter((path) => existsSync(path))
    .map((path) => packageStatus(pluginRoot, path));
  for (const install of installations) {
    if (!install.matches) {
      let version;
      try {
        version = (
          JSON.parse(readFileSync(resolve(install.path, 'package.json'), 'utf8')) as PackageMetadata
        ).version;
      } catch {}
      const current = (
        JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8')) as PackageMetadata
      ).version;
      const command =
        install.path === paths[0]
          ? version === current
            ? 'install-user --repair'
            : 'install-user for a normal upgrade'
          : version === current
            ? 'install-plan --repair'
            : 'an explicit vendored package upgrade';
      issues.push(`Package content differs at ${install.path}; preview ${command}.`);
    }
  }
  const staging = new Map<string, string[]>();
  const addPrefix = (directory: string, prefix: string) =>
    staging.set(directory, [...(staging.get(directory) ?? []), prefix]);
  for (const path of paths) addPrefix(dirname(path), basename(path) + '.next-');
  const settings = [
    resolve(root, '.halvard.json'),
    resolve(personalRoot(), 'personal.json'),
    resolve(personalRoot(), '.agents/plugins/marketplace.json'),
    ...drivers.flatMap(({ install }) => [
      ...(install?.projectFiles ?? []).map((path) => resolve(root, path)),
      ...(install?.homeFiles ?? []).map((path) => resolve(homedir(), path)),
    ]),
  ];
  for (const path of settings) addPrefix(dirname(path), `.${basename(path)}.workflow-`);
  for (const [directory, prefixes] of staging) {
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && prefixes.some((prefix) => entry.name.startsWith(prefix))) {
          issues.push(
            `Installation staging leftover: ${resolve(directory, entry.name)}; inspect before removing.`,
          );
        }
      }
    }
  }
  return {
    root,
    branch: currentBranch(root),
    runner: resolve(pluginRoot, 'bin/halvard.ts'),
    gate: config.gate,
    requireReview: config.workflow.requireReview,
    reviewers,
    installations,
    issues,
    note: 'Configuration checks do not prove native hooks are loaded or trusted, or that reviewer providers are available.',
  };
}
