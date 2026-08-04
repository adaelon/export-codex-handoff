# Lossless Evidence Addressing

**Decision**: Pair lossy Handoff claims with durable Evidence Anchors and an Evidence Index.

**Rejected**:
- Embed complete tool output: destroys the Handoff budget and portability.
- Head-tail truncation alone: silently removes unrecoverable middle evidence.
- Turn IDs as sole provenance: identifies a turn but not the supporting event or range.

**Critical constraint**: Exact identifiers and source revisions are deterministic, never model-rewritten.
**Revisit when**: Source Thread storage provides durable, content-addressed claim citations natively.
**Expanded**: [Evidence-preserving compression slice plan](../slice-plan-evidence-preserving-compression.md#slice-1-evidence-addressing-and-tool-receipts).
