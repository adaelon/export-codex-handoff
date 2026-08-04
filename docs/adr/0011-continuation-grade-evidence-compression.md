# Continuation-Grade Evidence Compression

**Status**: accepted

**Decision**: New Compression Runs will keep the complete Evidence Index but require semantic coverage only for Critical Anchors; MAP Workers emit Claims with compact evidence references, while Node derives anchors, bindings, non-critical exclusions, Preservation Coverage, and final provenance.

**Rejected**:
- Exhaustive model-authored evidence coverage: the accepted sparse contract still required 2.78M MAP-input characters and about 29 minutes before REDUCE.
- Unanchored free-form summaries: they cannot prove that continuation-critical state came from durable evidence.
- Concurrency-only remediation: the measured single-wave lower bound plus Frame and REDUCE already exceeds ten minutes.

**Constraint**: The latest goal, explicit exclusions, active user constraints, current workspace state, failures, verification, and open work remain evidence-addressed; existing work directories and `sparse-map-v1` remain immutable.
**Revisit when**: A forensic or regulatory use case requires model-authored disposition for every indexed evidence item.
**Expanded**: [Continuation-grade compression initiative](../slice-plan-continuation-grade-compression.md).
