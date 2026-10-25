import type { Action, ProjectConfig } from '../types.ts';
import { matches } from '../project.ts';

// One contract for managed status rendering and completion detection.
export function completionStatus(marker: string) {
  return marker.startsWith('**Status:**') ? marker : `**Status:** ${marker}`;
}

export function claimsDone(
  action: Action,
  config: Pick<ProjectConfig, 'doneMarker' | 'taskFiles'>,
) {
  if (action.kind !== 'files') return false;
  const expected = completionStatus(config.doneMarker);
  const done = (content: string) =>
    content.split(/\r?\n/).some((line) => {
      return (
        line === expected ||
        (line.startsWith(expected) && /^(?:\s+|\s*<!--)/.test(line.slice(expected.length)))
      );
    });
  return action.files.some(
    (file) =>
      matches(file.path, config.taskFiles) &&
      file.after !== null &&
      ((done(file.after) && !done(file.before ?? '')) ||
        file.after.split(expected).length > (file.before ?? '').split(expected).length),
  );
}
