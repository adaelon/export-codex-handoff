# Worker-bound Sparse MAP Expansion

**Decision**: Workers persist a digest-bound deterministic expansion; coordinators consume it without reopening private evidence chunks.

**Rejected**:
- Coordinator-side re-expansion: it requires reopening `chunkPath` after receipt acceptance.
- Raw-candidate digest only: it cannot authenticate the derived full-MAP result without source evidence.

**Constraint**: Expansion remains non-semantic, and the receipt binds both raw and normalized SHA-256 digests.
**Revisit when**: A compact proof can authenticate expansion without persisting the derived result.
**Deep dive**: [Sparse MAP and deterministic bookkeeping initiative](../slice-plan-sparse-map-deterministic-bookkeeping.md).
