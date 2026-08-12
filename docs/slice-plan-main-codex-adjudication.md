# Main Codex Adjudication Slices

## Frozen intent

After a Compression Run has a durable manifest, every caught workflow problem must become an
Adjudication Request. Main Codex chooses a bounded repair, responsible-stage regeneration,
publication relocation, or explicit degradation and continues the same run until a normal Handoff
or Degraded Handoff is atomically published. No decision may fabricate evidence, modify the Source
Thread, rewrite an accepted receipt, or claim an I/O result that did not occur. Process termination,
machine loss, loss of the coordinator itself, and the absence of every writable work or publication
target remain outside the software guarantee.

## Authority and state model

```text
RUNNING
  -> caught diagnostic -> AWAITING_ADJUDICATION
  -> valid bound decision -> APPLYING_ADJUDICATION
  -> applied repair/regeneration/relocation -> RUNNING
  -> failed application -> AWAITING_ADJUDICATION (linked successor request)
  -> explicit degradation -> DEGRADED_PUBLICATION
  -> atomic Handoff + Evidence Index verification -> PUBLISHED
```

`PUBLISHED` is the only software terminal state. `AWAITING_ADJUDICATION`, invalid decision input,
exhausted Worker attempts, budget rejection, and failed decision application are resumable states.
An invalid decision never clears or replaces its active request. A repeated diagnostic is not retried
automatically: Main Codex must record another decision or choose explicit degradation.

The immutable event chain is authoritative. A manifest status, CLI response, or compatibility
`failure-report.json` is only a projection and cannot silently erase an Adjudication Request,
Adjudication Decision, accepted receipt, superseded generation, or unresolved diagnostic.

## Decision vocabulary

| Action | Permitted effect | Forbidden effect |
| --- | --- | --- |
| `retry_stage` | Resume the named phase after Main Codex corrects its mutable candidate or input | Change another phase or silently accept invalid data |
| `regenerate_stage` | Archive the named mutable generation and issue a superseding generation for its Failure Owner | Replay unrelated MAP work or rewrite an accepted receipt |
| `relocate_publication` | Bind a new non-existing Handoff/Evidence Index pair in the same run | Overwrite an existing file or change Source evidence |
| `publish_degraded` | Publish verified continuation facts plus exact unresolved diagnostics and omissions | Present an unresolved item as verified or fabricate replacement evidence |

Each request carries only bounded evidence-safe context: run/phase identity, diagnostic code and
message, responsible artifact coordinates, immutable digests, accepted-work counts, and allowed
actions. Private MAP input, raw Source payloads, and unrestricted exception details never enter the
request or CLI response.

## MA0 diagnostic inventory

| Command boundary | Phase / Failure Owner | Current captured result | Lawful Main Codex actions | Executable baseline |
| --- | --- | --- | --- | --- |
| `prepare-frame` | deterministic Frame input / workflow control files | exception only | `retry_stage`, `regenerate_stage`, `publish_degraded` | `compression.test.mjs` workflow-file and version mismatch cases |
| `validate-frame` | authored Frame, projection, or pre-dispatch budget | only budget rejection writes terminal report; other exceptions escape | `retry_stage`, `regenerate_stage`, `publish_degraded` | `provider-timing-pt1.test.mjs` and `main-codex-adjudication-ma0.test.mjs` |
| `validate-map --claim` | dispatch ownership / coordinator | exception only | `retry_stage`, `regenerate_stage`, `publish_degraded` | `map-worker.test.mjs` duplicate-claim cases |
| `validate-map --check` | active MAP candidate / MAP Worker | bounded candidate diagnostic but no run-level resumable state | `retry_stage`, `regenerate_stage`, `publish_degraded` | `targeted-map-repair-tr1.test.mjs` and TR5/TR6 owner cases |
| `validate-map --complete` | active MAP candidate / MAP Worker | attempt-2 then `MAP_WORKER_EXHAUSTED`; no adjudication state | `retry_stage`, `regenerate_stage`, `publish_degraded` | `map-worker.test.mjs` exhausted-attempt cases and `targeted-map-repair-tr2.test.mjs` |
| `validate-map --accept` | immutable receipt / coordinator | exception only, including duplicate or conflicting receipt | `regenerate_stage`, `publish_degraded` | `map-worker.test.mjs` duplicate-receipt cases |
| direct `validate-map` | candidate plus claim/check/complete/accept composite / earliest failing subphase | exception only outside existing attempt bookkeeping | the failing subphase's actions | `map-worker.test.mjs` direct lifecycle cases |
| `record-map-metric` | provider observation / host ingress | exception only | `retry_stage`, `regenerate_stage`, `publish_degraded` | `provider-timing-pt3.test.mjs` correlation and replay-conflict cases |
| `schedule-map` | later-wave capacity and timing / coordinator | overwritable terminal report, no continuation state | `retry_stage`, `publish_degraded` | `provider-timing-pt4.test.mjs` unavailable/unreachable cases |
| `prepare-reduce` | accepted MAP set and deterministic REDUCE input / earliest failing MAP or REDUCE-input owner | overwritable terminal report | `retry_stage`, `regenerate_stage`, `publish_degraded` | `continuation-grade-r4.test.mjs` and targeted owner regressions |
| `validate-reduce --check` | `reduced.json` / REDUCE author | overwritable terminal report | `retry_stage`, `regenerate_stage`, `publish_degraded` | `continuation-grade-r5.test.mjs` preflight failure |
| `publish` | checked REDUCE, source revision, budgets, and transactional outputs / publisher | overwritable terminal report; first-file rollback on pair failure | `retry_stage`, `relocate_publication`, `publish_degraded` | `compression.test.mjs` source/budget/transaction cases and R5 digest binding |
| stage-specific CLI parse | the command named by the first managed `WORK_DIR` argument / coordinator | stderr and process exit only | `retry_stage`, `publish_degraded` | MA2 CLI table fixture |
| `adjudicate --apply` | selected decision action / Main Codex | immutable success/failure application plus exact resume contract | retry a corrected decision or record a linked successor request | MA3 application matrix |

`prepare` validation before a managed manifest and Evidence Pack exist is bootstrap, not a live
Compression Run. MA2 must capture any later CLI parse problem when a managed `WORK_DIR` can be
identified. Once the run is durable, unknown exceptions are owned by the invoked phase and receive
the same evidence-safe request treatment as named diagnostics.

`retrieve` and `verify-evidence` consume an already published Evidence Index, carry no managed
`WORK_DIR`, and therefore remain post-publication utilities outside the Adjudication Loop.

## Slice MA0 — Diagnostic inventory and authentic red fixtures

**Input**: current Frame, MAP claim/check/complete/accept, provider metric/scheduling, REDUCE,
publication, compatibility failure-report, and CLI error boundaries.

**Produces**: a deterministic inventory mapping each catchable diagnostic to its phase, Failure
Owner, resumable command, safe context, and lawful actions; authentic red fixtures prove representative
pre-dispatch, exhausted Worker, accepted-receipt conflict, REDUCE, budget, and publication problems
currently leave no resumable adjudication state.

**Excludes**: runtime behavior changes, new automatic retries, and fabricated physical-failure tests.

**Done when**: every existing workflow command after durable `prepare` has an owner in the inventory,
each listed red fixture fails for the missing adjudication contract rather than a synthetic assertion,
and the complete pre-MA1 suite stays green.

**Implementation evidence**: the inventory above covers every post-prepare CLI command and separates
bootstrap from a durable Compression Run. `main-codex-adjudication-ma0.test.mjs` executes the real
pre-dispatch budget boundary and freezes the authentic gap: a `codex-handoff-terminal-failure` report
exists while no adjudication directory or resumable state exists. Existing MAP Worker, targeted MAP,
provider timing, continuation REDUCE, and transactional publication tests supply the other retained
failure-class fixtures named in the table without copying private evidence into a new fixture.

**Acceptance evidence**: the focused MA0 fixture passes 1/1; the complete pre-MA1 Node suite passes
189/189 with zero skips; `git diff --check` passes. No executable workflow file changed in MA0.

## Slice MA1 — Durable request, event chain, and CLI

**Input**: one bounded Captured Workflow Diagnostic plus the immutable Compression Run contract,
phase identity, artifact coordinates, and allowed actions from MA0.

**Produces**: an immutable `adjudication-contract.json`, request and decision documents, a
digest-chained append-only event directory, and `adjudicate --inspect|--submit` CLI operations. State
is replayed from events; no mutable status file is authoritative.

**Excludes**: routing existing stage failures, applying decisions, MAP supersession, candidate
regeneration, degraded rendering, and publication target mutation.

**Done when**: focused tests prove active-request replay is byte-stable, requests expose no private
evidence, event chains detect deletion/reordering/mutation, decisions bind the exact run/request/digest
and one allowed action, invalid or stale decisions leave the active request and ledger unchanged, and
a valid decision transitions only its named request to `APPLYING_ADJUDICATION`.

**Implementation evidence**: every new v2 `prepare` writes one root
`adjudication-contract.json` bound to the exact managed run. `adjudication.mjs` accepts only the
bounded request schema, stores immutable request/decision documents, appends digest-linked numbered
events, reconstructs state exclusively from those events, and rejects orphaned, missing, reordered,
or mutated history. `adjudicate --inspect` is read-only; `--submit` accepts one bounded decision file
and records only an exact active-request/action binding. Existing stage failures remain unrouted.

**Acceptance evidence**: the authentic MA1 red failed 0/7 only because the contract, library API,
event replay, and CLI command were absent. MA1 then passes 7/7; MA0/MA1, Compression Task, and MAP
Worker regressions pass 28/28. The isolated staged MA1 snapshot passes 195/195 with zero skips; the
coexisting worktree, including the preserved uncommitted TR6 test, passes 196/196 with zero skips.

## Slice MA2 — All-stage capture and run gating

**Input**: the MA1 contract plus every post-prepare workflow command and diagnostic owner in MA0.

**Produces**: one facade boundary that converts caught Frame, MAP, Worker-capacity, provider-timing,
budget, REDUCE, integrity, and publication exceptions into durable Adjudication Requests. Ordinary
commands refuse to advance while a request or unapplied decision is active and return the exact
inspection path and request identity to Main Codex.

**Excludes**: automatic repair, clean-run fallback, decision application, and degraded publication.

**Done when**: table-driven tests inject one diagnostic per phase, observe `AWAITING_ADJUDICATION`
without losing accepted artifacts, replay the same command without adding an event, and prove no
captured diagnostic projects a completed/failed export terminal state.

**Implementation evidence**: the managed v2 CLI is the single capture facade. Before any
post-prepare command it replays the MA1 chain and gates both `AWAITING_ADJUDICATION` and
`APPLYING_ADJUDICATION`; on a caught diagnostic it selects the phase/Failure Owner/action policy,
records one evidence-safe request, and returns its exact run/request/digest plus inspection paths.
The immutable contract now replays independently of mutable manifest integrity. The compatibility
`failure-report.json` is a non-authoritative `codex-handoff-captured-workflow-diagnostic` projection,
never a completed/failed run state. Deterministic library cores and legacy v1 execution stay below
the v2 CLI facade. No decision action is applied.

**Acceptance evidence**: the authentic MA2 red failed 0/16 because every real boundary remained
`RUNNING`, parse errors were unbound, and submitted decisions did not gate commands. The completed
focused matrix passes 19/19 across Frame/pre-dispatch, every MAP subcommand, provider timing,
capacity, REDUCE, publication, managed parse, mutable-manifest integrity, accepted-artifact
retention, idempotent replay, and unapplied-decision gating. MA0-MA2 plus MAP/TR1-TR6, provider,
REDUCE, and publication regressions pass 70/70; the isolated staged MA2 snapshot passes 214/214,
and the coexisting complete worktree passes 215/215; both have zero skips.

## Slice MA3 — Decision application and immutable supersession

**Input**: one active, strictly bound Adjudication Decision selecting `retry_stage`,
`regenerate_stage`, or `relocate_publication`.

**Produces**: `adjudicate --apply`; phase-specific resume contracts; archived REDUCE/Frame candidates;
same-run publication relocation; and generation-specific MAP paths/dispatches. An accepted or exhausted
MAP generation remains immutable with its receipt, candidate digests, provider observation, and
decision link while only the responsible segment receives a superseding dispatch.

**Excludes**: unrelated MAP replay, receipt mutation, Source Thread changes, evidence fabrication,
and degraded rendering.

**Done when**: tests supersede an accepted conflicting MAP receipt, regenerate a REDUCE candidate,
relocate a blocked publication pair, and resume only the named phase. A failed apply records a linked
successor request, a replayed apply is idempotent, and REDUCE consumes only the latest active accepted
MAP generation while prior generations remain audit-verifiable.

**Implementation evidence**: `adjudication.mjs` extends the append-only chain with immutable
`APPLIED` / `APPLICATION_FAILED` documents. `adjudication-actions.mjs` owns exact phase resume
contracts, REDUCE candidate archival, generation-specific MAP supersession, and same-run publication
relocation. The mutable manifest carries only active routing plus complete prior MAP-generation and
publication-relocation audit records; the immutable contract and accepted artifacts are never rewritten.

**Acceptance evidence**: the authentic MA3 red failed 0/5 because `adjudicate --apply` was absent.
The completed fixture passes 23/23 across all retryable named-phase resume contracts, repeat-apply
zero-write replay, REDUCE archival, accepted MAP supersession with unrelated generation preservation,
latest-only REDUCE input, digest drift, provider-observation regeneration, safe publication relocation,
and one linked successor after application failure. MA0-MA3 pass 50/50; the coexisting complete Node
suite passes 238/238 with zero skips.

## Slice MA4 — Evidence-bounded Degraded Handoff

**Input**: an active `publish_degraded` decision, durable run evidence, the complete adjudication
chain, and whichever normal-stage artifacts still verify.

**Produces**: a deterministic Degraded Handoff projection containing the byte-exact current goal when
available, verified terminal/workspace facts, retained accepted work, exact unresolved diagnostics,
explicit unavailable/omitted fields, and continuation instructions; its Evidence Index remains
complete when verifiable or is rebuilt to an explicit verified subset. The existing exclusive
two-artifact transaction publishes the pair.

**Excludes**: unverified semantic completion, invented Claims/Findings, suppressed diagnostics,
overwriting output, and false evidence validity.

**Done when**: representative failures before MAP, after accepted MAP, during REDUCE, and during
normal publication each reach an evidence-verifiable Degraded Handoff. A degraded publication I/O
failure returns to adjudication unless every lawful target is physically unwritable.

**Implementation evidence**: `task-workflow-core.mjs:publishDegradedHandoff` binds the exact active
decision, re-verifies the complete Evidence Index or rebuilds an explicit verified subset, retrieves
the byte-exact current goal, revalidates accepted MAP generations, and never reads a failed REDUCE
candidate into the projection. `render-degraded-handoff.mjs` renders exact diagnostics, omissions,
continuation instructions, and the adjudication head deterministically. The existing exclusive
two-file transaction publishes the pair; its failure rolls back attempt-owned output and the MA3
application boundary activates one linked successor. Successful application replays as `PUBLISHED`,
including for pre-MA4 contracts whose immutable lifecycle list did not yet name that terminal state.

**Acceptance evidence**: the original authentic MA4 red failed 0/5 only because
`publish_degraded` was unimplemented. The completed fixture passes 7/7 across pre-MAP, accepted-MAP,
REDUCE, normal-publication, source-change subset, mutated-goal rejection, terminal replay/gating,
and transactional rollback paths. MA0-MA4 pass 57/57; the coexisting complete Node suite passes
245/245 with zero skips.

## Slice MA5 — Operator contract and end-to-end guarantee

**Input**: the implemented state machine and retained live overlapping-coverage case.

**Produces**: updated Skill, Worker contract, architecture, code trail, package installation, and a
Main Codex loop that always inspects, decides, applies, resumes, and—when reliable repair cannot be
proven—chooses explicit degradation instead of stopping.

**Excludes**: asking the user to adjudicate internal workflow defects, infinite automatic retries,
clean Compression Runs as recovery, and claims covering process or machine death.

**Done when**: documentation contains no instruction to terminate on a captured diagnostic; focused
fault-injection and complete suites pass; repository and installed packages match; and fresh live
acceptance produces a final normal or explicit Degraded Handoff plus a valid Evidence Index from one
Compression Run, with every Main Codex decision and unresolved item auditable.

## Slice order and stop rules

`MA0 -> MA1 -> MA2 -> MA3 -> MA4 -> MA5` is strict. Each slice begins from a green complete suite,
adds the smallest authentic failing test first, changes one authority boundary, records exact test
evidence in this file and `docs/code-trail.md`, and leaves a cold-startable file state. A slice may
stop implementation work when its own test is red, but the product workflow being built may never
treat that diagnostic as a terminal export result.
