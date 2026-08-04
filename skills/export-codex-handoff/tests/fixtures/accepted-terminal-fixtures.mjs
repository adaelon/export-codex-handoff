import {
  buildContinuationPreservationLedger,
  createEvidenceEntry,
} from "../../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../../scripts/lib/evidence-index.mjs";
import { buildTerminalStateArtifacts } from "../../scripts/lib/terminal-state.mjs";

export const ACCEPTED_TERMINAL_SESSION_ID = "00000000-0000-7000-8000-0000000000b0";
export const PROPOSAL_TURN_ID = "00000000-0000-7000-8000-0000000000b1";
export const TERMINAL_TURN_ID = "00000000-0000-7000-8000-0000000000b2";
export const FINAL_CONFIRMATION = "同意，修改这个";
export const ACCEPTED_ANALYZER_PROPOSAL = [
  "建议修复 analyzer 的终态策略：保留最后完成的工具结果，",
  "并把后续未完成调用单独标记为 pending，而不是恢复旧的 AA staging。",
].join("\n");
export const TERMINAL_ASSISTANT_MESSAGE = "分析器修复已验证；正在写入最终策略。";
export const COMPLETED_TOOL_CALL_ID = "call-analyzer-verify";
export const PENDING_TOOL_CALL_ID = "call-analyzer-write";
export const ABORT_REASON = "interrupted";
export const CHECKPOINT_REVISION = "1111111111111111111111111111111111111111";
export const COMPRESSION_GIT_HEAD = "2222222222222222222222222222222222222222";

export const STALE_AA_CHECKPOINT = `# SESSION_CHECKPOINT — synthetic\n\n## 新鲜度自检\n- 写入时最新 commit: ${CHECKPOINT_REVISION} Stage AA implementation.\n\n## 当前在做什么\n正在继续 AA staging；下一步发布 AA artifacts。\n`;

export function acceptedTerminalRolloutRecords() {
  return [
    {
      timestamp: "2026-07-30T09:00:00.000Z",
      type: "session_meta",
      payload: {
        session_id: ACCEPTED_TERMINAL_SESSION_ID,
        cwd: "C:/synthetic/accepted-terminal-workspace",
        timestamp: "2026-07-30T09:00:00.000Z",
        cli_version: "synthetic",
      },
    },
    {
      timestamp: "2026-07-30T09:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: PROPOSAL_TURN_ID,
        started_at: 1785402001,
      },
    },
    {
      timestamp: "2026-07-30T09:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "请给出 analyzer policy 的修复方案。" }],
      },
    },
    {
      timestamp: "2026-07-30T09:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: ACCEPTED_ANALYZER_PROPOSAL }],
      },
    },
    {
      timestamp: "2026-07-30T09:00:04.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: PROPOSAL_TURN_ID,
        started_at: 1785402001,
        completed_at: 1785402004,
      },
    },
    {
      timestamp: "2026-07-30T09:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: TERMINAL_TURN_ID,
        started_at: 1785402060,
      },
    },
    {
      timestamp: "2026-07-30T09:01:00.500Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "synthetic framework event" }],
      },
    },
    {
      timestamp: "2026-07-30T09:01:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: FINAL_CONFIRMATION }],
      },
    },
    {
      timestamp: "2026-07-30T09:01:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: TERMINAL_ASSISTANT_MESSAGE }],
      },
    },
    {
      timestamp: "2026-07-30T09:01:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "verify_analyzer",
        call_id: COMPLETED_TOOL_CALL_ID,
        arguments: "{\"fixture\":\"synthetic\"}",
      },
    },
    {
      timestamp: "2026-07-30T09:01:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: COMPLETED_TOOL_CALL_ID,
        output: { result: "pass", tests: 1 },
      },
    },
    {
      timestamp: "2026-07-30T09:01:05.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "write_analyzer_policy",
        call_id: PENDING_TOOL_CALL_ID,
        input: "synthetic pending write",
      },
    },
    {
      timestamp: "2026-07-30T09:01:06.000Z",
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: TERMINAL_TURN_ID,
        started_at: 1785402060,
        completed_at: 1785402066,
        reason: ABORT_REASON,
      },
    },
  ];
}

export function acceptedTerminalWorkspaceFixture(parsed) {
  const workspaceRevision = `sha256:${"b".repeat(64)}`;
  const cwd = parsed.session.cwd;
  const checkpointEntry = createEvidenceEntry({
    sourceKind: "workspace",
    sourceRevision: workspaceRevision,
    payloadPath: "/checkpoint/content",
    value: STALE_AA_CHECKPOINT,
    locator: {
      kind: "file",
      observationId: "checkpoint",
      path: `${cwd}/SESSION_CHECKPOINT.md`,
    },
  });
  const statusText = "## main";
  const statusEntry = createEvidenceEntry({
    sourceKind: "workspace",
    sourceRevision: workspaceRevision,
    payloadPath: "/git/branchAndStatus",
    value: statusText,
    locator: {
      kind: "command",
      observationId: "git.status",
      executable: "git",
      cwd,
      args: ["status", "--short", "--branch"],
      expectedOk: true,
      stream: "stdout",
    },
  });
  const commitsText = `${COMPRESSION_GIT_HEAD} Complete AA implementation`;
  const commitsEntry = createEvidenceEntry({
    sourceKind: "workspace",
    sourceRevision: workspaceRevision,
    payloadPath: "/git/recentCommits",
    value: commitsText,
    locator: {
      kind: "command",
      observationId: "git.log",
      executable: "git",
      cwd,
      args: ["log", "--oneline", "-5"],
      expectedOk: true,
      stream: "stdout",
    },
  });
  const evidenceEntries = [checkpointEntry, statusEntry, commitsEntry];
  const observationAnchors = evidenceEntries
    .filter((entry) => entry.anchor.payloadPath?.startsWith("/git/"))
    .map((entry) => entry.anchor.anchorId);
  return {
    evidenceEntries,
    workspace: {
      status: "available",
      cwd,
      observedAt: "2026-07-30T10:00:00.000Z",
      sourceRevision: workspaceRevision,
      observationAnchors,
      checkpoint: {
        status: "found",
        path: `${cwd}/SESSION_CHECKPOINT.md`,
        content: STALE_AA_CHECKPOINT,
        truncatedChars: 0,
        recordedRevision: CHECKPOINT_REVISION,
        freshness: "stale",
      },
      git: {
        status: "available",
        head: COMPRESSION_GIT_HEAD,
        branchAndStatus: statusText,
        recentCommits: commitsText,
        unstagedDiffStat: "",
        stagedDiffStat: "",
        unstagedNames: "",
        stagedNames: "",
      },
    },
  };
}

export function acceptedTerminalEvidencePack(parsed) {
  const workspaceFixture = acceptedTerminalWorkspaceFixture(parsed);
  const evidenceEntries = [
    ...parsed.evidenceEntries,
    ...workspaceFixture.evidenceEntries,
  ];
  const terminalArtifacts = buildTerminalStateArtifacts(
    parsed.sourceContinuation,
    workspaceFixture.workspace,
  );
  const preservationLedger = buildContinuationPreservationLedger(
    parsed.sourceRevision,
    evidenceEntries,
    {
      turns: parsed.turns,
      workspace: workspaceFixture.workspace,
      additionalRequiredAnchors: [
        ...(parsed.sourceContinuation?.acceptedProposal?.anchors || []),
        ...terminalArtifacts.terminalStateClaim.anchors,
      ],
    },
  );
  const source = {
    sessionId: ACCEPTED_TERMINAL_SESSION_ID,
    storageKind: "active",
    rolloutPath: parsed.rolloutPath,
    sourceChars: parsed.sourceChars,
    sourceBytes: parsed.sourceBytes,
    sourceRevision: parsed.sourceRevision,
    session: parsed.session,
  };
  const evidencePack = {
    formatVersion: 1,
    source,
    turns: parsed.turns,
    ignoredEvents: parsed.ignored,
    workspace: workspaceFixture.workspace,
    evidenceAnchors: evidenceEntries.map((entry) => entry.anchor),
    preservationLedger,
    sourceContinuation: parsed.sourceContinuation,
    ...terminalArtifacts,
  };
  evidencePack.evidenceChars = JSON.stringify(evidencePack).length;
  evidencePack.evidenceIndex = buildEvidenceIndex({
    sessionId: ACCEPTED_TERMINAL_SESSION_ID,
    source,
    workspace: evidencePack.workspace,
    entries: evidenceEntries,
    preservationLedger,
  });
  return evidencePack;
}

export const EXPECTED_TERMINAL_AUTHORITY = Object.freeze({
  currentGoal: FINAL_CONFIRMATION,
  acceptedProposal: ACCEPTED_ANALYZER_PROPOSAL,
  checkpointFreshness: "stale",
  terminalTurnId: TERMINAL_TURN_ID,
  terminalStatus: "aborted",
  abortReason: ABORT_REASON,
  lastAssistant: TERMINAL_ASSISTANT_MESSAGE,
  lastCompletedToolCallId: COMPLETED_TOOL_CALL_ID,
  pendingToolCallId: PENDING_TOOL_CALL_ID,
  sourceTerminatedAt: 1785402066,
  workspaceGitHead: COMPRESSION_GIT_HEAD,
});
