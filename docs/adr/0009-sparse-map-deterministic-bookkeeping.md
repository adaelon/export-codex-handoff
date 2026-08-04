# Sparse MAP Deterministic Bookkeeping

**Decision**: MAP Workers emit each anchored claim once plus compact evidence bindings; Node expands coverage and ledger references deterministically.

**Rejected**:
- Full per-fragment coverage prose: repeated identifiers and reasons dominate semantic content.
- Anchor-only coverage inference: range fragments can share one anchor and still require explicit binding.
- Coordinator semantic repair: it breaks isolation and makes correctness depend on another model pass.

**Critical constraint**: Expansion may validate and reshape structure but never invent, merge, rewrite, or re-anchor semantic claims; legacy work directories retain their original contract.
**Revisit when**: Native structured-output enforcement makes full coverage objects cheaper than deterministic sparse expansion.
**Expanded**: [Sparse MAP and deterministic bookkeeping initiative](../slice-plan-sparse-map-deterministic-bookkeeping.md).
