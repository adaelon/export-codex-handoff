import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { createMapDispatch } from "../scripts/lib/map-worker.mjs";
import {
  prepareCompressionTask,
  recordMapGenerationMetric,
  scheduleNextMapWave,
} from "../scripts/lib/task-workflow.mjs";

const SESSION_ID = "00000000-0000-7000-8000-0000000001a1";
const TURN_ID = "00000000-0000-7000-8000-0000000001a2";
const FRAME_DIGEST = `sha256:${"a".repeat(64)}`;

async function writeJson(target, value) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(target) {
  return JSON.parse(await fs.promises.readFile(target, "utf8"));
}

function syntheticEvidencePack() {
  const text = "Schedule every pending MAP dispatch through independently admitted waves.";
  const sourceRevision = `sha256:${"b".repeat(64)}`;
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
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/map-wave-scheduling.jsonl",
    sourceChars: text.length,
    sourceBytes: text.length,
    sourceRevision,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/map-wave-scheduling",
      startedAt: "2026-08-13T00:00:00.000Z",
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
    turns: [{
      turnId: TURN_ID,
      userMessages: [{ text, anchors: [entry.anchor.anchorId] }],
      assistantMessages: [],
      tools: [],
      toolReceipts: [],
      patches: [],
    }],
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

function digest(ordinal) {
  return `sha256:${String(ordinal).repeat(64)}`;
}

function stageDefinition(manifest, ordinal) {
  const segmentId = `arbitrary-wave-map-${String(ordinal).padStart(3, "0")}`;
  const base = path.join(manifest.workDir, "arbitrary-wave", segmentId);
  const dispatch = createMapDispatch({
    segmentId,
    chunkPath: `${base}-chunk.json`,
    summaryPath: `${base}-summary.json`,
    framePath: manifest.paths.frame,
    frameDigest: FRAME_DIGEST,
    attempt: 1,
    mapResultMode: "continuation-map-v1",
    maxMapOutputChars: 4_000,
  });
  return {
    segmentId,
    stage: "segment_map",
    chunkPath: dispatch.chunkPath,
    summaryPath: dispatch.summaryPath,
    completedSummaryPath: `${base}-completed.json`,
    receiptPath: `${base}-receipt.json`,
    diagnosticsDir: `${base}-diagnostics`,
    contextPath: `${base}-context.json`,
    dictionaryPath: `${base}-dictionary.json`,
    contextDigest: null,
    contextChars: null,
    dictionaryDigest: null,
    dictionaryChars: null,
    evidenceInputChars: null,
    mapInputChars: null,
    evidenceChars: 1,
    maxMapOutputChars: 4_000,
    dispatch,
    workerStatus: "pending",
  };
}

async function prepareSchedulingWorkflow(root, dispatchCount = 7) {
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    evidenceIndexPath: path.join(root, "handoff.evidence.json"),
    workRoot: root,
    mapResultMode: "continuation-map-v1",
  }, { buildEvidencePack: async () => syntheticEvidencePack() });
  const manifest = await readJson(prepared.manifestPath);
  manifest.frameId = "frame-arbitrary-wave-map";
  manifest.frameDigest = FRAME_DIGEST;
  manifest.turnAggregates = [];
  manifest.segments = Array.from({ length: dispatchCount }, (_, index) => (
    stageDefinition(manifest, index + 1)
  ));
  manifest.reduceStages = manifest.segments.map((stage) => ({
    stage: stage.stage,
    segmentId: stage.segmentId,
  }));
  await writeJson(prepared.manifestPath, manifest);
  return prepared;
}

async function acceptScheduledWave(prepared, scheduled) {
  const manifest = await readJson(prepared.manifestPath);
  for (const dispatch of scheduled.dispatches) {
    const stage = manifest.segments.find((candidate) => (
      candidate.segmentId === dispatch.segmentId
    ));
    const ordinal = manifest.segments.indexOf(stage) + 1;
    const receipt = {
      dispatchId: dispatch.dispatchId,
      segmentId: dispatch.segmentId,
      status: "validated",
      summaryDigest: digest(ordinal),
      completedSummaryDigest: digest(ordinal + 7),
      rawMapOutputChars: 100 + ordinal,
      completedMapOutputChars: 200 + ordinal,
    };
    stage.workerStatus = "validated";
    stage.receiptAcceptedAt = new Date().toISOString();
    stage.checkDurationMs = 1;
    stage.completeDurationMs = 1;
    stage.acceptDurationMs = 1;
    stage.summaryDigest = receipt.summaryDigest;
    stage.completedSummaryDigest = receipt.completedSummaryDigest;
    stage.rawMapOutputChars = receipt.rawMapOutputChars;
    stage.completedMapOutputChars = receipt.completedMapOutputChars;
    await writeJson(stage.receiptPath, receipt);
  }
  await writeJson(prepared.manifestPath, manifest);
}

test("arbitrary-wave MAP refreshes capacity and completes 7 dispatches without provider timing", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "arbitrary-map-waves-"));
  try {
    const prepared = await prepareSchedulingWorkflow(root);
    const slotObservations = [3, 2, 1, 1];
    const admittedSegments = [];

    for (let index = 0; index < slotObservations.length; index += 1) {
      const scheduled = await scheduleNextMapWave(
        prepared.workDir,
        slotObservations[index],
      );
      assert.equal(scheduled.status, "ready");
      assert.equal(scheduled.wave, index + 1);
      assert.equal(scheduled.availableSlots, slotObservations[index]);
      assert.equal(scheduled.dispatches.length, slotObservations[index]);
      assert.equal(Object.hasOwn(scheduled, "projection"), false);
      admittedSegments.push(scheduled.dispatches.map((dispatch) => dispatch.segmentId));

      const waiting = await scheduleNextMapWave(prepared.workDir, 7);
      assert.equal(waiting.status, "awaiting-acceptance");
      assert.equal(waiting.wave, index + 1);
      assert.deepEqual(waiting.dispatches, []);
      await acceptScheduledWave(prepared, scheduled);
    }

    assert.deepEqual(admittedSegments.map((wave) => wave.length), [3, 2, 1, 1]);
    assert.equal(new Set(admittedSegments.flat()).size, 7);

    const complete = await scheduleNextMapWave(prepared.workDir, 5);
    assert.equal(complete.status, "complete");
    assert.equal(complete.totalDispatches, 7);
    assert.equal(complete.acceptedDispatches, 7);

    const manifest = await readJson(prepared.manifestPath);
    assert.deepEqual(
      manifest.mapWaveAdmissions.map((wave) => ({
        wave: wave.wave,
        availableSlots: wave.availableSlots,
        segmentIds: wave.segmentIds,
      })),
      slotObservations.map((availableSlots, index) => ({
        wave: index + 1,
        availableSlots,
        segmentIds: admittedSegments[index],
      })),
    );
    assert.equal(manifest.segments.every((stage) => stage.receiptAcceptedAt), true);
    assert.equal(manifest.segments.some((stage) => stage.mapGenerationMetric), false);
    assert.equal(JSON.stringify(manifest).includes("providerLatencyMs"), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("workflow deadline is frozen from the synthesized creation clock", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "map-wave-deadline-"));
  try {
    const createdAtMs = Date.parse("2035-06-07T08:09:10.000Z");
    t.mock.timers.enable({ apis: ["Date"], now: createdAtMs });
    const prepared = await prepareSchedulingWorkflow(root, 2);
    const manifest = await readJson(prepared.manifestPath);
    const binding = await readJson(path.join(prepared.workDir, "workflow-version.json"));
    assert.equal(manifest.createdAt, "2035-06-07T08:09:10.000Z");
    assert.equal(manifest.workflowDeadlineAt, "2035-06-07T08:19:10.000Z");
    assert.equal(binding.createdAt, manifest.createdAt);
    assert.equal(binding.workflowDeadlineAt, manifest.workflowDeadlineAt);

    t.mock.timers.tick(600_001);
    const manifestBefore = await fs.promises.readFile(prepared.manifestPath, "utf8");

    await assert.rejects(
      scheduleNextMapWave(prepared.workDir, 1),
      { code: "WORKFLOW_DEADLINE_EXCEEDED" },
    );
    assert.equal(await fs.promises.readFile(prepared.manifestPath, "utf8"), manifestBefore);
    const unchanged = await readJson(prepared.manifestPath);
    assert.deepEqual(unchanged.mapWaveAdmissions, []);
    assert.equal(JSON.stringify(unchanged).includes("providerLatencyMs"), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("provider timing stays optional but binds to the durable wave admission", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "map-wave-provider-binding-"));
  try {
    const prepared = await prepareSchedulingWorkflow(root, 2);
    const scheduled = await scheduleNextMapWave(prepared.workDir, 2);
    await acceptScheduledWave(prepared, scheduled);
    const [dispatch] = scheduled.dispatches;
    const observation = {
      providerObservationId: "provider-observation-arbitrary-wave-1",
      dispatchId: dispatch.dispatchId,
      segmentId: dispatch.segmentId,
      providerLatencyMs: 12_345,
      source: "provider",
      model: "configured-worker-model",
      reasoningEffort: "high",
      wave: 1,
      availableSlots: 2,
    };

    await assert.rejects(
      recordMapGenerationMetric(
        prepared.workDir,
        dispatch.segmentId,
        dispatch.dispatchId,
        { ...observation, source: "workflow" },
      ),
      { code: "INVALID_PROVIDER_LATENCY" },
    );
    await assert.rejects(
      recordMapGenerationMetric(
        prepared.workDir,
        dispatch.segmentId,
        dispatch.dispatchId,
        { ...observation, wave: 2 },
      ),
      { code: "MAP_GENERATION_OBSERVATION_MISMATCH" },
    );
    await recordMapGenerationMetric(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
      observation,
    );

    await assert.rejects(
      scheduleNextMapWave(prepared.workDir, 1),
      { code: "INCOMPLETE_FIRST_WAVE_METRICS" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("durable wave admissions must contain the exact next min(pending, slots) segments", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "map-wave-ledger-integrity-"));
  try {
    const prepared = await prepareSchedulingWorkflow(root, 3);
    await scheduleNextMapWave(prepared.workDir, 2);
    const manifest = await readJson(prepared.manifestPath);
    manifest.mapWaveAdmissions[0].segmentIds.pop();
    await writeJson(prepared.manifestPath, manifest);

    await assert.rejects(
      scheduleNextMapWave(prepared.workDir, 1),
      { code: "INVALID_MAP_WAVE_STATE" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
