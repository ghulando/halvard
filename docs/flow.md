# Flow

How to use Halvard, from install to merge, by hand or through the [factory](#factory). VS Code draws the diagrams in the Markdown preview with the Markdown Preview Mermaid Support extension; GitHub draws them as is.

```mermaid
flowchart TD
    install["Install the plugin, restart sessions, approve hook trust"] --> configured{"Repo has .halvard.json?"}
    configured -- no --> setup["Run halvard-bootstrap for stack rules and skills, then halvard-setup: set gate and reviewers, commit .halvard.json"]
    setup --> ask
    configured -- yes --> ask["Describe the task, or call /halvard with it"]

    ask --> mode{"Team run?"}
    mode -- "no, solo" --> start["Agent runs task-start: clean tree, feature/ or fix/ branch, docs/tasks/id.md"]
    mode -- "yes, in Herdr" --> team["Ask for halvard-team in the Claude pane: lead, implementer, reviewer"]
    team --> start

    start --> size{"Substantial or unclear?"}
    size -- yes --> plan["Agent writes acceptance criteria and plan, then stops"]
    plan --> read{"You read the plan. Correct?"}
    read -- no --> plan
    read -- yes --> build
    size -- "no, small fix" --> build["Agent implements and updates task notes"]

    build --> gate{"Gate passes?"}
    gate -- no --> build
    gate -- yes --> review{"Independent review passes?"}
    review -- "blocked, round 1" --> fix["Agent fixes once, reruns gate, asks for re-review"]
    fix --> review
    review -- "blocked again" --> more{"You allow another round with a reviewExceptions entry?"}
    more -- yes --> build
    more -- no --> open["Task stays open; you resolve the remaining findings"]
    review -- yes --> done["Agent marks the task done and shows the diff"]
    done --> retro{"Run the offered retro?"}
    retro -- yes --> grill["halvard-retro reads workflow events, grills you per finding, appends the retro log"]
    grill --> ship
    retro -- no --> ship["You approve commit, then merge and push, each with its own yes"]

    build -. "switch harness" .-> handoff["halvard-handoff, then task-resume in the new tool"]
    handoff -.-> build
```

## New service

Starting a service from an empty folder adds steps before the flow above. Bootstrap and setup write configuration only, so the gate cannot pass until the first task scaffolds the service.

```mermaid
flowchart TD
    init["Create the folder, git init, empty first commit on main"] --> branch["Switch to a working branch; the guard refuses bootstrap writes on protected branches"]
    branch --> stacks{"stacks set in personal config?"}
    stacks -- no --> setstacks["Set stacks to your records checkout, restart the session"]
    setstacks --> investigate
    stacks -- yes --> investigate["Optional: agent investigates the requirement and neighbouring services, writes findings and open questions"]
    investigate --> choose["You pick the stack"]
    choose --> record{"Record exists?"}
    record -- no --> newrec["halvard-bootstrap asks the new-stack questions and writes the record; you commit it in the stacks checkout"]
    newrec --> bootstrap
    record -- yes --> bootstrap["halvard-bootstrap: answer the open choices; writes the AGENTS.md stack section, CLAUDE.md, skills and stack entry"]
    bootstrap --> setup["halvard-setup: review the proposed gate and reviewers, then apply them"]
    setup --> commit["You review and commit the configuration, then fast-forward main"]
    commit --> scaffold["First task: /halvard scaffold the service until the gate passes"]
    scaffold --> features["Each feature after that follows the flow above"]
```

The empty first commit matters: in a repository without commits, `setup` proposes the current branch as base.

## Factory

Factory mode runs the same flow without you at the keyboard: a runner on your machine or a server drives a headless harness, runs the gate and the review itself, and ships a pull request. You stay at three points: approving plans, merging, and deciding parked jobs. See [Factory](factory.md) for setup and every command.

```mermaid
flowchart TD
    intake["Someone with write access labels an issue factory, or you run factory run or factory plan"] --> small{"Labeled factory:small?"}
    small -- no --> planrun["Read-only plan run; the plan goes on the issue"]
    planrun --> approve{"You label factory:approved?"}
    approve -- no --> waiting["Job waits; factory:stop parks it"]
    approve -- yes --> checkout
    small -- yes --> checkout["Fresh worktree, or a clone and containers, on a task branch; setup runs"]

    checkout --> tests["Optional: a second harness writes frozen acceptance tests"]
    tests --> build["Headless build; every guard ask is a denial"]
    build --> checks{"Git config, guarded paths, frozen tests and scope unchanged?"}
    checks -- no --> parked
    checks -- yes --> gate{"Runner's gate passes?"}
    gate -- "no, fix pass left" --> build
    gate -- "no, none left" --> parked
    gate -- yes --> holdout{"Holdout checks pass?"}
    holdout -- no --> parked
    holdout -- yes --> review{"Cross-harness review passes?"}
    review -- "blocked, fix pass left" --> build
    review -- "blocked in round 2" --> parked
    review -- yes --> ship["task-done, commit of the reviewed tree, push, draft pull request with evidence"]

    ship --> automerge{"Auto-merge on, and the pull request meets every rule?"}
    automerge -- yes --> merged["Runner merges at the factory commit"]
    automerge -- no --> human["You review and merge"]

    parked["Job parks with a reason on the issue"] --> decide{"You decide"}
    decide -- "factory:retry or rework --note" --> checkout
    decide -- "drop it" --> closed["Remove the job"]

    merged -.-> outcomes["Outcomes feed the human-edit rate per class"]
    human -.-> outcomes
    outcomes -.-> retro["Periodic retro job: recurring findings become a guidance change, merged by you"]
```
