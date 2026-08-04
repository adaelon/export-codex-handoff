# Accepted Proposal and Terminal-State Continuation Slices

Status: accepted; implementation pending  
Scope: prevent a referential final confirmation or stale checkpoint from replacing the actual unfinished task, and make the Source Thread's terminal execution state a mandatory continuation Claim.

## 1. Frozen intent

New Compression Runs must preserve four authorities without silently merging their time domains:

```text
currentGoal + acceptedProposal -> intent authority
terminalStateClaim            -> source execution boundary
compression-time Git          -> current file truth
checkpointFreshness           -> current or historical checkpoint role
```

The implementation will:

- keep the final user message byte-exact;
- when that message is a referential confirmation, bind the nearest preceding non-empty assistant message as the Accepted Proposal;
- classify an anchored checkpoint as `fresh`, `stale`, or `unknown` from its recorded write revision and compression-time Git HEAD;
- keep stale and unknown checkpoints retrievable in the complete Evidence Index but remove their automatic current-work authority;
- deterministically construct exactly one Terminal-State Claim from the last assistant state, last completed tool result, pending tool call if any, termination evidence, and compression-time Git observations;
- label Source Thread termination time and workspace observation time separately;
- carry the Accepted Proposal and Terminal-State Claim through the frozen Frame, Critical Anchor selection, compact MAP/REDUCE path, Handoff, and Evidence Index provenance.

This initiative does not add a semantic or cross-field consistency gate. It does not repair an already published Handoff, rewrite Source Thread messages, infer an Accepted Proposal from arbitrary earlier history, remove stale checkpoint evidence, migrate an existing work directory, or change legacy v1 and `sparse-map-v1` contracts.

## 2. Trigger and authority contracts

### 2.1 Referential confirmation

```text
isReferentialConfirmation(text) -> boolean

if true:
  currentGoal = exact final user message
  acceptedProposal = nearest preceding non-empty assistant message
else:
  currentGoal = exact final user message
  acceptedProposal = null
```

The detector is deterministic and conservative. Its allowlist covers bounded acceptance and continuation forms such as `同意`, `确认`, `继续`, `对`, `修改这个`, `按这个做`, `yes`, `agreed`, `continue`, and `do it`, including surrounding punctuation and short deictic suffixes. A standalone task statement is never replaced by an older assistant message. Framework messages, tool calls, and empty assistant messages cannot become the Accepted Proposal.

The Accepted Proposal does not rewrite `currentGoal`. It is a separate anchored Claim so that `同意，修改这个` and the exact proposal denoted by `这个` remain independently retrievable.

### 2.2 Checkpoint freshness

```text
classifyCheckpointFreshness(checkpointRevision, gitHead):
  if both parse and checkpointRevision == gitHead: fresh
  if both parse and checkpointRevision != gitHead: stale
  otherwise: unknown
```

| Classification | Continuation role | Evidence Index |
| --- | --- | --- |
| `fresh` | May remain a current Critical workspace observation | Retained |
| `stale` | Historical context only; cannot independently produce current open work or next actions | Retained |
| `unknown` | Historical context unless explicitly preserved by the user | Retained |

Freshness uses the revision recorded inside the checkpoint, not file modification time. Git remains authoritative for branch, HEAD, staged, unstaged, and untracked facts.

### 2.3 Terminal-State Claim

Preparation first freezes a structured terminal observation:

```text
TerminalStateV1 {
  formatVersion: 1
  sourceTerminal: {
    turnId: string
    startedAt: timestamp | null
    terminatedAt: timestamp | null
    status: completed | aborted | in_progress | unknown
    abortReason: string | null
    lastAssistant: {
      phase: commentary | final_answer | unknown
      timestamp: timestamp | null
      text: string
      anchors: EvidenceAnchor[]
    } | null
    lastCompletedToolResult: {
      toolName: string
      callId: string
      status: ok | error | unknown
      valueKind: string
      outputAnchor: EvidenceAnchor
    } | null
    pendingToolCall: {
      toolName: string
      callId: string
      inputAnchor: EvidenceAnchor
    } | null
  }
  workspaceObserved: {
    observedAt: timestamp
    sourceRevision: sha256 | null
    gitStatus: available | not_repository | unavailable
    head: string | null
    observationAnchors: EvidenceAnchor[]
  }
}
```

Deterministic code projects it into exactly one ordinary Claim:

```text
TerminalStateClaim {
  kind: terminal_state
  text: bounded canonical rendering of TerminalStateV1
  anchors: stable union of every represented component anchor
}
```

`lastAssistant` is the final non-empty user-visible assistant message before the termination marker. `lastCompletedToolResult` is the final completed output receipt, never a tool input receipt. If a later tool call has input but no completed result, it is recorded separately as `pendingToolCall`. A session with no tool call uses `null` and does not invent a receipt.

The terminal Claim is deterministic workflow state, not optional Worker prose. New Frames bind it by digest, its supporting anchors are Critical, continuation completion places it once in the global Claim table, and REDUCE cannot omit or rewrite it. Handoff renders it in a dedicated `Terminal state` section rather than distributing its meaning across checkpoint-derived fields.

## 3. Target data flow

```text
rollout events
  -> Source Thread parser
       -> final user message
       -> preceding assistant message
       -> last terminal turn
       -> assistant/tool/termination anchors
  -> workspace snapshot
       -> checkpoint revision classification
       -> compression-time Git observations
  -> Frame vNext
       -> currentGoal
       -> acceptedProposal?
       -> terminalStateClaim
       -> explicit exclusions
  -> Critical Anchor selector
       -> goal + proposal + terminal components + current Git
       -> fresh checkpoint only as current authority
  -> continuation MAP/Claim table
       -> model-authored Claims
       -> one deterministic Terminal-State Claim
  -> compact REDUCE
  -> Handoff
       -> Objective + Accepted Proposal
       -> Terminal state
       -> current workspace state
       -> historical checkpoint context only when useful
```

## 4. Slice order

### Slice TS0: Regression fixtures and frozen terminology

**Input**: ADR-0012, the Source Thread shape from session `019fb265-a781-7520-b64e-50386a6cf5f6`, and synthetic-only message, checkpoint, tool, abort, and Git values.

**Produces**: fixtures for a referential confirmation, an assistant-approved analyzer fix, an aborted final turn, a completed last tool result, a stale AA checkpoint, and a newer Git HEAD where the AA implementation is already committed.

**Does not do**: copy private rollout bodies or workspace files into the repository, change runtime behavior, or assert a semantic consistency gate.

**Done when**: the fixture reproduces the failure class: old behavior can select AA staging while the expected contract preserves the analyzer fix as Accepted Proposal and treats AA checkpoint work as historical.

**Implemented evidence**: `accepted-terminal-fixtures.mjs` contains only synthetic messages, tool values, abort metadata, checkpoint text, and Git revisions. `accepted-terminal-ts0.test.mjs` proves the pre-TS1 Frame retains the byte-exact final confirmation and stale AA checkpoint but has no Accepted Proposal or abort reason, while the frozen expected contract retains the analyzer fix, completed tool, pending tool, and newer HEAD separately. Focused verification passes 1/1.

### Slice TS1: Accepted Proposal and termination evidence

**Input**: TS0 fixtures and parsed Source Thread turns.

**Produces**: deterministic `isReferentialConfirmation`, Accepted Proposal selection, anchored termination records including abort reason, and explicit final-turn ordering for assistant messages and Tool Receipts.

**Does not do**: construct Terminal-State Claims, inspect Git, summarize proposals, or change MAP/REDUCE.

**Done when**: `同意，修改这个` binds the immediately preceding assistant proposal while a standalone user task does not; aborted reason/timestamp/turn ID remain anchored; duplicate framework events do not become proposals.

**Implemented evidence**: `source-thread.mjs` now exposes a bounded `isReferentialConfirmation`, byte-exact `sourceContinuation.currentGoal`, the nearest eligible `acceptedProposal`, an anchored termination record, and source-ordered assistant/Tool Receipt events. `evidence-pack.mjs` persists that parser result. TS0–TS1 plus Source Thread/Evidence Pack compatibility tests pass 10/10.

### Slice TS2: Checkpoint freshness and authority downgrade

**Input**: TS0 checkpoint/Git fixtures and current workspace snapshot capture.

**Produces**: `fresh | stale | unknown` classification, parsed checkpoint revision metadata, and Critical Anchor selection that grants automatic current authority only to a fresh checkpoint.

**Does not do**: delete checkpoint anchors, rewrite checkpoint content, infer file truth from checkpoint prose, or block publication because evidence disagrees.

**Done when**: equal revisions retain current authority; different revisions retain only historical retrievability; missing/unparseable revisions become `unknown`; Git observations remain Critical current facts.

**Implemented evidence**: `workspace-snapshot.mjs` parses checkpoint revisions, captures full Git HEAD and `observedAt`, and classifies freshness. Critical selection and Frame checkpoint projection now auto-promote only explicitly `fresh` checkpoints while preserving legacy missing-metadata behavior for frozen fixtures. TS0–TS2 plus affected workspace/Frame tests pass 20/20.

### Slice TS3: Deterministic Terminal-State Claim

**Input**: TS1 terminal evidence and TS2 workspace observations.

**Produces**: `TerminalStateV1`, deterministic bounded rendering, stable anchor union, pending-tool detection, and exactly one `terminal_state` Claim for each new Compression Run.

**Does not do**: let a Worker paraphrase the terminal state, combine the two timestamps, or claim a tool completed when only its input exists.

**Done when**: normal completion, abort after a completed tool, abort during an in-flight tool, no-tool, non-Git, and unavailable-workspace fixtures all produce one stable digest-bound Claim without invented fields.

**Implemented evidence**: `terminal-state.mjs` builds `TerminalStateV1` and one stable `terminal_state` Claim with a bounded canonical body and stable anchor union. `buildEvidencePack` makes every represented terminal/proposal anchor Critical. Completion, abort-after-output, abort-in-flight, no-tool, non-Git, unavailable-workspace, time-domain separation, and deterministic replay tests pass; the affected regression set is 21/21.

### Slice TS4: Frame, continuation, REDUCE, and Handoff projection

**Input**: TS1 Accepted Proposal and TS3 Terminal-State Claim.

**Produces**: a version-bound new Frame shape, segment projection of reachable proposal/terminal anchors, deterministic insertion into the global Claim table, compact REDUCE input, and dedicated Handoff `Accepted proposal` and `Terminal state` projections.

**Does not do**: migrate frozen work directories, change legacy routes, require directive/objective semantic agreement, or add a cross-field consistency gate.

**Done when**: proposal and terminal Claims survive prepare -> MAP completion -> REDUCE check -> publication byte-exactly; omission or anchor mutation fails structurally; contradictory evidence can still publish as separately labeled evidence.

**Implemented evidence**: new prepared workdirs bind `frameContractVersion: 2`; Frame v2 and reference Projection v3 carry the exact current goal, optional Accepted Proposal, and mandatory Terminal-State Claim. Deterministic continuation completion inserts the two authority Claims once, REDUCE carries body-free authority IDs and requires exact candidate projections, and Handoff renders dedicated sections. The TS4 end-to-end test also publishes a contradictory historical checkpoint conflict; missing, duplicate, and anchor-mutated terminal state fail structurally. TS0–TS4 plus compatibility paths pass 57/57.

### Slice TS5: Compatibility, documentation, and live acceptance

**Input**: TS0-TS4, repository and installed Skill packages, and a fresh dedicated Compression Task.

**Produces**: updated contracts, Skill workflow, architecture, code trail, installed mirror, and one fresh Handoff/Evidence Index pair for the retained failure-class session or an equivalent synthetic-safe live source.

**Does not do**: overwrite the existing incorrect Handoff, resume the Source Thread, or relax existing size/time/integrity gates.

**Done when**: all repository tests pass; repository and installed Skill files match; the new Handoff continues the analyzer-policy fix rather than AA staging; terminal state names the aborted turn and final completed tool result; stale checkpoint content remains retrievable but not current; `verify-evidence` passes within existing publication limits.

## 5. Verification matrix

| Boundary | Deterministic acceptance evidence |
| --- | --- |
| Referential goal is recoverable | Exact `同意，修改这个` plus exact preceding analyzer-fix proposal are separate anchored Claims |
| Standalone goals stay standalone | Non-referential final task yields `acceptedProposal = null` |
| Abort reason survives | Turn ID, reason, and termination timestamp are anchored and present in TerminalStateV1 |
| Tool completion is honest | Last output Receipt is distinct from a later unmatched tool input |
| Time domains stay separate | `terminatedAt` and `workspaceObserved.observedAt` are independently rendered |
| Git is current file truth | HEAD/status come only from workspace observations |
| Stale checkpoint is downgraded | Mismatched checkpoint revision remains indexed but cannot independently drive current next actions |
| No consistency gate is introduced | Contradictory checkpoint/conversation evidence remains publishable in distinct labeled fields |
| Terminal state cannot disappear | Missing or duplicated deterministic `terminal_state` Claim fails structural validation |
| Frozen workflows remain immutable | Legacy v1, missing-mode v2, pre-feature continuation, and `sparse-map-v1` fixtures retain their contracts |

## 6. Compatibility and rollback

- The new Frame/terminal contract applies only to newly prepared Compression Runs and is immutable once bound.
- Existing work directories continue through their recorded workflow and Frame shapes without migration.
- The complete Evidence Index remains the retrieval boundary for stale checkpoints and all non-critical evidence.
- Rollback disables the new-run contract and selector route; it never rewrites a Source Thread, work directory, Handoff, or Evidence Index.
- No rollback path may promote a stale or unknown checkpoint to current authority without an explicit user-preserve instruction.
