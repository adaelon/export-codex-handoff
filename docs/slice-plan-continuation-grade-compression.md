# Continuation-Grade Compression Initiative

Status: R7 packaging fix verified; fresh live rerun pending  
Scope: meet the ten-minute live acceptance target by removing exhaustive semantic bookkeeping from model context while retaining exact retrieval and strong coverage of continuation-critical state.

## 1. Frozen intent

New Compression Runs use `continuation-map-v1` and separate two guarantees:

- the Evidence Index retains every indexed source and workspace anchor for exact retrieval;
- Continuation Coverage requires Claims or explicit critical exclusions only for Critical Anchors;
- MAP Workers author semantic Claims once and cite segment-local evidence indexes;
- deterministic code creates global Claim IDs, copies exact anchors, derives bindings and coverage, and supplies canonical reasons for unbound non-critical evidence;
- exact identifiers become critical obligations only when selected by deterministic policy or reached by a retained Claim;
- REDUCE consumes one compact Claim table plus typed relations, not expanded summaries or the complete Preservation Ledger;
- Preservation Coverage, important-location projection, final provenance, and publication diagnostics are deterministic outputs;
- `validate-reduce --check` must pass before the first publication attempt;
- existing v1, pre-performance v2, and `sparse-map-v1` work directories remain on their frozen contracts.

This initiative does not weaken source-revision checks, Evidence Index integrity, Source Thread isolation, no-overwrite publication, or the two-attempt MAP circuit breaker. It does not repair or republish the retained failed live run.

## 2. Measured live baseline

The retained S5 run at `C:\Users\Lenovo\AppData\Local\Temp\codex-handoff-task-3tYnXG` established:

- 7,368,652 Source Thread characters and 2,030,898 Evidence Pack characters;
- a 916,115-byte frozen Frame with 376 `requiredAnchors`, 2,793 `exactIdentifiers`, and zero `criticalCategories`;
- 10 initial MAP Workers, all validated and accepted on attempt 1 with no contract-shape retry;
- 1,487,513 evidence-input characters plus 1,291,712 Frame-Projection characters, totaling 2,779,225 MAP-input characters;
- 95,571 raw MAP-output characters within the 102,000 aggregate budget and 180,820 deterministic normalized characters;
- 2,098,212 REDUCE-input bytes and a 27,575-byte REDUCE candidate;
- comparable phase boundaries of 115,345 ms for prepare-and-frame and 1,749,646 ms for MAP through `prepare-reduce`;
- 266,819 ms to write the REDUCE candidate and a 2,131,810 ms prepublication lower bound;
- publication failed before either public artifact appeared because the frozen category set was empty while REDUCE emitted six `preservationCoverage` entries.

Sparse output removed the prior retry failures, but it did not reduce large evidence inputs, repeated Frame obligations, expanded normalized structures, or REDUCE input. Concurrency alone cannot close the gap: the measured maximum Worker claim-to-check interval was 518,059 ms before adding prepare-and-frame or REDUCE.

## 3. Target architecture

```text
Source Thread + workspace
  -> complete Evidence Index (all retrievable anchors)
  -> deterministic continuation selector
       -> compact Evidence Pack
       -> Critical Anchors
       -> identifier hygiene filter
  -> frozen Compression Frame
       -> segment-local Evidence Reference Dictionary
  -> isolated continuation-map-v1 Worker
       -> Claims + local evidence indexes + typed relations
  -> Worker-owned deterministic completion
       -> global Claim IDs + exact anchors + compact Claim table
  -> deterministic Continuation Coverage
       -> critical evidence: retained or explicitly excluded
       -> other unbound evidence: canonical policy exclusion
  -> compact REDUCE input
       -> one Claim table + relations + current workspace + outstanding obligations
  -> REDUCE candidate
  -> validate-reduce --check
  -> deterministic Preservation Coverage + provenance + transactional publication
```

### 3.1 Continuation MAP contract

```text
ContinuationMapResult {
  formatVersion: 1
  kind: codex-handoff-continuation-map
  frameId: string
  frameDigest: sha256
  segmentId: string
  claims: Array<{
    localId: positive integer
    kind: objective | constraint | completed_work | open_work | next_action |
          important_location | conflict | decision | rationale | attempt_goal |
          attempt_action | attempt_outcome | lesson | verification
    text: string
    evidenceIndexes: integer[]
  }>
  relations: {
    decisions: Array<{ statement: integer, rationale: integer[], status, supersedes: integer[] }>
    attempts: Array<{ goal: integer, action: integer, outcome: integer, lesson?: integer, failureClass?: string }>
    verification: Array<{ claim: integer, command: string, result: pass | fail | not_run | unknown }>
  }
  criticalExclusions: Array<{
    evidenceIndex: integer
    reasonCode: superseded | duplicate | out_of_scope | no_continuation_value
  }>
}
```

Workers do not emit global Claim IDs, Evidence Anchor strings, `claimGroups`, separate `claimBindings`, full `exclusionRanges`, or `compressionNotes`. Completion resolves local evidence indexes while the Worker still owns the private chunk, copies immutable anchors, generates stable global IDs, validates typed relations, and persists one compact digest-bound Claim table.

### 3.2 Continuation Coverage

```text
for each critical evidence index:
  require at least one retained Claim reference
  or exactly one criticalExclusion with a concrete reasonCode

for each non-critical evidence index without a Claim:
  derive ignored coverage with canonical reason "not selected by continuation policy"

for each retained Claim:
  derive exact anchors from its evidence indexes
  require at least one source or workspace anchor
```

The published Evidence Index keeps the existing complete retrievability boundary. The public Semantic Coverage graph remains schema-compatible: Node derives summarized turns from retained Claim edges and ignored turns from the continuation policy instead of asking a Worker to narrate every omission.

### 3.3 Deterministic size and time gates

New-run targets, measured on the retained Source Thread planning fixture and then confirmed live:

- complete Evidence Index remains within its independent configured budget;
- compact Evidence Pack target: at most 800,000 characters;
- each Frame Projection target: at most 20,000 characters;
- each evidence-plus-projection MAP input: at most 100,000 characters;
- each raw Continuation MAP candidate: at most 4,000 characters;
- aggregate raw MAP output: at most the REDUCE target, not three times that target;
- REDUCE input target: at most 300,000 characters;
- initial MAP target: no more than six dispatches for the retained planning sample;
- first-wave projection aborts before later waves when the conservative total estimate exceeds 600,000 ms;
- fresh live publication plus `verify-evidence` completes with `phaseTimingsMs.total <= 600000`.

Size projections are development gates, not substitutes for live acceptance.

## 4. Slice order

### Slice R0: Failure fixtures and accepted terminology

**Input**: ADR-0011, the retained run's bounded manifest/receipts, existing synthetic MAP fixtures, and the new glossary terms.

**Produces**: synthetic fixtures for all-anchors-required growth, high-entropy path false positives, empty critical categories with six REDUCE defaults, repeated Claim bookkeeping, and a documented metric comparator for the retained baseline.

**Does not do**: read retained private MAP candidates, copy Source Thread evidence into the repository, or change runtime behavior.

**Done when**: fixtures reproduce the size and publication failure classes, local Markdown links resolve, and the pre-R1 runtime suite remains green.

**Implementation evidence**: [continuation-grade-fixtures.mjs](../skills/export-codex-handoff/tests/fixtures/continuation-grade-fixtures.mjs) uses only generated anchors, identifiers, Claims, and workspace/source metadata. It reproduces the retained 376-required-anchor / 2,793-exact-identifier growth class in a 963,948-byte synthetic Frame, the path regex false positive from an opaque high-entropy token, the zero-category / six-default `preservationCoverage` mismatch, and repeated Claim-ID/anchor bookkeeping in the current REDUCE input shape. [continuation-grade-r0.test.mjs](../skills/export-codex-handoff/tests/continuation-grade-r0.test.mjs) locks those four classes without changing runtime behavior.

The recorded retained workdir was no longer present when R0 began. R0 therefore copies only the aggregate measurements already frozen in section 2 into its fixture comparator; it does not reconstruct missing receipts, inspect private MAP candidates, or claim a fresh retained-run measurement.

#### R0 retained-baseline metric comparator

`compareRetainedMetrics(candidate)` reports the candidate value, delta and ratio against the retained baseline, and target status. A delta or target result is emitted only when units are identical; missing values remain `null`, and the recorded byte-sized REDUCE input is never silently compared with a future character-sized gate.

| Metric | Retained baseline | Candidate field | Acceptance target | Comparator rule |
| --- | ---: | --- | ---: | --- |
| Evidence Pack | 2,030,898 chars | `evidencePackChars` | <= 800,000 chars | Direct comparison |
| frozen Frame | 916,115 bytes | `frameBytes` | none | Baseline delta only |
| initial MAP dispatches | 10 | `initialMapDispatches` | <= 6 | Direct comparison |
| aggregate MAP input | 2,779,225 chars | `aggregateMapInputChars` | none | Baseline delta only |
| raw MAP output | 95,571 chars | `rawMapOutputChars` | configured REDUCE target | Target supplied by the measured run, not hard-coded by R0 |
| normalized MAP output | 180,820 chars | `normalizedMapOutputChars` | none | Baseline delta only |
| REDUCE input | 2,098,212 bytes | `reduceInputChars` | <= 300,000 chars | Baseline delta is `null`; character target remains directly checkable |
| elapsed time | 2,131,810 ms prepublication lower bound | `phaseTimingsTotalMs` | <= 600,000 ms end to end | Candidate total is compared to the conservative retained lower bound |

Per-dispatch projection and MAP-input targets remain outside the retained-baseline delta table because section 2 records only aggregate projection/input sizes. Future runs must report `maxFrameProjectionChars` and `maxMapInputChars` directly rather than deriving maxima from aggregates.

**Acceptance evidence**: the focused R0 suite passes 5/5 and the complete repository suite passes 90/90, including the existing local Markdown-link check. The pre-R1 executable baseline passed 85/85 before the slice and no runtime file under `scripts/lib` changed.

### Slice R1: Critical-anchor selection and identifier hygiene

**Input**: R0 fixtures and the complete Evidence Index boundary.

**Produces**: a deterministic Critical Anchor selector; `requiredAnchors` limited to the latest goal, explicit exclusions, current workspace checkpoint/Git observations, explicit user-preserve markers, and other policy-approved hard obligations; identifier validation that rejects base64/high-entropy blobs and syntactically invalid paths or URLs.

**Does not do**: remove any Evidence Index entry, alter MAP output, or change REDUCE.

**Done when**: every indexed anchor remains retrievable, Critical Anchors are a strict justified subset on the retained planning fixture, synthetic binary/path false positives disappear, and required anchors plus exact identifiers have deterministic counts and digests.

**Implementation evidence**: [evidence-addressing.mjs](../skills/export-codex-handoff/scripts/lib/evidence-addressing.mjs) adds `selectCriticalAnchors`, `buildContinuationPreservationLedger`, and `preservationLedgerMetrics`. New Evidence Packs select the latest user goal (including extractive exclusions on the same anchors), explicit preserve-marker messages, failed Tool Receipts, current checkpoint/Git observations, and caller-approved hard obligations in original evidence order. Exact identifiers are projected only from those selected entries; the legacy `buildPreservationLedger` path remains unchanged for frozen fixtures and existing work-directory contracts. URL and path candidates now pass syntax checks and reject base64-like or long opaque segments before entering any new entry.

[evidence-pack.mjs](../skills/export-codex-handoff/scripts/lib/evidence-pack.mjs) applies the continuation selector before building the Evidence Index. The index still receives every evidence entry, so non-critical anchors remain retrievable even though they no longer expand the Frame preservation policy. [continuation-grade-r1.test.mjs](../skills/export-codex-handoff/tests/continuation-grade-r1.test.mjs) locks the strict subset, complete-index boundary, high-entropy and invalid-syntax rejection, selected-identifier projection, stable ordering, counts, and SHA-256 digests.

**Acceptance evidence**: the R0 gate remains 5/5 using its frozen pre-R1 false-positive comparator; R1 passes 4/4; selector/identifier/Evidence Pack focused regression passes 20/20; and the complete repository suite passes 94/94. No MAP result, Frame Projection, REDUCE, Evidence Index schema, or installed Skill package changed.

### Slice R2: Evidence Reference Dictionary and bounded Frame Projection

**Input**: R1 Critical Anchors and exact-identifier obligations.

**Produces**: a segment-local Evidence Reference Dictionary, compact integer references in Frame Projection, separate projection and total-input budgets, and immutable dictionary digests in MapDispatch identity.

**Does not do**: change Worker semantic responsibility or migrate an existing work directory.

**Done when**: mutation or cross-dispatch reference reuse fails closed, Workers can resolve every authorized local reference, every projection is at most 20,000 characters, and every retained-sample MAP input is at most 100,000 characters.

**Implementation evidence**: [frame-projection.mjs](../skills/export-codex-handoff/scripts/lib/frame-projection.mjs) now builds an immutable per-segment Evidence Reference Dictionary with consecutive local evidence and exact-identifier indexes. The v2 Frame Projection replaces reachable anchor and identifier strings with those integer indexes while retaining the global `frameId` and `frameDigest`; deterministic validation rebuilds both artifacts from the frozen frame and private chunk, and `resolveEvidenceReferences` fails on unknown or duplicate local indexes.

[map-worker.mjs](../skills/export-codex-handoff/scripts/lib/map-worker.mjs) binds `dictionaryPath` and `dictionaryDigest` into new MapDispatch identities. [task-workflow-core.mjs](../skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs) routes new work directories through immutable `reference-frame-projection-v1`, persists dictionary and projection files separately, caps the projection at 20,000 characters, and charges evidence plus dictionary plus projection against a 100,000-character total-input budget. Frozen `frame-projection-v1` and embedded-frame work directories retain their original paths and are not migrated.

**Acceptance evidence**: [continuation-grade-r2.test.mjs](../skills/export-codex-handoff/tests/continuation-grade-r2.test.mjs) passes 4/4 for dictionary mutation, cross-dispatch reuse, local-reference resolution, and the independent 20,000 / 100,000-character gates. R0–R2 pass 13/13 and the complete repository suite passes 98/98. The installed Skill package remains intentionally unsynchronized until R7.

### Slice R3: Continuation MAP contract and compact completion

**Input**: R2 dispatch dictionaries and the `ContinuationMapResult` contract.

**Produces**: immutable `mapResultMode: continuation-map-v1`; MAP-only contract documentation; local numeric Claim references; Node-generated global Claim IDs, anchors, and bindings; compact dual-digest receipts; and a non-consuming `validate-map --check` route for the new mode.

**Does not do**: change `sparse-map-v1`, legacy full MAP, REDUCE, or the two-attempt circuit breaker.

**Done when**: a diagnostic-equivalent fixture emits each Claim once without anchor strings or separate bindings, invalid local evidence references fail deterministically, exact anchors are derived byte-for-byte, and raw candidates stay within 4,000 characters.

**Implementation evidence**: [continuation-map-worker-contract.md](../skills/export-codex-handoff/references/continuation-map-worker-contract.md) defines the MAP-only `ContinuationMapResult` with positive dictionary-local evidence references, local numeric Claim IDs, typed relations, critical exclusions, and a strict prohibition on global IDs, Anchor strings, separate bindings, coverage ranges, or REDUCE fields.

[validation.mjs](../skills/export-codex-handoff/scripts/lib/validation.mjs) adds strict candidate validation and deterministic completion. Completion resolves every local evidence reference through the immutable R2 dictionary, generates stable global Claim IDs from kind, text, and exact anchors, converts relations to global IDs, and persists one compact Claim table with integrated evidence indexes and anchors. [map-worker.mjs](../skills/export-codex-handoff/scripts/lib/map-worker.mjs) adds the opt-in immutable `continuation-map-v1` dispatch mode, requires a per-dispatch output binding no greater than 4,000 characters, and validates raw-plus-completed dual-digest receipts without changing sparse receipts.

[task-workflow-core.mjs](../skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs) binds the opt-in mode into workflow state, keeps total raw allocation within one REDUCE target, runs the existing non-consuming check against the continuation contract, rejects post-check mutation, writes the private completed table, and returns its compact receipt. `sparse-map-v1`, missing-mode full MAP, REDUCE, and the two-attempt circuit breaker retain their existing routes; downstream continuation coverage and Claim-table consumption are implemented by R4.

**Acceptance evidence**: [continuation-grade-r3.test.mjs](../skills/export-codex-handoff/tests/continuation-grade-r3.test.mjs) passes 4/4 for diagnostic-equivalent single-authorship, invalid references, byte-exact anchor/global-relation derivation, and CLI `validate-map --check` plus 4,000-character completion. R0–R3 pass 17/17, directly affected compatibility tests pass 43/43, and the complete repository suite passes 102/102. Tests used an E-drive temporary root because the host C drive had zero free bytes; this changes no product path or contract.

### Slice R4: Continuation Coverage and normalized-free downstream

**Input**: accepted compact Claim tables from R3.

**Produces**: critical-only explicit coverage validation, canonical non-critical ignored coverage, edge-only deterministic parent coverage, a single global Claim table, and downstream readers that no longer require expanded full-MAP normalized summaries.

**Does not do**: weaken Critical Anchor coverage, reopen chunks in the coordinator, or change the published Evidence Index retrieval contract.

**Done when**: an unrepresented Critical Anchor fails; unbound non-critical evidence is ignored mechanically; shared Claims survive fragment-to-parent folding once; raw chunks can be removed after completion; and the retained planning REDUCE input contains each Claim body exactly once.

**Implementation evidence**: [validation.mjs](../skills/export-codex-handoff/scripts/lib/validation.mjs) adds `buildContinuationDownstream`, which validates one retained-or-excluded disposition for every Critical Anchor, rejects non-critical explicit exclusions and overlap, folds accepted completed tables into one frame-bound global Claim table, and derives the schema-compatible turn graph. Unbound non-critical turns use the canonical reason `not selected by continuation policy`; the public coverage graph retains only Claim IDs and anchors.

`buildContinuationParentCoverage` derives parent Claim-ID edges directly from completed child tables and deduplicates shared Claims in first-occurrence order without copying bodies. [task-workflow-core.mjs](../skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs) routes only `continuation-map-v1` through completed-output metrics, edge-only `segmentSummaries`, the global `claimTable`, and `continuationCoverage`. Its continuation REDUCE and publication readers verify accepted completed digests without reopening `chunkPath`; sparse, legacy v1, missing-mode v2, and aggregate-Worker compatibility paths retain their prior shapes and failure priority.

**Acceptance evidence**: [continuation-grade-r4.test.mjs](../skills/export-codex-handoff/tests/continuation-grade-r4.test.mjs) passes 5/5 for missing Critical Anchors, canonical non-critical ignore, shared parent Claim folding, post-completion raw-chunk removal, and Claim-body-once REDUCE serialization. R0–R4 pass 22/22, the directly affected sparse/legacy/downstream compatibility set passes 55/55, and the complete repository suite passes 107/107. Tests use an E-drive temporary root because the host C drive remains full; product paths and contracts do not depend on it.

### Slice R5: Compact REDUCE and prepublication validation

**Input**: R4 Claim table, frozen Frame, current workspace evidence, and outstanding critical obligations.

**Produces**: REDUCE input without the complete Preservation Ledger; deterministic important-location projection, Preservation Coverage, and final provenance; `validate-reduce --check`; and a persisted failure report containing diagnostics, phase timings, Worker metrics, and workdir on every terminal failure.

**Does not do**: relax publication gates, permit post-publication repair, or republish the retained failed run.

**Done when**: the empty-category/six-default fixture fails at `validate-reduce --check` before publication; a corrected candidate passes without changing semantics; REDUCE input is at most 300,000 characters; and publication consumes only a preflight-bound candidate digest.

**Implementation evidence**: [task-workflow-core.mjs](../skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs) now routes continuation preparation through a compact frame view, the single R4 Claim table, edge-only segment summaries, current workspace evidence, and critical obligations. The continuation input omits the complete Preservation Ledger, complete Semantic Coverage, and full frame preservation policy; it preserves exact identifiers under `criticalObligations`, carries only a body-free deterministic projection policy, and fails with `REDUCE_INPUT_TOO_LARGE` above 300,000 serialized characters.

[validation.mjs](../skills/export-codex-handoff/scripts/lib/validation.mjs) deterministically projects `important_location` Claims and frozen Preservation Coverage categories, then requires continuation candidates to match those projections and include claim-derived final provenance. `validate-reduce --check` freezes the exact serialized candidate digest without publishing. Continuation publication requires that binding and rejects post-check mutation; sparse, missing-mode v2, and legacy v1 publication retain their previous routes.

Terminal `prepare-reduce`, `validate-reduce`, and `publish` errors write `failure-report.json` with the diagnostic, phase timings, Worker metrics, failure phase, timestamp, and managed workdir. [continuation-grade-r5.test.mjs](../skills/export-codex-handoff/tests/continuation-grade-r5.test.mjs) locks the six-default early failure plus report, semantics-preserving correction through the CLI, compact-input boundary, and unchecked/mutated/exact digest publication path.

**Acceptance evidence**: R0–R5 pass 26/26 and the complete repository suite passes 111/111. The R5 synthetic continuation input omits `preservationLedger`, complete `semanticCoverage`, and full-frame preservation policy, remains below the 300,000-character gate, and keeps every Claim body in the single Claim table. Installed Skill synchronization, performance calibration, and live acceptance remain deferred to R6–R7.

### Slice R6: Performance calibration and fail-fast policy

**Input**: R5 end-to-end deterministic path and representative smallest, median, and largest retained-sample dispatches.

**Produces**: separate MAP-generation, check/accept, REDUCE, and publication latency metrics; controlled model/reasoning and slot-count comparisons; and a conservative first-wave projection that stops later dispatches when the ten-minute target is already unreachable.

**Does not do**: pick a faster model from intuition, count harness time as provider latency, or claim success from projected sizes.

**Done when**: one evidence-backed worker-model/concurrency decision is recorded, the abort calculation is deterministic and tested, failed runs return complete metrics, and the selected configuration has a measured path to the live budget.

**Implementation evidence**: [performance-calibration.mjs](../skills/export-codex-handoff/scripts/lib/performance-calibration.mjs) defines the controlled comparison contract for representative smallest, median, and largest dispatch samples. A comparison keeps the fixture and dispatch count fixed, changes exactly one of model, reasoning effort, or slot count, and rejects harness elapsed time in provider-latency fields. It projects the full run from the slowest representative MAP and check/accept samples, preserving separate prepare/frame, REDUCE, and publication inputs.

[map-worker.mjs](../skills/export-codex-handoff/scripts/lib/map-worker.mjs) now accepts a complete first-wave projection when scheduling a later wave. It combines the freshly observed slot count with the slowest first-wave MAP generation, slowest check/accept path, and measured REDUCE/publication reserves; a projection above 600,000 ms returns `LIVE_BUDGET_UNREACHABLE` and zero dispatches. [task-workflow-core.mjs](../skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs) records workflow-owned check, complete, accept, REDUCE preparation/check, and publication durations separately from optional provider MAP/REDUCE observations. Successful publication and every terminal REDUCE/publication failure expose all four phase objects under `performanceMetrics`, while retaining `phaseTimingsMs` for compatibility.

**Calibration decision**: Keep the caller-selected worker model and reasoning effort unless a controlled provider-timed comparison changes exactly one factor and wins; use no more than the freshly observed slot count, and abort later waves whenever the conservative projection exceeds 600,000 ms. The R6 controlled vector gives the six-slot configuration a 247,000 ms projected path, while the fail-fast vector deterministically rejects 695,345 ms. These are calibration-contract measurements, not live acceptance; R7 still requires a fresh publication and `verify-evidence` within 600,000 ms.

**Acceptance evidence**: [continuation-grade-r6.test.mjs](../skills/export-codex-handoff/tests/continuation-grade-r6.test.mjs) passes 3/3 for model/reasoning/slot isolation, provider-source enforcement, first-wave abort, and complete four-phase failure metrics. R0–R6 pass 29/29 and the complete repository suite passes 114/114. No installed Skill file was synchronized and no live Compression Run was claimed.

### Slice R7: Compatibility, packaging, and fresh live acceptance

**Input**: R0-R6, complete deterministic regression, and the installed Skill package.

**Produces**: updated contracts, Skill workflow, architecture, code trail, installed mirror, and one fresh dedicated Compression Run with unique output paths.

**Does not do**: resume or modify the Source Thread, reuse either retained failed workdir, migrate legacy manifests, or relax a gate to obtain a passing time.

**Done when**: legacy v1, missing-mode v2, and `sparse-map-v1` suites remain green; repository and installed packages match; every Critical Anchor is covered; both public artifacts publish and `verify-evidence` passes; no contract-shape retry occurs; Handoff stays within 40,000 characters; and `phaseTimingsMs.total <= 600000`.

**In-progress evidence**: The first R7 live run for Source Thread `019fadc7-964d-73d2-b7ab-93456835f402` corrected a PowerShell UTF-8 frame-candidate encoding error inside the same managed directory without creating a MAP dispatch or consuming an attempt. The byte-exact frame then reached the real pre-dispatch gate and failed `MAP_INPUT_TOO_LARGE`: `fragment-map-001` contained 160,234 evidence characters, 11,946 dictionary characters, and 1,194 projection characters, for 173,374 total against the immutable 100,000 limit. No MAP, REDUCE, publication, or public artifact followed. The frozen diagnostic directory is `C:\Users\Lenovo\AppData\Local\Temp\codex-handoff-task-bLt9xi`; it is not a migration or continuation input.

[chunking.mjs](../skills/export-codex-handoff/scripts/lib/chunking.mjs) now gives `continuation-map-v1` a Critical-Anchor-only plan: MAP receives selected source units and independent workspace observations, while the complete Evidence Index and complete Source Thread turn-ID inventory remain unchanged. [task-workflow-core.mjs](../skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs) derives the continuation evidence budget from the 100,000 total-input and 20,000 projection budgets, producing the 60,000-character default effective cap. [continuation-grade-r7.test.mjs](../skills/export-codex-handoff/tests/continuation-grade-r7.test.mjs) proves large non-critical history is absent from MAP, every Critical Anchor remains dictionary-visible, and the complete retrieval/turn inventories are untouched.

**Current verification**: R7 passes 5/5, including a `prepare` through `validate-frame` integration path; R0–R7 pass 34/34; the complete repository suite passes 119/119; repository and installed Skill validators pass; repository and installed packages match at 46/46 relative files and SHA-256 hashes. This is not live acceptance: one new fresh dedicated Compression Task must still publish both artifacts, pass `verify-evidence`, prove complete Critical Anchor coverage with no contract-shape retry, and report `phaseTimingsMs.total <= 600000`.

## 5. Compatibility and rollback

- `continuation-map-v1` is opt-in only for new prepares and is immutable once bound into workflow state.
- Missing mode and `sparse-map-v1` retain their existing validators, normalized summaries, and publication behavior.
- The Evidence Index continues to store every indexed anchor even when it is not a Critical Anchor.
- Published Handoff and Evidence Index schemas remain unchanged; policy-derived ignored coverage preserves the current complete turn graph shape.
- Rollback disables `continuation-map-v1` for future prepares and never rewrites an existing directory or artifact.
- The retained S5 managed directory remains diagnostic evidence and is never used as a migration fixture.

## 6. Verification matrix

| Boundary | Deterministic evidence |
| --- | --- |
| Retrieval is not weakened | Every indexed synthetic and retained-sample anchor still passes `verify-evidence` |
| Critical state cannot disappear | Missing goal, constraint, workspace, failure, verification, or open-work anchors fail coverage |
| Model bookkeeping is removed | Candidate schema has no global Anchor strings, `claimGroups`, separate bindings, full exclusions, or notes |
| Projection is compact | Dictionary and projection size tests enforce 20,000 / 100,000-character gates |
| REDUCE cannot fail late on shape | `validate-reduce --check` binds the exact candidate accepted by publication |
| Compatibility is preserved | Legacy v1, pre-performance v2, and `sparse-map-v1` fixtures remain byte-contract compatible |
| Ten-minute objective is real | Fresh publication and evidence verification report total wall time at or below 600,000 ms |
