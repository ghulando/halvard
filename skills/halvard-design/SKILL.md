---
name: halvard-design
description: Choose interfaces, data shapes and module ownership before consequential application changes. Use when implementation would lock in an unclear architecture.
---

Ground the design in the current runtime flow and project architecture. Write caller usage first, then derive the data shape and interface. Include ordering, error, configuration and performance obligations, not just signatures.

For consequential choices, compare two structurally different approaches. Assume the next contributor is an agent that sees only the files it opened, copies the nearest example and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repo. Prefer hiding complexity behind a small interface and keeping related changes local. Avoid pass-through layers and hypothetical extension points. Routine changes use the established design without manufactured alternatives.

Record the decision and tradeoff in the task. Repeated workarounds or escapes from the type model are evidence to revisit the design. Do not keep adding special cases to protect a disproven premise.

Parallel exploration is optional, subject to authorization and harness capabilities. No fixed model or Cursor-only tool is required.

Adapted from Pstack architect and Matt Pocock codebase-design; see ../../UPSTREAM.md.
