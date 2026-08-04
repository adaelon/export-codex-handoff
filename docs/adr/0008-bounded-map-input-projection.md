# Bounded MAP Input Projection

**Decision**: Pack adjacent fragments, project the frozen frame per segment, and fold parent coverage deterministically.

**Rejected**:
- One fragment per Worker: tiny evidence bodies multiply isolated-agent startup cost.
- Full frame per segment: unrelated global identifiers dominate every MAP input.
- Semantic parent aggregate: validated child coverage can be folded without another model call.

**Critical constraint**: Every projection stays bound to the full frame digest; MAP evidence stays isolated and total Worker input may not exceed 400,000 characters.
**Revisit when**: A first-class isolated batch primitive exposes measured token budgets and durable shared context.
**Expanded**: [Performance-bounded compression initiative](../slice-plan-performance-bounded-compression.md).
