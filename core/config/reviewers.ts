import type { FlowConfig } from '../types.ts';
import { HARNESSES } from '../types.ts';

export const authors: string[] = [...HARNESSES];
export const AUTHOR_ERROR = `author must be ${authors.join(', ')}`;

// Headless review providers: each runs a CLI on this machine.
export const providers = ['claude', 'codex', 'grok', 'cursor', 'ollama'];

export const reviewerChoices: Record<string, string[]> = {
  pi: ['claude', 'codex', 'grok', 'cursor'],
  codex: ['ollama', 'claude', 'grok', 'cursor'],
  claude: ['ollama', 'codex', 'grok', 'cursor'],
  grok: ['ollama', 'claude', 'codex', 'cursor'],
  cursor: ['ollama', 'claude', 'codex', 'grok'],
};

export const assignment = (workflow: FlowConfig, author: string) =>
  Object.hasOwn(workflow.reviewers, author) && workflow.reviewers[author]!.reviewer !== undefined
    ? workflow.reviewers[author]!
    : null;

// An assigned author has exactly one reviewer; others choose among unassigned providers.
export const eligibleReviewers = (workflow: FlowConfig, author: string) => {
  const assigned = assignment(workflow, author);
  if (assigned) return [assigned.reviewer!];
  return (reviewerChoices[author] ?? []).filter(
    (name) =>
      Object.hasOwn(workflow.reviewers, name) && workflow.reviewers[name]!.reviewer === undefined,
  );
};

export function reviewerSettings(workflow: FlowConfig, author: string, reviewer: string) {
  if (!eligibleReviewers(workflow, author).includes(reviewer)) return null;
  const { model, transport } = assignment(workflow, author) ?? workflow.reviewers[reviewer]!;
  return { model, transport };
}
