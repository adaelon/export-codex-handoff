# Architecture

## Components

```text
Dedicated Codex Compression Task
  -> export-codex-handoff skill contract
       -> deterministic helper CLI
            -> workflow version router
                 -> immutable v2 directory + sparse or opt-in continuation MAP mode binding
                 -> immutable aggregate and per-dispatch MAP-output budgets
                 -> unchanged legacy v1 path
            -> Source Thread resolver/parser
                 -> Evidence Anchors + event boundaries + bounded Tool/Patch Receipts
            -> workspace snapshot
                 -> command/file Evidence Anchors + observedAt + Git HEAD
            -> deterministic terminal-state projector
                 -> Source termination + assistant/completed/pending tool state
                 -> separate compression-time workspace observation
                 -> one bounded terminal_state Claim + stable anchor union
            -> deterministic Critical Anchor selector + identifier hygiene
                 -> latest goal/proposal/terminal/failure/current Git hard obligations
                 -> fresh checkpoint current authority; stale/unknown historical retrieval only
                 -> validated exact identifiers from selected anchors only
            -> Evidence Pack and bounded segmentation planner
                 -> [sparse/legacy] complete-turn or adjacent-fragment MAP inputs
                 -> [continuation] Critical-Anchor source units + workspace observations only
                 -> continuation effective chunk budget derived from the 100k total-input gate
            -> compact Evidence Index builder/retriever
            -> bounded Progress Evidence projector
                 -> user-visible assistant progress + successful content inspections
                 -> deterministic operation classes + exact-scope latest-read folding
                 -> independent input/dispatch budgets + coverage digests
                 -> existence, verification, mutation, and mechanical results remain cold
            -> action-ready continuation-map-v2 planner
                 -> one private progress_map dispatch for validated Progress Evidence
                 -> unchanged Critical-only dispatches with empty action-ready relations
                 -> 4k raw candidate + 16k deterministic completion gates
            -> Compression Frame input builder/validator
                 -> frozen frameId + canonical frameDigest
                 -> byte-exact v2 currentGoal + clause-level extractive exclusions
                 -> Accepted Proposal? + Terminal-State Claim
                 -> segment-local Evidence Reference Dictionaries
                 -> integer-only Frame Projection references + 20k projection gate
                 -> 100k evidence + dictionary + projection MAP-input gate
       -> Compression Task coordinator emits frame-bound MapDispatch capabilities
            -> performance calibration + first-wave budget projector
                 -> controlled model/reasoning/slot comparisons
                 -> provider-only generation latency + workflow-only check/accept latency
                 -> 600000ms conservative later-wave abort
            -> isolated MAP Worker claims exactly one dispatch
                 -> reads one bounded segment + digest-bound dictionary/projection + mode-specific MAP contract
                 -> writes one private sparse or continuation summary candidate
                 -> MAP-only contract excludes REDUCE output shapes
                 -> non-consuming structural check freezes its digest
                 -> deterministic sparse expansion or compact continuation completion
                 -> bounded MapReceipt binds raw + normalized/completed digests
            -> coordinator accepts digest-bound derived artifacts and receipts only
                 -> [sparse/legacy] deterministic full-summary parent fold
                 -> [continuation] one global Claim table + edge-only parent fold
                 -> [continuation v2] Finding/Deliverable/Inspection tables from progress_map
                 -> deterministic Accepted Proposal/Terminal-State insertion exactly once
                 -> critical-only Continuation Coverage + claim-to-turn Semantic Coverage
            -> mode-routed REDUCE input builder
                 -> [continuation] compact frame + one Claim table + edge summaries
                 -> critical obligations + body-free deterministic projection policy
                 -> body-free continuation-authority Claim IDs
                 -> [continuation v2] Working Synthesis input + action-ready output contract
                 -> 300k serialized-input gate
            -> active Codex task performs REDUCE
            -> non-consuming continuation REDUCE preflight
                 -> deterministic important locations + Preservation Coverage
                 -> claim-derived final provenance + exact candidate digest binding
                 -> [continuation v2] task-profile Actionability gate
                 -> [continuation v2] typed-root Hot Context projection
                 -> compact Evidence Keys + separate exact audit map
            -> transactional Handoff and Evidence Index publisher
                 -> dedicated Accepted proposal and Terminal state sections
                 -> [continuation v2] isolated execution-first Handoff v2 renderer
                 -> [continuation v2] integrity-covered Evidence Key map + consumer contract
                 -> bounded diagnostic projection; managed CLI opens one Adjudication Request
                 -> fixed MAP generation/check-accept/REDUCE/publication metrics
```

The active Codex task supplies semantic compression. Scripts own evidence discovery, bounded previews,
exact source addressing, structural validation, no-overwrite publication, and managed temporary cleanup.
No script starts another Codex process.

The accepted adjudication boundary is specified by
[ADR-0016](./adr/0016-main-codex-adjudication-loop.md) and its
[ordered slices](./slice-plan-main-codex-adjudication.md). MA1-MA5 are implemented: each new v2 run has an
immutable root `adjudication-contract.json`; bounded request and decision documents are referenced by
a numbered digest chain; replay is authoritative; and `adjudicate --inspect|--submit|--apply` exposes that
state without a mutable status file. The managed v2 CLI replays that state before every post-prepare
command, captures a caught diagnostic through its phase policy, and refuses to invoke the deterministic
core while a request or submitted-but-unapplied decision is active. Library-level workflow functions
remain composable deterministic cores, and v1 runs without a durable adjudication contract keep their
compatibility route. Application documents close one submitted decision immutably; success restores
`RUNNING`, while failure closes the predecessor as `APPLICATION_FAILED` and activates exactly one
linked successor request. The `publish_degraded` action is the successful terminal exception: it
re-verifies retained evidence, publishes a bounded Degraded Handoff plus Evidence Index transactionally,
and replays as `PUBLISHED` without promoting a failed REDUCE candidate or an unverifiable fact.
MA5 installs the Main Codex operator loop over that state machine: every managed diagnostic is
inspected, decided, applied, and resumed in the same run; repeated or unprovable corrections select
explicit degradation rather than user adjudication or a clean run. The bounded `adjudicate --capture`
ingress admits only the two pre-worker observations that otherwise occur outside a managed command,
`MAP_WORKER_UNAVAILABLE` and `PROVIDER_TIMING_UNAVAILABLE`. MAP repair requests additionally persist
the exact evidence-safe issue list, so a resumed Worker receives deterministic field-level guidance
without private evidence. The retained same-run fault-injection proof and exact immutable bindings
are recorded in [Main Codex Adjudication Live Acceptance](./main-codex-adjudication-live-acceptance.md).

```text
v2 prepare -> immutable adjudication-contract.json
bounded library ingress -> immutable request document -> numbered request_opened event
adjudicate --inspect -> verify contract + document digests + complete event chain -> replay state
adjudicate --capture -> pre-worker capacity/timing code allowlist -> schedule-map request policy
adjudicate --submit -> exact run/request/digest/action check -> immutable decision document
                    -> numbered decision_submitted event -> APPLYING_ADJUDICATION
adjudicate --apply -> retry named phase | regenerate named generation | relocate publication pair
                  | publish evidence-bounded degraded pair
  repair success -> immutable APPLIED application + numbered event -> RUNNING + exact resume command
  degraded success -> immutable APPLIED application + numbered event -> PUBLISHED
  failure -> immutable APPLICATION_FAILED application + linked successor -> AWAITING_ADJUDICATION
  replay after success -> same result and event head; zero writes
publish_degraded -> verify exact request/decision binding
                 -> re-verify complete Evidence Index or build explicit verified subset
                 -> retrieve byte-exact current goal + deterministic terminal state
                 -> revalidate accepted MAP generations; omit failed REDUCE candidate
                 -> deterministic degraded renderer + exclusive two-file transaction
managed v2 CLI command -> replay state
  RUNNING -> invoke deterministic core
    success -> return unchanged command result
    caught diagnostic -> phase/owner/action policy -> bounded library ingress
                      -> non-terminal failure-report projection + exact inspection reference
  AWAITING_ADJUDICATION | APPLYING_ADJUDICATION -> return same request identity; do not invoke core
  PUBLISHED -> return the stable terminal state; do not invoke core or open a successor
Main Codex operator loop -> inspect active request -> select one allowed evidence-bounded action
                         -> submit -> apply -> run only result.resume.command
                         -> repeated/unprovable correction -> publish_degraded
                         -> normal pair or degraded pair verified -> PUBLISHED outcome
MAP regeneration -> retain complete prior generation in manifest audit history
                 -> issue generation-specific candidate/receipt paths and one new dispatch
                 -> unrelated MAP generations remain byte-identical; REDUCE reads only active stages
```

New managed directories are v2 and pair the manifest with an immutable version binding over the
session, absolute work directory, MAP result mode, reference-projection mode, projection and
total-input budgets, and aggregate MAP-output budget. The default remains `sparse-map-v1`; an
explicit prepare may instead bind `continuation-map-v1`. Sparse allocation defaults to three times
the REDUCE target. Continuation allocation stays within one REDUCE target and caps every dispatch at
4,000 raw characters. Every MapDispatch includes its own character cap in its identity. Every stage
load checks the pair and allocation before reading mutable state; reference-projection dispatches
also bind the dictionary path and digest. Legacy v1 and
pre-initiative v2 directories without a result mode remain on their original full-MAP path; neither
contract may be reinterpreted as the other.

The Compression Task coordinator never opens a MAP `chunkPath`. New continuation runs keep every
indexed anchor and Source Thread turn ID, but package only source units carrying Critical Anchors
plus separate Critical workspace observations for MAP. The caller-visible chunk request still
defaults to 140,000 characters; continuation preparation derives an effective cap from the immutable
total-input and projection budgets, yielding 60,000 characters under the 100,000 / 20,000 defaults.
New runs also keep the 916k-class global frame out of every chunk and give each Worker a deterministic
Evidence Reference Dictionary plus a Frame Projection containing the current goal, exclusions, and
only local integer references for obligations reachable from that packed segment. The dictionary
maps consecutive evidence and exact-identifier indexes back to immutable values; both artifacts are
rebuilt deterministically before acceptance. The projection is capped at 20,000 characters, and
evidence plus dictionary plus projection is capped at 100,000 characters. Existing
`frame-projection-v1` work directories retain
their 400,000-character evidence-plus-projection path. The coordinator observes currently available
dedicated worker slots before each dispatch wave and stops with `needs-user` when no slot exists. If
the current dispatches fit that fresh capacity, the wave needs no timing capability. If dispatches
remain beyond it, the coordinator validates an exact four-field `ProviderTimingCapability` before
returning any dispatch: an unavailable capability returns `PROVIDER_TIMING_UNAVAILABLE`, while an
available provider/post-worker capability admits only the first wave within that capacity. Workers
then atomically claim one admitted frame-bound MapDispatch,
read only the contract selected by `mapResultMode`, and write private summary candidates.
`validate-map --check`
reports structural or `MAP_OUTPUT_TOO_LARGE` errors without
post-check mutation. Sparse completion preserves its deterministic full-MAP expansion and private
normalized summary. Continuation completion instead resolves dictionary-local references, derives
global Claim IDs and byte-exact anchors, converts typed relations, and writes one private compact
Claim table. The MapReceipt remains bounded to 2,048 characters and binds the raw digest plus the
mode-specific normalized or completed digest; the coordinator verifies that result without opening
`chunkPath`. Accepted raw and derived character totals are persisted separately;
accepted raw totals cannot exceed the immutable aggregate budget. The first failed completion creates one retry dispatch; the second trips a per-segment
circuit breaker and retains both diagnostic receipts and candidates.

Performance calibration is deterministic bookkeeping, not a model-selection heuristic. Controlled
runs use the same representative smallest, median, and largest dispatch fixture and change exactly
one of model, reasoning effort, or slot count. Provider-reported MAP and REDUCE generation time is
kept separate from Node check/complete/accept, REDUCE preparation/check, and transactional
publication time; harness elapsed time cannot enter a provider field. Immediately after Frame
validation, the coordinator projects the `createdAt`-to-`frameValidatedAt` workflow duration plus
fixed conservative 60,000 ms REDUCE and 20,000 ms publication reserves. Invalid UTC boundaries fail
deterministically; a lower bound above 600,000 ms writes a retained captured-diagnostic projection and returns
`LIVE_BUDGET_UNREACHABLE` before MAP contexts, MapDispatch descriptors, or claims exist. Before later
waves, the coordinator calls `schedule-map <WORK_DIR> <AVAILABLE_SLOTS>`. That boundary rereads only
the manifest and accepted MapReceipts, verifies the receipt-bound metric integrity state, requires
unique correlated observations and exact workflow durations for every admitted dispatch, and then
combines the first-wave samples with the newly observed slot count and conservative
REDUCE/publication reserves. Missing, duplicate, broken, or non-correlated samples produce
`INCOMPLETE_FIRST_WAVE_METRICS`; zero capacity produces `MAP_WORKER_UNAVAILABLE`; an over-target
projection produces `LIVE_BUDGET_UNREACHABLE`. Each becomes one active Adjudication Request at the
managed CLI boundary and cannot create an attempt-2 Worker dispatch or public output. The current model and reasoning
configuration stays unchanged unless a controlled provider-timed comparison wins; concurrency never
exceeds the fresh slot observation.

The Evidence Index stores every locator, source revision, UTF-16 range, and digest without copying
complete rollout payloads. New Evidence Packs deterministically select Critical Anchors before
constructing the Preservation Ledger: the latest user goal, Accepted Proposal, deterministic terminal
components, explicit preserve markers, failed Tool Receipts, current Git observations, and only a
revision-matched fresh checkpoint are hard obligations; stale/unknown checkpoint entries remain
in the complete Evidence Index. Exact identifier obligations come only from selected entries and
must pass URL/path syntax plus opaque-token hygiene. `retrieve` verifies the source revision and
selected anchor digest; `verify-evidence` checks the index and every currently retrievable anchor.

After the complete Evidence Index and Critical-only Preservation Ledger are fixed, the Progress
Evidence projector independently scans user-visible assistant messages and successful non-input Tool
Receipts. Every successful receipt receives exactly one operation class. Only content inspections
become bounded inspection rows; existence probes, verification, mutation, and mechanical success stay
Cold and contribute only to stable classification coverage. Exact duplicate content scopes fold to
the latest output reference, while every earlier output remains retrievable in the Evidence Index.
The projection records separate input and dispatch character metrics and a digest-bound budget pair;
it does not enter existing MAP, REDUCE, or rendering routes.

`continuation-map-v2` is a separate immutable new-run route. Preparation validates the existing
Progress Evidence and adds exactly one bounded `progress_map` segment without adding its anchors to
the Critical Preservation Ledger. Only that segment may author Finding-to-Claim,
Deliverable-to-Finding, and Inspection-to-Finding/reread-policy relations; every content inspection
must be disposed exactly once. Completion derives global Finding IDs and immutable inspection
coordinates under a separate 16,000-character cap. Downstream keeps the existing Claim table and
Continuation Coverage, then adds `workingSynthesisInput` plus a typed contract for Working
Synthesis, Deliverable Status, Inspected Evidence Map, and Resume Policy. REDUCE preflight validates
those relations and requires review, research, or diagnosis work to carry a usable synthesize-first
draft with bounded reads. It then projects only the frozen objective, deliverable Findings, exact
constraints and next actions, and active decisions into Hot Context. Compact `E<n>` keys replace raw
Claim IDs and Evidence Anchors in that projection; the exact key map is integrity-covered by the
published Evidence Index. The isolated AH5 renderer emits execution-first Handoff v2 Markdown and a
consumer contract without changing the legacy renderer.

The Compression Frame validator routes frozen legacy shapes separately from Frame v2. Frame v2 permits
only the latest anchored byte-exact user goal, exact Accepted Proposal or null, mandatory deterministic
Terminal-State Claim, and source-ordered clause-level explicit exclusions. Exclusion extraction starts
at supported negative markers, keeps comma payload lists and path punctuation intact, and never rewrites
the complete goal; standalone exclusions retain their existing exact text. The Frame requires the
Critical Anchor Preservation Ledger and freezes a canonical digest in managed control state. New runs
project only segment-reachable obligations to Workers and bind MAP summaries
plus the REDUCE result to the full frame's exact `frameId` and `frameDigest`.

Legacy and sparse MAP validation accepts a summarized turn only when it reaches at least one unique claim backed by an
Evidence Anchor from that turn. Ignored turns carry no claims and require an exclusion reason. The
combined graph is integrity-covered in the Evidence Index as turn-to-claim and claim-to-anchor edges
without copying claim text. Sparse Workers author each Claim once, bind it to ordered evidence
positions, and exclude claim-free ranges; deterministic bookkeeping expands that structure into the
same full internal coverage and ledger shape. Opt-in continuation Workers author each Claim once
with positive Evidence Reference Dictionary indexes and typed relations. Completion produces a
private segment table; downstream validation merges those tables into one frame-bound global Claim
table, requires every Critical Anchor to be retained or explicitly excluded exactly once, and
derives canonical ignored turn coverage for unbound non-critical evidence. Continuation parent
coverage contains Claim-ID edges only, so Claim bodies are not copied into per-segment summaries.

Oversized turns are decomposed into independently bounded evidence units. Sparse and legacy paths
greedily pack adjacent fragments from the same parent turn under the requested evidence budget.
Continuation paths first discard non-critical units from MAP packaging, then pack selected units
under the effective total-input-derived evidence budget. User goals and final
assistant results keep exact message anchors; tool and patch values remain bounded receipts. Only an
oversized splittable message becomes UTF-16 range fragments, with exact-identifier and surrogate-pair
boundaries protected. Each packed fragment MAP validates every child independently. After all child
receipts validate, sparse/legacy workflows fold their coverage and unchanged claims into one
parent-turn summary. Continuation workflows instead derive only the parent turn-to-Claim edges from
completed child tables. In both routes, Claim IDs shared by multiple fragments appear once in
first-occurrence order, no Claim body is rewritten, and no aggregate Worker starts. `evidenceChars`
measures the evidence body, while `mapInputChars` additionally charges the Frame Projection.

REDUCE keeps decisions, rationale, attempts, failure lessons, and four-state verification results in
one chronological Archival Ledger. Sparse and legacy inputs retain their complete internal shape.
Continuation input omits the complete Preservation Ledger, complete Semantic Coverage, and full
frame preservation policy; it carries the compact frame view, one Claim table, edge-only segment
summaries, current workspace evidence, exact-identifier obligations, and Critical Anchor
disposition. A 300,000-character gate applies before the input becomes visible to REDUCE.

Continuation important locations and Preservation Coverage are projected deterministically from
the Claim table and frozen category set. `validate-reduce --check` requires the candidate to match
those projections; Frame v2 additionally requires exact Accepted Proposal and Terminal state
projections. It derives final Source Thread provenance from retained claim and frozen-frame
anchors, and freezes the exact serialized digest. Publication refuses an unchecked or mutated
candidate. Caught `prepare-reduce`, `validate-reduce`, and `publish` errors retain a bounded
`failure-report.json` projection with diagnostics, phase timings, Worker metrics, request identity,
and the managed workdir; event replay, not that projection, owns lifecycle state.

The post-worker provider-observation ingress is a host/coordinator boundary, not a MAP Worker
validation mode. New work directories carry a `provider-observation-v1` manifest binding. After the
coordinator accepts a MapReceipt, `recordMapGenerationMetric` validates one bounded provider document,
correlates it with the immutable MapDispatch and same-wave execution configuration, and adds a
receipt-bound SHA-256 metric state to the manifest. It reads no chunk, raw/normalized/completed MAP
candidate, Frame Projection, or Evidence Reference Dictionary; identical replay returns the same
digest without rewriting state, while correlation, receipt, or replay conflicts fail closed.

Multi-wave live acceptance is an execution-surface property, not a repository-only simulation. A
surface counts as supported only when its Worker result contains a durable provider-reported duration
that the host can bind to the immutable MapDispatch before later-wave admission. Package-tree equality,
single-wave compatibility, or coordinator elapsed time cannot satisfy that boundary. The current
surface observation and exact unblock condition are recorded in
[Provider Timing Live Acceptance](./provider-timing-live-acceptance.md); an unsupported surface exits
before semantic MAP work and leaves publication unopened.

The v2 publisher validates the Handoff budget, Evidence Index budget, coverage graph, frozen frame,
source-revision binding, and live Source Thread revision before either output is visible. Sparse,
missing-mode, and `continuation-map-v1` routes retain the legacy renderer. `continuation-map-v2`
instead renders only gate-validated Hot Context, persists exact `E<n>` resolution in the Evidence
Index, and returns the Resume Policy as a structured consumer contract. Both public files are created
exclusively; if the second create fails, rollback removes only a first file whose filesystem identity
still matches that publication attempt. Cleanup runs after the pair is durable; cleanup failure
retains the pair and managed work directory for diagnosis.

## Data flow

```text
Source Thread UUID
  -> rollout JSONL + deterministic workspace observations
  -> complete Evidence Anchors + event boundaries + Tool/Patch Receipts
  -> Critical Anchor selection + exact-identifier hygiene -> Preservation Ledger
       -> checkpoint revision == Git HEAD: current; otherwise historical-only
  -> Source terminal + compression-time workspace observation -> one terminal_state Claim
  -> managed Evidence Pack + compact Evidence Index
  -> user-visible assistant messages + successful Tool Receipts
       -> deterministic operation classification
       -> latest output per exact content scope
       -> bounded Progress Evidence + coverage/budget digests
       -> non-content operations remain Cold Evidence
  -> [continuation-map-v2] validated Progress Evidence -> one private progress_map dispatch
       -> evidence-backed Findings -> requested Deliverable status
       -> every content inspection -> Finding edges + reread policy
       -> 4k candidate gate -> deterministic global IDs/coordinates -> 16k completed gate
  -> [continuation MAP plan] select Critical-Anchor source units + Critical workspace observations
       -> preserve complete Evidence Index + complete Source Thread turn-ID inventory
       -> derive effective evidence cap from total-input and projection budgets
  -> frame-input.json
  -> active-task Frame v2 (byte-exact goal + clause exclusions + proposal? + terminal)
       -> frame.json -> validate + freeze digest
       -> pre-dispatch lower bound (prepare/frame + REDUCE/publication reserves)
            -> invalid boundary: stable diagnostic + retained captured-diagnostic projection
            -> >600000ms: LIVE_BUDGET_UNREACHABLE + zero MapDispatches/claims
            -> <=600000ms: continue unchanged
  -> bounded complete-turn or packed-fragment segment
  -> deterministic segment-local Evidence Reference Dictionary
       -> local evidence indexes + local exact-identifier indexes -> immutable dictionary digest
  -> compact Frame Projection bound to dictionary + global frame digest
  -> dictionary/projection/input/output-bound MapDispatch
       -> observe fresh dedicated slots
            -> zero slots: MAP_WORKER_UNAVAILABLE + zero admitted dispatches
            -> all pending dispatches fit: admit one structural wave without timing capability
            -> later wave required: validate exact ProviderTimingCapability
                 -> unavailable: PROVIDER_TIMING_UNAVAILABLE + zero admitted dispatches
                 -> available provider/post_worker surface: admit first wave within fresh capacity
  -> isolated worker atomic claim
  -> worker reads private chunk -> writes mode-specific private MAP candidate
  -> non-consuming structure/output check -> immutable candidate digest
       -> [continuation v2] collect MAP-owned candidate issues before receipt acceptance
            -> non-Critical exclusions + low-value/misclassified Findings
            -> missing Progress MAP action-ready author, including empty Progress Evidence
            -> evidence-free MAP_REPAIR_REQUIRED { repairScope, segmentId, issues[] }
                 -> --check: repair only the same private candidate and reuse the dispatch
                 -> --complete: retain the failed receipt/candidate and create only segment attempt-2
                 -> preserve every unrelated dispatch, accepted receipt, and provider observation
  -> [sparse] deterministic expansion -> digest-bound normalized full-MAP summary
  -> [continuation] local-reference resolution -> digest-bound compact Claim table
  -> bounded MapReceipt with raw + normalized/completed digests and sizes -> coordinator accepts
  -> accepted MapReceipt metadata + immutable MapDispatch identity
  -> record-map-metric <WORK_DIR> <SEGMENT_ID> <DISPATCH_ID> <OBSERVATION_FILE>
       -> exact bounded provider-only MapGenerationObservation validation
       -> dispatch/segment + model/reasoning/wave/fresh-slot correlation
       -> receipt-bound SHA-256 metric digest -> additive manifest integrity state
       -> identical replay: stable; conflict/mismatch: fail closed without receipt mutation
  -> workflow-owned check/complete/accept observation remains separate from provider latency
  -> schedule-map <WORK_DIR> <AVAILABLE_SLOTS>
       -> accepted receipt + metric digest integrity validation
       -> unique correlated observations + contiguous complete wave groups
       -> missing/duplicate/broken sample: INCOMPLETE_FIRST_WAVE_METRICS
       -> fresh slots == 0: MAP_WORKER_UNAVAILABLE
       -> first-wave conservative projection with fixed REDUCE/publication reserves
            -> <=600000ms: dispatch next wave within freshly observed slots
            -> >600000ms: LIVE_BUDGET_UNREACHABLE
       -> every failure: active Adjudication Request + retained projection; no retry/publication
  -> [sparse/legacy fragment path] all child receipts validate -> deterministic parent summary
  -> [continuation] completed tables -> one global Claim table + Critical Anchor disposition
       -> deterministic Accepted Proposal/Terminal-State Claims inserted once
       -> edge-only parent coverage + canonical non-critical ignored turn coverage
  -> [continuation v2] completed progress table -> Working Synthesis input
       -> global Finding-to-Claim bindings
       -> exact Deliverable Status and Inspected Evidence Map projections
       -> typed Working Synthesis and Resume Policy output contract
  -> [sparse/legacy] summaries + coverage + workspace + frozen frame + Preservation Ledger
  -> [continuation] compact frame + one Claim table + edge summaries + critical obligations
       -> body-free deterministic projection and authority-ID policy -> <=300k reduce-input.json
       -> each continuation Claim body appears once
  -> active-task REDUCE -> reduced.json
  -> validate-reduce --check
       -> validate unique claims + typed Archival Ledger
       -> reconstruct important locations + category coverage
       -> require exact proposal/terminal projections
       -> derive final provenance + bind exact candidate digest
       -> [continuation v2] validate Working Synthesis/Deliverable/Inspection/Resume relations
       -> [continuation v2] require usable synthesize-first task state
       -> [continuation v2] project typed-root Hot Context + stable Evidence Key map
       -> [continuation v2] reject low-value/raw-audit context before digest binding
  -> [continuation v2] attach exact Evidence Key map to the complete Evidence Index
  -> [continuation v2] isolated Handoff v2 renderer
       -> objective/first deliverable -> multiline synthesis -> status/findings/inspections
       -> Resume Policy -> actions/constraints -> compact audit footer
       -> synthesize-first consumer contract with zero pre-draft evidence reads
  -> validate live source revision + Handoff/Evidence Index/MAP-output budgets
  -> exclusive transactional publish of the preflight-bound candidate
       -> Handoff Markdown
            -> [legacy renderer] Accepted proposal + Terminal state sections
            -> [continuation v2] execution-first Hot Context only
       -> Evidence Index JSON + compact Semantic Coverage graph
            -> [continuation v2] exact Handoff Evidence Key map
  -> fixed four-phase performanceMetrics + compatibility phaseTimingsMs
  -> remove managed temporary copies; retain both published artifacts
```

The Compression Task is disposable. The Source Thread remains unchanged, and a different fresh task
consumes the published Handoff. Evidence retrieval reads the exact indexed Source Thread payload or
re-runs an indexed workspace observation and fails closed if its source revision has changed.

## Decision index

- **Evidence Pack boundary**: [Conversation plus workspace evidence](./adr/0001-conversation-plus-workspace-evidence.md)
- **Superseded nested isolation**: [Isolated hierarchical compression](./adr/0002-isolated-hierarchical-compression.md)
- **Compression execution boundary**: [Dedicated Compression Task](./adr/0003-dedicated-compression-task.md)
- **Implemented lossless source lookup**: [Lossless Evidence Addressing](./adr/0005-lossless-evidence-addressing.md)
- **Implemented shared semantic focus**: [Task-aware Compression Frame](./adr/0004-task-aware-compression-frame.md)
- **Implemented claim accountability**: [Semantic Coverage and Archival Ledger](./adr/0006-semantic-coverage-and-archival-ledger.md)
- **Implemented bounded hierarchical segmentation and MAP isolation**: [Bounded Hierarchical MAP Isolation](./adr/0007-bounded-hierarchical-map-isolation.md)
- **Implemented performance-bounded MAP inputs**: [Bounded MAP Input Projection](./adr/0008-bounded-map-input-projection.md)
- **Implemented sparse MAP bookkeeping**: [Sparse MAP Deterministic Bookkeeping](./adr/0009-sparse-map-deterministic-bookkeeping.md)
- **Implemented coordinator-isolated sparse expansion**: [Worker-bound Sparse MAP Expansion](./adr/0010-worker-bound-sparse-map-expansion.md)
- **Implemented retrieval/critical-coverage separation**: [Continuation-Grade Evidence Compression](./adr/0011-continuation-grade-evidence-compression.md)
- **Action-ready Hot/Cold boundary and staged v2 route**: [Action-Ready Handoff Hot/Cold Boundary](./adr/0013-action-ready-handoff-hot-cold-boundary.md)
- **Provider-observation admission and persistence boundary**: [Provider Timing Capability for Multi-Wave MAP](./adr/0014-provider-timing-capability-for-multi-wave-map.md)
- **Implemented earliest-owner targeted MAP repair (TR1-TR4)**: [Earliest-Owner Targeted MAP Repair](./adr/0015-earliest-owner-targeted-map-repair.md)
- **Implemented empty-Progress earliest-owner repair (TR5)**: [Targeted MAP repair slices](./slice-plan-targeted-map-repair.md#slice-tr5--empty-progress-map-ownership)
- **Implemented Main Codex durable contract, all-stage capture, decision application, degraded publication, and operator loop (MA1-MA5)**: [Main Codex Adjudication Loop](./adr/0016-main-codex-adjudication-loop.md)

- **Implemented version routing and transactional publication**: [Evidence-preserving compression slice plan](./slice-plan-evidence-preserving-compression.md#slice-6-transactional-publication-compatibility-and-end-to-end-evaluation)
