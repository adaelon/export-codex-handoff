# Main Codex Adjudication Loop

**Status**: accepted

**Decision**: Every Captured Workflow Diagnostic enters Main Codex Adjudication; only verified normal or explicit Degraded Handoff publication ends the Compression Run.

**Rejected**:
- Terminal fail-closed: preserves integrity but strands the requested artifact.
- Automatic bypass: can discard evidence obligations or invent semantic resolution.
- Clean-run recovery: loses accepted work and repeats unresolved failure classes.

**Constraint**: Invalid decisions retain the active request; failed decision application creates a linked request. Adjudication may omit unverified content, but never fabricate evidence, mutate the Source Thread, or rewrite prior receipts.
**Revisit when**: No coordinator turn or writable work/publication target remains; process termination and machine loss stay outside the software guarantee.
**Deep dive**: [Main Codex adjudication slices](../slice-plan-main-codex-adjudication.md).
