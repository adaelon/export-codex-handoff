import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  isReferentialConfirmation,
  parseSourceThread,
} from "../scripts/lib/source-thread.mjs";
import {
  ABORT_REASON,
  ACCEPTED_ANALYZER_PROPOSAL,
  COMPLETED_TOOL_CALL_ID,
  FINAL_CONFIRMATION,
  PENDING_TOOL_CALL_ID,
  TERMINAL_ASSISTANT_MESSAGE,
  TERMINAL_TURN_ID,
  acceptedTerminalRolloutRecords,
} from "./fixtures/accepted-terminal-fixtures.mjs";

async function parseRecords(records) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ts1-terminal-"));
  const rolloutPath = path.join(root, "synthetic-rollout.jsonl");
  await fs.promises.writeFile(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  try {
    return await parseSourceThread(rolloutPath);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

test("TS1 referential detector is bounded and conservative", () => {
  for (const text of [
    "同意",
    "同意，修改这个",
    "按这个做。",
    "继续上述方案",
    "yes",
    "Agreed, continue",
    "do it!",
  ]) {
    assert.equal(isReferentialConfirmation(text), true, text);
  }
  for (const text of [
    "实现 analyzer policy 的修复并运行测试",
    "继续实现 TS1 的 parser、测试和文档",
    "confirm the standalone release task",
    "yes, but replace the persistence architecture with Redis",
  ]) {
    assert.equal(isReferentialConfirmation(text), false, text);
  }
});

test("TS1 binds the nearest preceding assistant proposal and anchors terminal ordering", async () => {
  const parsed = await parseRecords(acceptedTerminalRolloutRecords());
  const continuation = parsed.sourceContinuation;

  assert.equal(continuation.currentGoal.text, FINAL_CONFIRMATION);
  assert.equal(continuation.acceptedProposal.text, ACCEPTED_ANALYZER_PROPOSAL);
  assert.equal(continuation.acceptedProposal.phase, "final_answer");
  assert.ok(continuation.acceptedProposal.anchors.length > 0);
  assert.equal(parsed.ignored.frameworkMessages, 1);

  const terminal = continuation.terminalEvidence;
  assert.equal(terminal.turnId, TERMINAL_TURN_ID);
  assert.equal(terminal.status, "aborted");
  assert.equal(terminal.terminatedAt, 1785402066);
  assert.equal(terminal.abortReason, ABORT_REASON);
  assert.equal(terminal.terminationAnchors.length, 1);

  const assistant = terminal.orderedEvents.find((event) => (
    event.kind === "assistant_message" && event.text === TERMINAL_ASSISTANT_MESSAGE
  ));
  const completedOutput = terminal.orderedEvents.find((event) => (
    event.kind === "tool_receipt" &&
    event.callId === COMPLETED_TOOL_CALL_ID &&
    event.valueKind === "output"
  ));
  const pendingInput = terminal.orderedEvents.find((event) => (
    event.kind === "tool_receipt" &&
    event.callId === PENDING_TOOL_CALL_ID &&
    event.valueKind === "input"
  ));
  assert.ok(assistant.eventOrdinal < completedOutput.eventOrdinal);
  assert.ok(completedOutput.eventOrdinal < pendingInput.eventOrdinal);
  assert.equal(completedOutput.status, "ok");
  assert.ok(completedOutput.outputAnchor);
  assert.ok(pendingInput.outputAnchor);
});

test("TS1 standalone final task never inherits an older assistant proposal", async () => {
  const standalone = "实现 analyzer policy 的修复并运行测试";
  const records = acceptedTerminalRolloutRecords().map((record) => {
    if (
      record.type === "response_item" &&
      record.payload?.type === "message" &&
      record.payload?.role === "user" &&
      record.payload?.content?.[0]?.text === FINAL_CONFIRMATION
    ) {
      return {
        ...record,
        payload: {
          ...record.payload,
          content: [{ ...record.payload.content[0], text: standalone }],
        },
      };
    }
    return record;
  });
  const parsed = await parseRecords(records);

  assert.equal(parsed.sourceContinuation.currentGoal.text, standalone);
  assert.equal(parsed.sourceContinuation.acceptedProposal, null);
});
