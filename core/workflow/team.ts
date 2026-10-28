import type { TeamConfig } from '../types.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { teamConfig } from '../config/team.ts';
import { CONFIG, findRoot, loadProject } from '../project.ts';

export function showTeam(cwd: string) {
  const { root, config } = loadProject(cwd);
  return { root, team: config.team };
}

const toggle = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (value === 'on' || value === 'off') return value === 'on';
  throw new Error(`--${name} takes on or off`);
};

// Writes the team section of the root .halvard.json, keeping every other setting.
export function setTeam(cwd: string, flags: Record<string, string | boolean | undefined>) {
  const root = findRoot(cwd);
  if (!root) throw new Error('no repository or workflow configuration found');
  const file = resolve(root, CONFIG);
  let raw: Record<string, unknown> = { version: 1 };
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const current = (raw.team ?? {}) as Partial<TeamConfig>;
  const monitor = { ...current.monitor } as Record<string, unknown>;
  const watch = toggle(flags.watch, 'watch');
  const nudge = toggle(flags.nudge, 'nudge');
  if (watch !== undefined) monitor.watch = watch;
  if (nudge !== undefined) monitor.nudge = nudge;
  if (flags.approve !== undefined) monitor.approve = flags.approve;
  const team = teamConfig({
    lead: flags.lead ?? current.lead,
    dev: flags.dev ?? current.dev,
    reviewer: flags.reviewer ?? current.reviewer,
    investigator:
      flags.investigator === 'none' ? null : (flags.investigator ?? current.investigator ?? null),
    monitor,
  });
  const next = { ...raw, team };
  // The whole configuration must still load before anything is written.
  loadProject(root, next);
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return { root, team };
}
