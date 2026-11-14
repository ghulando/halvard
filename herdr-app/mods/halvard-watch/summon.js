// Opens the "hall" tab for the team saved in a repository's .halvard.json:
//   lead | dev
//        | reviewer | investigator (when configured)
// Each pane starts its harness. run() returns nothing and the new pane reaches panes()
// only on a later frame, so the summon waits for a pane that was not there before.
// pane.split takes no argv, so splits focus their neighbour and use terminal.open.
// Pane roles go to shared "halvard.roles" for the pane headers.

import { panes, readTextFile, run, setShared, shared } from "herdr";

// Cursor's terminal agent is cursor-agent; the other harnesses run under their own name.
const argv = (harness) => (harness === "cursor" ? ["cursor-agent"] : [harness]);

export const TEAM_HELP = "halvard team set --lead <harness> --dev <harness> --reviewer <harness>";

// Halvard's harnesses, and its rules for a team: core/config/team.ts.
const HARNESSES = ["pi", "claude", "codex", "grok", "cursor"];
const isHarness = (value) => HARNESSES.includes(value);

// The team saved in the repository's .halvard.json, or null when it has no valid one.
export async function readTeam(root) {
  let team = null;
  try {
    team = JSON.parse((await readTextFile(`${root}/.halvard.json`)) ?? "null")?.team ?? null;
  } catch {
    return null;
  }
  if (!team || ![team.lead, team.dev, team.reviewer].every(isHarness)) return null;
  if (team.investigator != null && !isHarness(team.investigator)) return null;
  if (team.lead === team.dev || team.reviewer === team.dev) return null;
  return team;
}

// Returns null when the hall opened, else what stopped it.
export async function summon(root, cx) {
  const team = await readTeam(root);
  if (!team) return `This repository has no valid team. Save one with: ${TEAM_HELP}`;

  // A split's new pane is looked for in the hall's tab only, so a pane opened elsewhere
  // meanwhile is never taken for it.
  const open = async (command, args, tab = null) => {
    const before = new Set(panes().map((p) => p.pane));
    run(command, args);
    for (let waited = 0; waited < 3000; waited += 50) {
      const pane = panes().find((p) => !before.has(p.pane) && (!tab || p.tab === tab))?.pane;
      if (pane) return pane;
      await cx.sleep(50);
    }
    return null;
  };
  let hall = null;
  const split = (pane, place, harness) => {
    run("pane.focus", { pane });
    return open("terminal.open", { argv: argv(harness), folder: root, place }, hall);
  };
  const live = new Set(panes().map((p) => p.pane));
  const roles = Object.fromEntries(Object.entries(shared("halvard.roles") ?? {}).filter(([pane]) => live.has(pane)));

  const lead = await open("tab.new", { name: "hall", folder: root, argv: argv(team.lead) });
  if (!lead) return "Herdr did not open the hall tab.";
  hall = panes().find((p) => p.pane === lead)?.tab ?? null;
  roles[lead] = "lead";
  const dev = await split(lead, "right", team.dev);
  if (dev) roles[dev] = "dev";
  const reviewer = dev && (await split(dev, "down", team.reviewer));
  if (reviewer) roles[reviewer] = "reviewer";
  const investigator = reviewer && team.investigator && (await split(reviewer, "right", team.investigator));
  if (investigator) roles[investigator] = "investigator";
  setShared("halvard.roles", roles);
  run("pane.focus", { pane: lead });
  return dev && reviewer && (!team.investigator || investigator) ? null : "Herdr did not open every pane of the hall.";
}
