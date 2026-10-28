import type { HookResult, NativeHookOutput } from '../core/types.ts';
import { resolve } from 'node:path';
import { pluginRoot, quote } from '../core/shared/plugin.ts';

// Cursor's own shape. It does not enforce ask, and its CLI fires no prompt hook, so the
// user approves a request from a terminal instead of with a chat phrase.
function cursorOutput(event: string | undefined, result: HookResult): NativeHookOutput {
  if (result.decision) {
    const reason = result.request
      ? `${result.reason}\nTo approve this one operation, run this in the repository from your own terminal: node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))} approve ${result.session} ${result.request}\nThen ask the agent to retry it.`
      : result.reason;
    return { permission: 'deny' as const, user_message: reason, agent_message: reason };
  }
  // A prompt hook that answers without continue could hold the prompt back.
  if (event === 'UserPromptSubmit') return { continue: true };
  if (result.context && event !== 'PreToolUse') return { additional_context: result.context };
  return {};
}

export function hookOutput(
  harness: string | undefined,
  event: string | undefined,
  result: HookResult,
): NativeHookOutput {
  if (harness === 'cursor') return cursorOutput(event, result);
  if (result.decision) {
    const reason = result.request
      ? `${result.reason}\nTo approve this one operation, send exactly: approve halvard ${result.request}`
      : result.reason;
    return {
      // Grok also reads the top-level decision, including for entries it loads from
      // Cursor's hooks file.
      ...(harness === 'grok' ? { decision: result.decision, reason } : {}),
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision:
          harness === 'codex' && result.decision === 'ask' ? 'deny' : result.decision,
        permissionDecisionReason: reason,
      },
    };
  }
  if (result.context) {
    return { hookSpecificOutput: { hookEventName: event, additionalContext: result.context } };
  }
  return {};
}
