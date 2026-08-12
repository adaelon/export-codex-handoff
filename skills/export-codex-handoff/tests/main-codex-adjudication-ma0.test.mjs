import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import {
  prepareCompressionTask,
  prepareFrameStage,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";

const SESSION_ID = "00000000-0000-7000-8000-0000000000e0";
const TURN_ID = "00000000-0000-7000-8000-0000000000e1";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;

function evidencePack() {
  const entry = createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId: TURN_ID,
    eventOrdinal: 1,
    rolloutLine: 1,
    payloadPath: "/payload/content/0/text",
    value: "Exercise the Main Codex adjudication boundary.",
    locator: { kind: "rollout_payload" },
  });
  const turns = [{
    turnId: TURN_ID,
    userMessages: [{
      text: "Exercise the Main Codex adjudication boundary.",
      anchors: [entry.anchor.anchorId],
    }],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
  }];
  const preservationLedger = buildPreservationLedger(SOURCE_REVISION, [entry]);
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/main-codex-adjudication-ma0.jsonl",
    sourceChars: 64,
    sourceBytes: 64,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/main-codex-adjudication-ma0",
      startedAt: "2026-08-12T00:00:00.000Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: source.session.cwd,
    checkpoint: { status: "missing" },
    git: { status: "not_repository" },
  };
  const pack = {
    formatVersion: 1,
    source,
    turns,
    ignoredEvents: {},
    workspace,
    evidenceAnchors: [entry.anchor],
    preservationLedger,
  };
  return {
    ...pack,
    evidenceChars: JSON.stringify(pack).length,
    evidenceIndex: buildEvidenceIndex({
      sessionId: SESSION_ID,
      source,
      workspace,
      entries: [entry],
      preservationLedger,
    }),
  };
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("MA0 authentic pre-dispatch failure has a terminal report but no adjudication state", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma0-adjudication-gap-"));
  try {
    const prepared = await prepareCompressionTask({
      sessionId: SESSION_ID,
      outputPath: path.join(root, "handoff.md"),
      evidenceIndexPath: path.join(root, "handoff.evidence.json"),
      workRoot: root,
    }, { buildEvidencePack: async () => evidencePack() });
    const frameStage = await prepareFrameStage(prepared.workDir);
    const frameInput = JSON.parse(await fs.promises.readFile(frameStage.frameInputPath, "utf8"));
    await writeJson(frameStage.framePath, {
      frameId: frameInput.expectedFrameId,
      currentGoal: frameInput.latestUserGoal,
      taskType: "implementation",
      taskPhase: "implementing",
      explicitExclusions: frameInput.explicitExclusions,
      preservationPolicy: frameInput.preservationPolicy,
      anchors: frameInput.requiredFrameAnchors,
    });

    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    manifest.createdAt = "2026-08-12T00:00:00.000Z";
    manifest.frameValidatedAt = "2026-08-12T00:10:01.000Z";
    await writeJson(prepared.manifestPath, manifest);

    await assert.rejects(
      validateFrameStage(prepared.workDir),
      { code: "LIVE_BUDGET_UNREACHABLE" },
    );
    const report = JSON.parse(await fs.promises.readFile(
      path.join(prepared.workDir, "failure-report.json"),
      "utf8",
    ));
    assert.equal(report.kind, "codex-handoff-terminal-failure");
    assert.equal(report.phase, "pre-dispatch");
    assert.equal(report.diagnostic.code, "LIVE_BUDGET_UNREACHABLE");
    await assert.rejects(
      fs.promises.access(path.join(prepared.workDir, "adjudication")),
      { code: "ENOENT" },
    );
    await assert.rejects(fs.promises.access(prepared.outputPath), { code: "ENOENT" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
