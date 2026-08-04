import {
  canonicalStringify,
  sha256Text,
} from "./evidence-addressing.mjs";

const SOURCE_STATUSES = new Set(["completed", "aborted", "in_progress", "unknown"]);
const TOOL_STATUSES = new Set(["ok", "error", "unknown"]);
const ASSISTANT_PHASES = new Set(["commentary", "final_answer"]);
const TERMINAL_RENDER_MAX_CHARS = 4_000;

function stableUnique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function boundedText(value, maxChars) {
  if (typeof value !== "string") return "";
  if (value.length <= maxChars) return value;
  const marker = `\n[... ${value.length - maxChars} UTF-16 code units omitted ...]\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

function normalizedSourceStatus(value) {
  return SOURCE_STATUSES.has(value) ? value : "unknown";
}

function normalizedToolStatus(value) {
  return TOOL_STATUSES.has(value) ? value : "unknown";
}

function normalizedAssistantPhase(value) {
  return ASSISTANT_PHASES.has(value) ? value : "unknown";
}

function workspaceGitStatus(workspace) {
  if (workspace?.status !== "available") return "unavailable";
  if (workspace?.git?.status === "not_repository") return "not_repository";
  return workspace?.git?.status === "available" ? "available" : "unavailable";
}

function toolEvents(terminalEvidence) {
  return (terminalEvidence?.orderedEvents || []).filter((event) => (
    event?.kind === "tool_receipt" &&
    typeof event.callId === "string" &&
    event.callId
  ));
}

function lastCompletedToolResult(terminalEvidence) {
  const completed = toolEvents(terminalEvidence).filter((event) => event.valueKind !== "input");
  const event = completed.at(-1);
  if (!event) return null;
  return {
    toolName: event.toolName || "unknown",
    callId: event.callId,
    status: normalizedToolStatus(event.status),
    valueKind: event.valueKind || "output",
    outputAnchor: event.outputAnchor,
  };
}

function pendingToolCall(terminalEvidence) {
  const events = toolEvents(terminalEvidence);
  const completedCallIds = new Set(
    events.filter((event) => event.valueKind !== "input").map((event) => event.callId),
  );
  const event = events
    .filter((candidate) => candidate.valueKind === "input" && !completedCallIds.has(candidate.callId))
    .at(-1);
  if (!event) return null;
  return {
    toolName: event.toolName || "unknown",
    callId: event.callId,
    inputAnchor: event.outputAnchor,
  };
}

export function buildTerminalStateV1(sourceContinuation, workspace) {
  const terminalEvidence = sourceContinuation?.terminalEvidence || {};
  const assistant = terminalEvidence.lastAssistant;
  const completedTool = lastCompletedToolResult(terminalEvidence);
  const pendingTool = pendingToolCall(terminalEvidence);
  const observationAnchors = stableUnique(workspace?.observationAnchors || []);
  return {
    formatVersion: 1,
    sourceTerminal: {
      turnId: terminalEvidence.turnId || "unknown",
      startedAt: terminalEvidence.startedAt ?? null,
      terminatedAt: terminalEvidence.terminatedAt ?? null,
      status: normalizedSourceStatus(terminalEvidence.status),
      abortReason: typeof terminalEvidence.abortReason === "string"
        ? terminalEvidence.abortReason
        : null,
      lastAssistant: assistant ? {
        phase: normalizedAssistantPhase(assistant.phase),
        timestamp: assistant.timestamp ?? null,
        text: assistant.text,
        anchors: stableUnique(assistant.anchors || []),
      } : null,
      lastCompletedToolResult: completedTool,
      pendingToolCall: pendingTool,
    },
    workspaceObserved: {
      observedAt: workspace?.observedAt || workspace?.capturedAt || null,
      sourceRevision: workspace?.sourceRevision || null,
      gitStatus: workspaceGitStatus(workspace),
      head: typeof workspace?.git?.head === "string" && workspace.git.head
        ? workspace.git.head
        : null,
      observationAnchors,
    },
  };
}

export function renderTerminalStateClaimText(terminalState) {
  const source = terminalState.sourceTerminal;
  const workspace = terminalState.workspaceObserved;
  const rendered = canonicalStringify({
    formatVersion: terminalState.formatVersion,
    sourceTerminal: {
      turnId: boundedText(source.turnId, 256),
      startedAt: source.startedAt,
      terminatedAt: source.terminatedAt,
      status: source.status,
      abortReason: source.abortReason === null ? null : boundedText(source.abortReason, 256),
      lastAssistant: source.lastAssistant ? {
        phase: source.lastAssistant.phase,
        timestamp: source.lastAssistant.timestamp,
        text: boundedText(source.lastAssistant.text, 1_600),
      } : null,
      lastCompletedToolResult: source.lastCompletedToolResult ? {
        toolName: boundedText(source.lastCompletedToolResult.toolName, 256),
        callId: boundedText(source.lastCompletedToolResult.callId, 256),
        status: source.lastCompletedToolResult.status,
        valueKind: boundedText(source.lastCompletedToolResult.valueKind, 64),
      } : null,
      pendingToolCall: source.pendingToolCall ? {
        toolName: boundedText(source.pendingToolCall.toolName, 256),
        callId: boundedText(source.pendingToolCall.callId, 256),
      } : null,
    },
    workspaceObserved: {
      observedAt: workspace.observedAt,
      sourceRevision: workspace.sourceRevision,
      gitStatus: workspace.gitStatus,
      head: workspace.head,
    },
  });
  if (rendered.length > TERMINAL_RENDER_MAX_CHARS) {
    throw new TypeError(`Terminal-State Claim rendering exceeds ${TERMINAL_RENDER_MAX_CHARS} characters`);
  }
  return rendered;
}

export function projectTerminalStateClaim(terminalState, fallbackAnchors = []) {
  const source = terminalState.sourceTerminal;
  const anchors = stableUnique([
    ...(source.lastAssistant?.anchors || []),
    ...(source.lastCompletedToolResult?.outputAnchor
      ? [source.lastCompletedToolResult.outputAnchor]
      : []),
    ...(source.pendingToolCall?.inputAnchor ? [source.pendingToolCall.inputAnchor] : []),
    ...(terminalState.workspaceObserved.observationAnchors || []),
    ...fallbackAnchors,
  ]);
  const text = renderTerminalStateClaimText(terminalState);
  return {
    claimId: `claim-${sha256Text(canonicalStringify({
      kind: "terminal_state",
      text,
      anchors,
    }))}`,
    kind: "terminal_state",
    text,
    anchors,
  };
}

export function buildTerminalStateArtifacts(sourceContinuation, workspace) {
  const terminalState = buildTerminalStateV1(sourceContinuation, workspace);
  const fallbackAnchors = stableUnique([
    ...(sourceContinuation?.terminalEvidence?.terminationAnchors || []),
    ...(sourceContinuation?.currentGoal?.anchors || []),
  ]);
  return {
    terminalState,
    terminalStateClaim: projectTerminalStateClaim(terminalState, fallbackAnchors),
  };
}
