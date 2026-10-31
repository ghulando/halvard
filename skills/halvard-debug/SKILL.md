---
name: halvard-debug
description: Reproduce and diagnose an application bug or performance regression before fixing its cause. Use for failures, incorrect behavior or unexplained slowness.
---

Build a tight feedback loop for the exact symptom: failing test, HTTP request, CLI fixture, browser script or captured replay. Run it and observe failure before claiming a cause. A different nearby failure does not reproduce this bug.

For a UI or runtime symptom, get the console and network evidence, or reproduce in the real runtime, before naming a cause. A spec that mocks the failing layer cannot reproduce the bug, and a dev build can hide errors the production build throws.

When the file or commit is known or cheap to find (`git show --stat`, grep), read it yourself. Delegate only broad sweeps across many locations.

Minimize the scenario while preserving the symptom. For intermittent bugs, measure and raise the reproduction rate rather than claiming determinism. For performance, establish a measured baseline first and vet it, and every later number, with [halvard-benchmark](../halvard-benchmark/SKILL.md).

Form a small set of falsifiable hypotheses. Change one variable per probe, using targeted instrumentation. Redact secrets from commands, logs and artifacts. If reproduction requires unavailable access, report the evidence gap and ask for it.

For a failure seen only in CI, compare per-package timings with the last green run (`gh run view <id> --log`). Reproduce with the exact CI flags, including coverage: Go's coverage counters under `-race` can make a test several times slower than `-race` alone. A fixed wait about equal to the CPU cost of the operation it waits for is a likely cause; confirm it by changing the wait and watching the failure rate.

Turn the repro into a regression test at a seam that reaches the real failure and watch it fail. If you forced the failure by mutating code or a fixture, diff against a pristine copy to prove the mutation landed before you trust it. Apply the smallest root-cause fix, run that test and the original repro, and remove temporary instrumentation. Record the limitation if no adequate seam exists.

Adapted from Matt Pocock diagnosing-bugs; see ../../UPSTREAM.md.
