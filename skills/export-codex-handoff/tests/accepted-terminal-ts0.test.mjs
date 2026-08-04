import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildFrameInput } from "../scripts/lib/compression-frame.mjs";
import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import {
  ACCEPTED_ANALYZER_PROPOSAL,
  CHECKPOINT_REVISION,
  COMPRESSION_GIT_HEAD,
  EXPECTED_TERMINAL_AUTHORITY,
  FINAL_CONFIRMATION,
  STALE_AA_CHECKPOINT,
  acceptedTerminalEvidencePack,
  acceptedTerminalRolloutRecords,
} from "./fixtures/accepted-terminal-fixtures.mjs";

test("TS0 synthetic fixture reproduces referential-goal and stale-checkpoint authority loss", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ts0-terminal-"));
  const rolloutPath = path.join(root, "synthetic-rollout.jsonl");
  try {
    await fs.promises.writeFile(
      rolloutPath,
      `${acceptedTerminalRolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const parsed = await parseSourceThread(rolloutPath);
    const pack = acceptedTerminalEvidencePack(parsed);
    const legacyPack = structuredClone(pack);
    delete legacyPack.workspace.checkpoint.freshness;
    delete legacyPack.sourceContinuation;
    delete legacyPack.terminalState;
    delete legacyPack.terminalStateClaim;
    const legacyFrameInput = buildFrameInput(legacyPack, pack.evidenceIndex);
    const finalTurn = parsed.turns.at(-1);
    const precedingAssistant = parsed.turns.at(-2).assistantMessages.at(-1);

    assert.equal(legacyFrameInput.latestUserGoal.text, FINAL_CONFIRMATION);
    assert.equal(precedingAssistant.text, ACCEPTED_ANALYZER_PROPOSAL);
    assert.equal(legacyFrameInput.workspaceCheckpoint.text, STALE_AA_CHECKPOINT);
    assert.equal(Object.hasOwn(legacyFrameInput, "acceptedProposal"), false);
    assert.equal(finalTurn.status, "aborted");
    assert.equal(Object.hasOwn(finalTurn, "abortReason"), false);
    assert.equal(finalTurn.toolReceipts.filter((receipt) => receipt.valueKind === "output").length, 1);
    assert.equal(finalTurn.tools.at(-1).outputReceiptId, null);
    assert.notEqual(CHECKPOINT_REVISION, COMPRESSION_GIT_HEAD);

    assert.deepEqual(EXPECTED_TERMINAL_AUTHORITY, {
      currentGoal: FINAL_CONFIRMATION,
      acceptedProposal: ACCEPTED_ANALYZER_PROPOSAL,
      checkpointFreshness: "stale",
      terminalTurnId: finalTurn.turnId,
      terminalStatus: "aborted",
      abortReason: "interrupted",
      lastAssistant: "分析器修复已验证；正在写入最终策略。",
      lastCompletedToolCallId: "call-analyzer-verify",
      pendingToolCallId: "call-analyzer-write",
      sourceTerminatedAt: 1785402066,
      workspaceGitHead: COMPRESSION_GIT_HEAD,
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
