import type { ParsedCommand } from './types.ts';
import { HARNESSES } from './types.ts';
import { AUTHOR_ERROR } from './flow-config.ts';

// Shared CLI grammar: the runner and hooks accept the same options and ordering.
const commandSpecs: Record<string, { count: number; options?: string[]; required?: string[] }> = {
  install: { count: 1, options: ['repair'] },
  'install-plan': { count: 1, options: ['repair'] },
  'install-user': { count: 0, options: ['apply', 'repair'] },
  setup: { count: 1 },
  'setup-apply': { count: 2 },
  bootstrap: { count: 1 },
  'bootstrap-apply': { count: 2 },
  'task-start': {
    count: 2,
    options: ['author', 'fix', 'small', 'brief', 'base', 'plan', 'approved-by'],
    required: ['author'],
  },
  'task-done': { count: 1, options: ['gate-session'], required: ['gate-session'] },
  'task-resume': { count: 1 },
  'task-handoff': { count: 1, options: ['author'], required: ['author'] },
  review: {
    count: 1,
    options: ['author', 'reviewer', 'round', 'gate-session', 'pane'],
    required: ['author', 'reviewer', 'round', 'gate-session'],
  },
  'review-status': { count: 1 },
  'review-recover': { count: 1, options: ['stopped-reviewer'] },
  doctor: { count: 0, options: ['author'] },
  gate: { count: 1 },
  approve: { count: 2 },
  team: {
    count: 1,
    options: ['lead', 'dev', 'reviewer', 'investigator', 'approve', 'watch', 'nudge'],
  },
  'history-plan': { count: 0, options: ['harness'], required: ['harness'] },
  'history-digest': { count: 0, options: ['harness'], required: ['harness'] },
  'history-clean': { count: 1, options: ['confirm'], required: ['confirm'] },
  'retro-events': { count: 1 },
};

const booleans = new Set(['fix', 'small', 'apply', 'repair', 'stopped-reviewer', 'pane']);

export function options(args: string[], allowed: string[] = []) {
  const positional: string[] = [];
  const flags: ParsedCommand['flags'] = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i]!.startsWith('--')) {
      positional.push(args[i]!);
      continue;
    }
    const key = args[i]!.slice(2);
    if (!allowed.includes(key) || Object.hasOwn(flags, key)) {
      throw new Error(`unknown or repeated option: ${args[i]!}`);
    }
    if (booleans.has(key)) {
      flags[key] = true;
    } else {
      if (!args[i + 1]! || args[i + 1]!.startsWith('--')) {
        throw new Error(`missing value for ${args[i]!}`);
      }
      flags[key] = args[++i]!;
    }
  }
  return { positional, flags };
}

export function parseCommand(verb: string, args: string[]): ParsedCommand {
  const spec = Object.hasOwn(commandSpecs, verb) && commandSpecs[verb];
  if (!spec) throw new Error(`unknown command: ${verb}`);
  const result = options(args, spec.options);
  if (result.positional.length !== spec.count) {
    throw new Error(`${verb} needs ${spec.count} positional arguments`);
  }
  for (const key of spec.required ?? []) {
    if (!result.flags[key]) throw new Error(`missing --${key}`);
  }
  if (
    result.flags.author &&
    !(HARNESSES as readonly string[]).includes(result.flags.author as string)
  ) {
    throw new Error(AUTHOR_ERROR);
  }
  if (
    result.flags.reviewer &&
    ![...HARNESSES, 'ollama'].includes(result.flags.reviewer as string)
  ) {
    throw new Error('invalid reviewer');
  }
  if (result.flags.round && !/^(?:[1-9]|10)$/.test(result.flags.round as string)) {
    throw new Error('invalid review round');
  }
  return { verb, ...result };
}
