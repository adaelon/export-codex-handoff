import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";

import {
  findSourceThread,
  parseSourceThread,
  validateSessionId,
} from "../scripts/lib/source-thread.mjs";
import { buildEvidencePack } from "../scripts/lib/evidence-pack.mjs";
import { captureWorkspaceSnapshot } from "../scripts/lib/workspace-snapshot.mjs";

const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
const TURN_ID = "019fa2c4-3e76-79a2-b530-8b7652767423";

async function createFixture(root) {
  const codexHome = path.join(root, ".codex");
  const workspace = path.join(root, "workspace");
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "28");
  const rolloutPath = path.join(sessionDir, `rollout-${SESSION_ID}.jsonl`);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.mkdir(workspace, { recursive: true });

  const records = [
    { type: "session_meta", payload: { id: SESSION_ID, cwd: workspace, cli_version: "test" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: TURN_ID } },
    { type: "turn_context", payload: { turn_id: TURN_ID, cwd: workspace, model: "test-model" } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "framework" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Implement the exporter" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "Implement the exporter" } },
    { type: "response_item", payload: { type: "reasoning", encrypted_content: "opaque" } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "run tests" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1", output: "x".repeat(500) } },
    { type: "event_msg", payload: { type: "patch_apply_end", call_id: "patch-1", success: true, changes: [{ path: "src/export.mjs", kind: "update" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Implemented" }] } },
    { type: "event_msg", payload: { type: "agent_message", message: "Implemented" } },
    { type: "event_msg", payload: { type: "token_count", info: {} } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: TURN_ID } },
  ];
  await fs.promises.writeFile(rolloutPath, records.map((record) => JSON.stringify(record)).join("\n"));
  return { codexHome, workspace, rolloutPath };
}

test("validates and resolves a Source Thread UUID", async () => {
  assert.equal(validateSessionId(SESSION_ID.toUpperCase()), SESSION_ID);
  assert.throws(() => validateSessionId("not-a-uuid"), { code: "INVALID_SESSION_ID" });

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-source-"));
  try {
    const fixture = await createFixture(root);
    const found = await findSourceThread(SESSION_ID, { codexHome: fixture.codexHome });
    assert.equal(found.path, fixture.rolloutPath);
    assert.equal(found.storageKind, "active");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("parses semantic events once and emits bounded Tool Receipts", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-parse-"));
  try {
    const fixture = await createFixture(root);
    const parsed = await parseSourceThread(fixture.rolloutPath, { maxToolChars: 220 });
    assert.equal(parsed.turns.length, 1);
    assert.equal(parsed.turns[0].turnId, TURN_ID);
    assert.deepEqual(parsed.turns[0].userMessages.map((item) => item.text), ["Implement the exporter"]);
    const userGoalAnchor = parsed.turns[0].userMessages[0].anchors[0];
    assert.match(userGoalAnchor, /^anchor-[0-9a-f]{64}$/);
    assert.ok(parsed.evidenceEntries.some((entry) => (
      entry.anchor.anchorId === userGoalAnchor &&
      entry.anchor.payloadPath === "/payload/content"
    )));
    assert.equal(parsed.turns[0].userMessages[0].source.payloadPath, "/payload/content/0/text");
    assert.equal(parsed.turns[0].userMessages[0].source.indivisible, false);
    assert.deepEqual(
      parsed.turns[0].userMessages[0].source.rangeUtf16,
      { start: 0, end: "Implement the exporter".length },
    );
    assert.deepEqual(parsed.turns[0].assistantMessages.map((item) => item.text), ["Implemented"]);
    assert.equal(parsed.turns[0].assistantMessages[0].phase, "final_answer");
    assert.match(parsed.turns[0].assistantMessages[0].source.anchorId, /^anchor-[0-9a-f]{64}$/);
    assert.equal(parsed.turns[0].assistantMessages[0].source.payloadPath, "/payload/content/0/text");
    const outputReceipt = parsed.turns[0].toolReceipts.find((item) => item.valueKind === "output");
    assert.ok(outputReceipt);
    assert.equal(outputReceipt.outputChars, 500);
    assert.ok(outputReceipt.previewHead.length + outputReceipt.previewTail.length <= 220);
    assert.match(outputReceipt.outputAnchor, /^anchor-[0-9a-f]{64}$/);
    assert.equal(parsed.turns[0].tools[0].outputReceiptId, outputReceipt.receiptId);
    const changeReceipt = parsed.turns[0].toolReceipts.find((item) => item.valueKind === "changes");
    assert.ok(changeReceipt);
    assert.equal(parsed.turns[0].patches[0].receiptIds.includes(changeReceipt.receiptId), true);
    assert.equal("changes" in parsed.turns[0].patches[0], false);
    assert.equal("truncatedToolChars" in parsed.turns[0], false);
    assert.equal(parsed.ignored.frameworkMessages, 1);
    assert.equal(parsed.ignored.encryptedReasoning, 1);
    assert.equal(parsed.ignored.tokenStatistics, 1);
    assert.equal(parsed.ignored.duplicateUserMessages, 1);

    const pack = await buildEvidencePack(SESSION_ID, {
      codexHome: fixture.codexHome,
      maxToolChars: 220,
      maxProgressInputChars: 1_000,
      maxProgressDispatchChars: 800,
    });
    assert.equal(pack.source.sessionId, SESSION_ID);
    assert.match(pack.source.sourceRevision, /^sha256:[0-9a-f]{64}$/);
    assert.equal(pack.turns.length, 1);
    assert.equal(pack.workspace.status, "available");
    assert.equal(pack.workspace.git.status, "not_repository");
    assert.ok(pack.evidenceChars > 0);
    assert.ok(pack.evidenceAnchors.length >= 3);
    assert.equal(pack.evidenceIndex.kind, "codex-handoff-evidence-index");
    assert.equal(pack.preservationLedger.requiredAnchors.includes(outputReceipt.outputAnchor), true);
    assert.ok(pack.preservationLedger.requiredAnchors.includes(userGoalAnchor));
    assert.ok(pack.evidenceIndex.anchors.some((entry) => (
      entry.anchor.anchorId === outputReceipt.outputAnchor
    )));
    assert.equal(pack.progressEvidence.kind, "codex-handoff-progress-evidence");
    assert.equal(pack.progressEvidence.budgets.maxInputChars, 1_000);
    assert.equal(pack.progressEvidence.budgets.maxDispatchChars, 800);
    assert.deepEqual(
      pack.progressEvidence.assistantProgress.map((reference) => reference.text),
      ["Implemented"],
    );
    assert.equal(pack.progressEvidence.inspections.length, 0);
    assert.deepEqual(pack.progressEvidence.inputMetrics.operationClassCounts, {
      content_inspection: 0,
      existence_probe: 0,
      verification: 1,
      mutation: 1,
      mechanical_success: 0,
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("captures deterministic Git and checkpoint workspace evidence", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-workspace-"));
  try {
    try {
      childProcess.execFileSync("git", ["--version"], { windowsHide: true });
    } catch {
      t.skip("git is not available");
      return;
    }

    childProcess.execFileSync("git", ["init"], { cwd: root, windowsHide: true });
    childProcess.execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, windowsHide: true });
    childProcess.execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, windowsHide: true });
    await fs.promises.writeFile(path.join(root, "tracked.txt"), "before\n");
    childProcess.execFileSync("git", ["add", "tracked.txt"], { cwd: root, windowsHide: true });
    childProcess.execFileSync("git", ["commit", "-m", "initial"], { cwd: root, windowsHide: true });
    await fs.promises.writeFile(path.join(root, "tracked.txt"), "after\n");
    await fs.promises.writeFile(path.join(root, "SESSION_CHECKPOINT.md"), "# Checkpoint\n\nNext: run tests.\n");

    const snapshot = await captureWorkspaceSnapshot(root);
    assert.equal(snapshot.status, "available");
    assert.equal(snapshot.git.status, "available");
    assert.match(snapshot.git.branchAndStatus, /tracked\.txt/);
    assert.match(snapshot.git.recentCommits, /initial/);
    assert.equal(snapshot.checkpoint.status, "found");
    assert.match(snapshot.checkpoint.content, /Next: run tests/);
    assert.match(snapshot.sourceRevision, /^sha256:[0-9a-f]{64}$/);
    assert.ok(snapshot.evidenceEntries.length >= 8);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
