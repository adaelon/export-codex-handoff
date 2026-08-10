# Code Trail

## 2026-07-28 Skill scaffold

**Touched**:
- `skills/export-codex-handoff/SKILL.md` — defines UUID-driven Handoff export workflow and safety guardrails.
- `skills/export-codex-handoff/agents/openai.yaml` — exposes skill display metadata and an explicit invocation prompt.

**Entry point**: Invoke `$export-codex-handoff` with a Codex session UUID.
**Test**: `quick_validate.py skills/export-codex-handoff` validates the skill package structure and metadata.

## 2026-07-28 Evidence Pack construction

**Touched**:
- `skills/export-codex-handoff/scripts/lib/source-thread.mjs:findSourceThread` — resolves active or archived rollout JSONL by UUID.
- `skills/export-codex-handoff/scripts/lib/source-thread.mjs:parseSourceThread` — reconstructs user turns, removes duplicate/framework events, and marks truncated tool evidence.
- `skills/export-codex-handoff/scripts/lib/workspace-snapshot.mjs:captureWorkspaceSnapshot` — captures bounded Git and checkpoint evidence without shell interpolation.
- `skills/export-codex-handoff/scripts/lib/evidence-pack.mjs:buildEvidencePack` — combines conversation intent with current workspace facts.

**Entry point**: `buildEvidencePack(sessionId, options)`.
**Test**: `evidence-pack.test.mjs` covers UUID resolution, event de-duplication, truncation, non-Git fallback, and Git/checkpoint snapshots.

## 2026-07-28 Isolated MAP/REDUCE export

**Touched**:
- `skills/export-codex-handoff/scripts/lib/chunking.mjs:chunkEvidencePack` — groups evidence on user-turn boundaries.
- `skills/export-codex-handoff/scripts/lib/codex-runner.mjs:createCodexRunner` — runs structured, ephemeral Codex compression stages with preserved failure diagnostics.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateMapResult` — enforces exact per-turn coverage and valid provenance.
- `skills/export-codex-handoff/scripts/lib/export-core.mjs:exportHandoff` — orchestrates MAP/REDUCE, one retry, budget enforcement, and atomic no-overwrite publication.
- `skills/export-codex-handoff/scripts/lib/render-handoff.mjs:renderHandoff` — renders the fixed Markdown continuation contract.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:main` — exposes the UUID-driven CLI used by the skill.

**Entry point**: `node skills/export-codex-handoff/scripts/export-handoff.mjs <UUID>`.
**Test**: `compression.test.mjs` covers turn-aligned chunking, isolated args, success, retry, incomplete coverage, output budget, diagnostics, and no-overwrite behavior.

## 2026-07-28 Dedicated Compression Task

**Touched**:
- `skills/export-codex-handoff/SKILL.md` — makes the invoking fresh Codex task the semantic MAP/REDUCE executor.
- `skills/export-codex-handoff/scripts/lib/task-workflow.mjs:prepareCompressionTask` — writes managed Evidence Pack and segment files without starting Codex.
- `skills/export-codex-handoff/scripts/lib/task-workflow.mjs:validateMapStage` — validates each persisted MAP result before REDUCE.
- `skills/export-codex-handoff/scripts/lib/task-workflow.mjs:prepareReduceStage` — builds bounded REDUCE input from validated summaries and workspace evidence.
- `skills/export-codex-handoff/scripts/lib/task-workflow.mjs:publishHandoff` — validates, renders, atomically publishes, and safely cleans managed temporary evidence.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateReduceResult` — enforces exact, duplicate-free provenance locally.

**Entry point**: Invoke `$export-codex-handoff <UUID>` from a fresh task in the Source Thread workspace.
**Test**: `compression.test.mjs` covers managed preparation, fail-closed MAP validation, REDUCE preparation, atomic publication, budget failure, cleanup, and duplicate provenance.

## 2026-07-29 Evidence-preserving compression design

**Touched**:
- `CONTEXT.md` — defines Compression Frame, Evidence Anchor, Evidence Index, Tool Receipt, Preservation Ledger, Semantic Coverage, Archival Ledger, and MAP Worker.
- `docs/adr/0004-task-aware-compression-frame.md` — freezes one evidence-backed focus for all semantic stages.
- `docs/adr/0005-lossless-evidence-addressing.md` — pairs lossy claims with durable, exact source lookup.
- `docs/adr/0006-semantic-coverage-and-archival-ledger.md` — replaces turn enumeration with claim coverage and typed operational history.
- `docs/adr/0007-bounded-hierarchical-map-isolation.md` — separates bounded segmentation from isolated MAP execution.
- `docs/slice-plan-evidence-preserving-compression.md` — orders seven independently verifiable implementation slices.
- `docs/architecture.md` — indexed the proposed architecture decisions before implementation began.

**Entry point**: Start with Slice 0 in `docs/slice-plan-evidence-preserving-compression.md`.
**Test**: Documentation validation checks local links, ADR decision shape, resolved terminology, slice ordering, and absence of unresolved placeholders.

## 2026-07-29 Slice 1 evidence addressing and Tool Receipts

**Touched**:
- `skills/export-codex-handoff/scripts/lib/evidence-addressing.mjs:createEvidenceEntry` — creates revision-bound anchors, bounded previews, receipts, identifier candidates, and Preservation Ledgers.
- `skills/export-codex-handoff/scripts/lib/source-thread.mjs:parseSourceThread` — replaces tool truncation with line-, event-, payload-, range-, and digest-addressed Tool Receipts.
- `skills/export-codex-handoff/scripts/lib/workspace-snapshot.mjs:captureWorkspaceSnapshot` — gives checkpoint and Git command results equivalent workspace anchors.
- `skills/export-codex-handoff/scripts/lib/evidence-pack.mjs:buildEvidencePack` — emits anchors, Tool Receipts, a Preservation Ledger, and the compact Evidence Index.
- `skills/export-codex-handoff/scripts/lib/evidence-index.mjs:retrieveEvidence` — verifies source revision and anchor digest before exact retrieval.
- `skills/export-codex-handoff/scripts/lib/evidence-index.mjs:validateEvidenceIndex` — rejects unknown schema fields so raw bodies cannot enter the compact index.
- `skills/export-codex-handoff/scripts/lib/evidence-index.mjs:verifyEvidenceIndex` — verifies index structure, integrity digests, locators, and retrievable anchors.
- `skills/export-codex-handoff/scripts/lib/task-workflow.mjs:publishHandoff` — validates claim anchor references and publishes the Evidence Index before managed cleanup.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:dispatch` — exposes `retrieve` and `verify-evidence` commands.
- `skills/export-codex-handoff/tests/slice1.test.mjs` — covers the semantic fixture comparator, middle-only retrieval, source mutation, exact identifiers, workspace anchors, publication, and unknown anchors.
- `skills/export-codex-handoff/tests/evidence-contract.test.mjs` — covers exact pointer fields, workspace retrieval, and zero-anchor source revision checks.
- `skills/export-codex-handoff/tests/evidence-index-schema.test.mjs` — proves integrity-covered raw body fields fail schema validation.

**Entry point**: `node skills/export-codex-handoff/scripts/export-handoff.mjs retrieve <index> <anchor>` or `verify-evidence <index>`.
**Test**: `node --test --test-isolation=none skills/export-codex-handoff/tests/evidence-pack.test.mjs skills/export-codex-handoff/tests/compression.test.mjs skills/export-codex-handoff/tests/slice1.test.mjs skills/export-codex-handoff/tests/evidence-contract.test.mjs skills/export-codex-handoff/tests/evidence-index-schema.test.mjs` plus the CLI success smoke.

## 2026-07-29 Slice 2 Compression Frame

**Touched**:
- `skills/export-codex-handoff/scripts/lib/source-thread.mjs:parseSourceThread` — anchors user-goal messages so frame claims resolve to exact rollout evidence.
- `skills/export-codex-handoff/scripts/lib/compression-frame.mjs:buildFrameInput` — selects the latest goal, superseded goals, exclusions, checkpoint, and Preservation Ledger deterministically.
- `skills/export-codex-handoff/scripts/lib/compression-frame.mjs:validateCompressionFrame` — rejects unsupported goals, unknown anchors, category omissions, and exact-identifier drift; computes a canonical digest.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareFrameStage` — writes immutable `frame-input.json` candidates into the managed workflow.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:validateFrameStage` — freezes the frame in the manifest and embeds it into every MAP segment.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareReduceStage` — carries the frozen frame and digest into REDUCE input.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateMapResult` — requires exact MAP `frameId` and `frameDigest` bindings.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateReduceResult` — requires the frozen binding, current goal, and exclusions in REDUCE output.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:dispatch` — exposes `prepare-frame` and `validate-frame` commands.
- `skills/export-codex-handoff/references/contracts.md` — publishes the Compression Frame and semantic-stage binding contracts.

**Entry point**: After `prepare`, run `prepare-frame <workDir>`, write `frame.json`, then run `validate-frame <workDir>` before MAP.
**Test**: `skills/export-codex-handoff/tests/slice2.test.mjs` covers late pivots, superseded goals, retry-stable digests, MAP/segment digest mismatch, Preservation Ledger drift, and unknown anchors; the full 29-test suite covers publication regression.

## 2026-07-29 Slice 3 Semantic Coverage and Archival Ledger

**Touched**:
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateMapResult` — requires every summarized turn to reach a unique, anchored claim and rejects ignored, duplicate, unsupported, or unreachable claim edges.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:buildSemanticCoverageGraph` — combines validated MAP outputs into one complete turn-to-claim and claim-to-anchor graph.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateReduceResult` — validates typed decisions, attempts, failure lessons, four-state verification, and per-category Preservation Ledger coverage.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:deriveFinalProvenance` — derives retained Source Thread turn IDs from final claim anchors instead of trusting a model-provided list.
- `skills/export-codex-handoff/scripts/lib/evidence-index.mjs:attachSemanticCoverage` — integrity-covers the compact Semantic Coverage graph in the published Evidence Index.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareReduceStage` — supplies the validated coverage graph to REDUCE.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:publishHandoff` — publishes claim-derived provenance and the integrity-covered coverage graph.
- `skills/export-codex-handoff/scripts/lib/render-handoff.mjs:renderHandoff` — renders superseded/rejected/active decisions, failed attempts, exact verification states, category coverage, and derived provenance separately.
- `skills/export-codex-handoff/tests/slice3.test.mjs` — fixes the Slice 3 fail-closed and chronological rendering boundaries.
- `skills/export-codex-handoff/references/contracts.md` — publishes the claim, Coverage Entry, Archival Ledger, and Preservation Coverage contracts.

**Entry point**: MAP writes claim-linked `turnCoverage`; `prepare-reduce` freezes the combined graph; `publish` derives final provenance and embeds the compact graph in the Evidence Index.
**Test**: `skills/export-codex-handoff/tests/slice3.test.mjs` covers empty semantic coverage, duplicate/unsupported/unreachable claims, ignored-turn edges, forged provenance, category omissions, decision supersession, failed attempts, and pass/fail/not-run/unknown verification; the full 38-test suite covers prior slices and publication regression.

## 2026-07-29 Slice 4 Bounded hierarchical segmentation

**Touched**:
- `skills/export-codex-handoff/scripts/lib/source-thread.mjs:parseSourceThread` — exposes exact message boundaries, anchors final assistant results, and converts patch changes to bounded Tool Receipts.
- `skills/export-codex-handoff/scripts/lib/chunking.mjs:chunkEvidencePack` — replaces passive oversize markers with budgeted complete-turn segments, ordered Turn Fragments, and parent aggregate plans.
- `skills/export-codex-handoff/scripts/lib/chunking.mjs:validateTurnFragments` — rejects missing, duplicate, reordered, overlapping, gapped, and non-exhaustive fragment sets.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareTurnAggregate` — emits a bounded parent-turn MAP input only after every fragment MAP validates.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:validateMapStage` — routes complete-turn, fragment, and parent-turn aggregate MAP validation without adding a public CLI command.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateMapResult` — requires anchored fragment coverage and prevents parent completion before complete child coverage.
- `skills/export-codex-handoff/tests/chunking.test.mjs` — fixes budget, reconstruction, exact-identifier, fragment-integrity, indivisible-failure, and workflow aggregation boundaries.
- `skills/export-codex-handoff/references/contracts.md` — publishes Turn Fragment and three-stage MAP contracts.
- `skills/export-codex-handoff/SKILL.md` — routes Compression Tasks through fragment and parent aggregate stages.

**Entry point**: `prepare` returns initial `segment_map`/`fragment_map` stages; `validate-map` returns a `turn_aggregate_map` `nextStage` after the last child validates.
**Test**: `skills/export-codex-handoff/tests/chunking.test.mjs` plus the full 43-test regression suite cover Slice 4 and Slices 0–3.

## 2026-07-29 Slice 5 Isolated MAP Workers

**Touched**:
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:createMapDispatch` — binds one segment, frozen frame digest, private paths, and attempt to an immutable dispatch identity.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:validateMapReceipt` — limits receipts to 2,048 characters and rejects wrong dispatch, segment, status, or digest shape.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:scheduleMapDispatches` — bounds each wave by freshly supplied dedicated slots and returns `needs-user` when none exist.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:claimMapDispatch` — atomically prevents two workers from claiming one dispatch.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:completeMapDispatch` — validates the private candidate, freezes its digest, creates one retry, and trips the two-attempt circuit breaker.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:acceptMapReceipt` — accepts only the durable bounded receipt and exposes a newly ready parent aggregate dispatch without raw evidence reads.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:readAcceptedMap` — lets aggregate, REDUCE, and publication consume only validated summaries and receipts without reopening raw MAP chunks.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:dispatch` — keeps the eight-command surface while adding explicit `validate-map --claim/--complete` worker modes.
- `skills/export-codex-handoff/tests/map-worker.test.mjs` — covers dispatch identity, fresh slot capacity, atomic claims, bounded and duplicate receipts, coordinator isolation, CLI modes, and retained circuit-breaker diagnostics.
- `skills/export-codex-handoff/references/contracts.md` — publishes the MapDispatch, MapReceipt, retry, and no-fallback contracts.
- `skills/export-codex-handoff/SKILL.md` — routes MAP work through isolated workers and forbids coordinator-side sequential fallback.

**Entry point**: `validate-frame` returns initial `mapDispatches`; each worker runs `validate-map --claim`, writes its private candidate, then runs `validate-map --complete`; the coordinator runs `validate-map --accept`.
**Test**: `skills/export-codex-handoff/tests/map-worker.test.mjs` plus the full 49-test regression suite prove receipts gate REDUCE and raw chunks remain outside coordinator reads.

## 2026-07-29 Slice 6 Transactional publication and compatibility

**Touched**:
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:assertWorkflowVersionBinding` — binds new v2 manifests to immutable directory identity while preserving unmodified v1 state.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:publishPairTransactionally` — exclusively publishes both public files and rolls back only attempt-owned filesystem identities.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:publishHandoff` — validates frame, coverage, source revision, live indexed evidence, and separate Handoff/Evidence Index budgets before publication.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:parsePrepare` — exposes the Evidence Index budget as `--index-chars` without changing the eight-command surface.
- `skills/export-codex-handoff/tests/compression.test.mjs` — covers v1/v2 routing, mixed-version rejection, source append, dual-output rollback, cleanup failure, index budget, and deterministic replay digest.
- `skills/export-codex-handoff/references/contracts.md` — publishes compatibility, transaction, cleanup, and digest guarantees.
- `skills/export-codex-handoff/SKILL.md` — routes new runs through v2 prepublication validation and preserves existing v1 directories.
- `docs/architecture.md` — adds version routing and the transactional publisher to the end-to-end data flow.

**Entry point**: `node skills/export-codex-handoff/scripts/export-handoff.mjs prepare <UUID> [--index-chars <count>]`, followed by the existing staged workflow and `publish <workDir>`.
**Test**: `skills/export-codex-handoff/tests/compression.test.mjs` plus the full 57-test regression suite cover compatibility, integration, fault injection, live-rollout mutation, output budgets, and deterministic structural replay.

## 2026-07-29 Initiative closure and Skill installation

**Touched**:
- `docs/slice-plan-evidence-preserving-compression.md:Closure` — closes the Slice 0–6 initiative, records final evidence, and forbids appending a Slice 7.
- `C:\Users\Lenovo\.codex\skills\export-codex-handoff` — synchronizes the complete 29-file validated v2 Skill package from the repository source.

**Entry point**: Future tasks invoke the installed `$export-codex-handoff`; future behavior changes open a new initiative instead of reopening this Slice Plan.
**Test**: Repository and installed packages pass `quick_validate.py`, their file sets and SHA-256 hashes match, the installed CLI exposes eight commands, and the repository suite passes 57/57.

## 2026-07-29 Performance-bounded compression design

**Touched**:
- `CONTEXT.md:Frame Projection` — defines the segment-local, full-frame-bound Worker context.
- `CONTEXT.md:Deterministic Parent Coverage` — defines non-semantic child-to-parent coverage folding.
- `docs/adr/0008-bounded-map-input-projection.md` — selects fragment packing, local projection, and deterministic parent coverage.
- `docs/slice-plan-performance-bounded-compression.md` — freezes the ten-minute acceptance target and P1–P3 implementation order.

**Entry point**: Start Slice P1 from `docs/slice-plan-performance-bounded-compression.md`.
**Test**: Local Markdown links resolve, the prior Slice 0–6 plan remains closed and unchanged, and the existing runtime suite remains 57/57 green.

## 2026-07-29 P1 packed fragments and Frame Projection

**Touched**:
- `skills/export-codex-handoff/scripts/lib/chunking.mjs:packFragmentSegments` — greedily packs adjacent same-turn fragments under the measured 140k evidence budget.
- `skills/export-codex-handoff/scripts/lib/frame-projection.mjs:buildFrameProjection` — selects only segment-reachable frame obligations while retaining the global frame binding.
- `skills/export-codex-handoff/scripts/lib/frame-projection.mjs:validateFrameProjection` — deterministically rejects projection drift.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:validateFrameStage` — writes projection-bound dispatches and enforces the 400k evidence-plus-context limit before dispatch.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:createMapDispatch` — binds new dispatch identity to `contextPath` and `contextDigest` while retaining legacy `framePath` validation.
- `skills/export-codex-handoff/tests/chunking.test.mjs` — fixes the 391-fragment to at-most-12-MAP performance boundary.
- `skills/export-codex-handoff/tests/slice2.test.mjs` — proves chunks exclude the full frame and projection mutation or budget overflow fails closed.

**Entry point**: `validate-frame <workDir>` returns packed projection-bound `mapDispatches`.
**Test**: Focused chunking, frame, and MAP Worker tests plus the full 59-test suite pass.

## 2026-07-29 P2 deterministic parent coverage

**Touched**:
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:buildDeterministicParentCoverage` — folds complete ordered child coverage and unchanged claims into one parent-turn summary.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:collectReduceStageSummaries` — routes new runs through deterministic folding and old v2 directories through their retained aggregate Worker.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:acceptMapReceipt` — returns no aggregate dispatch for new runs.
- `skills/export-codex-handoff/tests/chunking.test.mjs` — proves REDUCE succeeds after every raw child chunk is removed and no aggregate Worker is created.
- `skills/export-codex-handoff/SKILL.md` — instructs Workers to read Frame Projections and reports initial MAP/input metrics.
- `skills/export-codex-handoff/references/contracts.md` — publishes projection, total-input, compatibility, and deterministic-fold contracts.
- `docs/architecture.md` — replaces repeated full-frame and semantic parent-aggregate flows with the performance-bounded path.

**Entry point**: After all initial receipts are accepted, run `prepare-reduce <workDir>` directly.
**Test**: The complete suite passes 59/59 with deterministic parent coverage and legacy manifest routing intact.

## 2026-07-29 P3 packaging and retained-sample planning

**Touched**:
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:workflowPhaseTimings` — reports prepare/frame, MAP, REDUCE/publish, and total acceptance timings.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:usage` — publishes the 140k evidence and 400k actual-file MAP-input defaults.
- `docs/slice-plan-performance-bounded-compression.md:Implemented evidence` — records 10 MAPs, 4 waves, and the 356,414-character observed maximum.
- `C:\Users\Lenovo\.codex\skills\export-codex-handoff` — installs the complete performance-bounded Skill package.

**Entry point**: Run the installed Skill from a fresh dedicated Compression Task and inspect `phaseTimingsMs.total` after publication.
**Test**: Repository and installed suites pass 59/59; both Skill validators pass; 30/30 relative file hashes match; retained-sample deterministic planning satisfies MAP and actual serialized-input budgets.

## 2026-07-29 Sparse MAP deterministic-bookkeeping design

**Touched**:
- `docs/adr/0009-sparse-map-deterministic-bookkeeping.md:Decision` — assigns unique semantic Claim production to Workers and structural coverage expansion to Node.
- `docs/slice-plan-sparse-map-deterministic-bookkeeping.md:Slice S0` — records the 30-minute failure baseline and splits contract, workflow, budget, packaging, and live acceptance into S0–S5.

**Entry point**: Start Slice S0 from `docs/slice-plan-sparse-map-deterministic-bookkeeping.md` without modifying the retained failed work directory.
**Test**: PowerShell documentation validation confirms a 12-line ADR, six slices, six `Done when` clauses, zero broken local links, and zero unresolved placeholders.

## 2026-07-29 S1 sparse validator and deterministic expander draft (premature)

**Touched**:
- `CONTEXT.md:Sparse MAP Result` — defines the compact Claim, evidence-binding, and exclusion-range vocabulary.
- `CONTEXT.md:Deterministic MAP Bookkeeping` — defines non-semantic full-coverage and ledger expansion.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateSparseMapResult` — validates sparse Claims, semantic-container references, ordered bindings, exclusions, anchors, and ledger references without mutating the candidate.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:expandSparseMapResult` — expands valid sparse candidates into the existing internal MAP shape and reuses full-MAP validation without semantic rewriting.
- `skills/export-codex-handoff/tests/sparse-map.test.mjs` — fixes equivalent turn/fragment expansion and deterministic gap, overlap, ID, Claim, anchor, and ledger failure boundaries.
- `docs/slice-plan-sparse-map-deterministic-bookkeeping.md:Slice S1` — records S1 implementation evidence while leaving S2 workflow binding unopened.

**Entry point**: Import `validateSparseMapResult` or `expandSparseMapResult`; no Compression Task workflow routes sparse candidates until S2.
**Test**: The first implementation run passed 12/12 focused and 71/71 complete tests, but was not valid slice acceptance because formal S0 fixtures did not yet exist.

## 2026-07-29 S0 contract-fixture recovery

**Touched**:
- `skills/export-codex-handoff/tests/fixtures/sparse-map-fixtures.mjs:importantLocationsFullDiagnosticFixture` — creates a synthetic MAP candidate with the retained REDUCE-shaped location error class.
- `skills/export-codex-handoff/tests/fixtures/sparse-map-fixtures.mjs:reusedVerificationFullDiagnosticFixture` — creates a synthetic candidate that reuses one Claim ID across attempt outcome and verification.
- `skills/export-codex-handoff/tests/sparse-map-contract.test.mjs` — reproduces both deterministic diagnostics, protects valid legacy full-MAP validation, and checks local Markdown links.
- `docs/slice-plan-sparse-map-deterministic-bookkeeping.md:Slice S0` — records recovered evidence and the unavailable authentic pre-S1 red run without backdating it.

**Entry point**: Run `node --test --test-isolation=none skills/export-codex-handoff/tests/sparse-map-contract.test.mjs` before accepting S1.
**Test**: S0 contract tests pass 4/4; the pre-Sparse legacy suite remains 59/59 green; all local docs links resolve.

## 2026-07-29 S1 fixture-based re-audit

**Touched**:
- `skills/export-codex-handoff/tests/sparse-map.test.mjs` — replaces private fixture copies with imports from the recovered S0 fixture module.
- `skills/export-codex-handoff/tests/sparse-map.test.mjs:S0 importantLocations fixture expands as the existing MAP Claim shape` — proves the diagnostic location becomes one valid MAP Claim without semantic rewriting.
- `skills/export-codex-handoff/tests/fixtures/sparse-map-fixtures.mjs:reusedVerificationSparseDiagnosticFixture` — shares the retained duplicate-ID class between S0 reproduction and S1 rejection.
- `docs/slice-plan-sparse-map-deterministic-bookkeeping.md:Slice S1` — accepts S1 only after fixture-based re-audit and complete regression.

**Entry point**: Run the S0 contract suite before `sparse-map.test.mjs`; both operate only on synthetic evidence.
**Test**: S0+S1 focused tests pass 17/17; the complete repository suite passes 76/76 with the legacy subset still 59/59.

## 2026-07-29 S2 workflow binding and non-consuming preflight

**Touched**:
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:createMapDispatch` — binds `sparse-map-v1` into new dispatch identities while retaining the missing-mode legacy shape.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:validateMapReceipt` — binds sparse receipts to both raw-candidate and deterministic normalized-result digests.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:assertWorkflowVersionBinding` — makes the new MAP result mode immutable across manifest and workflow binding without migrating old v2 directories.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:checkMapDispatch` — validates a private candidate and freezes its digest without consuming a Worker attempt.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:completeMapDispatch` — rejects post-check mutation, expands sparse output deterministically, and persists the receipt-bound normalized result.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:readAcceptedMap` — verifies both receipt digests and returns normalized MAP data without reopening raw chunk evidence.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:parseMapWorkerAction` — exposes `validate-map --check <DISPATCH_ID>` without adding a new top-level command.
- `skills/export-codex-handoff/tests/sparse-map-workflow.test.mjs` — covers immutable mode binding, non-consuming correction, candidate/normalized digest mutation, CLI preflight, and legacy routing.
- `docs/adr/0010-worker-bound-sparse-map-expansion.md` — records Worker-side expansion as the coordinator-isolation trade-off.
- `docs/architecture.md:Data flow` — adds sparse preflight, normalized artifacts, dual-digest receipts, and missing-mode compatibility routing.

**Entry point**: A Worker claims a sparse-mode dispatch, writes its candidate, runs `validate-map --check`, then runs `validate-map --complete`; the coordinator accepts the dual-digest receipt.
**Test**: S0–S2 focused tests pass 22/22; the complete repository suite passes 81/81, including unchanged v1 and missing-mode v2 full-MAP routes.

## 2026-07-30 S3 stage-specific Worker contract and output budget

**Touched**:
- `skills/export-codex-handoff/references/map-worker-contract.md:Sparse MAP Worker Contract` — isolates the sparse output shape, validator-backed example, Claim-reference invariants, and output cap from REDUCE-only fields.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:createMapDispatch` — binds `maxMapOutputChars` into dispatch identity while preserving pre-S3 and legacy shapes.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:validateMapReceipt` — validates bounded raw and normalized output metrics for budgeted sparse receipts.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareCompressionTask` — freezes an aggregate budget no greater than three REDUCE targets and distributes it deterministically.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:validateWorkerSummary` — rejects exact serialized candidate overflow before semantic acceptance.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareReduceStage` — checks accepted aggregate raw output and reports raw/normalized totals.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:publishHandoff` — publishes aggregate budget and observed MAP output metrics.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:parsePrepare` — exposes the bounded `--map-output-chars` override.
- `skills/export-codex-handoff/tests/sparse-map-contract.test.mjs` — validates the MAP-only example and excludes REDUCE-shaped location keys.
- `skills/export-codex-handoff/tests/sparse-map-workflow.test.mjs` — covers budget identity, non-consuming overflow, metrics, and diagnostic-equivalent first-attempt success.
- `skills/export-codex-handoff/tests/compression.test.mjs` — proves accepted aggregate raw MAP output stays within the configured three-target ceiling.

**Entry point**: A new `sparse-map-v1` Worker reads only `references/map-worker-contract.md`, stays within its dispatch `maxMapOutputChars`, then runs `validate-map --check` before completion.
**Test**: S0–S3 focused tests pass 25/25; the complete repository suite passes 84/84; repository Skill validation, Skill Markdown link validation, and the CLI help smoke pass. Installed Skill synchronization remains deferred to S4.

## 2026-07-30 S4 downstream integration and packaging

**Touched**:
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:buildDeterministicParentCoverage` — deduplicates parent Claim references in first-occurrence order when one sparse Claim covers multiple fragments.
- `skills/export-codex-handoff/tests/chunking.test.mjs:one sparse Claim spanning fragments survives parent coverage, REDUCE, and publication` — proves normalized-only fragment folding, REDUCE compatibility, publication, and compact Semantic Coverage.
- `skills/export-codex-handoff/SKILL.md` and `references/contracts.md` — state the shared-Claim parent-coverage invariant.
- `docs/architecture.md` and `docs/slice-plan-sparse-map-deterministic-bookkeeping.md` — record the downstream fold and S4 acceptance evidence.
- `C:\Users\Lenovo\.codex\skills\export-codex-handoff` — synchronizes the validated 35-file repository Skill package.

**Entry point**: After all sparse fragment receipts are accepted, run `prepare-reduce <workDir>`; the deterministic parent fold is consumed unchanged by REDUCE and publication.
**Test**: The S4 regression path passes 27/27 and the repository suite passes 85/85; both Skill validators pass; repository and installed packages have identical 35/35 relative file sets and SHA-256 hashes; legacy v1 and missing-mode v2 fixtures remain green.

## 2026-07-30 Continuation-grade compression design

**Touched**:
- `CONTEXT.md:Critical Anchor / Continuation Coverage / Evidence Reference Dictionary / Continuation MAP Result` — separates complete retrieval from critical semantic coverage.
- `docs/adr/0011-continuation-grade-evidence-compression.md:Decision` — accepts compact evidence references and deterministic bookkeeping instead of exhaustive model-authored coverage.
- `docs/slice-plan-continuation-grade-compression.md:R0-R7` — orders failure fixtures, evidence selection, compact projection/MAP/REDUCE, preflight, calibration, packaging, and fresh live acceptance.
- `docs/slice-plan-sparse-map-deterministic-bookkeeping.md:Slice S5` — records the failed live result and closes the prior initiative without claiming acceptance.

**Entry point**: Start R0 with synthetic-only failure fixtures; do not modify either retained failed workdir.
**Test**: Documentation validation must resolve every local link, preserve sequential ADR numbering, and keep the pre-R0 executable suite unchanged.

## 2026-07-30 R0 continuation-grade failure fixtures

**Touched**:
- `skills/export-codex-handoff/tests/fixtures/continuation-grade-fixtures.mjs:allAnchorsRequiredGrowthFixture` — generates the retained 376-anchor / 2,793-identifier growth class without private evidence.
- `skills/export-codex-handoff/tests/fixtures/continuation-grade-fixtures.mjs:compareRetainedMetrics` — compares candidate metrics without crossing byte/character units or converting missing observations to zero.
- `skills/export-codex-handoff/tests/fixtures/continuation-grade-fixtures.mjs:emptyCriticalCategoriesReduceFixture` — generates the zero-category / six-default late REDUCE shape failure.
- `skills/export-codex-handoff/tests/fixtures/continuation-grade-fixtures.mjs:repeatedClaimBookkeepingFixture` — exposes repeated Claim-ID and anchor bookkeeping in the current REDUCE input shape.
- `skills/export-codex-handoff/tests/continuation-grade-r0.test.mjs` — fixes all four R0 failure/growth classes and the metric-comparison contract.
- `docs/slice-plan-continuation-grade-compression.md:Slice R0` — records the synthetic-only evidence boundary, comparator fields, units, and acceptance results.

**Entry point**: Run `node --test --test-isolation=none skills/export-codex-handoff/tests/continuation-grade-r0.test.mjs` before starting R1.
**Test**: R0 focused tests pass 5/5; the complete repository suite passes 90/90, including local Markdown-link validation; the pre-R1 runtime baseline remains 85/85 with no runtime edits.

## 2026-07-30 R1 Critical Anchor selection and identifier hygiene

**Touched**:
- `skills/export-codex-handoff/scripts/lib/evidence-addressing.mjs:selectCriticalAnchors` — selects latest-goal, explicit-preserve, failed-receipt, checkpoint/Git, and approved hard-obligation anchors in stable evidence order.
- `skills/export-codex-handoff/scripts/lib/evidence-addressing.mjs:buildContinuationPreservationLedger` — limits new-run required anchors and exact identifiers without changing the legacy ledger builder.
- `skills/export-codex-handoff/scripts/lib/evidence-addressing.mjs:extractExactIdentifiers` — rejects invalid URL/path syntax and base64-like or long opaque path segments.
- `skills/export-codex-handoff/scripts/lib/evidence-addressing.mjs:preservationLedgerMetrics` — derives deterministic Critical Anchor and exact-identifier counts and SHA-256 digests.
- `skills/export-codex-handoff/scripts/lib/evidence-pack.mjs:buildEvidencePack` — applies continuation selection while retaining every entry in the Evidence Index.
- `skills/export-codex-handoff/tests/continuation-grade-r1.test.mjs` — covers strict subset selection, complete retrieval boundary, identifier hygiene, and deterministic metrics.
- `skills/export-codex-handoff/tests/continuation-grade-r0.test.mjs` — keeps the pre-R1 false-positive class frozen independently of corrected runtime behavior.
- `skills/export-codex-handoff/tests/evidence-pack.test.mjs` and `slice1.test.mjs` — distinguish complete retrievability from Critical preservation obligations.
- `docs/slice-plan-continuation-grade-compression.md` and `docs/architecture.md` — record R1 evidence and the new selection boundary.

**Entry point**: `buildEvidencePack(sessionId, options)` builds a complete Evidence Index plus the Critical-only Preservation Ledger for every new Compression Run.
**Test**: R0 passes 5/5, R1 passes 4/4, the directly affected focused set passes 20/20, and the complete repository suite passes 94/94.

## 2026-07-30 R2 Evidence Reference Dictionary and bounded Frame Projection

**Touched**:
- `skills/export-codex-handoff/scripts/lib/frame-projection.mjs:buildEvidenceReferenceDictionary` — assigns consecutive segment-local evidence and exact-identifier indexes without weakening the full frame binding.
- `skills/export-codex-handoff/scripts/lib/frame-projection.mjs:buildReferenceFrameProjection` — replaces reachable anchor and identifier strings with dictionary-local integer references.
- `skills/export-codex-handoff/scripts/lib/frame-projection.mjs:validateEvidenceReferenceDictionary` — rebuilds dictionaries from the frozen frame and private chunk and rejects mutation or cross-segment reuse.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:createMapDispatch` — binds dictionary path and digest into new dispatch identities while accepting frozen legacy shapes.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:validateFrameStage` — persists dictionaries and projections, enforces separate 20k projection and 100k total-input budgets, and preserves `frame-projection-v1` routing.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:parsePrepare` — exposes the independent `--frame-projection-chars` budget and the 100k total-input default.
- `skills/export-codex-handoff/tests/continuation-grade-r2.test.mjs` — locks dictionary mutation, cross-dispatch reuse, local resolution, and both size gates.
- `docs/slice-plan-continuation-grade-compression.md` and `docs/architecture.md` — record R2 acceptance evidence and the new dictionary/projection data flow.

**Entry point**: `validate-frame <workDir>` writes one digest-bound dictionary and compact Frame Projection for every new `reference-frame-projection-v1` dispatch.
**Test**: R0–R2 pass 13/13 and the complete repository suite passes 98/98; installed Skill synchronization remains deferred to R7.

## 2026-07-30 R3 Continuation MAP contract and compact completion

**Touched**:
- `skills/export-codex-handoff/references/continuation-map-worker-contract.md:ContinuationMapResult` — defines the strict anchor-free candidate, local numeric Claim/evidence references, typed relations, critical exclusions, and completion lifecycle.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateContinuationMapResult` — rejects extra fields, invalid Claim kinds/roles, duplicate Claims, unknown local evidence references, and malformed typed relations without changing the candidate.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:completeContinuationMapResult` — derives stable global Claim IDs, byte-exact anchors, integrated bindings, global relation references, and completed exclusions.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:createMapDispatch` — adds immutable opt-in `continuation-map-v1` identity with a required per-dispatch cap no greater than 4,000 characters.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:validateMapReceipt` — binds continuation receipts to raw and compact completed-table digests and character counts while preserving sparse receipt fields.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:validateWorkerSummary` — validates and completes continuation candidates through the existing non-consuming check path using the dispatch dictionary.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:completeMapDispatch` — writes a private completed Claim table and returns its bounded dual-digest receipt without changing retry behavior.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:parsePrepare` — exposes explicit `--map-result-mode continuation-map-v1` opt-in.
- `skills/export-codex-handoff/tests/continuation-grade-r3.test.mjs` — locks single Claim authorship, invalid-reference failure, exact-anchor/global-relation completion, 4k output, and CLI non-consuming check.

**Entry point**: Prepare with `--map-result-mode continuation-map-v1`; the Worker reads `continuation-map-worker-contract.md`, claims its dispatch, writes the candidate, then runs `validate-map --check` and `--complete`.
**Test**: R0–R3 pass 17/17; affected compatibility tests pass 43/43; the complete repository suite passes 102/102. `sparse-map-v1`, missing-mode full MAP, REDUCE, and the two-attempt circuit breaker remain unchanged.

## 2026-07-30 R4 Continuation Coverage and normalized-free downstream

**Touched**:
- `skills/export-codex-handoff/scripts/lib/validation.mjs:buildContinuationDownstream` — merges accepted completed maps into one global Claim table, validates Critical Anchor disposition, and derives canonical turn coverage.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:buildContinuationParentCoverage` — folds completed fragment Claims into parent Claim-ID edges without copying bodies.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:collectContinuationReduceData` — reads digest-bound completed tables after raw chunks are gone and builds edge-only continuation summaries.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareReduceStage` — emits one continuation `claimTable` plus `continuationCoverage` while preserving sparse/legacy REDUCE shapes.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:mapOutputMetrics` — reports continuation completed-output totals separately from sparse normalized totals.
- `skills/export-codex-handoff/tests/continuation-grade-r4.test.mjs` — freezes the five R4 failure, folding, isolation, and single-authorship boundaries.
- `skills/export-codex-handoff/references/contracts.md` and `docs/architecture.md` — publish the global table, Critical Anchor coverage, and normalized-free downstream data flow.

**Entry point**: After every `continuation-map-v1` receipt is accepted, run `prepare-reduce <workDir>`; only completed tables and receipts are required from MAP work.
**Test**: R0–R4 pass 22/22; affected compatibility paths pass 55/55; the complete repository suite passes 107/107.

## 2026-07-30 R5 compact REDUCE and prepublication validation

**Touched**:
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareReduceStage` — emits the compact continuation REDUCE input, retains edge-only summaries, and enforces the 300k gate.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:buildContinuationReduceProjections` — derives important locations and Preservation Coverage from the global Claim table and frozen categories.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:checkReduceStage` — validates deterministic projections and provenance, then binds the exact candidate digest without publishing.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:publishHandoff` — requires the continuation preflight digest and rejects post-check mutation without changing sparse or legacy routing.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:recordTerminalFailure` — persists diagnostics, timings, Worker metrics, phase, and workdir for terminal REDUCE/publication failures.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:dispatch` — exposes `validate-reduce <WORK_DIR> --check`.
- `skills/export-codex-handoff/tests/continuation-grade-r5.test.mjs` — covers early six-default failure, corrected preflight, compact input, failure reporting, and digest-bound publication.
- `skills/export-codex-handoff/references/contracts.md` and `docs/architecture.md` — publish the compact REDUCE, deterministic projection, preflight, failure-report, and compatibility boundaries.

**Entry point**: After writing `reduced.json` for a continuation run, execute `validate-reduce <workDir> --check`, then publish the unchanged candidate.
**Test**: R0–R5 pass 26/26 and the complete repository suite passes 111/111; installed Skill synchronization remains deferred to R7.

## 2026-07-30 R6 performance calibration and fail-fast policy

**Touched**:
- `skills/export-codex-handoff/scripts/lib/performance-calibration.mjs:compareCalibrationRuns` — compares one model, reasoning-effort, or slot-count factor at a time over provider-timed representative dispatches.
- `skills/export-codex-handoff/scripts/lib/performance-calibration.mjs:projectFirstWaveBudget` — derives a conservative ten-minute projection from complete first-wave timings and fresh slot capacity.
- `skills/export-codex-handoff/scripts/lib/performance-calibration.mjs:buildPerformanceMetrics` — emits fixed MAP-generation, check/accept, REDUCE, and publication phase metrics for success and failure paths.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:scheduleMapDispatches` — returns no later-wave dispatches when the R6 projection exceeds 600,000 ms.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:recordTerminalFailure` — persists the four R6 metrics alongside compatibility phase timings and Worker metrics.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:checkMapDispatch / completeMapDispatch / acceptMapReceipt / prepareReduceStage / checkReduceStage / publishHandoff` — records workflow-owned stage durations without relabeling them as provider latency.
- `skills/export-codex-handoff/tests/continuation-grade-r6.test.mjs` — locks controlled comparison, provider-source rejection, 695345ms first-wave abort, and complete failure-metric shape.
- `skills/export-codex-handoff/references/contracts.md`, `docs/slice-plan-continuation-grade-compression.md`, and `docs/architecture.md` — publish the R6 timing boundary, decision, evidence, and data flow.

**Entry point**: Compare provider-timed calibration runs with `compareCalibrationRuns`; before a later wave, call `scheduleMapDispatches` with complete `firstWave` metrics and a freshly observed slot count.
**Test**: R0–R6 pass 29/29 and the complete repository suite passes 114/114; installed Skill synchronization and fresh live acceptance remain deferred to R7.

## 2026-07-30 Accepted Proposal and Terminal-State decision package

**Touched**:
- `CONTEXT.md:Accepted Proposal / Terminal-State Claim / Checkpoint Freshness` — defines referential intent recovery, terminal execution authority, and checkpoint revision roles without implementation detail.
- `docs/adr/0012-accepted-proposal-and-terminal-state-authority.md` — records the accepted authority order and rejection of a cross-field consistency gate.
- `docs/slice-plan-accepted-proposal-terminal-state.md:Slice TS0-TS5` — specifies fixtures, parser changes, checkpoint downgrade, deterministic terminal Claim, projection, compatibility, and live acceptance.

**Entry point**: Start TS0 with synthetic fixtures shaped like Source Thread `019fb265-a781-7520-b64e-50386a6cf5f6`; no executable behavior changes in this documentation slice.
**Test**: Markdown links, terminology, ADR shape, and slice input/output/done criteria are checked deterministically before implementation begins.

## 2026-07-30 TS0 terminal-authority regression fixtures

**Touched**:
- `skills/export-codex-handoff/tests/fixtures/accepted-terminal-fixtures.mjs:acceptedTerminalRolloutRecords` — builds a synthetic referential confirmation, accepted analyzer proposal, aborted final turn, completed tool output, pending tool input, stale checkpoint, and newer Git HEAD.
- `skills/export-codex-handoff/tests/accepted-terminal-ts0.test.mjs` — proves the old Frame can retain AA checkpoint staging while omitting the proposal and abort reason required by the new contract.
- `docs/slice-plan-accepted-proposal-terminal-state.md:Slice TS0` — records the executable fixture evidence.

**Entry point**: Run the TS0 test before changing Source Thread parsing or Frame construction.
**Test**: `node --test --test-isolation=none skills/export-codex-handoff/tests/accepted-terminal-ts0.test.mjs` passes 1/1.

## 2026-07-30 TS1 Accepted Proposal and termination evidence

**Touched**:
- `skills/export-codex-handoff/scripts/lib/source-thread.mjs:isReferentialConfirmation` — recognizes only bounded Chinese and English acceptance/continuation forms.
- `skills/export-codex-handoff/scripts/lib/source-thread.mjs:parseSourceThread` — binds the nearest preceding assistant proposal, anchors task termination metadata, and records assistant/Tool Receipt source order.
- `skills/export-codex-handoff/scripts/lib/evidence-pack.mjs:buildEvidencePack` — persists `sourceContinuation` without rewriting the final user message.
- `skills/export-codex-handoff/tests/accepted-terminal-ts1.test.mjs` — covers referential/standalone selection, framework exclusion, abort anchoring, completed output, and pending input order.

**Entry point**: `parseSourceThread(rolloutPath).sourceContinuation` supplies current goal, optional Accepted Proposal, and terminal evidence to later deterministic stages.
**Test**: TS0–TS1 and affected Source Thread/Evidence Pack compatibility tests pass 10/10.

## 2026-07-30 TS2 checkpoint freshness and authority downgrade

**Touched**:
- `skills/export-codex-handoff/scripts/lib/workspace-snapshot.mjs:parseCheckpointRevision / classifyCheckpointFreshness` — parses recorded revisions and classifies them against full compression-time Git HEAD.
- `skills/export-codex-handoff/scripts/lib/workspace-snapshot.mjs:captureWorkspaceSnapshot` — persists `observedAt`, `/git/head`, recorded checkpoint revision, and freshness.
- `skills/export-codex-handoff/scripts/lib/evidence-addressing.mjs:selectCriticalAnchors` — auto-selects checkpoint evidence only when fresh while retaining every Git observation.
- `skills/export-codex-handoff/scripts/lib/compression-frame.mjs:workspaceCheckpointClaim` — prevents stale or unknown checkpoints from becoming current Frame observations.
- `skills/export-codex-handoff/tests/accepted-terminal-ts2.test.mjs` — covers fresh/stale/unknown, real capture shape, Evidence Index retention, and current-authority downgrade.

**Entry point**: `captureWorkspaceSnapshot(cwd)` supplies freshness metadata consumed by `buildContinuationPreservationLedger` and `buildFrameInput`.
**Test**: TS0–TS2 and affected workspace/Frame tests pass 20/20.

## 2026-07-30 TS3 deterministic Terminal-State Claim

**Touched**:
- `skills/export-codex-handoff/scripts/lib/terminal-state.mjs:buildTerminalStateV1` — separates Source Thread termination from compression-time workspace observation and detects completed versus pending tools.
- `skills/export-codex-handoff/scripts/lib/terminal-state.mjs:projectTerminalStateClaim` — produces one bounded canonical `terminal_state` Claim with a stable supporting-anchor union.
- `skills/export-codex-handoff/scripts/lib/source-thread.mjs:deriveSourceContinuation` — exposes the last user-visible assistant state before termination.
- `skills/export-codex-handoff/scripts/lib/evidence-pack.mjs:buildEvidencePack` — persists the terminal artifacts and makes terminal/proposal anchors Critical.
- `skills/export-codex-handoff/tests/accepted-terminal-ts3.test.mjs` — covers completion, both abort tool boundaries, no-tool, non-Git, unavailable workspace, time separation, and deterministic replay.
- `docs/architecture.md:Components` — adds the deterministic terminal-state projector.

**Entry point**: Every new `buildEvidencePack` call emits exactly one `terminalStateClaim` beside its structured `terminalState`.
**Test**: The affected TS0–TS3/R1/R7/Evidence Pack set passes 21/21; TS3 focused tests pass 2/2.

## 2026-07-30 TS4 Frame-to-Handoff authority projection

**Touched**:
- `skills/export-codex-handoff/scripts/lib/compression-frame.mjs:buildFrameInput / validateCompressionFrame` — adds immutable Frame v2 with exact Accepted Proposal and mandatory Terminal-State Claim while retaining Frame v1 validation.
- `skills/export-codex-handoff/scripts/lib/frame-projection.mjs:buildReferenceFrameProjection` — projects segment-reachable proposal/terminal evidence indexes in Projection v3.
- `skills/export-codex-handoff/scripts/lib/chunking.mjs:turnEvidenceUnits` — makes anchored termination metadata routable as Critical MAP evidence.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:buildContinuationDownstream / buildContinuationReduceProjections / validateReduceResult` — inserts deterministic authorities once and rejects missing, duplicated, or mutated downstream projections.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareCompressionTask / prepareReduceStage / publishHandoff` — binds `frameContractVersion: 2` and carries body-free authority IDs through compact REDUCE.
- `skills/export-codex-handoff/scripts/lib/render-handoff.mjs:renderHandoff` — renders dedicated byte-exact Accepted proposal and Terminal state sections.
- `skills/export-codex-handoff/tests/accepted-terminal-ts4.test.mjs` — exercises prepare, MAP completion, REDUCE preflight, contradictory historical evidence, and publication.
- `docs/architecture.md` — records the new authority path and time-domain separation.

**Entry point**: New `continuation-map-v1` prepares with terminal artifacts create Frame v2; old workdirs remain on their recorded Frame route.
**Test**: TS0–TS4 plus continuation/legacy compatibility paths pass 57/57.

## 2026-08-04 Action-ready high-value Handoff design

**Touched**:
- `CONTEXT.md:Hot Context / Cold Evidence / Working Synthesis / Inspected Evidence Map / Resume Policy / Information Value Gate / Actionability Gate` — defines the action-ready continuation vocabulary and keeps Critical preservation separate from rendered context value.
- `docs/adr/0013-action-ready-handoff-hot-cold-boundary.md:Decision` — selects actionable Hot Context plus complete Cold Evidence and rejects evidence pruning or model-scored relevance.
- `docs/slice-plan-action-ready-high-value-handoff.md:AH0-AH6` — orders failure fixtures, progress capture, versioned synthesis, deterministic gates, clause extraction, rendering, and live continuation acceptance.

**Entry point**: Start AH0 with the synthetic failure fixture; no runtime route changes until its expected Hot/Cold and actionability contracts are frozen.
**Test**: Deterministic documentation checks cover sequential ADR numbering, local links, resolved terms, seven ordered slices, per-slice input/output/exclusion/done criteria, and absence of unresolved placeholders.

## 2026-08-04 Slice AH0 failure fixture and value baseline

**Touched**:
- `skills/export-codex-handoff/tests/fixtures/action-ready-handoff-fixtures.mjs:actionReadyHandoffRolloutRecords / compareActionReadyHandoff` — builds the private-data-free static-review failure class and freezes Hot/Cold classification, actionability, audit expansion, inline evidence noise, and first-deliverable readiness.
- `skills/export-codex-handoff/tests/action-ready-ah0.test.mjs:AH0 characterization tests` — proves the existing evidence-valid path has no usable draft, repeats the whole mixed goal as an exclusion, and is rejected by the expected v2 contract.
- `docs/slice-plan-action-ready-high-value-handoff.md:Slice AH0` — records the measured 4,860-character baseline and deterministic rejection diagnostics.

**Entry point**: `node --test --test-isolation=none skills/export-codex-handoff/tests/action-ready-ah0.test.mjs`.
**Test**: AH0 passes 3/3; the complete repository suite passes 132/132 with no runtime edits.

## 2026-08-04 Slice AH1 Progress Evidence and Inspection Ledger

**Touched**:
- `skills/export-codex-handoff/scripts/lib/progress-evidence.mjs:buildProgressEvidence / validateProgressEvidence` — selects bounded user-visible progress and content inspections, folds duplicate scopes, and binds independent budgets plus stable coverage digests.
- `skills/export-codex-handoff/scripts/lib/progress-evidence.mjs:classifyToolOperation` — assigns every successful Tool Receipt exactly one deterministic content, existence, verification, mutation, or mechanical operation class.
- `skills/export-codex-handoff/scripts/lib/evidence-pack.mjs:buildEvidencePack` — attaches Progress Evidence after the unchanged complete Evidence Index and Critical-only Preservation Ledger are built.
- `skills/export-codex-handoff/tests/action-ready-ah1.test.mjs:AH1 acceptance tests` — locks Cold routing, duplicate folding, independent budgets, replay stability, and index/Critical digest invariance.
- `skills/export-codex-handoff/tests/evidence-pack.test.mjs:Progress Evidence integration assertions` — proves the real Evidence Pack path classifies verification and mutation without creating inspection rows.

**Entry point**: `buildEvidencePack(sessionId, options).progressEvidence` or `buildProgressEvidence(turns, evidenceIndex, budgets)`.
**Test**: AH1 passes 3/3; AH0/AH1/Evidence Pack focused regression passes 9/9; the complete repository suite passes 135/135.

## 2026-08-04 Slice AH2 Versioned Working Synthesis contract

**Touched**:
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:CONTINUATION_MAP_V2_RESULT_MODE / validateMapReceipt` — binds the separate v2 route, preserves the 4k raw ceiling, and caps deterministic completion at 16k.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateActionReadyContinuationMapResult / completeActionReadyContinuationMapResult` — validates and completes exact Finding, Deliverable, and Inspection relations without widening v1.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:buildActionReadyContinuationDownstream / validateActionReadyReduceResult` — constructs Working Synthesis input and validates Working Synthesis, status, inspection-map, and Resume Policy references.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:prepareCompressionTask / validateWorkerSummary / prepareReduceStage` — adds one bounded Progress Evidence MAP segment, routes completed v2 tables into REDUCE, and leaves publication fail-closed.
- `skills/export-codex-handoff/references/continuation-map-v2-worker-contract.md:ActionReadyContinuationMapResult` — publishes the isolated v2 Worker and completion contract.
- `skills/export-codex-handoff/tests/action-ready-ah2.test.mjs:AH2 acceptance tests` — locks relation failures, raw/completed budgets, REDUCE input shape, and v1 byte-contract routing.

**Entry point**: Prepare with `--map-result-mode continuation-map-v2`, complete every returned dispatch, then run `prepare-reduce <workDir>` and consume `workingSynthesisInput` plus `actionReadyOutputContract`.
**Test**: AH2 passes 3/3; the directly affected compatibility set passes 41/41; the complete repository suite passes 138/138.

## 2026-08-04 Slice AH3 Information Value and Actionability gates

**Touched**:
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateActionReadyHandoffGates / buildActionReadyHotContextProjection` — enforces task-profile continuation readiness, typed-root Claim reachability, Cold routing, and deterministic compact Evidence Keys.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:validateReduceResult` — executes the AH3 gates on the `continuation-map-v2` preflight path without changing v1 validation.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:continuationReduceValidationContext` — supplies the frozen task type, current goal, global Claim table, Working Synthesis input, and Evidence Index to AH3.
- `skills/export-codex-handoff/tests/action-ready-ah3.test.mjs:AH3 acceptance tests` — locks stable Hot Context, existence-probe rejection, orphan/mechanical Cold routing, useful partial synthesis, and AH0 preflight rejection.
- `skills/export-codex-handoff/references/contracts.md` and `skills/export-codex-handoff/SKILL.md` — publish the gate diagnostics, projection/key-map shape, and gated REDUCE workflow.
- `docs/slice-plan-action-ready-high-value-handoff.md` and `docs/architecture.md` — record AH3 acceptance evidence and the prepublication Hot/Cold data flow.

**Entry point**: Run `validate-reduce <workDir> --check` for a `continuation-map-v2` work directory; only gate-valid output reaches digest binding, while publication remains closed for AH5.
**Test**: AH3 passes 4/4; the directly affected compatibility set passes 44/44; the complete repository suite passes 142/142.

## 2026-08-04 Slice AH4 clause-level explicit exclusions

**Touched**:
- `skills/export-codex-handoff/scripts/lib/compression-frame.mjs:exclusionSpans / exclusionClaims` — derives source-ordered exact negative-clause spans while preserving comma lists, path punctuation, standalone text, full-goal bytes, and goal anchors.
- `skills/export-codex-handoff/tests/action-ready-ah4.test.mjs:AH4 acceptance tests` — locks mixed Chinese, English negation, multiple exclusions, comma payloads, dotted paths, replay stability, and positive-only behavior.
- `skills/export-codex-handoff/tests/action-ready-ah0.test.mjs` and `tests/fixtures/action-ready-handoff-fixtures.mjs` — retain the historical AH0 metrics and freeze the AH4 interim fixture after only the exclusion defect is removed.
- `skills/export-codex-handoff/SKILL.md`, `references/contracts.md`, `docs/slice-plan-action-ready-high-value-handoff.md`, and `docs/architecture.md` — publish the byte-exact goal and clause-extraction boundary without enabling the AH5 renderer.

**Entry point**: `buildFrameInput(evidencePack, evidenceIndex).explicitExclusions` supplies exact anchored clauses beside the unchanged `latestUserGoal`.
**Test**: AH4 passes 4/4; AH0–AH4 pass 17/17; the Frame/TS/continuation compatibility set passes 69/69; the complete repository suite passes 146/146.

## 2026-08-04 Slice AH5 high-value renderer and synthesize-first consumption

**Touched**:
- `skills/export-codex-handoff/scripts/lib/render-action-ready-handoff.mjs:renderActionReadyHandoff / buildActionReadyConsumerContract` — renders only Hot Context in execution-first order and freezes zero pre-draft evidence reads plus bounded targeted reads.
- `skills/export-codex-handoff/scripts/lib/validation.mjs:buildActionReadyHotContextProjection` — gives clause-level explicit exclusions their own stable Handoff Evidence Keys.
- `skills/export-codex-handoff/scripts/lib/evidence-index.mjs:attachEvidenceKeyMap / validateEvidenceKeyMapShape` — integrity-covers exact `E<n>` to Claim/Anchor resolution in the published Evidence Index.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:publishHandoff` — replaces the v2 renderer fuse with digest-bound action-ready validation, independent rendering, transactional key-map publication, and a structured consumer contract without changing legacy routes.
- `skills/export-codex-handoff/tests/action-ready-ah5.test.mjs:AH5 acceptance tests` — locks renderer order, multiline synthesis, Cold omission, key resolution, preflight mutation rejection, and synthesize-first continuation instructions.
- `skills/export-codex-handoff/SKILL.md`, `references/contracts.md`, `docs/slice-plan-action-ready-high-value-handoff.md`, and `docs/architecture.md` — publish the AH5 renderer, index, consumer, and compatibility boundaries while deferring installation/live acceptance to AH6.

**Entry point**: After `validate-reduce <workDir> --check`, `publish <workDir>` routes only `continuation-map-v2` through the Handoff v2 renderer and returns `consumerContract`.
**Test**: AH5 passes 2/2; AH0–AH5 pass 19/19; the complete repository suite passes 148/148 with legacy v1, missing-mode v2, `sparse-map-v1`, and `continuation-map-v1` unchanged.

## 2026-08-04 Published-output-stable workspace verification

**Touched**:
- `skills/export-codex-handoff/scripts/lib/workspace-snapshot.mjs:publicationStatusExclusions / captureWorkspaceSnapshot` — encodes only exact untracked publication targets as integrity-bound negative Git pathspecs while retaining tracked and unrelated workspace changes.
- `skills/export-codex-handoff/scripts/lib/evidence-pack.mjs:buildEvidencePack` and `scripts/lib/task-workflow-core.mjs:prepareCompressionTask` — carry the resolved Handoff and Evidence Index targets into workspace capture before either file exists.
- `skills/export-codex-handoff/tests/evidence-pack.test.mjs` and `tests/compression.test.mjs` — reproduce post-publication self-contamination, prove standalone verification succeeds, preserve unrelated-change rejection, and lock custom output-path wiring.

**Entry point**: Prepare and publish a Handoff inside the Source Thread Git worktree, then run `verify-evidence` without moving either public artifact.
**Test**: Evidence Pack and Compression focused regressions pass 18/18; the complete repository suite passes 154/154.

## 2026-08-10 Provider Timing Capability and multi-wave recovery design

**Touched**:
- `CONTEXT.md:Provider Timing Capability` — names the execution-surface guarantee without conflating provider latency with coordinator or harness elapsed time.
- `docs/adr/0014-provider-timing-capability-for-multi-wave-map.md:Decision` — requires capability preflight before a structurally multi-wave run and a post-worker, dispatch-bound observation ingress.
- `docs/slice-plan-provider-timing-capability.md:PT0-PT5` — orders characterization, pre-dispatch lower-bound rejection, capability admission, metric persistence, later-wave scheduling, packaging, and live acceptance.

**Entry point**: Start PT0 with the synthetic four-dispatch/three-slot production-boundary fixture; do not read or reuse `codex-handoff-task-RqGiDo` as test input.
**Test**: ADR numbering is sequential through 0014; PT0-PT5 each contain Input/Produces/Does not do/Done when; no placeholders remain; local Markdown links pass 5/5 and R6 performance regressions pass 3/3.

## 2026-08-10 Slice PT0 production-boundary characterization

**Touched**:
- `skills/export-codex-handoff/tests/fixtures/provider-timing-fixtures.mjs:PROVIDER_TIMING_PT0_FIXTURE / createProviderTimingDispatches / firstWaveProjectionInput` — freezes four synthetic dispatches, three fresh slots, accepted workflow durations `52/53/54`, zero calibration objects, `644844` ms prepare/frame elapsed time, unavailable capability state, and the three expected diagnostics.
- `skills/export-codex-handoff/tests/provider-timing-pt0.test.mjs:PT0 integration tests` — drives the production dispatch factory, scheduler, performance projector, dynamic workflow export, and `validate-map --check` CLI parser without importing a missing export at module load or changing runtime behavior.
- `docs/slice-plan-provider-timing-capability.md:Slice PT0` — records the fixture boundary and exact authentic-red plus regression-green evidence while leaving PT1-PT5 pending.

**Entry point**: Run the PT0 Node test against the synthetic fixture; capability admission and `recordMapGenerationMetric` remain deliberately absent from production until PT2 and PT3.
**Test**: `node --test --test-isolation=none skills/export-codex-handoff/tests/provider-timing-pt0.test.mjs` exits 1 with 2/4 passing; its only failures are the current three-dispatch/no-diagnostic admission result versus `PROVIDER_TIMING_UNAVAILABLE` with zero dispatches, and `recordMapGenerationMetric` being `undefined`. The unchanged R6/Worker/CLI command exits 0 with 14/14 passing; its sandbox run redirected only the allowlisted `TEMP`/`TMP` variables to the writable fixture directory for the pre-existing nested CLI subprocess. Test argv and runtime code were unchanged.

## 2026-08-10 Slice PT1 pre-dispatch lower-bound gate

**Touched**:
- `skills/export-codex-handoff/scripts/lib/performance-calibration.mjs:projectPreDispatchLowerBound` — validates ordered UTC Frame boundaries, the unchanged 600,000 ms target, and conservative 60,000/20,000 ms REDUCE/publication reserves before returning a deterministic abort projection.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:validateFrameStage / recordTerminalFailure` — persists validated Frame identity, rejects an unreachable lower bound before MAP context/dispatch construction, and reports explicit accepted-MAP count without deleting the managed work directory.
- `skills/export-codex-handoff/tests/fixtures/provider-timing-fixtures.mjs:PROVIDER_TIMING_PT1_FIXTURE` — adds exact 644,844 ms unreachable and 45,000 ms within-budget phase boundaries plus stable PT1 diagnostics.
- `skills/export-codex-handoff/tests/provider-timing-pt1.test.mjs:PT1 acceptance tests` — locks projection validation, zero-claim terminal reporting, retained workdir state, absent public output, and unchanged within-budget atomic claiming.
- `docs/slice-plan-provider-timing-capability.md:Slice PT1` and `docs/architecture.md:performance flow` — record only the implemented Frame-to-pre-dispatch ordering and exact verification evidence while PT2 capability and PT3 observation ingress remain pending.

**Entry point**: Run `validate-frame <workDir>`; after the Compression Frame validates, the coordinator evaluates the lower bound before it prepares any MapDispatch that a Worker could claim.
**Test**: `node --test --test-isolation=none skills/export-codex-handoff/tests/provider-timing-pt1.test.mjs` exits 0 with 3/3 passing; `node --test --test-isolation=none skills/export-codex-handoff/tests/continuation-grade-r6.test.mjs skills/export-codex-handoff/tests/compression.test.mjs` exits 0 with 17/17 passing.

## 2026-08-10 Slice PT2 Provider Timing Capability preflight

**Touched**:
- `skills/export-codex-handoff/scripts/lib/performance-calibration.mjs:validateProviderTimingCapability` — validates exactly `available`, `source`, `observationPoint`, and `reasonCode`, including their available/unavailable invariants, without consulting model identity or clocks.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:scheduleMapDispatches` — preserves zero-slot and single-wave behavior, then rejects unavailable timing before returning any structurally multi-wave dispatch.
- `skills/export-codex-handoff/tests/fixtures/provider-timing-fixtures.mjs:PROVIDER_TIMING_PT2_FIXTURE` and `tests/provider-timing-pt2.test.mjs:PT2 acceptance tests` — lock strict capability validation, zero-slot precedence, four/three rejection, three/three compatibility, and available first-wave admission.
- `docs/slice-plan-provider-timing-capability.md:Slice PT2` and `docs/architecture.md:MAP admission flow` — record the implemented capability boundary and leave provider-duration ingress to PT3.

**Entry point**: After a caller freshly observes dedicated capacity, it passes the pending MapDispatches, that slot count, and—only for structural multi-wave work—the execution-surface capability to `scheduleMapDispatches` before creating Workers or claiming dispatches.
**Test**: PT2 passes 3/3; the exact R6/Worker/Compression regression command passes 23/23 with only allowlisted `TEMP`/`TMP` redirected to the writable fixture directory for its existing nested CLI subprocess.

## 2026-08-10 Slice PT3 post-worker provider-observation ingress

**Touched**:
- `skills/export-codex-handoff/scripts/lib/performance-calibration.mjs:validateMapGenerationObservation` — validates exactly nine bounded correlation fields and admits only provider-reported latency.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:recordMapGenerationMetric` — requires a new-workdir ingress binding and accepted receipt, then persists receipt-bound additive metric integrity state without reading a private MAP candidate.
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:checkMapDispatch` — keeps Worker-side checking independent by removing the optional timing attachment path.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:record-map-metric` — reads one observation document through a 2,048-byte production CLI boundary after Worker completion.
- `skills/export-codex-handoff/tests/fixtures/provider-timing-fixtures.mjs:PROVIDER_TIMING_PT3_FIXTURE / createMapGenerationObservation` — freezes valid observation data, manifest mode, and deterministic PT3 diagnostics without private evidence.
- `skills/export-codex-handoff/tests/provider-timing-pt0.test.mjs:empty-sample characterization` — supplies the already-implemented available capability so the authentic empty-sample and independent-ingress assertions both remain green.
- `skills/export-codex-handoff/tests/provider-timing-pt3.test.mjs:PT3 acceptance tests` — cover exact validation, accepted ordering, private-candidate deletion, digest/replay stability, conflicts, bounded CLI ingress, frozen-directory refusal, and exact documentation residue.
- `docs/slice-plan-provider-timing-capability.md:Slice PT3` and `docs/architecture.md:post-worker provider-observation ingress` — record the implemented host boundary and leave later-wave consumption to PT4.

**Entry point**: After `validate-map --accept`, write the exact provider document and run `record-map-metric <WORK_DIR> <SEGMENT_ID> <DISPATCH_ID> <OBSERVATION_FILE>`; never attach timing to `validate-map --check`.
**Test**: PT0 passes 4/4; PT3 plus MAP Worker passes 11/11, including identical replay with unchanged manifest bytes and accepted receipt digest after every successful or rejected ingress.

## 2026-08-10 Slice PT4 later-wave scheduling and terminal diagnostics

**Touched**:
- `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:scheduleNextMapWave / collectLaterWaveSchedulingInput` — validates accepted receipt-bound observations and workflow durations, groups complete waves, projects from the first wave with fresh capacity, and records schedule-map terminal failures without retry mutation.
- `skills/export-codex-handoff/scripts/lib/map-worker.mjs:scheduleMapDispatches` — accepts validated first-wave projection input on later waves, returns the ready projection, and bounds dispatches by the newly observed slot count.
- `skills/export-codex-handoff/scripts/export-handoff.mjs:schedule-map` — exposes the fresh-capacity host adapter separately from Worker claim/check/complete/accept actions.
- `skills/export-codex-handoff/tests/provider-timing-pt4.test.mjs:PT4 acceptance tests` — cover exact samples and reserves, CLI-ready dispatch, missing/duplicate/non-correlated metrics, zero slots, over-budget failure reports, receipt retention, no retries, and no public output.
- `docs/slice-plan-provider-timing-capability.md:Slice PT4` and `docs/architecture.md:schedule-map flow` — record the implemented later-wave and retained-failure boundaries while leaving PT5 unopened.

**Entry point**: After every admitted first-wave receipt has been accepted and its provider observation recorded, observe capacity again and run `schedule-map <WORK_DIR> <AVAILABLE_SLOTS>`.
**Test**: PT0-PT4 pass 19/19; the complete repository suite passes 173/173 with zero skips under the documented writable-temp Git ceiling; `git diff --check` passes.
