# Evidence-preserving Semantic Compression Slice Plan

Status: closed — Slices 0–6 implemented and verified  
Scope: evolve the existing Handoff exporter without modifying or resuming the Source Thread.

## 1. Intent

Build a Compression Run that is task-aware, evidence-addressable, semantically covered, bounded for oversized turns, and isolated at each MAP boundary.

Success requires all of the following:

- every semantic stage consumes the same validated Compression Frame;
- every Handoff claim resolves through an Evidence Anchor;
- exact identifiers survive byte-for-byte;
- every summarized turn supports at least one claim or is explicitly ignored;
- decisions, failed attempts, verification, and supersession remain chronologically recoverable;
- no MAP Worker receives more than the configured evidence budget;
- the Compression Task coordinator never reads raw MAP evidence;
- deterministic tests, not model self-review, decide publication.

## 2. Non-goals

- Do not add live 80% context-window triggering or KV Cache policy.
- Do not rank engineering evidence by emotion or generic memory recency.
- Do not embed complete rollout or tool output bodies in the Handoff.
- Do not make nested Codex CLI execution part of the production path.
- Do not turn the Handoff into a transcript or a replacement Source Thread.

## 3. Frozen decisions

- [Task-aware Compression Frame](./adr/0004-task-aware-compression-frame.md)
- [Lossless Evidence Addressing](./adr/0005-lossless-evidence-addressing.md)
- [Semantic Coverage and Archival Ledger](./adr/0006-semantic-coverage-and-archival-ledger.md)
- [Bounded Hierarchical MAP Isolation](./adr/0007-bounded-hierarchical-map-isolation.md)

## 4. Target contracts

    EvidenceAnchor {
      anchorId: string
      sourceKind: source_thread | workspace
      sourceRevision: string
      turnId?: string
      eventOrdinal?: number
      rolloutLine?: number
      payloadPath?: string
      callId?: string
      rangeUtf16?: { start: number, end: number }
      sha256: string
    }

    ToolReceipt {
      receiptId: string
      toolName: string
      callId: string
      status: ok | error | unknown
      previewHead: string
      previewTail: string
      outputChars: number
      outputAnchor: string
      exactIdentifiers: string[]
    }

    PreservationLedger {
      sourceRevision: string
      requiredAnchors: string[]
      exactIdentifiers: Array<{
        kind: uuid | hash | url | path | ip | port | symbol
        value: string
        anchors: string[]
      }>
      criticalCategories: Array<
        constraint | decision | change | verification | open_work | rollback
      >
    }

    CompressionFrame {
      frameId: string
      currentGoal: Claim
      taskType: implementation | diagnosis | review | research | documentation | other
      taskPhase: discovering | implementing | verifying | blocked | handoff
      explicitExclusions: Claim[]
      preservationPolicy: PreservationLedger
      anchors: string[]
    }

    Claim {
      claimId: string
      kind: string
      text: string
      anchors: string[]
    }

    CoverageEntry {
      turnId: string
      status: summarized | ignored
      claimIds: string[]
      reason: string
    }

    ArchivalLedger {
      decisions: Array<{
        statement: Claim
        rationale: Claim[]
        status: active | superseded | rejected
        supersedes: string[]
      }>
      attempts: Array<{
        goal: Claim
        action: Claim
        outcome: Claim
        failureClass?: string
        lesson?: Claim
      }>
      verification: Array<{
        command: string
        result: pass | fail | not_run | unknown
        anchors: string[]
      }>
    }

Exact identifiers are copied from the Preservation Ledger. A model may select an identifier but may not normalize, shorten, repair, or synthesize it.

## 5. Target flow

    PREPARE
      -> INDEX_EVIDENCE
      -> BUILD_FRAME
      -> SEGMENT
      -> DISPATCH_MAP
      -> VALIDATE_MAP
      -> PREPARE_REDUCE
      -> REDUCE
      -> VALIDATE_PUBLICATION
      -> PUBLISH_HANDOFF_AND_INDEX
      -> CLEAN_TEMPORARY_STATE

Failure transitions:

- contract failure -> one correction using the same input and frame digest;
- second semantic-stage failure -> stop, retain managed work directory;
- source revision mismatch -> stop with SOURCE_CHANGED;
- missing required identifier or anchor -> stop with PRESERVATION_GAP;
- uncovered summarized turn -> stop with INCOMPLETE_SEMANTIC_COVERAGE;
- exhausted MAP Worker -> stop with MAP_WORKER_EXHAUSTED;
- partial publication -> remove only files created by that publication attempt and retain diagnostics.

Publication produces:

- handoff-UUID.md: portable continuation checkpoint;
- handoff-UUID.evidence.json: compact Evidence Index, source revision, anchor map, and integrity digests;
- no copied raw rollout or complete tool body unless a later explicit bundle feature is approved.

## 6. Slice order

Each slice starts from green tests, changes one behavioral boundary, updates contracts and documentation in the same slice, and leaves a resumable file state.

### Slice 0: Characterization and semantic gold fixtures

**Goal**: Freeze current v1 behavior and add failing fixtures for the new guarantees.

**Does not do**: Change production parsing, segmentation, prompts, or publication.

**Inputs**:

- current rollout parser and managed Compression Task workflow;
- fixtures covering a late task pivot, an early architecture decision, a failed attempt, a middle-only tool error, exact identifiers, a workspace conflict, and one oversized turn.

**Outputs**:

- v1 characterization assertions;
- annotated expected claims, ignored turns, exact identifiers, and archival events;
- a deterministic fixture comparator that does not use LLM-as-judge.

**Verification**:

- current v1 tests remain green;
- new semantic contract tests fail for the intended missing guarantees;
- fixture comparator reports exact missing, mutated, unsupported, and duplicate claims.

**Done when**: Every later slice has at least one pre-existing red test that it will turn green.

### Slice 1: Evidence addressing and Tool Receipts

**Goal**: Replace irreversible tool truncation with bounded receipts backed by retrievable anchors.

**Does not do**: Add model task awareness or change MAP execution isolation.

**Production touchpoints**:

- source-thread.mjs: capture rollout line, event ordinal, payload path, UTF-16 range, and digest;
- evidence-pack.mjs: emit Tool Receipts, source revision, and Preservation Ledger candidates;
- task-workflow.mjs: persist and publish the compact Evidence Index;
- export-handoff.mjs: expose retrieval and integrity-check commands.

**Required behavior**:

- head and tail previews remain bounded;
- the complete value stays in the Source Thread rollout;
- retrieval verifies source revision and anchor digest before returning content;
- workspace observations receive equivalent command-result anchors;
- successful cleanup removes temporary copies but not the published Evidence Index.

**Verification**:

- retrieve a marker located only in the middle of a large tool output;
- reject a stale or mutated rollout prefix;
- preserve UUID, hash, URL, path, IP, port, and symbol fixtures byte-for-byte;
- fail publication when the Handoff references an unknown anchor.

**Done when**: No Evidence Pack truncation can make source evidence irretrievable.

### Slice 2: Compression Frame

**Goal**: Give every MAP and REDUCE the same evidence-backed current objective and preservation policy.

**Does not do**: Let the frame introduce new requirements or mutate during MAP.

**Production touchpoints**:

- add frame-input.json and frame.json to the managed manifest;
- add prepare-frame and validate-frame workflow commands;
- extend contracts.md with the Compression Frame schema;
- include frameId and frameDigest in every MAP and REDUCE result.

**Required behavior**:

- deterministic preparation selects the latest user-goal evidence, explicit exclusions, workspace checkpoint, and Preservation Ledger;
- one semantic frame stage normalizes those candidates into the typed contract;
- validation rejects unsupported goals, unknown anchors, missing critical categories, and changed exact identifiers;
- every downstream stage receives the frozen frame and digest.

**Verification**:

- a late task pivot changes what an early segment preserves;
- an old superseded goal is not restored as current;
- the same segment and frame produce contract-equivalent preservation obligations on retry;
- REDUCE rejects MAP results carrying another frame digest.

**Done when**: Segment order can no longer change the declared compression objective.

### Slice 3: Semantic Coverage and Archival Ledger

**Goal**: Make continuation-critical semantics and operational history deterministically accountable.

**Does not do**: Require every turn to appear in the Handoff or preserve conversational narration.

**Production touchpoints**:

- contracts.md: replace free-text facts with claimId plus Evidence Anchors;
- validation.mjs: build and verify the claim-to-turn coverage graph;
- render-handoff.mjs: render active decisions, superseded decisions, failed attempts, and verification separately;
- task-workflow.mjs: derive final provenance from validated claims instead of accepting a model-provided ID list.

**Required behavior**:

- a summarized turn has at least one reachable claim;
- an ignored turn has no claims and carries a concrete exclusion reason;
- every claim has at least one valid anchor;
- every Preservation Ledger category is represented or explicitly reported absent;
- decision rationale and failure lessons remain distinct from narrative;
- unsupported and duplicate claims fail closed.

**Verification**:

- reject complete turnCoverage paired with empty fact arrays;
- reject a final provenance list that was not derived from claims;
- preserve an early decision, its reason, a later supersession, and a failed alternative in order;
- preserve pass, fail, not-run, and unknown verification states without upgrading them.

**Done when**: Turn enumeration can no longer masquerade as semantic coverage.

### Slice 4: Bounded hierarchical segmentation

**Goal**: Guarantee that every semantic input stays within budget, including one oversized Source Thread turn.

**Does not do**: Split identifiers, silently discard fragments, or depend on model-estimated token counts.

**Production touchpoints**:

- chunking.mjs: introduce turn fragments and parent-turn coverage;
- source-thread.mjs: expose event boundaries and indivisible payload metadata;
- task-workflow.mjs: add fragment MAP and turn-aggregate MAP stages;
- validation.mjs: verify fragment completeness before parent-turn completion.

**Segmentation order**:

1. keep user goal messages and final assistant result as independent anchored units;
2. convert tool interactions and patch events to Tool Receipts;
3. split remaining large payloads on event or message-content boundaries;
4. use anchored range fragments only when one payload remains oversized;
5. aggregate fragment claims under the original turnId before segment REDUCE.

**Required invariants**:

- fragment evidenceChars never exceeds maxChunkChars;
- fragment ranges are ordered, non-overlapping, and exhaustive over retained content;
- parent turn coverage is complete only after every child fragment validates;
- an indivisible over-budget value fails with OVERSIZE_EVIDENCE_UNSPLITTABLE.

**Verification**:

- a single huge turn produces bounded child fragments;
- a critical marker at each boundary survives reconstruction;
- missing, duplicate, overlapping, and reordered fragments fail;
- exact identifiers crossing a candidate split remain whole.

**Done when**: The manifest contains no passive oversize marker and no semantic stage receives an over-budget file.

### Slice 5: Isolated MAP Workers

**Goal**: Keep raw segment evidence out of the Compression Task coordinator context.

**Does not do**: Start nested Codex CLI processes or allow workers to publish artifacts.

**Worker contract**:

    MapDispatch {
      dispatchId: string
      segmentId: string
      chunkPath: string
      summaryPath: string
      framePath: string
      frameDigest: string
      attempt: 1 | 2
    }

    MapReceipt {
      dispatchId: string
      segmentId: string
      status: validated | failed
      summaryDigest?: string
      diagnosticCode?: string
    }

**Required behavior**:

- the coordinator dispatches one bounded segment per isolated MAP Worker;
- a worker reads only its segment, frozen frame, and MAP contract;
- a worker writes only its private summary candidate and returns a bounded receipt;
- deterministic validation occurs before the coordinator accepts the receipt;
- concurrency is bounded to available dedicated slots and never inferred from stale state;
- two failed attempts trip a per-segment circuit breaker and retain diagnostics.

**Verification**:

- instrumentation proves the coordinator never opens chunkPath;
- two workers cannot claim the same dispatch;
- a stale frame digest, oversized receipt, wrong segmentId, or duplicate receipt fails;
- worker failure does not publish partial REDUCE input;
- sequential fallback, when no worker slot exists, returns needs-user rather than reading evidence in the coordinator.

**Done when**: REDUCE sees validated summaries and ledgers only, never raw segment content.

### Slice 6: Transactional publication, compatibility, and end-to-end evaluation

**Goal**: Publish Handoff plus Evidence Index as one validated checkpoint and preserve safe v1 behavior.

**Does not do**: Rewrite existing v1 managed work directories or overwrite prior Handoffs.

**Compatibility policy**:

- new prepare commands create formatVersion 2 manifests;
- v1 manifests continue through the existing v1 validation and publication path;
- v1 state is never silently upgraded;
- a mixed v1/v2 work directory fails with WORKFLOW_VERSION_MISMATCH.

**Publication policy**:

- validate Handoff, Evidence Index, coverage graph, frame digest, source revision, and output budgets before either public file appears;
- create both public files with exclusive semantics;
- on a second-file failure, remove only the first file created by the same attempt;
- successful cleanup removes the managed work directory;
- failed cleanup is reported without retracting a valid publication.

**Evaluation corpus**:

- short normal conversation;
- long multi-turn implementation;
- late objective pivot;
- contradictory conversation and workspace evidence;
- giant tool output with a middle-only failure;
- exact identifiers differing by one character;
- aborted turn and incomplete verification;
- early decision later superseded;
- repeated failed compression attempts;
- active rollout appended after preparation.

**Acceptance metrics**:

- 100% required-anchor recall on annotated fixtures;
- 100% exact-identifier byte equality;
- zero unsupported claim anchors;
- zero over-budget semantic inputs;
- zero partial public artifact sets after injected failures;
- deterministic replay produces identical structural digests;
- output remains within configured Handoff and Evidence Index budgets.

**Done when**: The complete v2 run passes unit, integration, fault-injection, and real-rollout smoke tests while v1 tests remain green.

**Implemented**: New runs create version-bound v2 directories; v1 state remains unchanged; mixed
state fails closed; publication verifies the live Source Thread plus Handoff/Evidence Index budgets,
rolls back an attempt-owned first file on second-file failure, retains valid outputs on cleanup
failure, and reports deterministic structural plus full-output digests.

## 7. Implementation dependencies

Slice dependencies are strict:

    Slice 0
      -> Slice 1
      -> Slice 2
      -> Slice 3
      -> Slice 4
      -> Slice 5
      -> Slice 6

Slices 1 and 2 may be developed on separate branches after Slice 0, but Slice 3 must integrate both before its coverage graph is authoritative. Slices 4 and 5 remain separate so segmentation failures cannot be confused with worker lifecycle failures.

## 8. Test ownership

- evidence-pack.test.mjs: source revisions, anchors, Tool Receipts, identifier extraction, retrieval;
- slice2.test.mjs: frame lifecycle, late goal pivot, retry stability, preservation drift, and digest binding;
- compression.test.mjs: REDUCE frame binding, coverage graph, version routing, publication transaction;
- chunking.test.mjs: fragment partition, parent coverage, boundary preservation, oversize failures;
- map-worker.test.mjs: dispatch identity, bounded receipts, retry circuit breaker, coordinator isolation;
- real-rollout smoke: one sanitized persisted Source Thread with deterministic expected anchors and Handoff facts.

All semantic fixtures carry human-authored expected facts. A model may generate candidate output, but the test runner decides exact coverage, identity, integrity, and publication success.

## 9. Risks and controls

| Risk | Control | Deterministic signal |
| --- | --- | --- |
| Evidence Index leaks raw content | Store pointers, digests, bounded previews only | schema rejects unbounded body fields |
| Active rollout changes during compression | Freeze byte length and source revision | SOURCE_CHANGED |
| Compression Frame invents scope | Require evidence anchors for every frame claim | UNSUPPORTED_FRAME_CLAIM |
| Exact identifiers mutate | Compare against Preservation Ledger | IDENTIFIER_MISMATCH |
| Coverage grows Handoff excessively | Keep graph in Evidence Index; render only compact sources | separate output budgets |
| Worker isolation is unavailable | Stop before raw read | MAP_WORKER_UNAVAILABLE |
| Old work directories become unreadable | Version-dispatch v1 unchanged | WORKFLOW_VERSION_MISMATCH |
| Publication leaves one public file | Attempt-scoped rollback | publication fault-injection test |

## 10. Exit criteria

The initiative is complete only when:

1. every ADR has an implemented and tested code path;
2. every new CONTEXT.md term appears in a public contract or is removed;
3. v1 compatibility behavior is explicit and green;
4. the real-rollout smoke proves retrieval from a Handoff claim to exact source evidence;
5. a fresh Codex task can continue from the Handoff without reading the raw rollout;
6. no correctness claim depends solely on LLM self-assessment.

## 11. Closure

This initiative is closed. Slices 0–6 are implemented, the v2 workflow and retained v1 path are
documented in the installed Skill contract, and there is no downstream Slice 7 in this plan.

Final deterministic evidence:

- 57/57 unit, integration, compatibility, and fault-injection tests pass;
- the CLI retains eight public commands and adds only the v2 Evidence Index budget option;
- live Source Thread mutation fails before publication;
- injected second-file failure leaves zero public artifacts;
- repository and installed Skill packages pass `quick_validate.py`.

Future behavior changes start a new initiative and must not reopen or append to this closed plan.
