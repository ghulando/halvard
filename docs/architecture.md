# Architecture

How Halvard is built, drawn with the [C4 model](https://c4model.com): a system context diagram, a container diagram, component diagrams for the two containers with real structure, a dynamic diagram of one factory job and a deployment diagram. There is no code-level diagram; the code is the source for that level. [Flow](flow.md) shows how to use Halvard; this page shows what runs where.

Every box names its type and technology, and every arrow says what it does and how. [Where things live](#where-things-live) maps each element to its files, so a change to the code shows which diagram to update.

## Key

| Shape | Meaning |
| --- | --- |
| Dark blue box | Person |
| Blue box | Halvard, or one of its containers |
| Light blue box | A component inside a Halvard container |
| Grey box | A system, store or process outside Halvard |
| Cylinder | A data store: files on disk |
| Dashed frame | The boundary of a system or container |
| Solid arrow | A one-way call, read or write, labelled with its purpose and technology |

## 1. System context

Halvard has no server of its own. It runs inside your coding harnesses, as their hooks and skills, and as a command you or an agent run in a terminal.

```mermaid
flowchart LR
    dev["<b>Developer</b><br/>[Person]<br/>Works with agents, approves plans, commits and merges"]
    maint["<b>Repository writer</b><br/>[Person]<br/>Labels issues for the factory and merges its pull requests"]

    halvard["<b>Halvard</b><br/>[Software System]<br/>Guards repositories, runs the gate and cross-harness review, and runs unattended factory jobs"]

    harness["<b>Coding harness</b><br/>[Software System]<br/>Claude Code, Codex, Pi, Grok Build or Cursor CLI, in your session"]
    headless["<b>Headless agents and reviewers</b><br/>[Software System]<br/>The same harness CLIs and Ollama, started without a person"]
    repo["<b>Target repository</b><br/>[Git working tree]<br/>The code being changed, with .halvard.json"]
    github["<b>GitHub</b><br/>[Software System]<br/>Issues, labels, pull requests, CI"]
    herdr["<b>Herdr</b><br/>[Terminal multiplexer]<br/>One pane per harness in team mode"]
    docker["<b>Docker Engine</b><br/>[Software System]<br/>Runs factory steps in containers"]
    models["<b>Model APIs</b><br/>[Software System]<br/>Anthropic, xAI, OpenAI, Cursor, Ollama"]

    dev -- "Gives tasks and approvals to<br/>[terminal, chat]" --> harness
    dev -- "Runs commands such as gate, approve and factory<br/>[CLI]" --> halvard
    maint -- "Labels issues and merges pull requests on<br/>[web, gh]" --> github
    harness -- "Calls on every session start, prompt and tool use<br/>[hook command with JSON on stdin and stdout; in process for Pi]" --> halvard
    harness -- "Sends prompts to<br/>[HTTPS]" --> models
    halvard -- "Reads, fingerprints, commits and pushes<br/>[git CLI]" --> repo
    halvard -- "Starts for plans, builds and reviews<br/>[CLI processes]" --> headless
    headless -- "Sends prompts to<br/>[HTTPS]" --> models
    halvard -- "Reads issues and label events, opens and merges pull requests<br/>[gh CLI, HTTPS]" --> github
    halvard -- "Starts one container per factory step<br/>[docker CLI]" --> docker
    harness -- "Runs in a pane of<br/>[terminal]" --> herdr

    classDef person fill:#08427b,stroke:#052e56,color:#ffffff
    classDef system fill:#1168bd,stroke:#0b4884,color:#ffffff
    classDef external fill:#999999,stroke:#6b6b6b,color:#ffffff
    class dev,maint person
    class halvard system
    class harness,headless,repo,github,herdr,docker,models external
```

_Key: see [Key](#key)._ The developer and the repository writer are often the same person. Headless agents call Halvard's hooks too, like your own session. Halvard never calls a model API itself: harnesses do, for both authors and reviewers.

## 2. Containers

A C4 container is something that runs or stores data on its own. Halvard's processes are short-lived Node.js programs started by a harness or by you; its stores are plain files. The containers appear in two views: interactive use, and a factory run.

### Interactive use

```mermaid
flowchart TB
    dev["<b>Developer</b><br/>[Person]"]
    harness["<b>Coding harness</b><br/>[Software System]<br/>Claude Code, Codex, Grok Build, Cursor CLI"]
    pi["<b>Pi</b><br/>[Software System]<br/>Loads Halvard as an extension"]
    repo["<b>Target repository</b><br/>[Git working tree]"]
    reviewers["<b>Reviewer CLIs</b><br/>[CLI processes]<br/>claude, codex, grok, cursor-agent, ollama or pi"]

    subgraph halvard["Halvard [Software System]"]
        skills[("<b>Skills</b><br/>[Container: Markdown files]<br/>Instructions the harness loads: spec, design, implement, test, review")]
        hook["<b>Hook guard</b><br/>[Container: Node.js process]<br/>Decides allow, ask or deny for each tool call and injects startup context"]
        piext["<b>Pi extension</b><br/>[Container: Node.js module in Pi]<br/>Same guard, called in process, plus plan mode"]
        cli["<b>halvard CLI</b><br/>[Container: Node.js process]<br/>task-start and task-done, gate, review, approve, setup, install"]
        state[("<b>Workflow state</b><br/>[Container: private files in TMPDIR]<br/>Gate receipts, approvals, review records, locks")]
        workspace[("<b>Task workspace</b><br/>[Container: files in ~/.halvard]<br/>Gate logs, review reports, team files, task markers")]
    end

    dev -- "Gives tasks and approvals to<br/>[terminal, chat]" --> harness
    dev -- "Runs approve and gate<br/>[shell]" --> cli
    harness -- "Loads at session start<br/>[plugin skills directory]" --> skills
    harness -- "Starts once per hook event<br/>[process, JSON on stdin and stdout]" --> hook
    pi -- "Calls on every event<br/>[in-process function call]" --> piext
    harness -- "Agent runs task-start, gate, review<br/>[shell command]" --> cli
    hook -- "Reads receipts, records approvals<br/>[files]" --> state
    piext -- "Reads receipts, records approvals<br/>[files]" --> state
    cli -- "Writes<br/>[files]" --> state
    cli -- "Writes<br/>[files]" --> workspace
    cli -- "Runs reviews<br/>[process]" --> reviewers
    hook -- "Reads branch, tree<br/>[git]" --> repo
    cli -- "Branches, runs the gate<br/>[git, shell]" --> repo

    classDef person fill:#08427b,stroke:#052e56,color:#ffffff
    classDef container fill:#438dd5,stroke:#2e6295,color:#ffffff
    classDef external fill:#999999,stroke:#6b6b6b,color:#ffffff
    class dev person
    class hook,piext,cli,skills,state,workspace container
    class harness,pi,repo,reviewers external
    style halvard fill:none,stroke:#0b4884,stroke-dasharray:6 4
```

_Key: see [Key](#key)._ The hook guard decides each call and records approvals and pending asks in workflow state. The agent runs the gate and the review itself with the CLI, and the guard checks their records when the agent marks the task done.

### Factory run

```mermaid
flowchart TB
    dev["<b>Developer</b><br/>[Person]"]
    repo["<b>Target repository</b><br/>[Git clone or worktree]"]
    github["<b>GitHub</b><br/>[Software System]"]
    docker["<b>Docker Engine</b><br/>[Software System]"]
    reviewers["<b>Reviewer CLIs</b><br/>[CLI processes]"]
    headless["<b>Headless agents</b><br/>[CLI processes]<br/>Plan and build runs with HALVARD_UNATTENDED=1"]

    subgraph halvard["Halvard [Software System]"]
        factory["<b>Factory runner</b><br/>[Container: Node.js process]<br/>halvard factory: plans, builds, checks and ships jobs; serve polls GitHub"]
        jobs[("<b>Factory store</b><br/>[Container: files in ~/.halvard-factory]<br/>Job files, events, evidence, outcomes, board")]
        cli["<b>halvard CLI</b><br/>[Container: Node.js process]<br/>gate, review, task-done for the runner"]
        hook["<b>Hook guard</b><br/>[Container: Node.js process]<br/>Turns every ask into a denial"]
        state[("<b>Workflow state</b><br/>[Container: files]<br/>The job's gate receipts and review records")]
    end

    dev -- "Runs factory commands<br/>[shell]" --> factory
    factory -- "Reads and writes<br/>[JSON files]" --> jobs
    headless -- "Calls on every tool use<br/>[JSON on stdin]" --> hook
    factory -- "Runs gate, review, task-done<br/>[child process]" --> cli
    cli -- "Writes receipts and review records<br/>[files]" --> state
    cli -- "Runs reviews<br/>[process]" --> reviewers
    factory -- "Clones and pushes<br/>[git]" --> repo
    factory -- "Reads issues, opens PRs<br/>[gh]" --> github
    factory -- "Runs steps in containers<br/>[docker run]" --> docker
    factory -- "Starts runs<br/>[process]" --> headless

    classDef person fill:#08427b,stroke:#052e56,color:#ffffff
    classDef container fill:#438dd5,stroke:#2e6295,color:#ffffff
    classDef external fill:#999999,stroke:#6b6b6b,color:#ffffff
    class dev person
    class factory,jobs,cli,hook,state container
    class headless,repo,github,docker,reviewers external
    style halvard fill:none,stroke:#0b4884,stroke-dasharray:6 4
```

_Key: see [Key](#key)._ The CLI and the factory runner start from the same file, `bin/halvard.ts`, but they run as separate processes with different jobs and credentials, so they are drawn apart. In container mode the headless agents and the runner's CLI steps run inside Docker containers; [deployment](#5-deployment) shows where.

## 3. Components

### Guard and workflow engine

The hook guard, the Pi extension and the CLI share one engine in `core/`. A hook call passes through the adapter, the runtime and the classifiers to a pure policy decision.

```mermaid
flowchart TB
    harness["<b>Coding harness</b><br/>[Software System]"]
    agentcmd["<b>Agent shell command</b><br/>[halvard CLI call]"]
    state[("<b>Workflow state</b><br/>[Container: files]")]
    repo["<b>Target repository</b><br/>[Git working tree]"]
    reviewers["<b>Reviewer CLIs</b><br/>[CLI processes]"]

    subgraph engine["Hook guard, Pi extension and halvard CLI [Containers]"]
        adapter["<b>Harness adapter</b><br/>[Component: TypeScript]<br/>Maps each harness's hook payload and output format"]
        runtime["<b>Runtime</b><br/>[Component: TypeScript]<br/>Handles each event: startup context, approvals, done checks, extensions"]
        shell["<b>Shell classifier</b><br/>[Component: TypeScript]<br/>Parses shell commands into reads, writes, Git and shipping operations"]
        tools["<b>Tool normalizer</b><br/>[Component: TypeScript]<br/>Turns edits and patches into the files and contents they produce"]
        policy["<b>Policy</b><br/>[Component: TypeScript]<br/>Pure allow, ask or deny decision from classified facts"]
        statec["<b>State and fingerprint</b><br/>[Component: TypeScript]<br/>Session keys, locked state files, tree fingerprints"]
        config["<b>Configuration</b><br/>[Component: TypeScript]<br/>Reads and validates .halvard.json and personal settings"]
        tasks["<b>Tasks</b><br/>[Component: TypeScript]<br/>task-start, resume, handoff, plan digests, done markers"]
        gate["<b>Gate</b><br/>[Component: TypeScript]<br/>Runs the configured checks and records a receipt for the tree"]
        review["<b>Review runner</b><br/>[Component: TypeScript]<br/>Builds the review snapshot, runs a reviewer, parses its verdict"]
    end

    harness -- "Hook payload<br/>[JSON]" --> adapter
    adapter -- "Canonical payload<br/>[function call]" --> runtime
    runtime -- "Classifies commands" --> shell
    runtime -- "Previews edits" --> tools
    runtime -- "Gets a decision" --> policy
    runtime -- "Reads receipts" --> statec
    runtime -- "Loads rules" --> config
    runtime -- "Checks done markers" --> tasks
    agentcmd -- "gate<br/>[CLI]" --> gate
    agentcmd -- "review<br/>[CLI]" --> review
    agentcmd -- "task-start<br/>[CLI]" --> tasks
    agentcmd -- "task-done<br/>[CLI]" --> runtime
    gate -- "Writes the receipt" --> statec
    review -- "Writes the record" --> statec
    review -- "Runs<br/>[process]" --> reviewers
    statec -- "Locks and writes<br/>[files]" --> state
    statec -- "Fingerprints<br/>[git ls-files, file hashes]" --> repo

    classDef component fill:#85bbf0,stroke:#5d82a8,color:#000000
    classDef container fill:#438dd5,stroke:#2e6295,color:#ffffff
    classDef external fill:#999999,stroke:#6b6b6b,color:#ffffff
    class adapter,runtime,shell,tools,policy,statec,config,tasks,gate,review component
    class state container
    class harness,agentcmd,repo,reviewers external
    style engine fill:none,stroke:#2e6295,stroke-dasharray:6 4
```

_Key: see [Key](#key)._ Policy has no input or output of its own; the runtime gathers the facts and acts on the decision. `task-done` runs the runtime's own completion checks, the same ones a done edit gets. A done edit is allowed only when the gate receipt and the review record match the current tree fingerprint.

### Factory runner

```mermaid
flowchart TB
    dev["<b>Developer</b><br/>[Person]"]
    github["<b>GitHub</b><br/>[Software System]"]
    harness["<b>Coding harness</b><br/>[Software System]"]
    cli["<b>halvard CLI</b><br/>[Container]"]
    docker["<b>Docker Engine</b><br/>[Software System]"]
    jobs[("<b>Factory store</b><br/>[Container: files]")]
    repo["<b>Target repository</b><br/>[Git working tree]"]

    subgraph runner["Factory runner [Container]"]
        commands["<b>Job pipeline</b><br/>[Component: TypeScript]<br/>Commands, plan and build stages, checks, park, ship"]
        serve["<b>Serve loop</b><br/>[Component: TypeScript]<br/>Polls labels, claims issues, runs up to concurrency jobs (1 to 4), starts retros"]
        driver["<b>Harness driver</b><br/>[Component: TypeScript]<br/>Headless command lines, scrubbed environment, timeouts, cost"]
        box["<b>Container box</b><br/>[Component: TypeScript]<br/>docker run flags, mounts, image version check"]
        store["<b>Job store</b><br/>[Component: TypeScript]<br/>Job folders, locks, events"]
        ship["<b>Ship and evidence</b><br/>[Component: TypeScript]<br/>Git helpers, changed files, risk, pull request body"]
        outcomes["<b>Outcomes and auto-merge</b><br/>[Component: TypeScript]<br/>Pull request outcomes, classes, track record, merge rules"]
        retro["<b>Retro</b><br/>[Component: TypeScript]<br/>Digest of recurring findings into a guidance job"]
        board["<b>Board and metrics</b><br/>[Component: TypeScript]<br/>Static HTML board and numbers"]
    end

    dev -- "Runs factory commands<br/>[CLI]" --> commands
    commands -- "Runs factory serve with" --> serve
    serve -- "Starts jobs in" --> commands
    serve -- "Merges and refreshes through" --> outcomes
    serve -- "Starts due retros from" --> retro
    commands -- "Runs agents with" --> driver
    commands -- "Wraps steps with" --> box
    commands -- "Saves jobs and events with" --> store
    commands -- "Commits and writes evidence with" --> ship
    commands -- "gate, review, task-done<br/>[child process]" --> cli
    driver -- "Runs plan and build<br/>[process]" --> harness
    box -- "docker run<br/>[CLI]" --> docker
    store -- "Writes<br/>[JSON files]" --> jobs
    ship -- "Commits and pushes<br/>[git CLI]" --> repo
    ship -- "Opens pull requests<br/>[gh CLI]" --> github
    outcomes -- "Reads pull requests, merges<br/>[gh CLI]" --> github
    serve -- "Reads issues and label events<br/>[gh CLI]" --> github
    serve -- "Writes the board after each step with" --> board
    board -- "Reads events and outcomes<br/>[files]" --> jobs
    outcomes -- "Reads events, writes outcome.json<br/>[files]" --> jobs
    retro -- "Reads events<br/>[files]" --> jobs
    commands -- "Reads briefs and plans<br/>[files]" --> jobs

    classDef person fill:#08427b,stroke:#052e56,color:#ffffff
    classDef component fill:#85bbf0,stroke:#5d82a8,color:#000000
    classDef external fill:#999999,stroke:#6b6b6b,color:#ffffff
    class dev person
    classDef container fill:#438dd5,stroke:#2e6295,color:#ffffff
    class commands,serve,driver,box,store,ship,outcomes,retro,board component
    class cli,jobs container
    class github,harness,docker,repo external
    style runner fill:none,stroke:#2e6295,stroke-dasharray:6 4
```

_Key: see [Key](#key)._ The runner keeps Git and GitHub credentials to itself: agents, setup, the gate and the reviewer run with a scrubbed environment, an empty `gh` configuration and a push URL that cannot connect.

## 4. Dynamic: one factory job

A planned issue from intake to pull request. Numbers follow the order of the calls; a small job skips steps 4 to 9.

```mermaid
sequenceDiagram
    autonumber
    actor W as Repository writer
    participant GH as GitHub
    participant S as Factory runner<br/>[serve loop]
    participant J as Factory store<br/>[files]
    participant A as Coding harness<br/>[headless agent]
    participant G as Hook guard
    participant C as halvard CLI<br/>[child process]
    participant R as Reviewer CLI

    W->>GH: Label the issue factory
    S->>GH: Read issues and label events [gh]
    S->>J: Create the job [mkdir, JSON]
    S->>A: Plan run, read-only [HALVARD_READONLY=1]
    A->>G: Every tool call [hook]
    G-->>A: Reads only
    S->>GH: Post the plan on the issue [gh]
    W->>GH: Label factory:approved
    S->>GH: Read the label event and the labeller's permission [gh]
    S->>A: Build run in a fresh worktree, or a clone with the run in a container [HALVARD_UNATTENDED=1]
    A->>G: Every tool call [hook]
    G-->>A: Asks become denials
    S->>S: Tamper and scope checks
    S->>C: halvard gate [child process or container]
    C-->>S: Receipt for the tree
    S->>S: Holdout checks
    S->>C: halvard review
    C->>R: Review the snapshot, read-only [process]
    R-->>C: Verdict
    S->>S: Tamper checks again
    S->>C: halvard task-done
    S->>S: Scope, Git directory and fingerprint checks, then commit the reviewed tree [git]
    S->>J: Record the committed event [JSON]
    S->>GH: Push and open a draft pull request with evidence [git, gh]
    S->>J: Record the pull request event [JSON]
```

_Key: solid arrows are calls, dashed arrows are replies; the bracket names the technology._ Setup steps and the optional acceptance-test writer run between steps 9 and 10. A failed gate or a blocked review sends the job back to step 10 while fix passes remain; otherwise the job parks and the runner comments on the issue. Outcomes of the pull request are fetched later, by `factory serve` or `factory automerge`.

## 5. Deployment

The same code runs on your machine and on a server. Container mode adds one Docker container per factory step; without it, every step runs as you.

```mermaid
flowchart TB
    subgraph laptop["Your machine [macOS or Ubuntu]"]
        subgraph term["Terminal or Herdr [process group]"]
            h1["<b>Coding harness</b><br/>[Node.js or native CLI]"]
            g1["<b>Hook guard</b><br/>[Node.js process per hook]"]
            c1["<b>halvard CLI</b><br/>[Node.js process]"]
        end
        f1["<b>Factory runner</b><br/>[Node.js process in a terminal]"]
        hh["<b>Headless harness runs</b><br/>[harness CLI processes]"]
        d1[("<b>Workflow state, task workspace, factory store</b><br/>[files under TMPDIR, ~/.halvard, ~/.halvard-factory]")]
    end

    subgraph vps["Server [Linux, optional]"]
        f2["<b>Factory runner</b><br/>[Node.js process, systemd user service]"]
        d2[("<b>Factory store and clones</b><br/>[files under ~/.halvard-factory]")]
        subgraph engine["Docker Engine"]
            subgraph net["Network: none, or internal with an egress proxy"]
                a2["<b>Agent container</b><br/>[harness CLI with Halvard's hooks]"]
                r2["<b>Runner-step containers</b><br/>[setup, gate, review, task-done]"]
                o2["<b>Holdout container</b><br/>[no network, read-only checkout]"]
            end
        end
    end

    gh["<b>GitHub</b><br/>[Software System]"]
    api["<b>Model APIs</b><br/>[Software System]"]

    h1 -- "Calls per hook<br/>[JSON on stdin]" --> g1
    h1 -- "Agent runs<br/>[shell command]" --> c1
    g1 -- "Reads and writes<br/>[files]" --> d1
    c1 -- "Reads and writes<br/>[files]" --> d1
    f1 -- "Reads and writes<br/>[files]" --> d1
    f1 -- "Starts plan and build runs, and reviews through the CLI<br/>[process]" --> hh
    hh -- "Calls per hook<br/>[JSON on stdin]" --> g1
    f1 -- "Fetches, pushes, opens pull requests<br/>[git over HTTPS or SSH, gh]" --> gh
    f2 -- "Fetches, pushes, opens pull requests<br/>[git over HTTPS or SSH, gh]" --> gh
    f2 -- "Starts<br/>[docker run]" --> a2
    f2 -- "Starts<br/>[docker run]" --> r2
    f2 -- "Starts<br/>[docker run]" --> o2
    f2 -- "Reads and writes<br/>[files]" --> d2
    h1 -- "Sends prompts<br/>[HTTPS]" --> api
    hh -- "Sends prompts<br/>[HTTPS]" --> api
    a2 -- "Sends prompts through the proxy, if allowed<br/>[HTTPS]" --> api
    r2 -- "Reviewer and gate traffic, if allowed<br/>[HTTPS]" --> api

    classDef container fill:#438dd5,stroke:#2e6295,color:#ffffff
    classDef external fill:#999999,stroke:#6b6b6b,color:#ffffff
    class g1,c1,f1,f2,d1,d2,a2,r2,o2 container
    class h1,hh,gh,api external
    style laptop fill:none,stroke:#0b4884,stroke-dasharray:6 4
    style vps fill:none,stroke:#0b4884,stroke-dasharray:6 4
    style term fill:none,stroke:#2e6295,stroke-dasharray:3 3
    style engine fill:none,stroke:#2e6295,stroke-dasharray:3 3
    style net fill:none,stroke:#6b6b6b,stroke-dasharray:3 3
```

_Key: dashed frames are deployment nodes; boxes inside them are the containers deployed there._ On the server only the runner holds GitHub and SSH credentials. Every container gets the clone with a read-only `.git`, the extra mounts you configure and the variables you list (the model keys by default); no other host variable reaches it. Setup containers get nothing more. The others also get Halvard's own settings variables, such as `HALVARD_UNATTENDED`. Agent containers also get their prompt folder and, for a build, the task workspace. Holdout containers get the checkout, the extra mounts and the scenarios folder read-only, and a writable scratch folder. Gate, review and `task-done` containers also get the job's receipt folder, the task workspace and, read-only, your personal settings. [Factory](factory.md#containers) lists every mount.

## Where things live

| Element | Files |
| --- | --- |
| Hook guard | `bin/hook.ts`, `hooks/hooks.json` (Claude Code), `hooks/codex.json`, `hooks/grok.json`, `hooks/cursor.json` |
| Pi extension | `adapters/pi.ts`, `adapters/plan-ui.ts`, `adapters/plan-utils.ts` |
| halvard CLI | `bin/halvard.ts`, `core/cli.ts` |
| Factory runner | `core/factory*.ts`, started by `bin/halvard.ts factory` |
| Skills | `skills/*/SKILL.md`; the harness manifests in `.claude-plugin/`, `.codex-plugin/`, `.grok-plugin/` |
| Workflow state | `core/state.ts` (`$TMPDIR/halvard-<uid>/<repo digest>`) |
| Task workspace | `core/tasks.ts`, `core/flow-config.ts` (`HALVARD_WORKSPACE`, default `~/.halvard`) |
| Factory store | `core/factory-store.ts` (`HALVARD_FACTORY_HOME`, default `~/.halvard-factory`) |
| Harness adapter | `adapters/payload.ts`, `adapters/hooks.ts`, `adapters/messages.ts` |
| Runtime | `core/runtime.ts`, `core/context.ts`, `core/status.ts` |
| Shell classifier | `core/shell.ts` |
| Tool normalizer | `core/tools.ts` |
| Policy | `core/policy.ts` |
| State and fingerprint | `core/state.ts` |
| Configuration | `core/project.ts`, `core/flow-config.ts`, `core/types.ts` |
| Tasks | `core/tasks.ts`; `task-done` runs `completeTask` in `core/runtime.ts` |
| Gate | `runGate` in `core/runtime.ts` |
| Review runner | `core/review.ts` |
| Job pipeline | `core/factory.ts` |
| Serve loop | `core/factory-serve.ts` |
| Harness driver | `core/factory-harness.ts` |
| Container box | `core/factory-container.ts` |
| Job store | `core/factory-store.ts` |
| Ship and evidence | `core/factory-ship.ts` for the Git and `gh` helpers, changed files, risk and the pull request body; `ship()` in `core/factory.ts` uses them to commit, push and open the pull request |
| Outcomes and auto-merge | `core/factory-outcomes.ts` |
| Retro | `core/factory-retro.ts` |
| Board and metrics | `core/factory-board.ts` |

Not drawn, because they run only when you install or maintain Halvard: installation (`scripts/install.sh`, `core/install*.ts`, `core/personal-install.ts`), setup and bootstrap (`core/setup.ts`, `core/bootstrap.ts`, with the stack records in `stacks/`), history cleanup and retro events (`core/clean-history.ts`, `core/retro.ts`, which read harness transcripts), the Herdr team settings (`core/team.ts`) and `doctor` (`core/doctor.ts`, `core/package.ts`).

## Keeping it current

Update the diagram and the table in the same change when you add, remove or rename a container or component, or change how two of them talk. A new file inside an existing component needs only a table entry.
