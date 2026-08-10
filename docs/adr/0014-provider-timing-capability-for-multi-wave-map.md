# Provider Timing Capability for Multi-Wave MAP

**Status**: accepted

**Decision**: Multi-wave MAP runs must preflight provider-timing capability before any Worker dispatch and persist each provider observation through a post-worker, dispatch-bound ingress; unavailable capability fails early, never using workflow elapsed time.

**Rejected**:
- Accept the first wave before checking timing capability: valid MAP work is stranded when the later-wave gate discovers an unsatisfied metric contract.
- Substitute coordinator or harness elapsed time: it changes the meaning of provider latency and invalidates controlled calibration.
- Coalesce or drop MAP dispatches only to avoid a later wave: it hides the integration defect by changing semantic isolation and coverage boundaries.

**Constraint**: A provider observation must bind one immutable dispatch, its execution configuration, wave, and fresh slot count without reopening private MAP evidence; frozen work directories are never retrofitted.
**Revisit when**: The Codex collaboration surface exposes a durable per-worker timing receipt that the workflow can consume without an adapter or separate capability negotiation.
**Expanded**: [Provider timing capability and multi-wave recovery slices](../slice-plan-provider-timing-capability.md).
