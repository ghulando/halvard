// A pane header for the halvard layout. Shows the pane's team role when "Summon the hall"
// opened it (shared "halvard.roles"), else the program; the agent's status; and for a
// repository pane its branch with the latest gate and review from the run log (shared
// "halvard.status", by repository, and "halvard.repos", each pane folder's repository, both
// written by halvard-watch). Buttons split, zoom and close the pane.
// Props from the app: { pane, terminal }.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, shared, theme } from "herdr";

const ROLE = { lead: "jarl", dev: "smith", reviewer: "skald", investigator: "seer" };

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// The latest gate and review on this pane's branch, from the repository Git resolved for
// its folder, so a nested repository never shows its parent's verdicts.
function verdicts(p) {
  if (!p.cwd || !p.branch) return null;
  const root = (shared("halvard.repos") ?? {})[p.cwd];
  const entry = root ? (shared("halvard.status") ?? {})[root] : null;
  // Branch names are keys; only the entry's own ones count, not Object's properties.
  return entry && Object.hasOwn(entry, p.branch) ? entry[p.branch] : null;
}

export default class Session extends View {
  init() {
    this.hovered = false;
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

  button(t, id, name, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${name}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = panes().find((pane) => pane.pane === props()?.pane);
    if (!p) return div();
    const pane = p.pane;
    const role = ROLE[(shared("halvard.roles") ?? {})[pane]];
    // Until a program sets a title, the title is the terminal's id, which names nothing.
    const title = p.title === p.terminal ? null : p.title;
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const v = verdicts(p);
    return h_flex()
      .id(`halvard-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => {
        this.hovered = hovered;
        cx.notify();
      })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(role), (el) => el.child(this.chip(t, (role ?? "").toUpperCase(), t.accent)))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(200).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(p.branch ?? ""))
      .when(Boolean(v?.gate), (el) =>
        el.child(this.chip(t, v.gate.passed ? "gate held" : "gate fell", v.gate.passed ? t.done : t.blocked)),
      )
      .when(Boolean(v?.review), (el) =>
        el.child(
          this.chip(
            t,
            `${v.review.verdict === "pass" ? "review passed" : "review blocked"}${v.review.round ? ` r${v.review.round}` : ""}`,
            v.review.verdict === "pass" ? t.done : t.blocked,
          ),
        ),
      )
      .when(p.status === "working", (el) =>
        el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)),
      )
      .when(p.status === "blocked", (el) => el.child(this.chip(t, "Needs you", t.blocked)))
      .when(p.status === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, (el) =>
        el
          .child(this.button(t, `hh-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
          .child(this.button(t, `hh-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
          .child(this.button(t, `hh-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
          .child(this.button(t, `hh-x-${pane}`, "close", "pane.close", { pane })),
      );
  }
}
