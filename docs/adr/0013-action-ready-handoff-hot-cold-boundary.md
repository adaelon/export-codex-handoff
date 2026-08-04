# Action-Ready Handoff Hot/Cold Boundary

**Status**: accepted

**Decision**: New Handoffs expose only actionable Hot Context, keep complete evidence cold, and fail closed without Working Synthesis and a bounded Resume Policy.

**Rejected**:
- Prune the Evidence Index: continuation becomes smaller but exact verification and later recovery are lost.
- Render all preserved evidence: audit metadata crowds out the state needed to finish the user's deliverable.
- Model-scored relevance: subjective scoring cannot enforce a stable publication boundary.

**Constraint**: Existence probes and mechanical success never enter Hot Context; inspected content must support a deliverable, uncertainty, action, or no-repeat scope.
**Revisit when**: Codex provides native typed continuation state with bounded evidence retrieval and deterministic actionability checks.
**Expanded**: [Action-ready high-value Handoff slices](../slice-plan-action-ready-high-value-handoff.md).
