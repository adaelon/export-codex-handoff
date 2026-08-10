# Provider Timing Live Acceptance — 2026-08-10

Status: BLOCKED

## Acceptance target

A supported fresh execution surface must run four synthetic-safe `continuation-map-v2` dispatches
with three freshly observed dedicated slots, expose one durable provider observation for each
accepted first-wave dispatch, schedule the remaining dispatch from those complete samples, publish
the Handoff and Evidence Index atomically, pass `verify-evidence`, and report
`phaseTimingsMs.total <= 600000`.

## Exact external capability blocker

The current Codex collaboration surface exposes no provider-reported per-worker generation duration
and no durable provider observation identity correlated with one immutable MapDispatch. Its agent
lifecycle data cannot supply the required `providerLatencyMs`, `source: provider`,
`providerObservationId`, dispatch identity, model, reasoning effort, wave, and fresh-slot binding.
Coordinator, spawn, wait, shell, and harness clocks are explicitly ineligible substitutes.

## Observed surface

- Observation date: 2026-08-10, Asia/Hong_Kong.
- `collaboration.list_agents` returned only the root agent identity and `running` status; it exposed no
  provider timing field.
- The available collaboration lifecycle contracts expose agent status and result content, but no
  provider-reported duration receipt or MapDispatch correlation field.
- No semantic MAP Worker was launched. The retained failed work directory was not read, resumed,
  migrated, or used as acceptance input.

## Deterministic fail-early proof

The private-data-free PT5 fixture supplies four production `continuation-map-v2` MapDispatches, three
fresh slots, and this exact capability observation:

```text
{
  available: false,
  source: null,
  observationPoint: null,
  reasonCode: not_exposed
}
```

Production `scheduleMapDispatches` returns `PROVIDER_TIMING_UNAVAILABLE` with zero admitted
dispatches. The input dispatches remain unchanged, no claim is created, and a workflow-sourced
`MapGenerationObservation` still fails `INVALID_PROVIDER_LATENCY`. This proves the unsupported
surface stops before semantic work without weakening provider-source validation.

## Consequence and unblock condition

Repository compatibility, packaging, and deterministic unsupported-surface behavior can be
accepted, but a four-dispatch/three-slot live publication cannot be claimed on this surface. Live
acceptance remains blocked until the collaboration result exposes a durable provider-reported
post-worker duration receipt correlated with the exact MapDispatch and execution configuration.
When that field exists, run only a new fresh Compression Task; do not reuse any retained work
directory or relax the 600,000 ms, output, publication, or evidence-verification gates.
