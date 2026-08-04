# Dedicated Compression Task

**Decision**: A fresh Codex task executes MAP/REDUCE.

**Rejected**:
- Nested `codex exec`: fragile executable and schema coupling.
- Source/continuation task execution: contaminates working context.

**Critical constraint**: Deterministic scripts retain evidence, validation, and publication authority.
**Revisit when**: Codex exposes a first-class isolated skill-run primitive.
