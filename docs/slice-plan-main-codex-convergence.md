# Main Codex Complete-Handoff Convergence Slices

## Frozen intent

Every recoverable failure after a Compression Run becomes durable is owned by Main Codex. Main
Codex diagnoses the exact failure, directs a bounded repair or responsible-stage regeneration,
revalidates the result, and continues until a normal Handoff and Evidence Index pair pass every
publication and evidence gate. A Worker may execute an isolated MAP repair, but it never chooses the
repair, accepts its own result, publishes an artifact, or ends the run. No Degraded Handoff is a
lawful result. Process or machine loss, loss of the coordinator, and absence of every writable work
or publication target remain outside the software guarantee.

## Authority and state model

```text
RUNNING
  -> captured diagnostic -> AWAITING_ADJUDICATION
  -> Main Codex directed repair/regeneration/relocation -> APPLYING_ADJUDICATION
  -> action applied -> RUNNING at the exact recorded resume command
  -> action application failed -> AWAITING_ADJUDICATION (linked successor)
  -> normal pair published and reverified -> PUBLISHED
```

`PUBLISHED` requires a normal Handoff. Repeated diagnostics, exhausted Worker attempts, unavailable
capacity, invalid decisions, failed applications, and publication problems are resumable and never
authorize an incomplete artifact.

## Decision vocabulary

| Action | Main Codex obligation | Result |
| --- | --- | --- |
| `repair_stage` | Identify and direct the smallest evidence-preserving correction to the named Failure Owner artifact | Re-run only the recorded responsible command |
| `regenerate_stage` | Supersede the named authored generation when local correction is unsafe or exhausted | Validate the fresh responsible-stage generation |
| `relocate_publication` | Select a fresh absent output pair for a path-only publication defect | Re-run normal publication |

No action suppresses validation, mutates an accepted receipt, replays unrelated MAP work, or
publishes unresolved diagnostics.

## Slices

### MC0 — Contract red

- Freeze that every phase policy excludes `publish_degraded` and blind `retry_stage`.
- Freeze that a retired degradation submission produces no output and leaves its request active.
- Freeze that only a normal verified pair can produce durable `PUBLISHED`.

### MC1 — Repair authority

- Replace blind retry with `repair_stage` throughout request, decision, CLI, and application contracts.
- Preserve exact diagnostic issues, artifact coordinates, immutable digests, and accepted receipts.
- Keep failed applications linked and resumable without a retry-count terminal.

### MC2 — Normal publication terminal receipt

- Reverify the written normal pair and append a bound publication receipt to the run ledger.
- Replay the receipt as the sole `PUBLISHED` transition and reject later managed work.
- Make publication replay idempotent when the exact already-written pair is present.

### MC3 — Failure-owner convergence

- Route MAP candidate corrections to an isolated Worker under the exact Main Codex directive.
- Route Frame and REDUCE corrections to Main Codex-authored candidates.
- Route unsafe local corrections to responsible-stage regeneration and path failures to relocation.

### MC4 — Operator contract

- Rewrite the Skill, Worker contract, CLI help, architecture, and acceptance procedure around the
  complete-Handoff invariant.
- Remove degradation guidance and require immediate inspection of every linked successor request.

### MC5 — Verification

- Run focused authority, repeated-failure, normal-publication, transaction, and package tests.
- Run the complete repository suite with zero failures and compare the repository Skill tree with an
  explicitly supplied installed directory when available.
