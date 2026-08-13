# Arbitrary-Wave MAP Scheduling Slice

Status: complete.

Scope: change only MAP wave admission and continuation so any dispatch count can complete through repeatedly refreshed capacity. Keep MAP semantics, repair policy, REDUCE content, and TR6 unchanged.

Decision: [ADR-0017 Deadline-Governed Arbitrary-Wave MAP Scheduling](./adr/0017-deadline-governed-arbitrary-wave-map-scheduling.md).

## Slice A1 — Deadline-governed wave loop

**Input**: an ordered pending MapDispatch set, a fresh slot observation for each wave, the workflow total deadline, and optional dispatch-bound provider timing.

**Produces**: a scheduling loop with this invariant:

```text
while pending > 0:
  slots = observe fresh slots
  require slots > 0 and workflow deadline permits another wave
  wave = take min(pending, slots)
  execute and accept wave
  pending = pending minus accepted wave
  if valid provider timing exists, generate the performance projection
```

Provider timing never controls admission. When timing is absent, the workflow deadline remains the independent next-wave gate and the workflow does not write `providerLatencyMs`.

**Does not do**: change MAP semantics, targeted repair, REDUCE content, TR6, provider-observation correlation, or provider source validation.

**Done when**: one zero-provider-timing integration regression schedules seven dispatches across fresh slot observations `3 -> 2 -> 1 -> 1`, accepts wave sizes `3 -> 2 -> 1 -> 1` exactly once, completes all pending work, and records no `providerLatencyMs`; provider-latency source validation and the complete test suite also pass.

## Acceptance evidence

The seven-dispatch regression completes waves `3 -> 2 -> 1 -> 1` without provider timing. Public
claims reject dispatches outside the unique current unaccepted admission, while adjudication can
reopen an earlier accepted generation without bypassing the durable ledger. A synthesized creation
clock proves `workflowDeadlineAt = createdAt + 600000ms` in both manifest and immutable binding.
The complete suite passes 256/256 with zero skips; installed-Skill parity acceptance passes 15/15
with all 88 package files byte-identical; `git diff --check` passes.
