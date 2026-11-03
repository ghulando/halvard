import type { HookResult, NativeHookOutput } from '../types.ts';

// The Claude-shaped hook answer that Claude, Codex, Grok and Pi read. Codex does not
// enforce ask, and Grok also reads the top-level decision, including for entries it loads
// from Cursor's hooks file.
export function standardOutput(
  event: string | undefined,
  result: HookResult,
  { askAsDeny = false, topLevel = false, dialog = '' } = {},
): NativeHookOutput {
  if (result.decision) {
    // A host with an approval dialog tool names it first; the text approval always works.
    const reason = result.request
      ? `${result.reason}\n${dialog ? `To ask the user, call the ${dialog} tool with request ${result.request}; it shows them an approval dialog. Otherwise the user ` : 'To approve this one operation, '}send${dialog ? 's' : ''} exactly: approve halvard ${result.request}`
      : result.reason;
    return {
      ...(topLevel ? { decision: result.decision, reason } : {}),
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: askAsDeny && result.decision === 'ask' ? 'deny' : result.decision,
        permissionDecisionReason: reason,
      },
    };
  }
  if (result.context) {
    return { hookSpecificOutput: { hookEventName: event, additionalContext: result.context } };
  }
  return {};
}

// Grok and Cursor print one JSON result object in headless JSON mode.
export function envelopeText(host: 'Grok' | 'Cursor', stdout: string) {
  const envelope = JSON.parse(stdout) as { is_error?: unknown; result?: unknown; text?: unknown };
  const text = host === 'Grok' ? (envelope.text ?? envelope.result) : envelope.result;
  if (envelope.is_error || typeof text !== 'string') {
    throw new Error(`${host} did not produce a successful review`);
  }
  return text;
}

// An agent run's answer from an envelope, with a parse failure reported as the run's error.
export function envelopeAgent(host: 'Grok' | 'Cursor', stdout: string) {
  try {
    return { text: envelopeText(host, stdout), costUsd: 0, error: null };
  } catch (err) {
    return { text: '', costUsd: 0, error: (err as Error).message };
  }
}
