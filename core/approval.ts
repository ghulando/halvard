import type { ApprovalVia, Grant, PendingRequest, Project, WorkflowState } from './types.ts';
import { fingerprint, withState } from './state.ts';
import { logEvent } from './workflow/log.ts';

// Approval requests and their answers, shared by the hook runtime, the terminal command and
// the approval dialogs.

// A request waits this long for an answer, and a grant this long for the retry it allows.
// Each is measured from its own time, so a timely approval survives a slow retry.
export const REQUEST_TTL = 10 * 60 * 1000;
export const GRANT_TTL = 10 * 60 * 1000;

export const clock = (time: number) => new Date(time).toTimeString().slice(0, 5);
export const short = (id: string) => id.slice(0, 12);

export type ApprovalOutcome = 'approved' | 'none' | 'unknown' | 'replaced' | 'expired' | 'stale';

// A request id the log may hold: a prefix of a digest, never the operation.
export const logId = (id: string) => id.slice(0, 16);

// Records what became of an approval request. Outcomes come only from a trusted answer:
// the user's prompt or terminal, or a host dialog whose answer reaches Halvard directly.
export function recordOutcome(
  project: Project,
  harness: string | null,
  key: string,
  request: string,
  outcome: 'approved' | 'rejected' | 'declined' | 'cancelled' | 'expired' | 'host-allowed',
  via: string,
) {
  try {
    logEvent(project, 'outcome', {
      harness,
      session: key,
      request: logId(request),
      outcome,
      via,
    });
  } catch {}
}

export const isPending = (value: unknown): value is PendingRequest =>
  Boolean(value) &&
  typeof (value as PendingRequest).id === 'string' &&
  typeof (value as PendingRequest).op === 'string' &&
  typeof (value as PendingRequest).at === 'number';

export const grantOf = (state: WorkflowState): Grant | null =>
  state.approved && typeof state.approved === 'object' ? state.approved : null;

// Marks one pending request approved, once. The prompt hook calls it for the approval
// phrase, `halvard approve` from the user's own terminal, and the approval dialogs with the
// answer their host delivered. Every other outcome leaves the operation blocked and says why.
export async function approve(
  project: Project,
  harness: string | null,
  key: string,
  id: string,
  via: ApprovalVia,
  deadline?: number,
): Promise<{ outcome: ApprovalOutcome; message: string }> {
  const { root } = project;
  const result = await withState(root, key, (state) => {
    const pending = isPending(state.pending) ? state.pending : null;
    const now = Date.now();
    if (!pending) {
      return {
        outcome: 'none' as const,
        message: `Workflow approval is missing, stale or expired: no request is waiting in this session, so request ${short(id)} was not applied. Retry the original operation to request approval.`,
      };
    }
    if (pending.id !== id) {
      if (pending.previous?.id === id) {
        return {
          outcome: 'replaced' as const,
          message: `Request ${short(id)} expired at ${clock(pending.previous.at + REQUEST_TTL)} and a newer request (${short(pending.id)}) replaced it, so this approval was not applied. Approve the current request only after reading it.`,
        };
      }
      return {
        outcome: 'unknown' as const,
        message: `Workflow approval is missing, stale or expired: request ${short(id)} is not the one waiting in this session (that is ${short(pending.id)}). It may belong to another session or an earlier operation. Nothing was approved.`,
      };
    }
    if (now - pending.at > REQUEST_TTL) {
      return {
        outcome: 'expired' as const,
        message: `Request ${short(id)} expired at ${clock(pending.at + REQUEST_TTL)}, before this approval arrived, so nothing was approved. Retry the operation; Halvard then shows a new request id to approve.`,
      };
    }
    if (pending.tree !== fingerprint(root, undefined, deadline)) {
      return {
        outcome: 'stale' as const,
        message: `Request ${short(id)} is stale: the working tree changed after it was made, so nothing was approved. Retry the operation to request approval on the current tree.`,
      };
    }
    state.approved = { id, at: now, via };
    return {
      outcome: 'approved' as const,
      message: `Approved workflow request ${short(id)}, once. Retry the exact original operation before ${clock(now + GRANT_TTL)}.`,
    };
  });
  if (
    result.outcome === 'approved' ||
    result.outcome === 'expired' ||
    result.outcome === 'replaced'
  ) {
    recordOutcome(
      project,
      harness,
      key,
      id,
      result.outcome === 'approved' ? 'approved' : 'expired',
      via,
    );
  }
  return result;
}

// The answer a host dialog returned for a request. Only an explicit approval approves;
// rejection and a dismissed dialog are logged and leave the operation blocked.
export async function answerDialog(
  project: Project,
  harness: string,
  key: string,
  request: string,
  answer: 'approve' | 'reject' | 'cancel',
  via: ApprovalVia,
) {
  if (answer === 'approve') return approve(project, harness, key, request, via);
  recordOutcome(
    project,
    harness,
    key,
    request,
    answer === 'reject' ? 'rejected' : 'cancelled',
    via,
  );
  return {
    outcome: answer === 'reject' ? ('rejected' as const) : ('cancelled' as const),
    message: '',
  };
}
