# Earliest-Owner Targeted MAP Repair

**Status**: accepted

**Decision**: Validate MAP-owned rules before receipt acceptance and return bounded, segment-specific correction hints without replaying unrelated MAP work.

**Rejected**:
- Clean-run recovery: one local defect discards valid parallel work and repeats model latency.
- Mutable accepted receipts: replacement obscures provenance and breaks provider-timing bindings.
- Generic retry messages: a fresh Worker can repeat the same defect without knowing the failed rule.

**Constraint**: REDUCE and run-level failures may not trigger automatic MAP replay; unowned failures stop with retained diagnostics.
**Revisit when**: A rule genuinely requires cross-segment semantics that cannot be attributed before receipt acceptance.
**Deep dive**: [Targeted MAP repair slices](../slice-plan-targeted-map-repair.md).
