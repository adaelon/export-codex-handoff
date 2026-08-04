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
            -> Compression Frame input builder/validator
                 -> frozen frameId + canonical frameDigest
                 -> v2 currentGoal + Accepted Proposal? + Terminal-State Claim
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
                 -> deterministic Accepted Proposal/Terminal-State insertion exactly once
                 -> critical-only Continuation Coverage + claim-to-turn Semantic Coverage
            -> mode-routed REDUCE input builder
                 -> [continuation] compact frame + one Claim table + edge summaries
                 -> critical obligations + body-free deterministic projection policy
                 -> body-free continuation-authority Claim IDs
                 -> 300k serialized-input gate
            -> active Codex task performs REDUCE
            -> non-consuming continuation REDUCE preflight
                 -> deterministic important locations + Preservation Coverage
                 -> claim-derived final provenance + exact candidate digest binding
            -> transactional Handoff and Evidence Index publisher
                 -> dedicated Accepted proposal and Terminal state sections
                 -> persisted failure report on terminal prepare/check/publish errors
                 -> fixed MAP generation/check-accept/REDUCE/publication metrics
```

The active Codex task supplies semantic compression. Scripts own evidence discovery, bounded previews,
exact source addressing, structural validation, no-overwrite publication, and managed temporary cleanup.
No script starts another Codex process.

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
dedicated worker slots before each dispatch wave, gives one frame-bound MapDispatch to each isolated
worker, and stops with `needs-user` when no slot exists. Workers atomically claim dispatch identity,
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
publication time; harness elapsed time cannot enter a provider field. Before later waves, the
coordinator combines complete first-wave samples with a freshly observed slot count and conservative
REDUCE/publication reserves. A projection above 600,000 ms returns
`LIVE_BUDGET_UNREACHABLE` with no dispatches. The current model and reasoning configuration stays
unchanged unless a controlled provider-timed comparison wins; concurrency never exceeds the fresh
slot observation.

The Evidence Index stores every locator, source revision, UTF-16 range, and digest without copying
complete rollout payloads. New Evidence Packs deterministically select Critical Anchors before
constructing the Preservation Ledger: the latest user goal, Accepted Proposal, deterministic terminal
components, explicit preserve markers, failed Tool Receipts, current Git observations, and only a
revision-matched fresh checkpoint are hard obligations; stale/unknown checkpoint entries remain
in the complete Evidence Index. Exact identifier obligations come only from selected entries and
must pass URL/path syntax plus opaque-token hygiene. `retrieve` verifies the source revision and
selected anchor digest; `verify-evidence` checks the index and every currently retrievable anchor.

The Compression Frame validator routes frozen legacy shapes separately from Frame v2. Frame v2 permits
only the latest anchored user goal, exact Accepted Proposal or null, mandatory deterministic
Terminal-State Claim, and extractive explicit exclusions; it requires the Critical Anchor Preservation
Ledger and freezes a canonical digest in managed control state. New runs project only segment-reachable obligations to Workers and bind MAP summaries
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
candidate. Terminal `prepare-reduce`, `validate-reduce`, and `publish` errors retain a bounded
`failure-report.json` with diagnostics, phase timings, Worker metrics, and the managed workdir.

The v2 publisher renders both candidates and validates the Handoff budget, Evidence Index budget,
coverage graph, frozen frame, source-revision binding, and live Source Thread revision before either
output is visible. It creates both files exclusively. If the second create fails, it removes only a
first file whose filesystem identity still matches that publication attempt. Cleanup runs after the
pair is durable; cleanup failure retains the pair and the managed work directory for diagnosis.

## Data flow

```text
Source Thread UUID
  -> rollout JSONL + deterministic workspace observations
  -> complete Evidence Anchors + event boundaries + Tool/Patch Receipts
  -> Critical Anchor selection + exact-identifier hygiene -> Preservation Ledger
       -> checkpoint revision == Git HEAD: current; otherwise historical-only
  -> Source terminal + compression-time workspace observation -> one terminal_state Claim
  -> managed Evidence Pack + compact Evidence Index
  -> [continuation MAP plan] select Critical-Anchor source units + Critical workspace observations
       -> preserve complete Evidence Index + complete Source Thread turn-ID inventory
       -> derive effective evidence cap from total-input and projection budgets
  -> frame-input.json
  -> active-task Frame v2 (goal + proposal? + terminal) -> frame.json -> validate + freeze digest
  -> bounded complete-turn or packed-fragment segment
  -> deterministic segment-local Evidence Reference Dictionary
       -> local evidence indexes + local exact-identifier indexes -> immutable dictionary digest
  -> compact Frame Projection bound to dictionary + global frame digest
  -> dictionary/projection/input/output-bound MapDispatch -> isolated worker atomic claim
  -> worker reads private chunk -> writes mode-specific private MAP candidate
  -> non-consuming structure/output check -> immutable candidate digest
  -> [sparse] deterministic expansion -> digest-bound normalized full-MAP summary
  -> [continuation] local-reference resolution -> digest-bound compact Claim table
  -> bounded MapReceipt with raw + normalized/completed digests and sizes -> coordinator
  -> provider MAP-generation observation + workflow check/complete/accept observation
  -> first-wave conservative projection
       -> <=600000ms: dispatch next wave within freshly observed slots
       -> >600000ms: fail fast with LIVE_BUDGET_UNREACHABLE
  -> [sparse/legacy fragment path] all child receipts validate -> deterministic parent summary
  -> [continuation] completed tables -> one global Claim table + Critical Anchor disposition
       -> deterministic Accepted Proposal/Terminal-State Claims inserted once
       -> edge-only parent coverage + canonical non-critical ignored turn coverage
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
  -> validate live source revision + Handoff/Evidence Index/MAP-output budgets
  -> exclusive transactional publish of the preflight-bound candidate
       -> Handoff Markdown
            -> Accepted proposal + Terminal state sections
       -> Evidence Index JSON + compact Semantic Coverage graph
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

- **Implemented version routing and transactional publication**: [Evidence-preserving compression slice plan](./slice-plan-evidence-preserving-compression.md#slice-6-transactional-publication-compatibility-and-end-to-end-evaluation)
