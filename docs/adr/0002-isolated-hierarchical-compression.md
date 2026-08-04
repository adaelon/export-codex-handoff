# Isolated hierarchical compression

Semantic Compression runs in independent ephemeral Codex executions: turn-aligned MAP stages produce source-covered segment summaries, then one REDUCE stage merges them with workspace evidence. This costs additional model calls but prevents the raw Source Thread from consuming the invoking task's context and allows fail-closed coverage validation.

Superseded by [Dedicated Compression Task](./0003-dedicated-compression-task.md).
