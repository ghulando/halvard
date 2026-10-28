import type { HookPayload, HookResult, NativeHookOutput } from '../types.ts';
import type { Driver, Raw } from './types.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { cursor } from './cursor.ts';
import { grok } from './grok.ts';
import { ollama } from './ollama.ts';
import { pi } from './pi.ts';
import { standardOutput } from './output.ts';

// Grok comes before Cursor: Grok also loads Cursor's hooks file, and its payload then
// looks like Cursor's.
export const drivers: readonly Driver[] = [pi, claude, codex, grok, cursor, ollama];

export function driver(name: string | undefined) {
  return drivers.find((entry) => entry.name === name);
}

// The host that really sent a payload, when it differs from the entry that received it.
export function hostHarness(raw: unknown, env: NodeJS.ProcessEnv = process.env) {
  const payload = raw && typeof raw === 'object' ? (raw as Raw) : {};
  return drivers.find((entry) => entry.detect?.(payload, env))?.name ?? null;
}

// Returns null for an event this harness's entry deliberately leaves to another one.
export function toHookPayload(harness: string | undefined, raw: unknown): HookPayload | null {
  if (!raw || typeof raw !== 'object') return raw as HookPayload;
  const hooks = driver(harness)?.hooks;
  return hooks ? hooks.payload(raw as Raw) : (raw as HookPayload);
}

export function hookOutput(
  harness: string | undefined,
  event: string | undefined,
  result: HookResult,
): NativeHookOutput {
  const hooks = driver(harness)?.hooks;
  return hooks ? hooks.output(event, result) : standardOutput(event, result);
}
