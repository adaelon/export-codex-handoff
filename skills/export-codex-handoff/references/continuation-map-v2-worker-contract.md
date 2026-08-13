# Action-ready Continuation MAP Worker Contract

Read this file only for a `MapDispatch` whose `mapResultMode` is
`continuation-map-v2`. Write one strict JSON object to `summaryPath`; do not write Markdown
fences. The exact serialized candidate, including whitespace and its final newline, must not exceed
the dispatch `maxMapOutputChars`, which is at most 4,000 characters. Deterministic completion is
separately capped at 16,000 characters.

## Output shape

```text
ActionReadyContinuationMapResult {
  formatVersion: 2
  kind: codex-handoff-continuation-map
  frameId: string
  frameDigest: sha256
  segmentId: string
  claims: ContinuationClaim[]
  relations: ContinuationRelations
  criticalExclusions: CriticalExclusion[]
  findings: Array<{
    localId: positive integer
    claim: positive integer
  }>
  deliverables: Array<{
    deliverableId: string
    request: string
    status: ready | partial | blocked
    findingIds: positive integer[]
    missingReason?: string
  }>
  inspectionDispositions: Array<{
    inspectionId: string
    findingIds: positive integer[]
    rereadPolicy: do_not_reread | verify_only | targeted_followup
  }>
}
```

`ContinuationClaim`, `ContinuationRelations`, and `CriticalExclusion` retain the exact
`continuation-map-v1` shapes. A Finding points to one local Claim of kind `completed_work`,
`conflict`, `decision`, `rationale`, `lesson`, or `verification`; it does not repeat Claim text or
evidence indexes. Every Finding must be reachable from at least one deliverable. `ready` and
`partial` deliverables require Findings; `partial` and `blocked` deliverables require a non-empty
`missingReason`.

Only the dispatch whose private chunk has `stage: progress_map` may author non-empty `findings`,
`deliverables`, or `inspectionDispositions`. Its bounded `progressEvidence` contains the complete
selected inspection set. The Progress MAP must author at least one action-ready relation. When its
Progress Evidence supports no Finding, write one `blocked` deliverable with empty `findingIds` and a
concrete `missingReason`; never invent a Claim or Finding merely to make the arrays non-empty. Copy
each inspection's `outputEvidence.referenceId` as `inspectionId` and dispose every inspection exactly
once:

- `do_not_reread` or `verify_only` requires at least one Finding whose Claim cites that inspection's
  output evidence;
- `targeted_followup` explicitly leaves the scope available for a bounded later read and may have no
  Finding;
- existence probes, verification commands, mutations, and mechanical success never appear as
  inspection dispositions because they are absent from Progress Evidence inspections.

Non-progress dispatches write empty action-ready arrays while retaining or explicitly excluding
their Critical Anchors through the unchanged continuation Claim contract. Never explicitly exclude
an Anchor already retained by the frozen Current Goal, explicit exclusions, Accepted Proposal, or
Terminal-State Claim; deterministic completion preserves those Frame authorities. Do not emit
global Claim IDs, Finding IDs, Evidence Anchor strings, REDUCE fields, raw Progress Evidence outside
its private chunk, or prose outside the JSON object.

## Coordinator handback and adjudication

The Worker owns only its private candidate. It returns a contract-valid `MapReceipt` or the exact
bounded diagnostic emitted by deterministic check/completion; it never chooses a run-level repair or
regeneration action. A Captured Workflow Diagnostic enters Main Codex Adjudication
in the same Compression Run. The coordinator must persist the exact evidence-safe `issues[]` in the
active Adjudication Request, and must not ask the user to choose the repair action.

After Main Codex applies `repair_stage`, the coordinator passes the request's ordered `issues[]`
unchanged to the responsible Worker and resumes only the recorded command on the same dispatch. If a
same-dispatch correction cannot be proven, Main Codex may select `regenerate_stage` to supersede only
the responsible generation; otherwise the diagnostic remains active. No Worker starts a clean
Compression Run or replays an unrelated dispatch.

## Deterministic completion

Run the non-consuming check and completion in order:

```text
node <skill-dir>/scripts/export-handoff.mjs validate-map <WORK_DIR> <SEGMENT_ID> --check <DISPATCH_ID>
node <skill-dir>/scripts/export-handoff.mjs validate-map <WORK_DIR> <SEGMENT_ID> --complete <DISPATCH_ID>
```

If `--check` reports `MAP_REPAIR_REQUIRED`, the exact ordered `details.issues[]` is the repair
contract. Apply every named `fieldPath` using its `correctionHint`, change only this private
candidate, and rerun `--check` on the same dispatch. Do not reinterpret, summarize, or replace the
issue list with generic retry guidance.

If completion reports `MAP_REPAIR_REQUIRED`, it freezes the current candidate, retains the exact
ordered `details.issues[]`, and opens an Adjudication Request without creating `nextDispatch`.
`repair_stage` returns the responsible Worker to the same dispatch; `regenerate_stage` creates a new
generation only after Main Codex explicitly selects it. Other completion diagnostics remain bounded
and unchanged; do not invent an issue list. Never start a clean Compression Run; never replay
unrelated MAP Workers, accepted receipts, or other candidates.

Completion preserves the v1 global Claim and relation derivation, derives each global Finding ID
from its completed Claim ID, resolves inspection coordinates from immutable Progress Evidence, and
writes one private completed result. The bounded receipt contains raw and completed digests plus
their character counts. Return only that receipt to the coordinator.

After all receipts are accepted, `prepare-reduce` produces one `workingSynthesisInput` with global
Finding-to-Claim bindings, complete deliverable status, and the deterministic Inspected Evidence Map
projection. It also emits `actionReadyOutputContract`, requiring `workingSynthesis`,
`deliverableStatus`, `inspectedEvidenceMap`, and `resumePolicy`. This Worker does not publish a v2
Handoff; publication remains fail-closed until the action-ready renderer is installed.
