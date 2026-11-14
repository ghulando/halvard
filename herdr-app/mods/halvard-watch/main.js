// The watchtower: Halvard's run log for the focused pane's repository. A mascot whose
// mood follows the guard, today's scoreboard, the skills cast on the task, a card for the
// branch's task, the last events by day behind a fold, and a button that opens the team's
// hall when the repository has a team. For the halvard-session pane headers it publishes, for
// every local repository a pane is open in, each branch's latest gate and review as shared
// "halvard.status", and each pane folder's repository as shared "halvard.repos".

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, focused, panes, readTextFile, setShared, shared, spaces, theme, watchFolder } from "herdr";
import * as fs from "fs/promises";
import { FEED, parseEvents, summarize } from "./log.js";
import { readTeam, summon } from "./summon.js";
import { readTask } from "./task.js";

const FACES = {
  calm: { eyes: "^   ^", mouth: " \\_/ ", says: "calm: nothing stirs in the hall" },
  watchful: { eyes: "-   o", mouth: " ___ ", says: null },
  alarmed: { eyes: "O   O", mouth: " !!! ", says: "alarmed: the guardian struck" },
};

// Text is cut at a word, with an ellipsis, to at most this many characters.
const clip = (text, max) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : cut.length)}…`;
};

// A tooltip is one line as wide as its text, so long text gets line breaks; all of it shows.
const wrapped = (text, width = 60) => {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line].join("\n");
};

const clock = (time) => {
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The saga's day headers: "Today", "Yesterday", else "Thu 12 Nov".
const dayLabel = (time, now) => {
  const d = new Date(time);
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

// The repository's real path, as Halvard writes it into the log folder's .repo marker.
async function repoRoot(cwd) {
  const r = await exec("sh", ["-c", 'top=$(git rev-parse --show-toplevel 2>/dev/null) && cd "$top" && pwd -P'], { cwd });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

// Halvard names the folder after the repository, with a digest suffix when two
// repositories share a name; the marker decides.
async function logDir(logs, root) {
  const name = root.split("/").pop();
  let entries;
  try {
    entries = await fs.readdir(logs);
  } catch {
    return null;
  }
  for (const entry of entries.filter((e) => e === name || e.startsWith(`${name}-`))) {
    const marker = await readTextFile(`${logs}/${entry}/.repo`);
    if (marker?.trim() === root) return `${logs}/${entry}`;
  }
  return null;
}

// Every event in a log folder: the repository's file and one file per task. The streak,
// tallies and latest verdicts need the whole history, so no file is tailed.
async function readLog(dir) {
  const files = [`${dir}/events.jsonl`];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) files.push(`${dir}/${entry.name}/events.jsonl`);
  }
  let text = "";
  for (const file of files) {
    // A newline after each file keeps a torn last line from swallowing the next file's first event.
    text += ((await readTextFile(file)) ?? "") + "\n";
  }
  return parseEvents(text);
}

const holds = (root) => (pane) => pane.cwd === root || pane.cwd?.startsWith(`${root}/`);

export default class Watch extends View {
  init(_props, cx) {
    this.logs = null;
    this.cwd = undefined;
    // The folder whose repository lookup finished; while it differs from cwd, root still
    // names the last repository.
    this.shown = undefined;
    this.root = null;
    this.dir = null;
    this.team = null;
    this.task = null;
    this.taskKey = null;
    this.taskFor = null;
    this.polls = 0;
    this.sagaOpen = false;
    this.events = [];
    // Log folders being watched, each with its repository root.
    this.watched = new Map();
    // Each pane folder's repository root, or null outside one; looked up once per folder.
    this.roots = new Map();
    this.remote = false;
    this.message = null;
    this.summoning = false;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'printf %s "${HALVARD_DATA:-$HOME/.halvard}"']);
      this.logs = `${r.stdout}/logs`;
      this.follow(cx);
      this.discover(cx);
    });
    // .halvard.json and the task file change without a log event, so reread them every 10 s.
    // A pane's folder can change without a focus change, so the timer also follows it.
    cx.timer.every(2000, (cx) => {
      if (this.root && ++this.polls % 5 === 0) {
        this.refreshTeam(cx);
        this.refreshTask(cx);
      }
      this.follow(cx, true);
      this.discover(cx);
    });
    // Moods and open requests age out after ten minutes.
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Render runs on every focus change, so it calls this; it starts work only when the
  // focused folder or branch differs from the one shown. Only the timer retries a
  // repository whose log folder is missing, so a lookup never sets off the next one.
  follow(cx, retry = false) {
    if (!this.logs) return;
    if (this.root && `${this.root}\n${this.branch()}` !== this.taskKey) this.refreshTask(cx);
    const f = focused();
    const space = spaces().find((s) => s.id === f?.space);
    const remote = Boolean(space?.machine);
    const cwd = remote ? null : f?.cwd || space?.folder || null;
    if (remote !== this.remote) {
      this.remote = remote;
      cx.notify();
    }
    if (remote) return;
    if (!cwd) {
      // A mod pane has no folder; keep watching the last repository. Anything else without
      // one, such as a local space with no folder, has no repository to show.
      const modPane = Boolean(f?.pane) && !f.terminal;
      if (!modPane && this.cwd !== null) {
        this.cwd = null;
        this.shown = null;
        this.root = null;
        this.dir = null;
        this.team = null;
        this.events = [];
        cx.notify();
      }
      return;
    }
    if (cwd === this.cwd && !(retry && this.root && !this.dir)) return;
    this.cwd = cwd;
    cx.spawn(async (cx) => {
      const root = await repoRoot(cwd);
      if (this.cwd !== cwd) return;
      const dir = root ? await logDir(this.logs, root) : null;
      const team = root ? await readTeam(root) : null;
      if (this.cwd !== cwd) return;
      const changed = this.shown !== cwd || JSON.stringify(team) !== JSON.stringify(this.team);
      this.team = team;
      this.shown = cwd;
      if (root === this.root && dir === this.dir) {
        if (changed) cx.notify();
        return;
      }
      this.root = root;
      this.dir = dir;
      this.events = [];
      this.refreshTask(cx);
      if (dir) {
        const events = await readLog(dir);
        if (this.dir !== dir) return;
        this.events = events;
        this.publish(root, events);
        this.watch(cx, root, dir);
      }
      cx.notify();
    });
  }

  refreshTask(cx) {
    const root = this.root;
    const branch = this.branch();
    const key = `${root}\n${branch}`;
    this.taskKey = key;
    cx.spawn(async (cx) => {
      const task = await readTask(root, branch);
      if (this.taskKey !== key) return;
      const changed = this.taskFor !== key || JSON.stringify(task) !== JSON.stringify(this.task);
      this.task = task;
      this.taskFor = key;
      if (changed) cx.notify();
    });
  }

  refreshTeam(cx) {
    const root = this.root;
    cx.spawn(async (cx) => {
      const team = await readTeam(root);
      if (this.root !== root || JSON.stringify(team) === JSON.stringify(this.team)) return;
      this.team = team;
      cx.notify();
    });
  }

  // Reads and watches the log of every local repository a pane is open in, so its pane
  // headers show verdicts before it is ever focused. A repository with no log folder yet is
  // checked again on the next poll.
  discover(cx) {
    if (!this.logs) return;
    const local = new Set(spaces().flatMap((s) => (s.machine ? [] : s.tabs.map((tab) => tab.id))));
    for (const p of panes()) {
      if (!p.cwd || !local.has(p.tab) || this.roots.has(p.cwd)) continue;
      const cwd = p.cwd;
      this.roots.set(cwd, null);
      cx.spawn(async () => {
        const root = await repoRoot(cwd);
        this.roots.set(cwd, root);
        // Pane headers match a pane to its repository by this map, not by folder nesting.
        if (root) setShared("halvard.repos", { ...(shared("halvard.repos") ?? {}), [cwd]: root });
      });
    }
    const watching = new Set(this.watched.values());
    for (const root of new Set(this.roots.values())) {
      if (!root || watching.has(root) || !panes().some(holds(root))) continue;
      cx.spawn(async (cx) => {
        const dir = await logDir(this.logs, root);
        if (!dir || this.watched.has(dir)) return;
        this.publish(root, await readLog(dir));
        this.watch(cx, root, dir);
      });
    }
  }

  // One watcher per log folder, kept after focus moves on so the repository's pane headers
  // stay current; it stops once no pane is open in the repository.
  watch(cx, root, dir) {
    if (this.watched.has(dir)) return;
    this.watched.set(dir, root);
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(dir);
        } catch {
          break;
        }
        if (dir !== this.dir && !panes().some(holds(root))) break;
        const events = await readLog(dir);
        this.publish(root, events);
        if (dir === this.dir) {
          this.events = events;
          cx.notify();
        }
      }
      this.watched.delete(dir);
    });
  }

  publish(root, events) {
    const current = shared("halvard.status") ?? {};
    const status = { ...current, [root]: summarize(events, Date.now(), null).branches };
    if (JSON.stringify(status) !== JSON.stringify(current)) setShared("halvard.status", status);
  }

  // One summon at a time: a second would take the first one's new panes for its own.
  async summonHall(cx) {
    const root = this.root;
    if (!root || this.summoning) return;
    this.summoning = true;
    this.message = null;
    cx.notify();
    try {
      this.message = await summon(root, cx);
    } finally {
      this.summoning = false;
    }
  }

  mascot(t, mood, s) {
    const face = FACES[mood];
    const color = mood === "alarmed" ? t.blocked : mood === "watchful" ? t.accent : t.done;
    const says = face.says ?? `watchful: ${s.open === 1 ? "1 request awaits" : `${s.open} requests await`} your word`;
    // Text collapses ordinary spaces, so the art uses no-break spaces to keep its shape.
    const art = ["  .-----.  ", ` / ${face.eyes} \\ `, ` \\ ${face.mouth} / `, " /|||||||\\ "].map((line) =>
      line.replaceAll(" ", " "),
    );
    const head = v_flex()
      .flex_none()
      .px(8)
      .py(6)
      .rounded(8)
      .bg(t.raised)
      .font_family("JetBrains Mono")
      .text_size(13)
      .text_color(color)
      .children(art.map((line) => div().h(17).flex_none().whitespace_nowrap().child(line)))
      .when(mood === "alarmed", (el) => el.loop("opacity", { from: 0.45, to: 1, period: 900 }));
    return h_flex()
      .flex_none()
      .gap(12)
      .items_center()
      .child(head)
      .child(
        v_flex()
          .flex_1()
          .gap(3)
          .min_w(0)
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Halvard keeps watch"))
          .child(div().text_size(12).text_color(color).child(says))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(this.root.split("/").pop() + (s.task ? `  ·  ${s.task}` : ""))),
      );
  }

  tile(t, label, value, color, tip) {
    return v_flex()
      .flex_1()
      .min_w(0)
      .px(8)
      .py(6)
      .rounded(6)
      .bg(t.raised)
      .when(Boolean(tip), (el) => el.id(`tile-${tip}`).tooltip(tip))
      .child(div().text_size(16).font_semibold().text_color(color).child(String(value)))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(label));
  }

  heading(t, text) {
    return div().flex_none().text_size(10.5).font_semibold().text_color(t.muted).child(text);
  }

  scoreboard(t, s) {
    const tile = (label, value, color) => this.tile(t, label, value, color);
    const row = (tiles) => h_flex().flex_none().gap(6).children(tiles);
    return v_flex()
      .flex_none()
      .gap(6)
      .child(this.heading(t, "TODAY"))
      .child(
        row([
          tile("blocked", s.score.blocked, t.blocked),
          tile("asked", s.score.asked, t.accent),
          tile("granted", s.score.granted, t.done),
          tile("streak", s.streak, t.done),
        ]),
      )
      .child(
        row([
          tile("gates held", s.score.held, t.done),
          tile("gates fell", s.score.fell, t.blocked),
          tile("1st-round pass", s.score.firstRound, t.done),
          tile("re-reviews", s.score.reReviews, t.accent),
        ]),
      );
  }

  // Skill names run longer than the scoreboard's labels, so their tiles sit two to a row.
  runes(t, s) {
    const tiles = s.skills.map(({ name, count }) => this.tile(t, name.replace(/^halvard-/, ""), count, t.accent, name));
    const rows = [];
    for (let i = 0; i < tiles.length; i += 2) {
      rows.push(h_flex().flex_none().gap(6).children(tiles.length > i + 1 ? tiles.slice(i, i + 2) : [tiles[i], div().flex_1().px(8)]));
    }
    return v_flex()
      .flex_none()
      .gap(6)
      .child(this.heading(t, s.task ? "RUNES CAST ON THIS SAGA" : "RUNES CAST TODAY"))
      .when(rows.length === 0, (el) =>
        el.child(div().text_size(11.5).text_color(t.dim).child(s.task ? "No runes cast on this saga yet." : "No runes cast today.")),
      )
      .children(rows);
  }

  chip(t, text, color) {
    return div()
      .flex_none()
      .px(6)
      .h(18)
      .flex()
      .items_center()
      .rounded(5)
      .bg(color + "26")
      .text_size(10.5)
      .font_semibold()
      .text_color(color)
      .child(text);
  }

  taskCard(t, s, branch, task) {
    const v = Object.hasOwn(s.branches, branch) ? s.branches[branch] : {};
    const gate = v.gate
      ? this.chip(t, `gate ${v.gate.passed ? "held" : "fell"} ${clock(v.gate.at)}`, v.gate.passed ? t.done : t.blocked)
      : this.chip(t, "no gate yet", t.dim);
    const review = v.review
      ? this.chip(
          t,
          `review${v.review.round ? ` r${v.review.round}` : ""} ${v.review.verdict === "pass" ? "passed" : "blocked"}`,
          v.review.verdict === "pass" ? t.done : t.blocked,
        )
      : this.chip(t, "no review yet", t.dim);
    return v_flex()
      .flex_none()
      .gap(6)
      .child(this.heading(t, "THIS SAGA"))
      .child(
        v_flex()
          .id("task-card")
          .flex_none()
          .gap(6)
          .px(10)
          .py(8)
          .rounded(6)
          .bg(t.raised)
          .tooltip(wrapped(task.next ? `next: ${task.next}` : task.title))
          .child(div().max_h(40).overflow_hidden().text_size(13).font_semibold().text_color(t.foreground).child(clip(task.title, 60)))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(branch + (task.status ? `  ·  ${task.status}` : "")))
          .child(h_flex().flex_wrap().gap(6).child(gate).child(review))
          .when(Boolean(task.next), (el) =>
            // About two lines of the panel's width; the tooltip holds the rest.
            el.child(div().max_h(36).overflow_hidden().text_size(11.5).text_color(t.muted).child(clip(`next: ${task.next}`, 80))),
          ),
      );
  }

  // One saga line; a long reason is cut to two lines with an ellipsis, and hovering shows it all.
  line(t, line, id) {
    const tone = { good: t.done, bad: t.blocked, warn: t.accent, info: t.working, saga: t.ansi5 ?? t.accent };
    return h_flex()
      .id(id)
      .gap(8)
      .py(3)
      .items_start()
      .text_size(11.5)
      .tooltip(wrapped(line.text))
      .child(div().flex_none().w(40).whitespace_nowrap().font_family("JetBrains Mono").text_color(t.dim).child(clock(line.time)))
      .child(div().flex_none().w(46).whitespace_nowrap().font_semibold().text_color(tone[line.tone]).child(line.tag.toUpperCase()))
      .child(div().flex_1().min_w(0).max_h(36).overflow_hidden().text_color(t.foreground).child(clip(line.text, 56)));
  }

  // Closed, the saga shows its newest line; open, every line under its day.
  saga(t, s) {
    const now = new Date();
    const lines = [...s.feed].reverse();
    const rows = [];
    if (this.sagaOpen) {
      let day = null;
      lines.forEach((line, i) => {
        const label = dayLabel(line.time, now);
        if (label !== day) {
          day = label;
          rows.push(div().flex_none().pt(rows.length ? 8 : 2).pb(2).text_size(10.5).font_semibold().text_color(t.dim).child(label));
        }
        rows.push(this.line(t, line, `feed-${i}`));
      });
    } else if (lines.length) {
      rows.push(div().flex_none().text_size(10.5).text_color(t.dim).child(dayLabel(lines[0].time, now)));
      rows.push(this.line(t, lines[0], "feed-newest"));
    }
    const toggle = (_e, cx) => {
      this.sagaOpen = !this.sagaOpen;
      cx.notify();
    };
    // Closed, the whole block opens it; open, only the header folds it, so lines stay hoverable.
    const head = h_flex()
      .id("saga-fold")
      .flex_none()
      .gap(8)
      .items_center()
      .when(this.sagaOpen, (el) => el.on_click(toggle))
      .child(svg(`mods/workspace-chrome/chevron-${this.sagaOpen ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
      .child(div().text_size(10.5).font_semibold().text_color(t.muted).child("THE SAGA"))
      .child(div().flex_1().text_size(10.5).text_color(t.dim).child(lines.length === FEED ? `last ${FEED} events` : `${lines.length} ${lines.length === 1 ? "event" : "events"}`))
      .child(div().text_size(10.5).text_color(t.dim).child(this.sagaOpen ? "fold" : "unfold"));
    return v_flex()
      .id("saga")
      .flex_none()
      .gap(4)
      .px(10)
      .py(8)
      .rounded(6)
      .bg(t.raised)
      .when(!this.sagaOpen, (el) => el.hover((st) => st.bg(t.hover)).on_click(toggle))
      .child(head)
      .children(rows);
  }

  button(t) {
    const base = div()
      .id("summon-hall")
      .flex_none()
      .px(10)
      .py(6)
      .rounded(6)
      .bg(t.solid)
      .text_color(t.solid_foreground)
      .text_size(12)
      .font_semibold();
    if (this.summoning) return base.opacity(0.5).child("Summoning the hall…");
    return base
      .hover((s) => s.opacity(0.85))
      .on_click((_e, cx) => {
        cx.spawn(async (cx) => {
          await this.summonHall(cx);
          cx.notify();
        });
      })
      .child("Summon the hall");
  }

  quiet(t, text) {
    return v_flex()
      .size_full()
      .p(16)
      .gap(8)
      .bg(t.surface)
      .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Halvard keeps watch"))
      .child(div().text_size(12).text_color(t.dim).child(text));
  }

  render(cx) {
    this.follow(cx);
    const t = theme();
    if (this.remote) return this.quiet(t, "The watchtower reads this computer's run log; the focused space lives on another machine.");
    if (!this.root) return this.quiet(t, "Focus a terminal inside a Git repository to watch its Halvard run log.");
    const branch = this.branch();
    // Until the focused folder's repository is known, root may be the last one, even on a
    // branch of the same name; its task card and its hall wait.
    const settled = this.cwd === this.shown;
    // The task file decides the task, so the card and the runes always name the same one.
    const task = settled && this.taskFor === `${this.root}\n${branch}` ? this.task : null;
    const s = summarize(this.events, Date.now(), task?.file.replace(/\.md$/, "") ?? null);
    return v_flex()
      .id("halvard-watch")
      .size_full()
      .overflow_y_scrollbar()
      .p(14)
      .gap(14)
      .bg(t.surface)
      .child(this.mascot(t, s.mood, s))
      .child(this.scoreboard(t, s))
      .child(this.runes(t, s))
      // A card loaded for another repository or branch waits for its own task.
      .when(Boolean(task) && !this.sagaOpen, (el) => el.child(this.taskCard(t, s, branch, task)))
      .when(!this.dir, (el) => el.child(div().text_size(12).text_color(t.dim).child("No run log yet for this repository.")))
      .when(Boolean(this.dir), (el) => el.child(this.saga(t, s)))
      .when(settled && Boolean(this.team), (el) =>
        el.child(
          v_flex()
            .gap(6)
            .child(this.button(t))
            .when(Boolean(this.message), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.message ?? ""))),
        ),
      );
  }

  branch() {
    const f = focused();
    return panes().find((p) => p.pane === f?.pane)?.branch ?? spaces().find((s) => s.id === f?.space)?.branch ?? null;
  }
}
