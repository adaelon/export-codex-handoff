import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPreservationLedger,
  computeWorkspaceRevision,
  createEvidenceEntry,
  hashFileRevision,
  sha256Text,
} from "../scripts/lib/evidence-addressing.mjs";
import {
  buildEvidenceIndex,
  retrieveEvidence,
  verifyEvidenceIndex,
} from "../scripts/lib/evidence-index.mjs";
import { parseSourceThread } from "../scripts/lib/source-thread.mjs";

const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
const TURN_ID = "turn-anchor-contract";

test("Source Thread tool anchors carry every required exact pointer field", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-anchor-contract-"));
  try {
    const rolloutPath = path.join(root, `rollout-${SESSION_ID}.jsonl`);
    const output = "head-MIDDLE-tail";
    const records = [
      { type: "session_meta", payload: { id: SESSION_ID, cwd: root } },
      { type: "event_msg", payload: { type: "task_started", turn_id: TURN_ID } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "inspect" }] } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-contract", name: "exec", input: "run" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-contract", output } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: TURN_ID } },
    ];
    await fs.promises.writeFile(rolloutPath, `${records.map(JSON.stringify).join("\n")}\n`);
    const parsed = await parseSourceThread(rolloutPath, { maxToolChars: 8 });
    const receipt = parsed.turns[0].toolReceipts.find((item) => item.valueKind === "output");
    const entry = parsed.evidenceEntries.find((item) => item.anchor.anchorId === receipt.outputAnchor);
    assert.deepEqual(entry.anchor, {
      anchorId: entry.anchor.anchorId,
      sourceKind: "source_thread",
      sourceRevision: parsed.sourceRevision,
      turnId: TURN_ID,
      eventOrdinal: 5,
      rolloutLine: 5,
      payloadPath: "/payload/output",
      callId: "call-contract",
      rangeUtf16: { start: 0, end: output.length },
      sha256: sha256Text(output),
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("workspace retrieval verifies the observation revision and selected digest", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-workspace-retrieve-"));
  try {
    const rolloutPath = path.join(root, "rollout.jsonl");
    await fs.promises.writeFile(rolloutPath, "{}\n");
    const source = await hashFileRevision(rolloutPath);
    const value = "## main\n M tracked.txt";
    const locator = {
      kind: "command",
      observationId: "git.status",
      executable: "git",
      cwd: root,
      args: ["status", "--short", "--branch"],
      expectedOk: true,
      stream: "stdout",
    };
    const observations = [{ observationId: "git.status", locator, value }];
    const workspaceRevision = computeWorkspaceRevision(observations);
    const entry = createEvidenceEntry({
      sourceKind: "workspace",
      sourceRevision: workspaceRevision,
      payloadPath: "/git/branchAndStatus",
      value,
      locator,
    });
    const ledger = buildPreservationLedger(source.sourceRevision, [entry]);
    const index = buildEvidenceIndex({
      sessionId: SESSION_ID,
      source: { rolloutPath, ...source },
      workspace: { cwd: root, sourceRevision: workspaceRevision },
      entries: [entry],
      preservationLedger: ledger,
    });
    const matchingRunner = async () => ({ ok: true, stdout: value, stderr: "" });
    const retrieved = await retrieveEvidence(index, entry.anchor.anchorId, {
      commandRunner: matchingRunner,
    });
    assert.equal(retrieved.content, value);
    await assert.rejects(
      retrieveEvidence(index, entry.anchor.anchorId, {
        commandRunner: async () => ({ ok: true, stdout: `${value}!`, stderr: "" }),
      }),
      { code: "WORKSPACE_CHANGED" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("integrity verification checks source revision even when the index has no anchors", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-empty-index-"));
  try {
    const rolloutPath = path.join(root, "rollout.jsonl");
    await fs.promises.writeFile(rolloutPath, "{}\n");
    const source = await hashFileRevision(rolloutPath);
    const index = buildEvidenceIndex({
      sessionId: SESSION_ID,
      source: { rolloutPath, ...source },
      workspace: { cwd: root, sourceRevision: null },
      entries: [],
      preservationLedger: buildPreservationLedger(source.sourceRevision, []),
    });
    assert.equal((await verifyEvidenceIndex(index)).valid, true);
    await fs.promises.appendFile(rolloutPath, "{}\n");
    await assert.rejects(verifyEvidenceIndex(index), { code: "SOURCE_CHANGED" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
