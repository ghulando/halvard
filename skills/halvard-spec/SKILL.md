---
name: halvard-spec
description: Clarify an application feature and write observable acceptance criteria and a short plan. Use for substantial or ambiguous implementation work.
---

Separate inspectable facts from decisions only the user can make. Inspect the former; ask concise questions about the latter. Preserve earlier answers. Do not force another interview when the conversation already establishes the requirement.

Record the problem, intended behavior, acceptance criteria, constraints and exclusions in the local task. Name what a builder might be tempted to do but must not under Out of scope. List under Assumptions each decision made where the request was ambiguous, and mark a product or business decision as one, because it belongs to the user. Identify the existing interface where each important behavior can be tested. Use the project domain language. Write acceptance criteria in [halvard-write](../halvard-write/SKILL.md) Strict mode.

Plan small complete slices that can each be demonstrated: a narrow path through necessary storage, API and UI is preferable to finishing all storage before any behavior. Record real dependencies between slices. For an inseparable migration, use an integration branch and state when the whole system becomes verifiable.

Keep the plan short. Discuss consequential product/architecture choices before locking them in. Routine implementation decisions need no repeated approval. A plan does not authorize commits, shipping or external issue creation.

Adapted from Matt Pocock to-spec and to-tickets, replacing tracker publishing with local tasks; see ../../UPSTREAM.md.
