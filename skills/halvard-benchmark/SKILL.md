---
name: halvard-benchmark
description: Vet a performance number before you report or act on it, by naming its limiter and checking tuning, physical limits, errors, repeatability, relevance and whether the work ran. Use when you run a benchmark, set a performance baseline, or report a speedup or regression you measured.
---

Use this for every performance number you produce: a baseline for [halvard-debug](../halvard-debug/SKILL.md), a before and after in a task or pull request, a regression claim, or a choice between libraries or settings. Answer each question with evidence from a run, not a guess from the code.

For a quick ballpark the user asked for, one run is enough. Still check questions 4 and 7, and say it is one run. A choice between options is never a ballpark.

## Before you run

- Write the claim you expect to make in the words you would ship, such as "export is 30% faster at p50 on the 60k-row dataset", and the result that would change a decision. The questions test that sentence.
- Read the measurement script. Note what it times, counts and ignores.
- Check the machine load and core count. If the machine is busy and you cannot stop the load, interleave the sides so both see the same noise, and say so.

## The questions

1. **Why not double?** Name the resource or code path that bounds the result: a core, a lock, the disk, the network or the load generator itself. Get it from a profile or system counters in a run you do not report, because profilers slow the work, then map it to source. If the load generator saturates first, you measured the load generator.
2. **Was it tuned?** Run every side the way production runs it: release builds, production flags, batching, pools, caches as warm or cold as production sees them, and the same versions and data. If one side runs on defaults, you compared configurations, not implementations.
3. **Did it break limits?** Compare bytes per second with disk and network bandwidth, and operations per second times cost per operation with the cores. Removing a piece that takes 10% of the run makes the run at most about 11% faster. A result past a limit measured something else, such as a cache or a no-op.
4. **Did it error?** Count failures and non-success responses, and check that outputs are correct, not just present. Rejections are often fast, and timeouts and retries slow. If the script does not count errors, add the count.
5. **Does it reproduce?** Run each side at least 5 times, alternating A, B, A, B, so warmup, caches and drift favor neither. Report the median and range. A gap smaller than the run-to-run spread is no measurable difference.
6. **Does it matter?** Next to a micro result, measure the end-to-end path a user waits on, with realistic data sizes and concurrency, and report the micro result as a share of it.
7. **Did it happen?** Confirm the work ran inside the timed region: the request reached the server, the rows were written and the code used the result. Lazy code, unawaited work, results an optimizer discards and timeouts produce numbers for work that never ran.

## Report

Lead with the verdict: faster, slower, no measurable difference or inconclusive. Give the number with its unit, run count, range and limiter, for example "p50 41 ms to 33 ms, median of 7 runs per side, range 32 to 35 ms after, bound by JSON parsing on one core". Call the verdict inconclusive when you cannot name the limiter, when a side ran untuned, or when you could not check questions 4 and 7, and name the gap. Record the runs, range and limiter evidence in the task notes; a summary or pull request gets one primary number.

Adapted from Pstack benchmark-checklist and principle-explain-the-number; see ../../UPSTREAM.md.
