import type { Harness, TeamConfig } from '../types.ts';
import { HARNESSES } from '../types.ts';

const TEAM_ROLES = ['lead', 'dev', 'reviewer'] as const;
const APPROVALS = ['reads-edits-gate', 'none'];

export const isHarness = (value: unknown): value is Harness =>
  typeof value === 'string' && (HARNESSES as readonly string[]).includes(value);

// A Herdr team: three required roles and an optional investigator, each one harness.
export function teamConfig(input: unknown): TeamConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('team must be an object');
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (![...TEAM_ROLES, 'investigator', 'monitor'].includes(key)) {
      throw new Error(`unknown team option: ${key}`);
    }
  }
  for (const role of TEAM_ROLES) {
    if (!isHarness(value[role])) throw new Error(`team ${role} must be ${HARNESSES.join(', ')}`);
  }
  const investigator = value.investigator ?? null;
  if (investigator !== null && !isHarness(investigator)) {
    throw new Error(`team investigator must be ${HARNESSES.join(', ')} or null`);
  }
  if (value.lead === value.dev)
    throw new Error('the team lead and dev must be different harnesses');
  if (value.reviewer === value.dev) {
    throw new Error('the team reviewer must not be the dev, whose work it reviews');
  }
  if (
    value.monitor !== undefined &&
    (!value.monitor || typeof value.monitor !== 'object' || Array.isArray(value.monitor))
  ) {
    throw new Error('team monitor must be an object');
  }
  const monitor: Record<string, unknown> = {
    watch: true,
    nudge: true,
    approve: 'reads-edits-gate',
    ...(value.monitor as Record<string, unknown> | undefined),
  };
  if (
    Object.keys(monitor).some((key) => !['watch', 'nudge', 'approve'].includes(key)) ||
    typeof monitor.watch !== 'boolean' ||
    typeof monitor.nudge !== 'boolean' ||
    !APPROVALS.includes(monitor.approve as string)
  ) {
    throw new Error(
      'team monitor takes watch and nudge (true or false) and approve (reads-edits-gate or none)',
    );
  }
  return {
    lead: value.lead as Harness,
    dev: value.dev as Harness,
    reviewer: value.reviewer as Harness,
    investigator: investigator as Harness | null,
    monitor: monitor as TeamConfig['monitor'],
  };
}
