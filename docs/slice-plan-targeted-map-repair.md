# Targeted MAP Repair Slices

## Frozen intent

When a validation problem belongs to one MAP candidate, report every deterministically known issue
with precise correction guidance and repair only that segment. Keep unrelated validated MAP work,
Critical Anchor rules, and the Information Value Gate unchanged. Never automatically start a clean
Compression Run as error recovery.

## Failure ownership

```text
MAP candidate rule -> validate-map --check/--complete -> same attempt or that segment's attempt-2
REDUCE candidate rule -> validate-reduce --check       -> rewrite reduced.json only
run/integrity rule   -> owning boundary                -> retain workdir and stop
```

A later stage reporting an earlier owner's rule is a validator-placement defect. The fix is to move
the deterministic rule to the owner boundary, not to replay the whole pipeline.

## Slice TR1 — Diagnostic contract

**Input**: existing continuation-map-v2 candidate validation and the retained live failure classes.

**Produces**: a bounded `MAP_REPAIR_REQUIRED` diagnostic containing `repairScope`, `segmentId`, and
an ordered `issues` list. Every issue names a stable rule code, candidate field path, explanation,
and correction hint. Candidate-local rules are collected in one pass where deterministic.

**Done when**: a single invalid candidate reports the non-Critical exclusion and every low-value
Finding together without consuming the Worker attempt.

**Implementation evidence**: `validation.mjs:actionReadyCandidateRepairIssues` collects
non-Critical exclusions, low-value verification Findings, and misclassified verification Findings
after structural validation, then emits one evidence-free `MAP_REPAIR_REQUIRED` detail object.
`checkMapDispatch` leaves the current manifest unchanged, while the existing `completeMapDispatch`
failure path preserves the same issue list when it creates only that segment's attempt-2 dispatch.

**Acceptance evidence**: `targeted-map-repair-tr1.test.mjs` passes 1/1; the focused MAP/action-ready
regression passes 20/20; the complete Node suite passes 179/179 with zero skips.

## Slice TR2 — Targeted retry workflow

**Input**: TR1 diagnostics and the existing two-attempt MapDispatch lifecycle.

**Produces**: same-attempt correction after `--check`; if `--complete` fails, the existing
attempt-2 dispatch is returned with the bounded repair diagnostic. Unrelated stages and receipts are
unchanged.

**Done when**: a corrected candidate completes in the retained workdir and no other dispatch ID,
receipt digest, or provider observation changes.

**Implementation evidence**: `targeted-map-repair-tr2.test.mjs` drives the existing
`checkMapDispatch` non-consuming path through same-attempt correction, then separately drives
`completeMapDispatch` failure through the returned segment-only attempt-2 dispatch. Both paths
complete and accept the corrected candidate without requiring a production workflow change.

**Acceptance evidence**: the test freezes every unrelated dispatch ID plus one unrelated accepted
receipt's exact bytes/digest and provider observation's serialized bytes before repair, then proves
them unchanged after both correction paths. TR1/TR2 plus MAP Worker and Action-ready regressions pass
32/32; the complete Node suite passes 181/181 with zero skips.

## Slice TR3 — Operator contract

**Input**: TR1/TR2 runtime behavior.

**Produces**: Skill and Worker instructions that pass the exact issue list to the responsible
Worker, prohibit clean-run recovery, and route REDUCE-owned defects to REDUCE-only correction.

**Done when**: the documented state machine has no instruction that restarts all MAP Workers for an
attributable candidate problem.

**Implementation evidence**: `SKILL.md` Workflow step 4 passes the exact ordered
`details.issues[]` unchanged through same-attempt and attempt-2 repair, forbids clean-run recovery
and unrelated MAP replay, and Workflow step 7 confines REDUCE-owned diagnostics to `reducedPath`.
`continuation-map-v2-worker-contract.md` makes the issue list the Worker repair contract and limits
each correction to the named segment candidate.

**Acceptance evidence**: the authentic TR3 red failed 3/3 documentation assertions; TR3 then passes
3/3. TR1-TR3 plus MAP Worker and Action-ready regressions pass 35/35; Skill, Markdown-link, and
compatibility regressions pass 15/15; the complete Node suite passes 184/184 with zero skips, and
`git diff --check` passes. No runtime file changed and TR4 remains unopened.

## Slice TR4 — Deterministic acceptance

**Input**: the three retained failure classes: non-Critical exclusion, existence/mechanical
Finding, and misclassified test-result Finding.

**Produces**: regression tests for issue aggregation, same-attempt repair, attempt-2 feedback, and
unrelated MAP retention.

**Done when**: focused tests and the complete Node test suite pass, and architecture/code-trail
documentation records the earliest-owner boundary.
