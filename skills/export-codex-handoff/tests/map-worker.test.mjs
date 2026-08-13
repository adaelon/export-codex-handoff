import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createMapDispatch,
  validateMapDispatch,
  validateMapReceipt,
  scheduleMapDispatches,
} from "../scripts/lib/map-worker.mjs";
import {
  acceptMapReceipt,
  claimMapDispatch,
  completeMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  scheduleNextMapWave,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  buildPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { sparseFromFullMapResult } from "./fixtures/sparse-map-fixtures.mjs";

const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
const TURN_ID = "turn-map-worker";
const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(
  "skills/export-codex-handoff/scripts/export-handoff.mjs",
);

function evidencePack() {
  const text = "Implement isolated MAP Workers";
  const sourceRevision = `sha256:${"a".repeat(64)}`;
  const entry = createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision,
    turnId: TURN_ID,
    eventOrdinal: 1,
    rolloutLine: 2,
    payloadPath: "/payload/content/0/text",
    value: text,
    locator: { kind: "rollout_payload" },
  });
  const preservationLedger = buildPreservationLedger(sourceRevision, [entry]);
  const pack = {
    formatVersion: 1,
    source: {
      sessionId: SESSION_ID,
      storageKind: "active",
      rolloutPath: "C:/codex/rollout.jsonl",
      sourceChars: text.length,
      sourceBytes: text.length,
      sourceRevision,
      session: { id: SESSION_ID, cwd: "C:/workspace", startedAt: null },
    },
    turns: [{
      turnId: TURN_ID,
      userMessages: [{
        text,
        anchors: [entry.anchor.anchorId],
        source: {
          anchorId: entry.anchor.anchorId,
          eventOrdinal: 1,
          rolloutLine: 2,
          payloadPath: "/payload/content/0/text",
          rangeUtf16: { start: 0, end: text.length },
          indivisible: false,
        },
      }],
      assistantMessages: [],
      tools: [],
      toolReceipts: [],
      patches: [],
    }],
    ignoredEvents: {},
    workspace: {
      status: "available",
      cwd: "C:/workspace",
      checkpoint: { status: "missing" },
      git: { status: "not_repository" },
    },
    evidenceAnchors: [entry.anchor],
    preservationLedger,
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source: pack.source,
    workspace: pack.workspace,
    entries: [entry],
    preservationLedger,
  });
  return { ...pack, evidenceChars: JSON.stringify(pack).length, evidenceIndex };
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function prepare(root, { legacy = false } = {}) {
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    workRoot: root,
    maxChunkChars: 4_000,
  }, { buildEvidencePack: async () => evidencePack() });
  if (legacy) {
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const versionPath = path.join(prepared.workDir, "workflow-version.json");
    const versionBinding = JSON.parse(await fs.promises.readFile(versionPath, "utf8"));
    delete manifest.mapResultMode;
    delete manifest.maxAggregateMapOutputChars;
    delete versionBinding.mapResultMode;
    delete versionBinding.maxAggregateMapOutputChars;
    for (const segment of manifest.segments) delete segment.maxMapOutputChars;
    await writeJson(prepared.manifestPath, manifest);
    await writeJson(versionPath, versionBinding);
  }
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
  const binding = await validateFrameStage(prepared.workDir);
  await scheduleNextMapWave(prepared.workDir, binding.mapDispatches.length);
  assert.equal(binding.mapDispatches.length, 1);
  return { ...prepared, ...binding, dispatch: binding.mapDispatches[0] };
}

function validMap(prepared) {
  const anchorId = evidencePack().turns[0].userMessages[0].anchors[0];
  const claimId = "map-worker-claim";
  const full = {
    frameId: prepared.frameId,
    frameDigest: prepared.frameDigest,
    segmentId: prepared.dispatch.segmentId,
    turnCoverage: [{
      turnId: TURN_ID,
      status: "summarized",
      claimIds: [claimId],
      reason: "captured isolated worker objective",
    }],
    objectiveFacts: [{
      claimId,
      kind: "objective",
      text: "Implement isolated MAP Workers",
      anchors: [anchorId],
    }],
    userConstraints: [],
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: [],
    conflicts: [],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    compressionNotes: [],
  };
  return prepared.mapResultMode === "sparse-map-v1"
    ? sparseFromFullMapResult(full)
    : full;
}

test("dispatch identity is frame-bound and scheduling requires fresh dedicated slots", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-dispatch-"));
  try {
    const prepared = await prepare(root);
    assert.deepEqual(Object.keys(prepared.dispatch), [
      "dispatchId",
      "segmentId",
      "chunkPath",
      "summaryPath",
      "frameDigest",
      "attempt",
      "mapResultMode",
      "maxMapOutputChars",
      "contextPath",
      "contextDigest",
      "dictionaryPath",
      "dictionaryDigest",
    ]);
    assert.equal(prepared.dispatch.attempt, 1);
    assert.doesNotThrow(() => validateMapDispatch(prepared.dispatch, {
      segmentId: prepared.dispatch.segmentId,
      frameDigest: prepared.frameDigest,
      contextDigest: prepared.dispatch.contextDigest,
    }));
    assert.throws(
      () => validateMapDispatch({
        ...prepared.dispatch,
        frameDigest: `sha256:${"f".repeat(64)}`,
      }, {
        segmentId: prepared.dispatch.segmentId,
        frameDigest: prepared.frameDigest,
      }),
      { code: "FRAME_DIGEST_MISMATCH" },
    );

    assert.equal(scheduleMapDispatches([prepared.dispatch], 1).dispatches.length, 1);
    assert.deepEqual(scheduleMapDispatches([prepared.dispatch], 0), {
      status: "needs-user",
      diagnosticCode: "MAP_WORKER_UNAVAILABLE",
      dispatches: [],
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("an atomic dispatch claim prevents two workers from claiming one dispatch", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-claim-"));
  try {
    const prepared = await prepare(root);
    const claimed = await claimMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      "worker-a",
    );
    assert.equal(claimed.claimed, true);
    await assert.rejects(
      claimMapDispatch(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
        "worker-b",
      ),
      { code: "MAP_DISPATCH_ALREADY_CLAIMED" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("validated bounded receipts let REDUCE proceed without reopening raw chunk evidence", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-receipt-"));
  try {
    const prepared = await prepare(root, { legacy: true });
    await claimMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      "worker-a",
    );
    await writeJson(prepared.dispatch.summaryPath, validMap(prepared));
    const receipt = await completeMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    assert.equal(receipt.status, "validated");
    assert.ok(JSON.stringify(receipt).length <= 2_048);
    await assert.rejects(
      completeMapDispatch(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
      ),
      { code: "DUPLICATE_MAP_RECEIPT" },
    );
    await assert.rejects(
      prepareReduceStage(prepared.workDir),
      { code: "MAP_RECEIPT_NOT_ACCEPTED" },
    );
    await acceptMapReceipt(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    await assert.rejects(
      acceptMapReceipt(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
      ),
      { code: "DUPLICATE_MAP_RECEIPT" },
    );

    await fs.promises.rm(prepared.dispatch.chunkPath);
    const reduce = await prepareReduceStage(prepared.workDir);
    assert.equal(reduce.ready, true);
    assert.deepEqual(reduce.expectedTurnIds, [TURN_ID]);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("the existing validate-map command exposes explicit worker claim and completion modes", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-cli-"));
  try {
    const prepared = await prepare(root);
    const claimed = await execFileAsync(process.execPath, [
      CLI_PATH,
      "validate-map",
      prepared.workDir,
      prepared.dispatch.segmentId,
      "--claim",
      prepared.dispatch.dispatchId,
      "--worker",
      "cli-worker",
    ]);
    assert.equal(JSON.parse(claimed.stdout).claimed, true);
    await writeJson(prepared.dispatch.summaryPath, validMap(prepared));
    const completed = await execFileAsync(process.execPath, [
      CLI_PATH,
      "validate-map",
      prepared.workDir,
      prepared.dispatch.segmentId,
      "--complete",
      prepared.dispatch.dispatchId,
    ]);
    assert.deepEqual(Object.keys(JSON.parse(completed.stdout)), [
      "dispatchId",
      "segmentId",
      "status",
      "summaryDigest",
      "rawMapOutputChars",
      "normalizedSummaryDigest",
      "normalizedMapOutputChars",
    ]);
    const accepted = await execFileAsync(process.execPath, [
      CLI_PATH,
      "validate-map",
      prepared.workDir,
      prepared.dispatch.segmentId,
      "--accept",
      prepared.dispatch.dispatchId,
    ]);
    assert.equal(JSON.parse(accepted.stdout).accepted, true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("receipt validation rejects wrong identity and oversized diagnostics", () => {
  const dispatch = createMapDispatch({
    segmentId: "segment-001",
    chunkPath: "C:/work/segment.json",
    summaryPath: "C:/work/summary.json",
    framePath: "C:/work/frame.json",
    frameDigest: `sha256:${"b".repeat(64)}`,
    attempt: 1,
  });
  assert.throws(
    () => validateMapReceipt({
      dispatchId: dispatch.dispatchId,
      segmentId: "segment-002",
      status: "validated",
      summaryDigest: `sha256:${"c".repeat(64)}`,
    }, dispatch),
    { code: "MAP_RECEIPT_SEGMENT_MISMATCH" },
  );
  assert.throws(
    () => validateMapReceipt({
      dispatchId: dispatch.dispatchId,
      segmentId: dispatch.segmentId,
      status: "failed",
      diagnosticCode: "X".repeat(3_000),
    }, dispatch),
    { code: "MAP_RECEIPT_TOO_LARGE" },
  );
});

test("two failed attempts trip the per-segment circuit breaker and retain diagnostics", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-breaker-"));
  try {
    const prepared = await prepare(root);
    await claimMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      "worker-a",
    );
    await writeJson(prepared.dispatch.summaryPath, {
      ...validMap(prepared),
      frameDigest: `sha256:${"f".repeat(64)}`,
    });
    await assert.rejects(
      completeMapDispatch(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
      ),
      { code: "FRAME_DIGEST_MISMATCH" },
    );
    await assert.rejects(prepareReduceStage(prepared.workDir));
    assert.equal(await fs.promises.access(prepared.reduceInputPath).then(
      () => true,
      () => false,
    ), false);

    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const retry = manifest.segments[0].dispatch;
    assert.equal(retry.attempt, 2);
    await claimMapDispatch(
      prepared.workDir,
      retry.segmentId,
      retry.dispatchId,
      "worker-b",
    );
    await writeJson(retry.summaryPath, {
      ...validMap({ ...prepared, dispatch: retry }),
      segmentId: "wrong-segment",
    });
    await assert.rejects(
      completeMapDispatch(prepared.workDir, retry.segmentId, retry.dispatchId),
      { code: "MAP_WORKER_EXHAUSTED" },
    );
    await assert.rejects(
      prepareReduceStage(prepared.workDir),
      { code: "MAP_WORKER_EXHAUSTED" },
    );
    const diagnostics = await fs.promises.readdir(manifest.segments[0].diagnosticsDir);
    assert.equal(diagnostics.filter((name) => name.endsWith(".receipt.json")).length, 2);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
