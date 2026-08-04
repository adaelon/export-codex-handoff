# Sparse MAP and Deterministic Bookkeeping Initiative

Status: implementation closed after S5 live failure — S0 recovery complete with recorded process deviation; S1 re-audited complete; S2–S4 complete; S5 attempted but not accepted  
Scope: reduce MAP intermediate output, validation retries, and wall time without weakening evidence addressing, semantic coverage, Worker isolation, or transactional publication.

## 1. Frozen intent

For new Compression Runs, replace verbose Worker-authored coverage ledgers with a Sparse MAP Result:

- every semantic Claim body appears exactly once;
- direct claim categories and Archival Ledger entries refer to Claim IDs;
- Workers bind Claims explicitly to source-order turn or fragment indexes;
- compact exclusion ranges cover evidence that contributes no retained Claim;
- Node validates those bindings and expands the existing full coverage shape for downstream REDUCE and publication;
- the coordinator never reads raw MAP evidence and never performs semantic repair;
- existing v1 and pre-initiative v2 work directories keep their original MAP contract;
- the retained failed work directory and diagnostics remain unmodified.

The code initiative is complete only when deterministic tests pass, repository and installed Skill packages match, and a fresh dedicated Compression Task publishes both artifacts. The live performance target remains `phaseTimingsMs.total <= 600000`.

## 2. Measured failure baseline

The retained run at `C:\Users\Lenovo\AppData\Local\Temp\codex-handoff-task-AYznwz` established:

- 7,368,652 Source Thread characters and 2,030,898 Evidence Pack characters;
- 10 initial MAP segments, 3 segments requiring retry, and 13 Worker executions;
- creation at `2026-07-29T13:48:29.889Z` and circuit-breaker exhaustion at `2026-07-29T14:19:13.769Z`, about 30 minutes 44 seconds;
- MAP inputs from 194,773 to 356,419 characters, all below the 400,000-character input gate;
- `fragment-map-009` attempt 1 failed because MAP `importantLocations` used REDUCE's `{location, purpose}` shape instead of Claim `text`;
- deterministic in-memory normalization of that one shape makes attempt 1 fully valid;
- attempt 2 failed because `map009-red-outcome` was reused by an attempt outcome and a verification record;
- REDUCE and publication never started.

This baseline separates two problems: contract verbosity caused avoidable model-output failures, while ten large Workers across three slots already exceeded the ten-minute target without REDUCE.

## 3. New runtime contract

New runs advertise `mapResultMode: sparse-map-v1` in the immutable workflow state and bind the same mode into each MapDispatch. A Worker writes:

```text
SparseMapResult {
  formatVersion: 1
  kind: codex-handoff-sparse-map
  frameId: string
  frameDigest: sha256
  segmentId: string
  claims: Claim[]
  claimGroups: {
    objectiveFacts: string[]
    userConstraints: string[]
    completedWork: string[]
    openWork: string[]
    nextActions: string[]
    importantLocations: string[]
    conflicts: string[]
  }
  claimBindings: Array<{
    claimId: string
    evidenceIndexes: integer[]
  }>
  exclusionRanges: Array<{
    startIndex: integer
    endIndexExclusive: integer
    reasonCode: non_semantic | superseded | duplicate | out_of_scope
  }>
  archivalLedger: {
    decisions: Array<{
      statementClaimId: string
      rationaleClaimIds: string[]
      status: active | superseded | rejected
      supersedes: string[]
    }>
    attempts: Array<{
      goalClaimId: string
      actionClaimId: string
      outcomeClaimId: string
      failureClass?: string
      lessonClaimId?: string
    }>
    verification: Array<{
      claimId: string
      command: string
      result: pass | fail | not_run | unknown
    }>
  }
  compressionNotes: string[]
}
```

`evidenceIndexes` address the ordered `expectedTurnIds` or `expectedFragmentIds` carried by the private segment. They do not replace Evidence Anchors: every Claim still carries one or more exact anchors, and each binding must intersect the addressed evidence item's anchors.

Every expected evidence index must be covered by at least one Claim binding or exactly one exclusion range. A bound index cannot also be excluded. Every Claim must belong to at least one group or Archival Ledger entry and must be reachable from at least one evidence binding.

## 4. Deterministic expansion

```text
expandSparseMapResult(result, chunk):
  validate frame, segment, Claim uniqueness, anchors, groups, and ledger references
  validate every evidence index is in range
  validate Claim anchors intersect every explicitly bound evidence item
  require each expected index to be bound or excluded exactly once
  invert claimBindings into ordered CoverageEntry records
  map exclusion reasonCode to one canonical concrete reason
  expand Claim-ID groups and ledger references into the existing internal MAP shape
  return the full normalized result without changing Claim text or anchors
```

The validated sparse candidate remains digest-bound in its private `summaryPath`. During Worker completion, Node expands it deterministically and writes a private normalized summary; the bounded MapReceipt binds both raw and normalized SHA-256 digests. After receipt verification, `readAcceptedMap` consumes only the normalized artifact for parent coverage, REDUCE, semantic-coverage indexing, and publication, so the coordinator never reopens `chunkPath`. Legacy full MAP candidates bypass expansion and retain their original receipt shape.

## 5. Output and retry policy

- Add a deterministic MAP-output budget distinct from the 400,000-character input budget.
- Allocate new-run MAP output from a total target no greater than three times the REDUCE target; publish observed raw and normalized MAP character totals.
- Give a Worker a non-consuming structural preflight before `--complete`; preflight may report bounded validation details but may not alter evidence or semantic content.
- `--complete` still consumes one Worker attempt and preserves the two-attempt circuit breaker.
- Fail incomplete bindings with `INCOMPLETE_SPARSE_COVERAGE`, overlapping exclusions with `OVERLAPPING_SPARSE_COVERAGE`, unknown references with `UNSUPPORTED_CLAIM`, and excess output with `MAP_OUTPUT_TOO_LARGE`.
- Never add a third attempt, coordinator-side model repair, raw-evidence fallback, or automatic migration of an existing work directory.

## 6. Slice order

### Slice S0: Contract fixtures and terminology

**Input**: this ADR, the retained run's bounded diagnostics, current MAP/REDUCE contracts, and current glossary.

**Produces**: glossary entries for Sparse MAP Result and Deterministic MAP Bookkeeping; synthetic regression fixtures for the `importantLocations` shape and reused verification Claim ID; a failing sparse-contract test suite.

**Does not do**: change runtime behavior or copy retained user evidence into the repository.

**Done when**: fixtures reproduce both diagnostic classes, legacy full-MAP tests stay green, and documentation links resolve.

**Recovered evidence**: `tests/fixtures/sparse-map-fixtures.mjs` contains synthetic-only fixtures for the REDUCE-shaped `importantLocations` error and reused verification Claim ID. `sparse-map-contract.test.mjs` reproduces `INVALID_MODEL_OUTPUT` and `DUPLICATE_CLAIM`, keeps a valid legacy full-MAP fixture green, and checks all local docs links. The legacy suite passes 59/59.

**Process deviation**: S1 code existed before these formal S0 fixtures, so no authentic pre-S1 red run was captured. This recovery does not backdate or fabricate one; S1 must be re-audited against the recovered fixtures before it is accepted.

### Slice S1: Sparse validator and deterministic expander

**Input**: S0 fixtures and the `SparseMapResult` contract.

**Produces**: pure validation/expansion functions that return the existing internal MAP shape without semantic rewriting.

**Does not do**: change dispatches, CLI modes, publication, or installed Skill files.

**Done when**: complete sparse bindings expand to the same semantic coverage as a full fixture; gaps, overlaps, unknown IDs, duplicate Claims, invalid anchors, and ledger-reference errors fail deterministically.

**Re-audited evidence**: `validation.mjs` exports pure sparse validation/expansion without workflow routing. `sparse-map.test.mjs` consumes the recovered S0 fixtures, proves positive `importantLocations` Claim expansion, rejects reused verification Claim IDs, and covers all declared failure gates. S0+S1 focused tests pass 17/17 and the complete repository suite passes 76/76.

### Slice S2: Workflow binding and non-consuming preflight

**Input**: the S1 expander and current MapDispatch/MapReceipt lifecycle.

**Produces**: immutable `mapResultMode`, dispatch binding, `validate-map --check`, sparse acceptance, digest verification, and legacy routing.

**Does not do**: alter the two-attempt circuit breaker or let the coordinator read chunk evidence.

**Done when**: a Worker can correct a structural error before `--complete`, a checked candidate cannot change before completion, and old work directories still validate through the full-MAP path.

**Implemented evidence**: new v2 workflow bindings and every derived MapDispatch carry immutable `mapResultMode: sparse-map-v1`; missing mode in v1 or pre-initiative v2 state selects legacy full-MAP validation. `validate-map --check` validates without consuming an attempt and freezes the raw candidate digest. Worker completion rejects post-check mutation, persists the deterministic full-MAP expansion, and emits a bounded receipt binding both raw and normalized digests. Coordinator acceptance detects either artifact changing and uses the normalized result without reopening raw chunk evidence. Focused S0–S2 tests pass 22/22 and the complete repository suite passes 81/81.

### Slice S3: Stage-specific Worker contract and output budget

**Input**: S2 workflow modes and measured retained-run sizes.

**Produces**: a MAP-only contract view, sparse example, explicit Claim-reference rules, per-dispatch output budget, and raw/normalized output metrics.

**Does not do**: weaken exact identifiers, Frame Projection, Evidence Anchors, or REDUCE validation.

**Done when**: the diagnostic-equivalent fixture succeeds without retry, aggregate accepted MAP output is at most three times the REDUCE target, and over-budget candidates fail before acceptance.

**Implemented evidence**: `references/map-worker-contract.md` is a sparse-only Worker view with a validator-backed example and one-container/one-binding Claim-reference rules, so it never exposes REDUCE's `{location, purpose}` shape. New workflow bindings freeze `maxAggregateMapOutputChars`; deterministic allocation binds `maxMapOutputChars` into each initial dispatch identity and retry. Non-consuming check rejects exact serialized output overflow with `MAP_OUTPUT_TOO_LARGE`. Sparse receipts and accepted stage state bind raw and normalized character counts; REDUCE preparation and publication enforce/report their totals. The diagnostic-equivalent `importantLocations` workflow completes on attempt 1, and aggregate raw output remains within three times the REDUCE target. S0–S3 focused tests pass 25/25; the complete repository suite passes 84/84.

### Slice S4: Downstream integration and packaging

**Input**: accepted normalized MAP results from S3.

**Produces**: unchanged deterministic parent coverage semantics, REDUCE input compatibility, documentation updates, installed Skill synchronization, and code-trail entries.

**Does not do**: reinterpret or migrate retained v1/v2 directories.

**Done when**: the full repository suite and both Skill validators pass, repository and installed relative file sets and SHA-256 hashes match, and legacy compatibility fixtures remain green.

**Implemented evidence**: deterministic parent folding now retains a Claim ID once at its first
source-order occurrence when one valid sparse Claim spans multiple fragments; Claim bodies and
anchors remain unchanged. A red-green workflow test removes the raw fragment chunks, consumes only
receipt-bound normalized summaries, prepares REDUCE, and transactionally publishes the Handoff and
Evidence Index. The downstream/legacy/package regression suite passes 27/27, the complete repository
suite passes 85/85, both repository and installed Skill validators pass, and all 35 relative package
files have identical SHA-256 hashes. No retained v1/v2 directory was modified; the checkpoint-named
temporary diagnostics path was absent when S4 rechecked external state.

### Slice S5: Fresh live acceptance

**Input**: the installed Skill and the retained Source Thread UUID in a fresh dedicated Compression Task.

**Produces**: published Handoff and Evidence Index plus phase, Worker, input, raw-output, and normalized-output metrics.

**Does not do**: resume the Source Thread, reuse the failed Compression Task, or relax a gate to obtain a passing time.

**Done when**: publication succeeds, `verify-evidence` passes, no MAP retry is caused by contract shape, final Handoff stays within 40,000 characters, and `phaseTimingsMs.total <= 600000`.

If S5 exceeds ten minutes, record measured MAP generation and REDUCE latency separately and open a new concurrency/model-latency decision. Do not claim this initiative complete from deterministic size projections alone.

**Live result**: all 10 initial sparse MAPs validated and were accepted on attempt 1, but MAP through `prepare-reduce` took 1,749,646 ms and the prepublication lower bound reached 2,131,810 ms. Publication then failed with `INCOMPLETE_PRESERVATION_COVERAGE` because the frozen category set was empty while REDUCE emitted six default entries; neither public artifact appeared and `verify-evidence` was not run. The retained workdir is `C:\Users\Lenovo\AppData\Local\Temp\codex-handoff-task-3tYnXG`.

The ten-minute target and the late REDUCE-shape failure are carried forward by [ADR-0011](./adr/0011-continuation-grade-evidence-compression.md) and the [Continuation-grade Compression Initiative](./slice-plan-continuation-grade-compression.md). This initiative is not reopened for implementation.

## 7. Compatibility and rollback

- Missing `mapResultMode` means the current full-MAP contract.
- `sparse-map-v1` is valid only when bound into new immutable workflow state and every dispatch.
- Sparse candidates remain private and receipt-digest-bound; normalized expansions are derived values, not new semantic artifacts.
- Rollback disables sparse mode for future prepares only; it never rewrites an existing manifest or diagnostic directory.
- The published Handoff and Evidence Index schemas remain unchanged unless a later slice proves a separate versioned change is necessary.
