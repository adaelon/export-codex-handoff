# Bounded Hierarchical MAP Isolation

**Decision**: Split oversized turns and execute each bounded MAP in an isolated MAP Worker.

**Rejected**:
- Oversize marker without control flow: one turn can exceed the MAP budget.
- Sequential raw MAP in the coordinator: earlier evidence pollutes later compression context.
- Nested Codex CLI execution: transport and schema coupling remain fragile.

**Critical constraint**: Evidence budgets exclude the shared frozen frame; the coordinator receives only validated MAP results, receipts, and diagnostics.
**Revisit when**: A first-class isolated skill-run primitive replaces MAP Worker dispatch.
**Expanded**: [Evidence-preserving compression slice plan](../slice-plan-evidence-preserving-compression.md#slice-5-isolated-map-workers).
