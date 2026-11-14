// Opens the "hall" tab for the team saved in a repository's .halvard.json:
//   lead         | dev
//   investigator | reviewer      (the investigator's corner only when configured)
// Each pane starts its harness. run() returns nothing and the new pane reaches panes()
// only on a later frame, so the summon waits for a pane that was not there before.
// pane.split takes no argv, so each split focuses its neighbour, waits until it has focus,
// and uses terminal.open with a place. Pane roles go to shared "halvard.roles" for the pane
// headers. A hall whose lead pane is still open in the repository is focused, not reopened.

import { focused, panes, readTextFile, run, setShared, shared } from "herdr";
import { validTeam } from "./rules.js";

// Cursor's terminal agent is cursor-agent; the other harnesses run under their own name.
const command = (harness) => (harness === "cursor" ? "cursor-agent" : harness);

export const TEAM_HELP = "halvard team set --lead <harness> --dev <harness> --reviewer <harness>";

// How long a new pane or a focus change may take to show up.
const WAIT = 3000;
const STEP = 50;

// The team saved in the repository's .halvard.json, or null when Halvard would refuse it.
export async function readTeam(root) {
  try {
    return validTeam(JSON.parse((await readTextFile(`${root}/.halvard.json`)) ?? "null")?.team);
  } catch {
    return null;
  }
}

const inside = (root) => (pane) => pane.cwd === root || pane.cwd?.startsWith(`${root}/`);

// Returns null when the hall opened or was already open, else what stopped it.
export async function summon(root, cx) {
  const team = await readTeam(root);
  if (!team) return `This repository has no valid team. Save one with: ${TEAM_HELP}`;

  const live = panes();
  const roles = Object.fromEntries(
    Object.entries(shared("halvard.roles") ?? {}).filter(([pane]) => live.some((p) => p.pane === pane)),
  );
  const open = live.find((p) => roles[p.pane] === "lead" && inside(root)(p));
  if (open) {
    run("pane.focus", { pane: open.pane });
    return null;
  }

  const waitFor = async (found) => {
    for (let waited = 0; waited < WAIT; waited += STEP) {
      const value = found();
      if (value) return value;
      await cx.sleep(STEP);
    }
    return null;
  };
  // A new pane: the lead's must be in a tab that did not exist, a split's in the hall's tab,
  // so a pane opened elsewhere meanwhile is never taken for one of the hall's.
  const newPane = async (name, args, inTab) => {
    const before = new Set(panes().map((p) => p.pane));
    const tabs = new Set(panes().map((p) => p.tab));
    run(name, args);
    return waitFor(
      () =>
        panes().find((p) => !before.has(p.pane) && (inTab ? p.tab === inTab : !tabs.has(p.tab)))?.pane ?? null,
    );
  };
  let hall = null;
  const split = async (pane, place, harness) => {
    run("pane.focus", { pane });
    if (!(await waitFor(() => focused()?.pane === pane))) return null;
    return newPane("terminal.open", { argv: [command(harness)], folder: root, place }, hall);
  };

  const lead = await newPane("tab.new", { name: "hall", folder: root, argv: [command(team.lead)] }, null);
  if (!lead) return `Herdr did not open the hall tab. Is ${command(team.lead)} installed and on PATH?`;
  hall = panes().find((p) => p.pane === lead)?.tab ?? null;
  roles[lead] = "lead";
  const dev = await split(lead, "right", team.dev);
  if (dev) roles[dev] = "dev";
  const reviewer = dev && (await split(dev, "down", team.reviewer));
  if (reviewer) roles[reviewer] = "reviewer";
  const investigator = team.investigator && (await split(lead, "down", team.investigator));
  if (investigator) roles[investigator] = "investigator";
  setShared("halvard.roles", roles);
  run("pane.focus", { pane: lead });

  const missing = [
    ["dev", team.dev, dev],
    ["reviewer", team.reviewer, reviewer],
    ["investigator", team.investigator, investigator],
  ].filter(([, harness, pane]) => harness && !pane);
  if (!missing.length) return null;
  const names = missing.map(([role, harness]) => `the ${role} (${command(harness)})`).join(", ");
  return `Herdr did not open ${names}. Check that each is installed and on PATH.`;
}
