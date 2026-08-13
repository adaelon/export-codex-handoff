# Deadline-Governed Arbitrary-Wave MAP Scheduling

**Status**: accepted

**Decision**: MAP schedules any pending count in repeated fresh-capacity waves; an independent workflow deadline admits waves, while provider timing only enables performance projections.

**Partially supersedes**: [ADR-0014](./0014-provider-timing-capability-for-multi-wave-map.md) only where Provider Timing Capability controls MAP admission; dispatch-bound provider observation and source-integrity requirements remain accepted.

**Rejected**:
- Fixed one- or two-wave scheduling: it encodes observed dispatch and slot counts instead of the pending-work invariant.
- Missing provider timing as an admission failure: telemetry availability must not strand otherwise executable MAP work.
- Workflow or harness elapsed time written as `providerLatencyMs`: it corrupts provider provenance.

**Constraint**: While `pending > 0`, each admitted wave re-observes slots, dispatches `min(pending, slots)`, executes and accepts that wave, then repeats. Without provider timing, admission uses the workflow total deadline and writes no `providerLatencyMs`.
**Revisit when**: The execution surface offers an authoritative scheduling deadline or slot lease that can replace the workflow-owned deadline or fresh-capacity observation.
**Deep dive**: [Arbitrary-wave MAP scheduling slice](../slice-plan-arbitrary-wave-map-scheduling.md).
