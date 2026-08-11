# Codex Turn Exporter

This context defines the portable handoff produced from a persisted Codex conversation when that conversation can no longer continue reliably in its original context window.

## Language

**Source Thread**:
A persisted Codex conversation identified by its session UUID and used as the source material for a handoff.
_Avoid_: Old chat, original turn

**Compression Run**:
A bounded Semantic Compression workflow executed inside a dedicated Compression Task and isolated from both the Source Thread and the task that will consume the resulting handoff.
_Avoid_: Resume run, continuation run

**Compression Task**:
A fresh Codex task that loads the export skill, processes one Source Thread through MAP/REDUCE, publishes the Handoff, and is discarded after completion.
_Avoid_: Source Thread, continuation task

**Semantic Compression**:
A meaning-preserving reduction of Source Thread evidence into the minimum context needed to continue its unfinished work.
_Avoid_: Transcript cleanup, truncation

**Handoff**:
A portable Markdown artifact containing the state, decisions, evidence, and next actions required for a fresh Codex task to continue the Source Thread's work.
_Avoid_: Turn file, summary, transcript export

**Hot Context**:
The evidence-backed, automatically consumed portion of a Handoff whose contents can change the continuation task's deliverable, decision, constraint, uncertainty, next action, or no-repeat scope.
_Avoid_: Full Handoff, relevant-looking text, evidence dump

**Cold Evidence**:
Durable indexed evidence retained for exact retrieval and verification but excluded from the continuation task's default model context.
_Avoid_: Discarded evidence, hidden prompt, Hot Context

**Local Compression**:
A Semantic Compression workflow whose source discovery, orchestration, and artifact storage happen on the user's machine while model inference may run through the configured Codex service.
_Avoid_: Local inference, offline compression

**Evidence Pack**:
The bounded input to a Compression Run, combining Source Thread events with a deterministic snapshot of the Source Thread's current workspace.
_Avoid_: Prompt dump, raw transcript

**Compression Frame**:
An evidence-bound statement of the current objective, task phase, exclusions, and preservation policy that guides every semantic compression stage in one Compression Run.
_Avoid_: Global prompt, free-form summary

**Evidence Anchor**:
A stable, exact pointer from a compressed claim to the Source Thread or workspace observation that supports it.
_Avoid_: Citation label, turn mention

**Evidence Index**:
A compact, durable mapping from Evidence Anchors to retrievable source material without embedding that material in the Handoff.
_Avoid_: Evidence Pack, raw evidence archive

**Handoff Evidence Key**:
A compact artifact-local reference that maps one displayed Hot Context fact to its supporting Evidence Index entries without rendering raw Claim IDs or Evidence Anchors.
_Avoid_: Evidence Anchor, Claim ID, citation prose

**Tool Receipt**:
A bounded record of one tool interaction containing its exact identity, outcome, preview, and Evidence Anchors while leaving large output outside the model context.
_Avoid_: Tool summary, truncated output

**Preservation Ledger**:
The deterministic inventory of exact identifiers and continuation-critical evidence that Semantic Compression must reproduce without mutation or unexplained omission.
_Avoid_: Glossary, compression prompt

**Semantic Coverage**:
The verified relationship proving that each retained Source Thread turn contributes to at least one supported Handoff claim, or is explicitly excluded with a concrete reason.
_Avoid_: Turn enumeration, provenance list

**Archival Ledger**:
A chronological, evidence-anchored record of decisions, attempts, failures, verification outcomes, and supersession needed to preserve the Source Thread operational history.
_Avoid_: Transcript, narrative timeline

**MAP Worker**:
An isolated semantic executor that reads one bounded Evidence Pack segment and returns only a contract-valid MAP result to the Compression Task coordinator.
_Avoid_: Compression Task, continuation agent

**MapDispatch**:
A frame-bound, attempt-specific capability that authorizes exactly one MAP Worker to read one private segment and write one private summary candidate within its immutable serialized-output budget.
_Avoid_: Segment descriptor, worker prompt

**MapReceipt**:
A bounded validation outcome that binds one MapDispatch to either an immutable summary digest or one diagnostic code, without returning raw segment evidence.
_Avoid_: MAP result, worker transcript

**Failure Owner**:
The earliest workflow stage whose authored artifact contains enough information to determine and correct a validation failure.
_Avoid_: Stage that happened to report the failure, whole Compression Run

**MAP Repair Diagnostic**:
A bounded, segment-attributed list of MAP candidate violations and precise correction hints that exposes no private evidence.
_Avoid_: Generic retry prompt, raw Worker evidence

**Targeted MAP Repair**:
Correction of only the MAP candidate named by a MAP Repair Diagnostic while unrelated validated MAP results remain reusable.
_Avoid_: Clean Compression Run, full MAP replay

**Provider Timing Capability**:
An execution-surface guarantee that provider-reported MAP generation timing can be correlated with one completed MapDispatch and durably recorded before later-wave admission.
_Avoid_: Harness timing, coordinator elapsed time, inferred latency

**Sparse MAP Result**:
A compact MAP output that states each anchored Claim once, binds Claims to ordered evidence indexes, and represents non-retained evidence with explicit exclusion ranges.
_Avoid_: Full coverage ledger, compressed transcript

**Deterministic MAP Bookkeeping**:
The non-semantic validation and expansion of a Sparse MAP Result into complete coverage and ledger structures without inventing, merging, rewriting, or re-anchoring Claims.
_Avoid_: Semantic repair, coordinator summary

**Frame Projection**:
A deterministic, segment-local view of the frozen Compression Frame containing the current goal, explicit exclusions, and only the exact-identifier and anchor obligations reachable from that segment; it remains bound to the full frame digest and cannot weaken global validation.
_Avoid_: Partial frame, worker-specific policy

**Deterministic Parent Coverage**:
The non-semantic fold that combines validated child fragment coverage and claims into exactly one parent-turn coverage entry without starting another MAP Worker.
_Avoid_: Parent summary, aggregate MAP

**Critical Anchor**:
An Evidence Anchor whose omission would make a continuation Handoff unsafe or incomplete; it is a strict subset of the complete retrievable anchor set in the Evidence Index.
_Avoid_: Every anchor, all indexed evidence

**Continuation Coverage**:
The verified relationship proving that every continuation-critical obligation is retained or explicitly excluded while non-critical evidence remains retrievable without requiring model-authored per-item exclusions.
_Avoid_: Exhaustive evidence narration, unanchored summary

**Evidence Reference Dictionary**:
A deterministic segment-local mapping from compact integer references to immutable Evidence Anchors and exact identifiers, allowing Workers to cite evidence without copying global identifier strings.
_Avoid_: Rewritten anchor, model-generated identifier

**Continuation MAP Result**:
A compact semantic result that states each Claim once with local evidence references and typed ledger relations; deterministic code derives global Claim IDs, anchors, bindings, and coverage.
_Avoid_: Full coverage ledger, free-form summary

**Progress Evidence**:
A bounded channel of user-visible assistant progress and successful content inspections used to recover already-formed understanding without expanding the Critical Anchor set.
_Avoid_: Every successful tool result, Critical Evidence, full Source Thread history

**Working Synthesis**:
An evidence-backed, partial or draft-ready account of what the Source Thread has already learned, organized around the user's requested deliverables.
_Avoid_: Progress log, completed-work list, transcript summary

**Inspected Evidence Map**:
A compact mapping from content scopes actually inspected to supported findings and reread policy; existence probes and mechanical command success are not inspections.
_Avoid_: File list, important-location dump, tool history

**Resume Policy**:
A validated continuation contract that fixes the first deliverable, evidence-read budget, permitted read reasons, and prohibited broad or repeated exploration for the next task.
_Avoid_: Suggested prompt, generic next action, unrestricted continuation

**Information Value Gate**:
Deterministic prepublication validation that admits only evidence-backed facts reachable from a deliverable, decision, constraint, finding, uncertainty, next action, no-repeat scope, or relevant verification into Hot Context.
_Avoid_: Relevance score, prose quality judgment, LLM-as-judge

**Actionability Gate**:
Deterministic prepublication validation that requires task-appropriate Working Synthesis, deliverable status, Inspected Evidence Map, and Resume Policy before an action-ready Handoff can publish.
_Avoid_: Completeness score, user acceptance test, semantic consistency judge

**Accepted Proposal**:
The nearest preceding non-empty assistant message that a referential final user confirmation explicitly accepts, retained alongside the byte-exact user goal without rewriting either message.
_Avoid_: Rewritten goal, inferred objective

**Terminal-State Claim**:
A mandatory deterministic Claim that combines the Source Thread's last assistant state, last completed Tool Receipt, pending tool call if any, termination status, and the later compression-time Git observation while preserving their distinct timestamps.
_Avoid_: Checkpoint summary, atomic session-and-workspace snapshot

**Checkpoint Freshness**:
The relationship between a checkpoint's recorded write revision and compression-time Git HEAD: `fresh` when equal, `stale` when different, and `unknown` when either side is unavailable or unparseable.
_Avoid_: File modification time, assumed current checkpoint
