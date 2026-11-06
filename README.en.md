# blacksailflow

A single-entry workflow that keeps the whole engineering process under one hand: a super-agent-style setup where the main session holds control and makes calls while resident execution units do the work, and state lives on the task board instead of in chat history.

The name is "black sail": on a black-sail ship only the captain gives the orders, yet the ship moves because the mate splits the work, the hands do it, and everyone obeys one shared code.

## Why it exists

Running large engineering work in one session reliably hits four problems:

1. **Context drowns in process**: long output from reading code, running tests and editing files piles up in the main session and squeezes out the information that actually needs judgement.
2. **Responsibilities blur**: who sets the goal, who splits the work, who verifies and who delivers all share one context, so when something goes wrong nobody can tell which layer failed.
3. **State lives in documents**: progress ends up in chat, notes or self-report, is lost on the next session, and someone has to restate it after a restart.
4. **The main session stalls on long commands and polling**: waiting for a build or watching a background job leaves it spinning in place, so concurrency never grows.

The result: the more one agent does, the slower the main session gets; and there is nowhere for parallelism to live.

## Core idea: one entry controls the entire workflow

Following the super-agent idea: **the main session keeps exactly one job — control** — set the goal, cut the scope, dispatch work, make calls, collect results. Execution detail moves to lower layers, each with its own context, its own responsibility and checkable output.

The main session is therefore no longer occupied by process. It can end its turn right after dispatching and resume when a message wakes it. That is the precondition for concurrency: when the entry does not block, lower layers have room to run in parallel.

## How the three tiers divide work

- **captain**: only cuts groups, dispatches mates, judges cross-group conflicts and makes calls. Writes no files, never blocks; ends the turn after dispatching and resumes on a message.
- **mate**: stays resident on one task group and owns that domain across versions. Splits tasks, dispatches hands, holds acceptance; when a hand reports back it verifies against acceptance criteria and sends it back for rework if it falls short.
- **hand**: takes one independently verifiable task and does investigate + change + test in a single pass, without opportunistic edits outside its scope.

**Group = domain, not one delivery**: a group is a long-lived area of responsibility, not "this version's requirements". Groups outlive versions, and a mate does not exit after one delivery.

## What the runtime adds on top of DSH

- **Task board as the only state source with executable acceptance**: create, claim, transition and record evidence only through the board tools; a task can bind a verification command and working directory, so marking it done runs the command and a non-zero exit refuses completion and records the result. Chat and self-report are not state.
- **Goal dispatch / auto-continued rounds / restart resume**: goals can be assigned to teammates; after a turn ends the goal state decides whether work continues; after a host restart the goal is re-armed so work continues toward the same objective.
- **Per-tier identity and skill visibility**: captain / mate / hand each receive their own charter and working-mode text; the eight skills are filtered in the model-facing catalog by role (captain 4 / mate 6 / hand 1).
- **Per-turn self-check, autonomous loop, completed-hand folding**: every turn runs a self-check; after the turn ends the board decides whether work continues; finished hand output folds into a title so it stops consuming the main session's context.

### Very high concurrency and efficiency

- Multiple mates in parallel: different groups advance at the same time without blocking each other.
- Multiple hands per mate: one group's work is split into non-overlapping pieces that start together.
- A non-blocking captain: it dispatches and immediately ends its turn instead of waiting inside the main session.

### What the general hooks fix in everyday LLM behaviour

| Problem | How it is injected / blocked |
|---|---|
| Defensive output and pointless restating | The resident-rules body (`hooks/resident-rules.md`) is injected every turn and constrains the output shape: conclusion, evidence, open items only |
| Read-only work handed back untouched | The per-turn self-check requires work to land on disk, and a task's acceptance command fails when nothing changed |
| Self-report treated as completion | Board state only moves through `bf_*` tools and acceptance exit codes; self-report, documents and chat are not state |
| Loop lock-up, retrying the same path | Resident rules require changing a condition before a second attempt, and stopping with blocking evidence after three rounds without progress |
| Discipline lost after compaction | Re-anchoring after compaction re-injects the same function and the same resident rules instead of trusting memory |
| Broken cross-layer communication, a dispatch that then goes dark | Identity injection per tier plus goal dispatch, auto-continued rounds and restart resume; a teammate can still be woken with `send_message` after its turn ends |

### livefire: verification on the real route

Verification does not stop at unit tests. It follows the user's own route — real repository, real browser, real data — does what the user would do, sends failures back for repair, and re-verifies on that same route until it passes. The 19/19 end-to-end checks in the cardplayer round, and every rework item that was only closed after re-verifying on that route, came from this.

## Naming details

- **The black-sail pirate ship (blacksailflow)**: the workflow's name; one entry gives the order, the whole ship executes.
- **captain / mate / hand**: the captain sets course and makes calls, the mate guards one domain and distributes work, the hand finishes one task.
- **The pirate code**: the resident rules shared by all three tiers. Everyone obeys the same code, so swapping people does not change the rules.

## Quick start

Install, verify, acceptance and rollback details are all in [`AGENT.md`](AGENT.md): `node release/install.mjs` → `node release/verify-install.mjs` → `node release/uninstall.mjs`.

## Known limits

- Bound to specific DSH `0.2.1-rc.5` behaviour (hooks bridge, preset selection and mount timing, session-log layout, skills layering); re-verify before using another version.
- Does not lock the host permission defaults: the plugin never modifies your permission configuration.

## License

MIT, see `LICENSE`.
