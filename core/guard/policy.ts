import type { HookResult } from '../types.ts';

interface PolicyInput {
  readonly: boolean;
  read: boolean;
  opaque: boolean;
  review: boolean;
  gate: boolean;
  gateConfigured: boolean;
  branch: string | null;
  branchOperation: boolean;
  shipping: boolean | undefined;
  shippingAttempt?: boolean | undefined;
  protectedBranches: string[];
}

const opaqueReason =
  'This command could not be classified as read-only because of shell substitution, variables or similar syntax. Use a plain read command with literal paths.';

// Pure decisions; runtime owns filesystem evidence, locks, extension execution and IO.
export function evaluatePolicy({
  readonly,
  read,
  opaque,
  review,
  gate,
  gateConfigured,
  branch,
  branchOperation,
  shipping,
  shippingAttempt,
  protectedBranches,
}: PolicyInput): HookResult | null {
  if (readonly && !read) {
    return {
      decision: 'deny',
      reason: opaque
        ? opaqueReason
        : 'This session is read-only. Exit plan/review mode before making changes or running project checks.',
    };
  }
  if (read || review) return {};
  if (gate) {
    return gateConfigured ? {} : { decision: 'deny', reason: 'No project gate is configured.' };
  }
  if (branchOperation) return null;
  if (!branch) {
    const reason = 'Check out a branch before changing the project.';
    return {
      decision: 'deny',
      reason: opaque
        ? `Cannot determine the branch. ${opaqueReason} ${reason}`
        : `Cannot determine the branch. ${reason}`,
    };
  }
  if (protectedBranches.includes(branch) && !shipping) {
    return {
      decision: 'deny',
      reason: shippingAttempt
        ? `No work on protected branch ${branch}. Run each shipping command alone and plain, for example git push origin ${branch}, without a pipe, chain, cd or redirect; it then asks for approval.${opaque ? ' Write names literally, without variables or substitution.' : ''}`
        : opaque
          ? `${opaqueReason} For real changes, create a feature or fix branch first.`
          : `No work on protected branch ${branch}. Create a feature or fix branch first. To trust a test or query command as a read, list it in readCommands.`,
    };
  }
  return null;
}
