import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  acceptMapReceipt,
  checkMapDispatch,
  claimMapDispatch,
  completeMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  scheduleNextMapWave,
  validateFrameStage,
  validateMapStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  buildPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { validateMapDispatch } from "../scripts/lib/map-worker.mjs";

const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
const TURN_ID = "turn-sparse-workflow";
const MAP_RESULT_MODE = "sparse-map-v1";
const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(
  "skills/export-codex-handoff/scripts/export-handoff.mjs",
);

function evidencePack() {
  const text = "Bind sparse MAP results into the workflow";
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

async function prepare(root, { legacy = false, maxAggregateMapOutputChars } = {}) {
  const pack = evidencePack();
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    workRoot: root,
    maxChunkChars: 4_000,
    ...(maxAggregateMapOutputChars === undefined ? {} : { maxAggregateMapOutputChars }),
  }, { buildEvidencePack: async () => pack });
  if (legacy) {
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const versionPath = path.join(prepared.workDir, "workflow-version.json");
    const binding = JSON.parse(await fs.promises.readFile(versionPath, "utf8"));
    delete manifest.mapResultMode;
    delete manifest.maxAggregateMapOutputChars;
    delete binding.mapResultMode;
    delete binding.maxAggregateMapOutputChars;
    for (const segment of manifest.segments) delete segment.maxMapOutputChars;
    await writeJson(prepared.manifestPath, manifest);
    await writeJson(versionPath, binding);
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
  return {
    ...prepared,
    ...binding,
    dispatch: binding.mapDispatches[0],
    anchorId: pack.turns[0].userMessages[0].anchors[0],
  };
}

function sparseMap(prepared) {
  const claimId = "sparse-workflow-claim";
  return {
    formatVersion: 1,
    kind: "codex-handoff-sparse-map",
    frameId: prepared.frameId,
    frameDigest: prepared.frameDigest,
    segmentId: prepared.dispatch.segmentId,
    claims: [{
      claimId,
      kind: "objective",
      text: "Bind sparse MAP results into the workflow",
      anchors: [prepared.anchorId],
    }],
    claimGroups: {
      objectiveFacts: [claimId],
      userConstraints: [],
      completedWork: [],
      openWork: [],
      nextActions: [],
      importantLocations: [],
      conflicts: [],
    },
    claimBindings: [{ claimId, evidenceIndexes: [0] }],
    exclusionRanges: [],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    compressionNotes: [],
  };
}

function sparseMapWithImportantLocation(prepared) {
  const candidate = sparseMap(prepared);
  candidate.claims.push({
    claimId: "map009-important-location",
    kind: "important_location",
    text: "C:/synthetic/workspace/reduce-input.json — sparse MAP Claim location",
    anchors: [prepared.anchorId],
  });
  candidate.claimGroups.importantLocations.push("map009-important-location");
  candidate.claimBindings.push({
    claimId: "map009-important-location",
    evidenceIndexes: [0],
  });
  return candidate;
}

function fullMap(prepared) {
  const claimId = "legacy-workflow-claim";
  return {
    frameId: prepared.frameId,
    frameDigest: prepared.frameDigest,
    segmentId: prepared.dispatch.segmentId,
    turnCoverage: [{
      turnId: TURN_ID,
      status: "summarized",
      claimIds: [claimId],
      reason: "legacy full-MAP coverage",
    }],
    objectiveFacts: [{
      claimId,
      kind: "objective",
      text: "Preserve the legacy full-MAP route",
      anchors: [prepared.anchorId],
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
}

test("new workflow state and every dispatch bind sparse-map-v1 immutably", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-sparse-mode-"));
  try {
    const prepared = await prepare(root);
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const versionBinding = JSON.parse(await fs.promises.readFile(
      path.join(prepared.workDir, "workflow-version.json"),
      "utf8",
    ));
    assert.equal(manifest.mapResultMode, MAP_RESULT_MODE);
    assert.equal(versionBinding.mapResultMode, MAP_RESULT_MODE);
    assert.equal(prepared.mapResultMode, MAP_RESULT_MODE);
    assert.equal(prepared.dispatch.mapResultMode, MAP_RESULT_MODE);
    assert.equal(
      prepared.dispatch.maxMapOutputChars,
      prepared.maxAggregateMapOutputChars,
    );

    assert.throws(
      () => validateMapDispatch({
        ...prepared.dispatch,
        maxMapOutputChars: prepared.dispatch.maxMapOutputChars + 1,
      }),
      { code: "MAP_DISPATCH_IDENTITY_MISMATCH" },
    );

    manifest.mapResultMode = "tampered-mode";
    await writeJson(prepared.manifestPath, manifest);
    await assert.rejects(
      prepareFrameStage(prepared.workDir),
      { code: "WORKFLOW_VERSION_MISMATCH" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("over-budget sparse output fails during non-consuming check", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-sparse-output-budget-"));
  try {
    const prepared = await prepare(root, { maxAggregateMapOutputChars: 64 });
    await claimMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      "worker-over-budget",
    );
    await writeJson(prepared.dispatch.summaryPath, sparseMap(prepared));
    await assert.rejects(
      checkMapDispatch(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
      ),
      { code: "MAP_OUTPUT_TOO_LARGE" },
    );
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    assert.equal(manifest.segments[0].dispatch.attempt, 1);
    assert.equal(manifest.segments[0].workerStatus, "pending");
    assert.equal(await fs.promises.access(prepared.segments[0].receiptPath).then(
      () => true,
      () => false,
    ), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("diagnostic-equivalent importantLocations completes on attempt 1 with output metrics", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-sparse-map009-"));
  try {
    const prepared = await prepare(root);
    await claimMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      "worker-map009",
    );
    await writeJson(
      prepared.dispatch.summaryPath,
      sparseMapWithImportantLocation(prepared),
    );
    await checkMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    const receipt = await completeMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    assert.ok(receipt.rawMapOutputChars > 0);
    assert.ok(receipt.normalizedMapOutputChars > 0);
    await acceptMapReceipt(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    assert.equal(manifest.segments[0].dispatch.attempt, 1);
    assert.equal(manifest.segments[0].lastDiagnosticCode, undefined);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("validate-map --check is non-consuming and lets a Worker correct the same attempt", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-sparse-check-"));
  try {
    const prepared = await prepare(root);
    await claimMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      "worker-a",
    );
    const invalid = sparseMap(prepared);
    invalid.claimBindings = [];
    await writeJson(prepared.dispatch.summaryPath, invalid);
    await assert.rejects(
      checkMapDispatch(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
      ),
      { code: "UNSUPPORTED_CLAIM" },
    );
    let manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    assert.equal(manifest.segments[0].dispatch.attempt, 1);
    assert.equal(manifest.segments[0].workerStatus, "pending");
    assert.equal(await fs.promises.access(prepared.segments[0].receiptPath).then(
      () => true,
      () => false,
    ), false);

    await writeJson(prepared.dispatch.summaryPath, sparseMap(prepared));
    const checked = await execFileAsync(process.execPath, [
      CLI_PATH,
      "validate-map",
      prepared.workDir,
      prepared.dispatch.segmentId,
      "--check",
      prepared.dispatch.dispatchId,
    ]);
    const checkResult = JSON.parse(checked.stdout);
    assert.equal(checkResult.valid, true);
    assert.match(checkResult.summaryDigest, /^sha256:[0-9a-f]{64}$/u);

    const receipt = await completeMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    assert.equal(receipt.status, "validated");
    await acceptMapReceipt(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    const reduce = await prepareReduceStage(prepared.workDir);
    assert.equal(reduce.ready, true);
    manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    assert.equal(manifest.segments[0].dispatch.attempt, 1);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("completion rejects a candidate that changed after a successful check", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-sparse-digest-"));
  try {
    const prepared = await prepare(root);
    await claimMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      "worker-a",
    );
    const candidate = sparseMap(prepared);
    await writeJson(prepared.dispatch.summaryPath, candidate);
    await checkMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    candidate.compressionNotes.push("changed after check");
    await writeJson(prepared.dispatch.summaryPath, candidate);
    await assert.rejects(
      completeMapDispatch(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
      ),
      { code: "MAP_SUMMARY_CHANGED" },
    );
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    assert.equal(manifest.segments[0].dispatch.attempt, 1);
    assert.equal(manifest.segments[0].dispatch.dispatchId, prepared.dispatch.dispatchId);
    assert.equal(manifest.segments[0].workerStatus, "failed");
    assert.equal(manifest.segments[0].lastDiagnosticCode, "MAP_SUMMARY_CHANGED");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("receipt acceptance rejects a changed normalized sparse result", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-sparse-normalized-"));
  try {
    const prepared = await prepare(root);
    await claimMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      "worker-a",
    );
    await writeJson(prepared.dispatch.summaryPath, sparseMap(prepared));
    const receipt = await completeMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    assert.match(receipt.normalizedSummaryDigest, /^sha256:[0-9a-f]{64}$/u);
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const normalizedPath = manifest.segments[0].normalizedSummaryPath;
    const normalized = JSON.parse(await fs.promises.readFile(normalizedPath, "utf8"));
    normalized.compressionNotes.push("tampered normalized result");
    await writeJson(normalizedPath, normalized);
    await assert.rejects(
      acceptMapReceipt(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
      ),
      { code: "MAP_SUMMARY_CHANGED" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("a v2 directory without mapResultMode retains the legacy full-MAP route", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-sparse-legacy-"));
  try {
    const prepared = await prepare(root, { legacy: true });
    assert.equal(prepared.mapResultMode, undefined);
    assert.equal(prepared.dispatch.mapResultMode, undefined);
    await writeJson(prepared.dispatch.summaryPath, fullMap(prepared));
    const result = await validateMapStage(
      prepared.workDir,
      prepared.dispatch.segmentId,
    );
    assert.equal(result.valid, true);
    const reduce = await prepareReduceStage(prepared.workDir);
    assert.equal(reduce.ready, true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
