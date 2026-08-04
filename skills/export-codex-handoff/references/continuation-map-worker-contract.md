# Continuation MAP Worker Contract

Read this file only for a `MapDispatch` whose `mapResultMode` is
`continuation-map-v1`. Write one strict JSON object to `summaryPath`; do not write Markdown
fences. The exact serialized file, including whitespace and its final newline, must not exceed the
dispatch `maxMapOutputChars`, which is always at most 4,000.

## Output shape

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
    evidenceIndexes: positive integer[]
  }>
  relations: {
    decisions: Array<{
      statement: integer
      rationale: integer[]
      status: active | superseded | rejected
      supersedes: integer[]
    }>
    attempts: Array<{
      goal: integer
      action: integer
      outcome: integer
      lesson?: integer
      failureClass?: string
    }>
    verification: Array<{
      claim: integer
      command: string
      result: pass | fail | not_run | unknown
    }>
  }
  criticalExclusions: Array<{
    evidenceIndex: positive integer
    reasonCode: superseded | duplicate | out_of_scope | no_continuation_value
  }>
}
```

`localId` values identify Claims only inside this candidate. `evidenceIndexes` and exclusion
indexes are positive references from the dispatch Evidence Reference Dictionary, not positions in
the turn array. Copy Claim text exactly from evidence when an exact source value matters.

Do not emit global Claim IDs, Evidence Anchor strings, `claimGroups`, `claimBindings`,
`exclusionRanges`, `compressionNotes`, REDUCE fields, or prose outside the JSON object. Author each
Claim body once. Typed relations refer to `localId` values: decision statements and superseded
statements use `decision` Claims, attempt fields use their matching attempt kinds, and verification
text is exactly `<command> => <result>`.

## Deterministic completion

The Worker runs the non-consuming check before completion:

```text
node <skill-dir>/scripts/export-handoff.mjs validate-map <WORK_DIR> <SEGMENT_ID> --check <DISPATCH_ID>
node <skill-dir>/scripts/export-handoff.mjs validate-map <WORK_DIR> <SEGMENT_ID> --complete <DISPATCH_ID>
```

The check validates local references and freezes the raw candidate digest without consuming an
attempt. Completion rejects post-check mutation, derives global Claim IDs from Claim kind, text, and
byte-exact dictionary anchors, converts typed relations to global IDs, and writes one private
compact Claim table. The bounded `MapReceipt` contains only the raw `summaryDigest`, the
`completedSummaryDigest`, and their character counts. Return that receipt to the coordinator;
never return the private dictionary, evidence, candidate, or completed table.
