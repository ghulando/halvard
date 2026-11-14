// Halvard's rules for a team and a task file, as the watchtower reads them. This module
// imports nothing from Herdr, so tests check it against the engine's own rules:
// core/config/team.ts for the team and core/workflow/tasks.ts for task metadata.

export const HARNESSES = ["pi", "claude", "codex", "grok", "cursor"];
const isHarness = (value) => typeof value === "string" && HARNESSES.includes(value);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const ROLES = ["lead", "dev", "reviewer", "investigator", "monitor"];
const MONITOR = ["watch", "nudge", "approve"];
const APPROVALS = ["reads-edits-gate", "none"];

// The team with its investigator ({ lead, dev, reviewer, investigator }), or null when
// Halvard would refuse it.
export function validTeam(team) {
  if (!isObject(team)) return null;
  if (Object.keys(team).some((key) => !ROLES.includes(key))) return null;
  if (![team.lead, team.dev, team.reviewer].every(isHarness)) return null;
  const investigator = team.investigator ?? null;
  if (investigator !== null && !isHarness(investigator)) return null;
  if (team.lead === team.dev || team.reviewer === team.dev) return null;
  if (team.monitor !== undefined) {
    const monitor = team.monitor;
    if (!isObject(monitor) || Object.keys(monitor).some((key) => !MONITOR.includes(key))) return null;
    if (monitor.watch !== undefined && typeof monitor.watch !== "boolean") return null;
    if (monitor.nudge !== undefined && typeof monitor.nudge !== "boolean") return null;
    if (monitor.approve !== undefined && !APPROVALS.includes(monitor.approve)) return null;
  }
  return { lead: team.lead, dev: team.dev, reviewer: team.reviewer, investigator };
}

const METADATA = /^<!-- halvard (.+) -->$/m;
const BASE = /^[a-f0-9]{40,64}$/;

// The first paragraph under a "## <heading>" line, or null.
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const body = text.slice(start + heading.length + 5).split(/\n## /)[0].trim();
  return body.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim() || null;
}

// { title, status, next } when the file is a Halvard task on this branch, else null. Only
// metadata Halvard accepts names a branch, so the card never shows a task Halvard ignores.
export function parseTask(source, branch, name) {
  if (typeof source !== "string" || !branch) return null;
  const match = source.match(METADATA);
  if (!match) return null;
  let metadata;
  try {
    metadata = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (
    !isObject(metadata) ||
    metadata.version !== 1 ||
    !isHarness(metadata.author) ||
    typeof metadata.branch !== "string" ||
    typeof metadata.base !== "string" ||
    !BASE.test(metadata.base) ||
    typeof metadata.title !== "string" ||
    (metadata.plan !== undefined &&
      (!isObject(metadata.plan) ||
        !/^[a-f0-9]{64}$/.test(String(metadata.plan.digest)) ||
        typeof metadata.plan.approvedBy !== "string" ||
        typeof metadata.plan.at !== "string")) ||
    metadata.branch !== branch
  ) {
    return null;
  }
  // Sections are found by their \n## lines, so Windows line ends are read as \n.
  const text = source.replace(/\r\n/g, "\n");
  return {
    title: text.match(/^# (.+)$/m)?.[1] ?? (metadata.title || name),
    status: text.match(/^\*\*Status:\*\* (.+?)\.?$/m)?.[1] ?? null,
    next: section(text, "Next step"),
  };
}
