import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import {
  buildTerminalStateArtifacts,
  buildTerminalStateV1,
} from "../scripts/lib/terminal-state.mjs";
import {
  ABORT_REASON,
  COMPLETED_TOOL_CALL_ID,
  COMPRESSION_GIT_HEAD,
  PENDING_TOOL_CALL_ID,
  TERMINAL_ASSISTANT_MESSAGE,
  TERMINAL_TURN_ID,
  acceptedTerminalEvidencePack,
  acceptedTerminalRolloutRecords,
  acceptedTerminalWorkspaceFixture,
} from "./fixtures/accepted-terminal-fixtures.mjs";

async function parsedFixture(root) {
  const rolloutPath = path.join(root, "synthetic-rollout.jsonl");
  await fs.promises.writeFile(
    rolloutPath,
    `${acceptedTerminalRolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  return parseSourceThread(rolloutPath);
}

test("TS3 aborted in-flight state produces one stable terminal_state Claim", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ts3-terminal-"));
  try {
    const parsed = await parsedFixture(root);
    const pack = acceptedTerminalEvidencePack(parsed);
    const replay = buildTerminalStateArtifacts(
      parsed.sourceContinuation,
      pack.workspace,
    );

    assert.equal(pack.terminalState.formatVersion, 1);
    assert.equal(pack.terminalState.sourceTerminal.turnId, TERMINAL_TURN_ID);
    assert.equal(pack.terminalState.sourceTerminal.status, "aborted");
    assert.equal(pack.terminalState.sourceTerminal.abortReason, ABORT_REASON);
    assert.equal(pack.terminalState.sourceTerminal.lastAssistant.text, TERMINAL_ASSISTANT_MESSAGE);
    assert.equal(
      pack.terminalState.sourceTerminal.lastCompletedToolResult.callId,
      COMPLETED_TOOL_CALL_ID,
    );
    assert.equal(pack.terminalState.sourceTerminal.pendingToolCall.callId, PENDING_TOOL_CALL_ID);
    assert.equal(pack.terminalState.workspaceObserved.head, COMPRESSION_GIT_HEAD);
    assert.notEqual(
      pack.terminalState.sourceTerminal.terminatedAt,
      pack.terminalState.workspaceObserved.observedAt,
    );
    assert.equal(pack.terminalStateClaim.kind, "terminal_state");
    assert.equal(pack.terminalStateClaim.claimId, replay.terminalStateClaim.claimId);
    assert.equal(pack.terminalStateClaim.text, replay.terminalStateClaim.text);
    assert.deepEqual(
      pack.terminalStateClaim.anchors,
      [...new Set(pack.terminalStateClaim.anchors)],
    );
    assert.ok(pack.terminalStateClaim.anchors.every((anchorId) => (
      pack.preservationLedger.requiredAnchors.includes(anchorId)
    )));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("TS3 normal, no-tool, non-Git, and unavailable observations never invent receipts", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ts3-variants-"));
  try {
    const parsed = await parsedFixture(root);
    const workspace = acceptedTerminalWorkspaceFixture(parsed).workspace;
    const normal = structuredClone(parsed.sourceContinuation);
    normal.terminalEvidence.status = "completed";
    normal.terminalEvidence.abortReason = null;
    normal.terminalEvidence.orderedEvents = normal.terminalEvidence.orderedEvents.filter(
      (event) => event.callId !== PENDING_TOOL_CALL_ID,
    );
    const completed = buildTerminalStateV1(normal, workspace);
    assert.equal(completed.sourceTerminal.status, "completed");
    assert.equal(completed.sourceTerminal.lastCompletedToolResult.callId, COMPLETED_TOOL_CALL_ID);
    assert.equal(completed.sourceTerminal.pendingToolCall, null);

    const abortAfterCompleted = structuredClone(normal);
    abortAfterCompleted.terminalEvidence.status = "aborted";
    abortAfterCompleted.terminalEvidence.abortReason = ABORT_REASON;
    const aborted = buildTerminalStateV1(abortAfterCompleted, workspace);
    assert.equal(aborted.sourceTerminal.lastCompletedToolResult.callId, COMPLETED_TOOL_CALL_ID);
    assert.equal(aborted.sourceTerminal.pendingToolCall, null);

    const noTool = structuredClone(normal);
    noTool.terminalEvidence.orderedEvents = noTool.terminalEvidence.orderedEvents.filter(
      (event) => event.kind !== "tool_receipt",
    );
    const noToolState = buildTerminalStateV1(noTool, workspace);
    assert.equal(noToolState.sourceTerminal.lastCompletedToolResult, null);
    assert.equal(noToolState.sourceTerminal.pendingToolCall, null);

    const nonGit = buildTerminalStateV1(noTool, {
      ...workspace,
      git: { status: "not_repository" },
      observationAnchors: workspace.observationAnchors.slice(0, 1),
    });
    assert.equal(nonGit.workspaceObserved.gitStatus, "not_repository");
    assert.equal(nonGit.workspaceObserved.head, null);

    const unavailable = buildTerminalStateV1(noTool, {
      status: "unavailable",
      observedAt: "2026-07-30T10:01:00.000Z",
      sourceRevision: null,
      observationAnchors: [],
    });
    assert.equal(unavailable.workspaceObserved.gitStatus, "unavailable");
    assert.equal(unavailable.workspaceObserved.sourceRevision, null);
    assert.equal(unavailable.workspaceObserved.head, null);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
