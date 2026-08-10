# SESSION_CHECKPOINT — 2026-08-10 11:30 +08:00

## Freshness check

- Commit at write time: `2d6f595 fix: keep publication outputs out of workspace revision`.
- On read, compare with `git log --oneline -3`; if HEAD differs, trust Git and re-audit the uncommitted files before PT0.

## What's in progress

PT0 Production-boundary characterization is the active slice: freeze a private-data-free four-dispatch/three-slot fixture and an authentic production-CLI failure characterization before changing runtime behavior.

## Next steps (ready to hand off)

1. Create `skills/export-codex-handoff/tests/fixtures/provider-timing-fixtures.mjs` with synthetic four-dispatch/three-slot state, accepted workflow durations `52/53/54`, zero calibration objects, and `644844` ms prepare/frame elapsed time.
2. Create `skills/export-codex-handoff/tests/provider-timing-pt0.test.mjs` to reproduce the empty `mapGenerationSamples` diagnostic and prove the production `validate-map --check` CLI has no provider-observation ingress.
3. Run `node --test skills/export-codex-handoff/tests/provider-timing-pt0.test.mjs`; retain the authentic PT0 red for the missing capability/ingress and do not edit runtime code in PT0.
4. Run `node --test --test-isolation=none skills/export-codex-handoff/tests/continuation-grade-r6.test.mjs skills/export-codex-handoff/tests/map-worker.test.mjs skills/export-codex-handoff/tests/sparse-map-contract.test.mjs` to protect R6, Worker, CLI, and Markdown-link baselines.
5. Record PT0 fixture paths, exact diagnostic, and test results under `docs/slice-plan-provider-timing-capability.md:Slice PT0` and `docs/code-trail.md`, then stop before PT1.

## Uncommitted / unfinished

- `CONTEXT.md`: modified with the accepted `Provider Timing Capability` term; focused verification passed.
- `docs/adr/0014-provider-timing-capability-for-multi-wave-map.md`: untracked accepted ADR; decision sentence is 30 words.
- `docs/slice-plan-provider-timing-capability.md`: untracked accepted PT0-PT5 plan; implementation has not started.
- `docs/code-trail.md`: modified with the design-slice entry and 8/8 focused verification result.
- `SESSION_CHECKPOINT.md`: refreshed to PT0 by this turn; pending review/commit with the other documentation.
- No runtime or test file has changed. PT0 is pending; PT1-PT5 must not start early.

## Cold-start reading sequence

1. `CONTEXT.md` — read `Provider Timing Capability` and the adjacent MAP vocabulary.
2. `docs/adr/0014-provider-timing-capability-for-multi-wave-map.md` — accepted fail-early and post-worker-ingress decision.
3. `docs/slice-plan-provider-timing-capability.md` — read sections 1-4 and Slice PT0 completely; later slices are downstream constraints only.
4. `docs/code-trail.md` — read the final `2026-08-10 Provider Timing Capability and multi-wave recovery design` entry.
5. `skills/export-codex-handoff/scripts/lib/performance-calibration.mjs` — inspect `requireDurationArray` and `projectFirstWaveBudget`.
6. `skills/export-codex-handoff/scripts/lib/map-worker.mjs` — inspect `scheduleMapDispatches`; then inspect `skills/export-codex-handoff/scripts/export-handoff.mjs:parseMapWorkerAction/dispatch` and `skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs:checkMapDispatch` for the missing ingress.
7. `skills/export-codex-handoff/tests/continuation-grade-r6.test.mjs` and `skills/export-codex-handoff/tests/map-worker.test.mjs` — recover the synthetic-sample and production-CLI test gaps before authoring PT0.

## Decisions made this session

- ADR-0014 Provider Timing Capability: structurally multi-wave runs preflight trustworthy timing capability before any Worker and record observations only through a post-worker, dispatch-bound ingress.
- PT0 boundary: characterize the real four-dispatch/three-slot failure using synthetic counts and durations only; never copy Source Thread, Evidence Pack, or private MAP content.
- Budget ordering: the later PT1 gate rejects the retained run's `644844` ms prepare/frame lower bound before any MAP claim, but PT0 changes no runtime behavior.
