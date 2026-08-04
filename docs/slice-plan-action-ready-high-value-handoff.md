# Action-Ready High-Value Handoff Slices

Status: accepted; implementation pending  
Scope: make a fresh continuation task synthesize from already-formed knowledge before bounded verification, while keeping complete evidence retrievable but outside its default context.
Decision: [ADR-0013 Action-Ready Handoff Hot/Cold Boundary](./adr/0013-action-ready-handoff-hot-cold-boundary.md).

## 1. Frozen intent

New Compression Runs must separate preservation value from context value:

```text
Critical Anchors -> safety and exact preservation obligations
Progress Evidence -> bounded prior understanding and content-inspection state
Evidence Index    -> complete Cold Evidence for exact retrieval
Hot Context       -> only facts that change the next task's output or behavior
```

The implementation will:

- retain the complete Evidence Index without automatically loading it into the continuation task;
- keep Critical Anchor coverage intact while refusing to equate `critical` with `hot-rendered`;
- select bounded user-visible progress and successful content inspections as Progress Evidence without promoting every successful Tool Receipt to a Critical Anchor;
- produce Working Synthesis, a deliverable checklist, an Inspected Evidence Map, explicit uncertainties, and a bounded Resume Policy;
- admit a fact to Hot Context only when deterministic graph reachability connects it to a requested deliverable, decision, constraint, confirmed finding, uncertainty, next action, no-repeat scope, or relevant verification;
- route existence probes, mechanical success, raw terminal payloads, raw coverage lists, timestamps, and orphan observations to Cold Evidence;
- render compact Handoff Evidence Keys instead of raw Claim-ID and Evidence-Anchor lists;
- require review, research, and diagnosis continuations to emit a draft before any new evidence read, forbid broad search and full-file rereads, and allow at most three targeted reads for named uncertainties or claim verification;
- extract explicit exclusions at clause granularity so a mixed objective such as `看代码，说明流程和复杂度，不要跑测试` retains the full objective but only `不要跑测试` as the exclusion.

This initiative does not delete indexed evidence, weaken exact retrieval, use an LLM relevance score as a publication gate, rewrite an existing Handoff, mutate a frozen work directory, or change legacy v1, missing-mode v2, `sparse-map-v1`, or `continuation-map-v1` contracts.

## 2. Output contracts

### 2.1 Hot Context reachability

```text
HotRole = objective | constraint | confirmed_finding | decision |
          uncertainty | next_action | no_repeat_scope | relevant_verification

retainHot(claim):
  claim has valid evidence
  AND claim is reachable from a requested deliverable or Resume Policy root
  AND claim is not duplicate or superseded
  AND claim is not a pure observation
```

Pure observations include ordinary file existence, path discovery, command completion, Git probes, timestamps, raw revision identifiers, and size/count statistics with no downstream consequence. An observation may become hot only when a typed edge makes it a constraint, conflict, finding, verification of a requested claim, or prerequisite for the next action.

The Hot Context projection is fail-closed. Unreachable Claims move to Cold Evidence; a required Hot Context field containing an existence probe, mechanical success, raw coverage, or an orphan Claim fails with `HANDOFF_LOW_VALUE` instead of relying on prose review.

### 2.2 Progress and inspection state

```text
ProgressEvidence {
  assistantProgress: EvidenceReference[]
  inspections: InspectionReceipt[]
}

InspectionReceipt {
  operationClass: content_inspection | existence_probe | verification |
                  mutation | mechanical_success
  location: string | null
  symbols: string[]
  scope: string | null
  outputEvidence: EvidenceReference
}
```

Only `content_inspection` can produce an Inspected Evidence Map entry. `existence_probe` and `mechanical_success` remain Cold Evidence. Verification is hot only when it verifies a retained Claim. Mutation evidence follows the existing change and workspace-state contracts.

Progress Evidence has its own immutable input and dispatch budgets. It neither expands `PreservationLedger.requiredAnchors` nor removes any entry from the complete Evidence Index.

### 2.3 Action-ready continuation state

```text
WorkingSynthesis {
  status: draft_ready | partial | blocked
  sections: Array<{ title, body, findingIds }>
  confirmedFindingIds: string[]
  uncertainties: Array<{ question, allowedScopes, findingIds }>
}

DeliverableStatus {
  deliverableId: string
  request: string
  status: ready | partial | blocked
  findingIds: string[]
  missingReason?: string
}

InspectedEvidenceEntry {
  location: string
  symbols: string[]
  scope: string
  findingIds: string[]
  rereadPolicy: do_not_reread | verify_only | targeted_followup
}

ResumePolicy {
  mode: synthesize_first | execute_next | resolve_blocker
  firstDeliverableIds: string[]
  maxTargetedReads: integer
  allowedReadReasons: Array<claim_verification | named_uncertainty>
  forbidBroadSearch: boolean
  forbidFullFileReread: boolean
}
```

For `review`, `research`, and `diagnosis`, publication requires `mode = synthesize_first`, a non-empty draft-ready or partial Working Synthesis, one status entry for every requested deliverable, complete disposition of content inspections, `forbidBroadSearch = true`, `forbidFullFileReread = true`, and `maxTargetedReads <= 3`. Missing structure fails with `HANDOFF_NOT_ACTIONABLE`.

An `InspectedEvidenceEntry` is not proof that a file exists. It records content scope that was actually read, the findings derived from it, and whether the continuation may revisit that scope.

### 2.4 Handoff rendering boundary

The action-ready Markdown body is ordered for execution rather than audit:

```text
Objective and first deliverable
-> Working Synthesis
-> Deliverable status
-> Confirmed findings and uncertainties
-> Inspected Evidence Map and reread policy
-> Next actions and constraints
-> compact audit footer
```

The body omits raw Terminal-State JSON, full Source metadata, raw Anchor lists, raw Claim-ID lists, full Semantic Coverage, existence probes, mechanical success, and unrelated verification. The compact footer keeps only the original workspace, artifact version, source revision digest, Evidence Index location, coverage counts, and integrity digests needed to find or verify Cold Evidence.

Every displayed evidence-backed fact receives a short Handoff Evidence Key. The Evidence Index maps that key to exact Claim IDs and Evidence Anchors; the continuation task resolves a key only for claim verification and never reads the full index as context.

## 3. Target data flow

```text
Source Thread + workspace observations
  -> complete Evidence Index -------------------------------------> Cold Evidence
  -> Critical Anchor selector -----------------------------------> preservation
  -> Progress Evidence selector
       -> assistant progress
       -> typed successful inspections
       -> existence/mechanical records remain cold
  -> continuation-map-v2
       -> findings + deliverable bindings + inspection disposition
  -> action-ready REDUCE
       -> Working Synthesis
       -> Deliverable Status
       -> Inspected Evidence Map
       -> Resume Policy
  -> Information Value Gate
       -> only value-reachable Claims enter Hot Context
  -> Actionability Gate
       -> task profile has enough state to continue
  -> Handoff v2 renderer
       -> compact Evidence Keys, no raw audit expansion
  -> fresh continuation task
       -> synthesize first
       -> at most three named targeted reads
       -> final deliverable
```

## 4. Slice order

### Slice AH0: Failure fixture and value baseline

**Input**: ADR-0013, a synthetic static-review Source Thread with successful code reads, user-visible progress, trivial existence probes, an interrupted terminal turn, and a mixed Chinese objective/exclusion.

**Produces**: a private-data-free fixture, the expected Hot/Cold classification, and a comparator for actionability, audit expansion, inline evidence noise, and first-deliverable readiness.

**Does not do**: change runtime behavior, copy the real rollout or workspace content, or declare existing evidence validation incorrect.

**Done when**: the fixture reproduces the failure class in which evidence-valid output lacks a usable draft, repeats the full objective as an exclusion, and spends most readable content on audit detail; the expected v2 contract rejects it with `HANDOFF_NOT_ACTIONABLE` or `HANDOFF_LOW_VALUE`.

### Slice AH1: Progress Evidence and Inspection Ledger

**Input**: AH0 fixtures, parsed assistant messages, Tool Receipts, and the existing complete Evidence Index.

**Produces**: bounded Progress Evidence, deterministic operation classes, content-scope Inspection Receipts, stable coverage of selected progress, and separate input metrics.

**Does not do**: change Critical Anchor semantics, MAP output, REDUCE, Handoff rendering, or promote every successful result into the Preservation Ledger.

**Done when**: assistant progress and successful content reads are selectable; existence probes and mechanical success stay cold; duplicate scopes fold deterministically; every selected receipt is classified exactly once; the complete Evidence Index and existing Critical Anchor digest remain unchanged.

### Slice AH2: Versioned Working Synthesis contract

**Input**: AH1 Progress Evidence, the frozen Compression Frame, and existing continuation Claims.

**Produces**: an immutable new-run `continuation-map-v2` binding, strict finding/deliverable/inspection relations, Working Synthesis input, Deliverable Status, Inspected Evidence Map, Resume Policy, and bounded completed results.

**Does not do**: mutate `continuation-map-v1`, render Markdown, choose relevance by model score, or publish an artifact.

**Done when**: every requested deliverable is `ready`, `partial`, or `blocked`; every retained finding has exact evidence; every content inspection is synthesized or explicitly marked for targeted follow-up; malformed relations and over-budget candidates fail deterministically; compatibility modes retain byte-contract routing.

### Slice AH3: Information Value and Actionability gates

**Input**: AH2 completed tables, the frozen task profile, deliverable roots, and complete Cold Evidence.

**Produces**: deterministic Hot Context reachability, compact Handoff Evidence Keys, cold routing for pure observations, `HANDOFF_LOW_VALUE`, and `HANDOFF_NOT_ACTIONABLE` publication gates.

**Does not do**: judge prose quality, delete Cold Evidence, infer missing conclusions, or weaken continuation coverage.

**Done when**: every hot fact is root-reachable and evidence-backed; existence/path confirmations, mechanical success, raw coverage, and orphan Claims cannot enter Hot Context; the AH0 output fails; a partial but useful synthesis with named uncertainties can pass; repeated validation produces identical keys and projections.

### Slice AH4: Clause-level explicit exclusions

**Input**: AH0 mixed Chinese and English objectives plus the current frozen-goal contract.

**Produces**: deterministic exclusion-clause spans and exact anchored exclusion Claims while preserving the byte-exact complete current goal.

**Does not do**: summarize the objective, reinterpret positive clauses, or modify unrelated Frame authority rules.

**Done when**: `看代码，说明流程和复杂度，不要跑测试` yields one complete objective and exactly one `不要跑测试` exclusion; comma lists, English negation, multiple exclusions, and path punctuation remain deterministic; existing standalone exclusions stay compatible.

### Slice AH5: High-value renderer and synthesize-first consumption

**Input**: AH3 Hot Context, AH4 exclusions, Handoff Evidence Keys, and the complete Evidence Index.

**Produces**: versioned Handoff v2 ordering, multiline Working Synthesis, deliverable status, compact inspection/reread rows, short evidence references, compact audit footer, and a consumer contract that requires the first draft before evidence reads.

**Does not do**: embed Cold Evidence, raw Anchor/Claim lists, complete terminal payloads, or allow arbitrary source exploration.

**Done when**: the AH0 fixture renders no existence confirmation, raw coverage list, raw Terminal JSON, Git probe, or mechanical verification; useful synthesis precedes audit metadata; Evidence Keys resolve exactly; a consuming task receives `synthesize_first`, zero pre-draft reads, no broad search, and at most three targeted-read capabilities.

### Slice AH6: Compatibility, packaging, and live continuation acceptance

**Input**: AH0-AH5, repository and installed Skill packages, one fresh Compression Task, and a separate fresh continuation task.

**Produces**: updated contracts, Skill workflow, architecture, code trail, installed mirror, one Handoff v2/Evidence Index pair, and one measured continuation result.

**Does not do**: overwrite the retained failure artifact, resume its Source Thread, migrate existing work directories, relax evidence/size/time gates, or use the Compression Task as the consumer.

**Done when**: all repository tests and validators pass; repository and installed packages match; legacy routes remain green; `verify-evidence` passes; Handoff stays within 40,000 characters; Compression Run remains within 600,000 ms; the continuation task emits a substantive draft before its first tool call, performs zero broad searches and full-file rereads, uses at most three claim-bound targeted reads, and delivers every requested review/research/diagnosis item or names its remaining uncertainty.

## 5. Verification matrix

| Boundary | Deterministic acceptance evidence |
| --- | --- |
| Hot and cold stay distinct | Complete Evidence Index digest is unchanged while existence probes and mechanical success are absent from Hot Context |
| Critical does not imply rendered | Every Critical Anchor is covered, but only value-reachable projections appear in Markdown |
| Working knowledge survives | Assistant progress and content inspections reach evidence-backed findings and deliverable sections |
| File existence is not insight | Existence-only fixtures produce no Working Synthesis or Inspected Evidence Map row |
| No orphan context | Every displayed fact is graph-reachable from a deliverable or Resume Policy root |
| No subjective publication judge | Validators use schema, references, reachability, budgets, and exact comparisons only |
| Mixed goals stay intact | Full goal remains byte-exact while only negative clauses become explicit exclusions |
| Evidence stays retrievable | Every Handoff Evidence Key resolves through a verified Evidence Index to exact anchors |
| Continuation starts with output | Fresh consumer emits the first draft before any evidence read |
| Exploration is bounded | Zero broad searches/full-file rereads and at most three named targeted reads |
| Compatibility is preserved | Legacy v1, missing-mode v2, `sparse-map-v1`, and `continuation-map-v1` retain their frozen contracts |

## 6. Compatibility and rollback

- `continuation-map-v2` and Handoff v2 apply only to newly prepared Compression Runs and are immutable once bound.
- Existing work directories and published artifacts continue through their recorded Frame, MAP, REDUCE, renderer, and consumer contracts without migration.
- The complete Evidence Index remains the Cold Evidence boundary; Hot Context filtering never deletes or rewrites indexed entries.
- Rollback disables v2 for future prepares and never rewrites a Source Thread, work directory, Handoff, or Evidence Index.
- A legacy consumer may read a legacy Handoff, but only a v2-aware consumer may claim the synthesize-first and targeted-read guarantees.
