# ADR-0018: Main Codex complete-Handoff convergence

**Status**: accepted; supersedes ADR-0016 terminal-outcome policy

**Decision**: Main Codex owns every recoverable failure and may finish only after a normal Handoff pair passes all deterministic publication and evidence checks.

**Rejected**:
- Degraded publication: ends recovery while required evidence or semantics remain unresolved.
- Worker-owned retry: delegates the repair decision and cannot guarantee global convergence.
- Terminal diagnostic: reports internal workflow failure instead of delivering the requested artifact.

**Constraint**: Workers may author isolated private candidates only under a Main Codex directive; process, machine, coordinator, or all-writable-target loss remains outside the software guarantee.
**Revisit when**: A deterministic proof exists that a required source fact is permanently unrecoverable rather than temporarily unavailable or invalid.
**Deep dive**: [Main Codex convergence slices](../slice-plan-main-codex-convergence.md).
