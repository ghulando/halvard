import type { FlowConfig } from '../types.ts';
import { HARNESSES } from '../types.ts';
import { driver, drivers } from '../harnesses/index.ts';

export const authors: string[] = [...HARNESSES];
export const AUTHOR_ERROR = `author must be ${authors.join(', ')}`;

// Headless review providers: each runs a CLI on this machine.
export const providers = drivers.flatMap(({ name, review }) => (review ? [name] : []));

// Each author may be reviewed by every other provider it is independent of, Ollama first.
export const reviewerChoices: Record<string, string[]> = Object.fromEntries(
  authors.map((author) => [
    author,
    [...providers]
      .sort((a, b) => Number(b === 'ollama') - Number(a === 'ollama'))
      .filter((name) => name !== author && !driver(name)!.review!.notFor?.includes(author)),
  ]),
);

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
