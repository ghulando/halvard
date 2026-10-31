---
name: halvard-test
description: Write behavior-based tests and use a red-green loop at meaningful application interfaces. Use for regression coverage and new behavior.
---

Choose the interface where real callers observe behavior. Match project conventions and acceptance criteria. Discuss a consequential new test boundary when it changes the design; existing clear boundaries need no extra approval. When you propose boundaries, give each a one-line note on what it catches and what it misses.

For a bug or test-first feature, run one meaningful failing test, implement enough to pass it, then add the next slice. Avoid bulk suites against imagined implementations. Refactor within authorized scope and preserve observed behavior.

Behavior is what callers can observe through the interface they use: return values, errors, state they can read back, and effects outside the code, such as a request sent, a row written or a message emitted. Private helpers, internal call order and intermediate data are implementation. Assert what the contract promises, no less and no more. Derive expected values from the requirement, not from a run of the code. Do not recompute the implementation in expectations or mock away the behavior. Mock genuine external boundaries when needed, and assert the payload the external service receives. Pair an absence check, such as no charge for an empty cart, with a case where the effect happens. Use hostile and boundary inputs that distinguish wrong behavior.

Judge each test against two edits. Break the behavior: return a wrong value, skip an effect or do it twice. The test must fail, so name a one-line mutation that makes it fail; if none exists, it proves nothing. Change only the internals and keep every observable result. The test must still pass; if it fails, it is pinned to the implementation. Rewrite or delete tests that fail either edit. Differential fixtures must distinguish implementations. Keep tests deterministic and cover relevant error paths.

Adapted from Matt Pocock tdd and Pstack principle-test-behavior-not-implementation; see ../../UPSTREAM.md.
