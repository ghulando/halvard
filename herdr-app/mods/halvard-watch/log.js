// Halvard's run log, read for the watchtower. Halvard writes one JSON line per event to
// <data>/logs/<repo>/events.jsonl and <data>/logs/<repo>/<task>/events.jsonl; each has
// `at` (ISO time), `kind`, `harness`, `branch`, `task` and the kind's own fields.

// Approval requests expire after ten minutes, so "recent" means the same.
export const RECENT = 10 * 60 * 1000;
export const FEED = 20;

// One event per line; a torn line, a non-object or an unparseable time skips only itself.
export function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || typeof event.kind !== "string") continue;
    const time = typeof event.at === "string" ? Date.parse(event.at) : NaN;
    if (Number.isNaN(time)) continue;
    events.push({ ...event, time });
  }
  return events.sort((a, b) => a.time - b.time);
}

const granted = (e) => e.kind === "outcome" && (e.outcome === "approved" || e.outcome === "host-allowed");
const alarm = (e) =>
  e.kind === "deny" || (e.kind === "gate" && e.passed === false) || (e.kind === "review" && e.verdict === "blocked");

// task: the id of the focused branch's task file, or null; the runes count its events.
export function summarize(events, now, task) {
  const day = new Date(now).toDateString();
  const today = events.filter((e) => new Date(e.time).toDateString() === day);
  const recent = events.filter((e) => e.time >= now - RECENT);
  const answered = new Set(events.filter((e) => e.kind === "outcome").map((e) => e.request));
  const open = recent.filter((e) => e.kind === "ask" && !answered.has(e.request)).length;
  const mood = recent.some(alarm) ? "alarmed" : open > 0 ? "watchful" : "calm";

  const gates = events.filter((e) => e.kind === "gate");
  let streak = 0;
  for (let i = gates.length - 1; i >= 0 && gates[i].passed === true; i--) streak++;

  const count = (test) => today.filter(test).length;
  const score = {
    blocked: count((e) => e.kind === "deny"),
    asked: count((e) => e.kind === "ask"),
    granted: count(granted),
    held: count((e) => e.kind === "gate" && e.passed === true),
    fell: count((e) => e.kind === "gate" && e.passed === false),
    firstRound: count((e) => e.kind === "review" && e.round === 1 && e.verdict === "pass"),
    reReviews: count((e) => e.kind === "review" && (e.round ?? 1) > 1),
  };

  // The latest gate and review per branch, for the pane headers. Branch names are keys, so
  // the object has no prototype: a branch called __proto__ or constructor is just a name.
  const branches = Object.create(null);
  for (const e of events) {
    if (!e.branch || (e.kind !== "gate" && e.kind !== "review")) continue;
    const entry = (branches[e.branch] ??= {});
    if (e.kind === "gate") entry.gate = { passed: e.passed === true, at: e.time };
    else entry.review = { verdict: e.verdict, round: e.round ?? null, reviewer: e.reviewer ?? null, at: e.time };
  }

  // The runes cast on this branch's task, else today; most cast first.
  const tally = new Map();
  for (const e of task ? events.filter((e) => e.task === task) : today) {
    if (e.kind === "skill" && typeof e.skill === "string") tally.set(e.skill, (tally.get(e.skill) ?? 0) + 1);
  }
  const skills = [...tally]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { mood, open, streak, score, branches, task, skills, feed: events.slice(-FEED).map(narrate) };
}

// tone: "good", "bad", "warn", "info" or "saga", for the line's color.
export function narrate(e) {
  const who = e.harness ?? "an agent";
  const tool = e.tool ? ` (${e.tool})` : "";
  const request = (e.request ?? "?").slice(0, 6);
  const line = (tag, tone, text) => ({ time: e.time, tag, tone, text });
  switch (e.kind) {
    case "session":
      return line("enter", "info", `${who} entered the hall`);
    case "deny":
      return line("block", "bad", `the guardian blocked ${who}${tool}: ${e.reason ?? "denied"}`);
    case "ask":
      return line("ask", "warn", `${who} asks leave${e.tool ? ` for ${e.tool}` : ""}, request ${request}`);
    case "outcome":
      return line("word", granted(e) ? "good" : "warn", `request ${request} ${e.outcome ?? "answered"}${e.via ? ` via ${e.via}` : ""}`);
    case "gate":
      return e.passed === true
        ? line("gate", "good", `the gate held${e.seconds ? ` in ${e.seconds}s` : ""}`)
        : line("gate", "bad", `the gate fell: ${e.reason ?? "failed"}`);
    case "review": {
      const findings = Array.isArray(e.findings) ? e.findings : [];
      const blocking = findings.filter((f) => f?.severity === "blocking").length;
      const verb = e.verdict === "pass" ? "passed" : "blocked";
      return line(
        "skald",
        e.verdict === "pass" ? "good" : "bad",
        `${e.reviewer ?? "the skald"} ${verb} round ${e.round ?? "?"} with ${findings.length} finding${findings.length === 1 ? "" : "s"}${blocking ? ` (${blocking} blocking)` : ""}`,
      );
    }
    case "skill":
      return line("rune", "saga", `${who} cast the ${e.skill ?? "unknown"} rune`);
    case "task-start":
      return line("saga", "saga", `a new saga begins: ${e.task ?? "untitled"}`);
    case "task-handoff":
      return line("hand", "saga", `${e.task ?? "a task"} passes from ${e.from ?? "?"} to ${e.harness ?? "?"}`);
    case "task-done":
      return line("done", "saga", `${e.task ?? "a task"} is done; the saga is sung`);
    default:
      return line(e.kind.slice(0, 5), "info", e.kind);
  }
}
