# Provider Timing Capability and Multi-Wave Recovery Slices

Status: accepted; PT0 ready for controller verification (authentic red); PT1-PT5 pending

Scope: make multi-wave MAP scheduling fail before semantic work when trustworthy provider timing is unavailable, and consume dispatch-bound provider observations when the execution surface supports them.
Decision: [ADR-0014 Provider Timing Capability for Multi-Wave MAP](./adr/0014-provider-timing-capability-for-multi-wave-map.md).

## 1. Frozen intent

The repair separates three facts that the current workflow conflates:

```text
Provider latency          -> optional provider telemetry and controlled calibration
Workflow elapsed time     -> end-to-end phase accounting, never relabeled as provider latency
Provider Timing Capability -> whether a structurally multi-wave run may start MAP at all
```

The implementation will:

- reject an already-unreachable ten-minute budget before dispatching a MAP Worker;
- observe fresh dedicated Worker slots before deciding whether a later wave is structurally required;
- require Provider Timing Capability before the first MAP wave only when `totalDispatches > availableSlots`;
- record each provider observation after the Worker turn completes and bind it to the immutable MapDispatch;
- require exactly one valid first-wave provider observation per accepted first-wave dispatch before projecting a later wave;
- retain `LIVE_BUDGET_UNREACHABLE` for a complete projection above 600,000 ms;
- introduce `PROVIDER_TIMING_UNAVAILABLE` for a known unsupported execution surface and reserve `INCOMPLETE_FIRST_WAVE_METRICS` for broken or incomplete observations after capability was declared;
- preserve atomic publication, Source Thread isolation, private MAP evidence isolation, and the two-attempt Worker circuit breaker.

This initiative does not infer provider latency from `spawn`, `wait`, claim-to-check, shell, coordinator, or harness clocks. It does not merge `progress_map` into another semantic dispatch, weaken the live target, resume the retained failed work directory, migrate frozen manifests, or publish a partial Handoff.

## 2. Characterized failure baseline

The retained diagnostic run at `C:\Users\Lenovo\AppData\Local\Temp\codex-handoff-task-RqGiDo` established only bounded workflow facts:

- `continuation-map-v2` prepared four initial dispatches: two fragment MAPs, one workspace MAP, and one progress MAP;
- three fresh Worker slots accepted the first three dispatches on attempt 1 with no retry; `progress-map-001` remained pending;
- all accepted stages recorded workflow-owned check, complete, and accept durations, while the manifest contained zero `calibration` objects;
- the production `validate-map --check` CLI exposed no provider-observation argument, and the collaboration result surface exposed no per-worker provider generation duration;
- later-wave projection failed with `INCOMPLETE_FIRST_WAVE_METRICS: mapGenerationSamples must contain at least one duration`;
- `createdAt` to `frameValidatedAt` was 644,844 ms, already above the 600,000 ms total target;
- with zero provider generation, REDUCE, and publication duration, the deterministic lower bound was still 645,060 ms;
- neither public artifact existed, and no private MAP candidate or Evidence Pack is needed for the repair fixtures.

The fixture for this initiative copies only those counts, durations, statuses, and diagnostic codes. It contains no Source Thread text, private MAP output, Evidence Anchor, or workspace content.

## 3. Target control flow

```text
FRAME_VALIDATED
  -> PRE_DISPATCH_LOWER_BOUND
       -> over target: LIVE_BUDGET_UNREACHABLE; zero MAP claims
       -> within target: OBSERVE_FRESH_SLOTS
            -> zero slots: MAP_WORKER_UNAVAILABLE
            -> all dispatches fit: DISPATCH_SINGLE_WAVE
            -> later wave required: CHECK_PROVIDER_TIMING_CAPABILITY
                 -> unavailable: PROVIDER_TIMING_UNAVAILABLE; zero MAP claims
                 -> available: DISPATCH_FIRST_WAVE
                      -> accept Worker receipts
                      -> record dispatch-bound provider observations
                      -> require complete first-wave observation set
                      -> PROJECT_LATER_WAVE_WITH_FRESH_SLOTS
                           -> over target: LIVE_BUDGET_UNREACHABLE
                           -> within target: DISPATCH_NEXT_WAVE
```

### 3.1 Typed boundary

```text
ProviderTimingCapability {
  available: boolean
  source: provider | null
  observationPoint: post_worker | null
  reasonCode: not_exposed | not_correlatable | null
}

MapGenerationObservation {
  providerObservationId: string
  dispatchId: string
  segmentId: string
  providerLatencyMs: non-negative number
  source: provider
  model: string
  reasoningEffort: string
  wave: positive integer
  availableSlots: positive integer
}

recordMapGenerationMetric(
  workDir,
  segmentId,
  dispatchId,
  observation
) -> { recorded: true, metricDigest: sha256 } | deterministic error
```

The observation ingress runs after the Worker turn exposes provider timing and before any later-wave scheduling. It may read the manifest, accepted MapReceipt, and immutable dispatch identity; it must not read `chunkPath`, `summaryPath`, or `completedSummaryPath`. Repeated identical observations are idempotent; conflicting observations fail closed.

### 3.2 Admission pseudocode

```text
lowerBound = projectPreDispatchLowerBound(manifest, reserves)
if lowerBound.abort:
  return LIVE_BUDGET_UNREACHABLE with zero dispatches

slots = observeFreshDedicatedSlots()
if slots == 0:
  return MAP_WORKER_UNAVAILABLE

if totalDispatches > slots:
  capability = observeProviderTimingCapability()
  if !capability.available:
    return PROVIDER_TIMING_UNAVAILABLE with zero dispatches

dispatch first wave within slots
accept receipts and record provider observations

if dispatches remain:
  require one observation for every accepted first-wave dispatch
  slots = observeFreshDedicatedSlots()
  projection = projectFirstWaveBudget(samples, slots, reserves)
  dispatch next wave only when projection.abort == false
```

## 4. Slice order

### Slice PT0: Production-boundary characterization

**Input**: ADR-0014, the bounded baseline in section 2, current CLI parsing, current calibration validators, and synthetic MapDispatch fixtures.

**Produces**: a private-data-free four-dispatch/three-slot fixture; a failing integration test proving the production CLI cannot record provider timing; and explicit expected diagnostics for over-budget, unavailable-capability, and incomplete-observation states.

**Does not do**: inspect the retained Evidence Pack or MAP candidates, change runtime behavior, or encode Source Thread identifiers into fixtures.

**Done when**: the fixture reproduces the empty-sample failure through the same exported functions and CLI boundary, existing R6 tests remain green, and the new tests fail only because the capability and post-worker ingress do not yet exist.

**PT0 implementation evidence**: [provider-timing-fixtures.mjs](../skills/export-codex-handoff/tests/fixtures/provider-timing-fixtures.mjs) contains four synthetic `continuation-map-v2` dispatch definitions, three fresh slots, three accepted stages with workflow-owned check/complete/accept durations `52/53/54`, one pending stage, zero calibration objects, `644844` ms prepare/frame elapsed time, an unavailable capability observation, and only the three frozen diagnostics. [provider-timing-pt0.test.mjs](../skills/export-codex-handoff/tests/provider-timing-pt0.test.mjs) dynamically loads the production Worker, calibration, and workflow exports; validates/schedules the synthetic dispatches; reproduces `INCOMPLETE_FIRST_WAVE_METRICS: mapGenerationSamples must contain at least one duration`; exercises the production `validate-map --check` parser; and keeps the two future boundaries independently visible.

**Exact red evidence**: `node --test --test-isolation=none skills/export-codex-handoff/tests/provider-timing-pt0.test.mjs` exits `1` with 4 tests: 2 pass and 2 fail. The only failures are (1) multi-wave admission returns three dispatches and no diagnostic instead of zero dispatches with `PROVIDER_TIMING_UNAVAILABLE`, and (2) the workflow export exposes `recordMapGenerationMetric` as `undefined` instead of a post-worker function. The empty-sample and production-CLI characterization tests pass.

**Exact green evidence**: `node --test --test-isolation=none skills/export-codex-handoff/tests/continuation-grade-r6.test.mjs skills/export-codex-handoff/tests/map-worker.test.mjs skills/export-codex-handoff/tests/sparse-map-contract.test.mjs` exits `0` with 14/14 tests passing. In the managed Windows sandbox, this unchanged regression command used the allowlisted `TEMP`/`TMP` variables redirected to `skills/export-codex-handoff/tests/fixtures` so its pre-existing nested CLI subprocess could execute; the argv and production behavior were unchanged.

### Slice PT1: Pre-dispatch lower-bound gate

**Input**: PT0 fixture, `createdAt`, `frameValidatedAt`, target duration, and conservative REDUCE/publication reserves.

**Produces**: `projectPreDispatchLowerBound`; a deterministic gate immediately after Frame validation; and terminal reporting for an already-unreachable total budget.

**Does not do**: require a provider sample, schedule a Worker, change the 600,000 ms target, or classify workflow time as provider time.

**Done when**: the 644,844 ms fixture returns `LIVE_BUDGET_UNREACHABLE` before any claim; a within-budget fixture proceeds unchanged; missing or invalid phase boundaries fail deterministically; and the terminal report contains phase timings with zero accepted MAPs.

### Slice PT2: Provider Timing Capability preflight

**Input**: PT1-admitted runs, total dispatch count, a freshly observed dedicated slot count, and an execution-surface capability observation.

**Produces**: validated `ProviderTimingCapability`; structural single-wave versus multi-wave admission; and early `PROVIDER_TIMING_UNAVAILABLE` failure with zero MAP claims.

**Does not do**: synthesize capability from model identity, reuse an earlier slot count, block a structurally single-wave run, or collect a MAP duration.

**Done when**: four dispatches with three slots and unavailable timing fail before Worker creation; three dispatches with three slots remain admissible; available capability admits the first wave; and zero slots still returns `MAP_WORKER_UNAVAILABLE` before capability evaluation.

### Slice PT3: Post-worker provider-observation ingress

**Input**: PT2 capability, one completed Worker turn, its immutable MapDispatch, accepted MapReceipt, and execution-surface provider observation.

**Produces**: `recordMapGenerationMetric`; a CLI or host adapter that writes a digest-bound metric after Worker completion; correlation checks for dispatch, segment, model, reasoning effort, wave, and fresh slot count; and idempotent persistence in the managed manifest.

**Does not do**: accept arbitrary harness durations, reopen private evidence, mutate a MapReceipt, attach timing during Worker-side `--check`, or retrofit a frozen work directory.

**Done when**: a valid provider observation records once; identical replay is stable; conflicting identity, source, duration, or configuration fails; no MAP candidate is read; and the accepted receipt digest remains unchanged.

### Slice PT4: Later-wave scheduling and terminal diagnostics

**Input**: PT3 observations for every accepted first-wave dispatch, workflow check/complete/accept durations, prepare/frame timing, conservative reserves, remaining dispatches, and a newly observed slot count.

**Produces**: deterministic first-wave sample collection; later-wave invocation of `projectFirstWaveBudget`; persisted scheduling-stage failure reports; and bounded ready, unavailable, incomplete, or unreachable outcomes.

**Does not do**: tolerate a missing sample after capability was declared, reuse first-wave slots, dispatch above fresh capacity, or convert a scheduling failure into a Worker retry.

**Done when**: complete samples either dispatch the next wave or return `LIVE_BUDGET_UNREACHABLE`; an absent or duplicate sample returns `INCOMPLETE_FIRST_WAVE_METRICS`; every failure retains the work directory and all accepted receipts; and no public output appears before REDUCE and transactional publication.

### Slice PT5: Compatibility, packaging, and live acceptance

**Input**: PT0-PT4, legacy and continuation compatibility suites, repository and installed skill packages, and one fresh supported execution surface.

**Produces**: updated CLI help, Skill workflow, contracts, architecture, code trail, installed-package synchronization, and one fresh multi-wave acceptance report or an explicit external-capability blocker.

**Does not do**: claim live success on an unsupported surface, use the retained failed work directory, weaken provider-source validation, migrate existing manifests, or relax output and time budgets.

**Done when**: legacy v1, missing-mode v2, `sparse-map-v1`, `continuation-map-v1`, and single-wave v2 remain compatible; repository and installed files match; unsupported timing fails before the first claim; a supported four-dispatch/three-slot run records complete provider samples; publication and `verify-evidence` succeed atomically with `phaseTimingsMs.total <= 600000`; otherwise PT5 remains blocked with the exact missing capability named.

## 5. Acceptance matrix

| Pre-dispatch state | Required result |
| --- | --- |
| Lower bound exceeds 600,000 ms | `LIVE_BUDGET_UNREACHABLE`, zero MAP claims |
| No fresh Worker slot | `MAP_WORKER_UNAVAILABLE`, zero MAP claims |
| All dispatches fit one wave, timing unavailable | Single wave may proceed; provider metric remains explicitly incomplete |
| Later wave required, timing unavailable | `PROVIDER_TIMING_UNAVAILABLE`, zero MAP claims |
| Timing declared available, first-wave sample missing | `INCOMPLETE_FIRST_WAVE_METRICS`, retain accepted receipts |
| Complete samples project above target | `LIVE_BUDGET_UNREACHABLE`, no later-wave dispatch |
| Complete samples project within target | Dispatch only within the newly observed slot count |

## 6. Compatibility and rollback

- New capability and metric fields apply only to new workflow bindings; existing work directories retain their recorded behavior and are never migrated.
- Provider observations are additive integrity state and never enter MapReceipt, MAP candidate, Evidence Index, or public Handoff content.
- Rolling back disables multi-wave admission on surfaces without provider timing; it does not permit coordinator-side sequential MAP or elapsed-time substitution.
- The retained diagnostic directory remains diagnosis evidence only and is never a test input, migration source, or publication candidate.
