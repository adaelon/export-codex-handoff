import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  buildPreservationLedger,
  canonicalStringify,
  createEvidenceEntry,
  sha256Text,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { createMapDispatch } from "../scripts/lib/map-worker.mjs";
import {
  prepareCompressionTask,
  recordMapGenerationMetric,
  scheduleNextMapWave,
} from "../scripts/lib/task-workflow.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..");
const CLI_PATH = path.resolve(TEST_DIR, "..", "scripts", "export-handoff.mjs");
const SESSION_ID = "00000000-0000-7000-8000-0000000000f1";
const TURN_ID = "00000000-0000-7000-8000-0000000000f2";
const FRAME_DIGEST = `sha256:${"f".repeat(64)}`;
const FIRST_WAVE_SLOTS = 3;
const WORKFLOW_DURATION_MS = Object.freeze({ check: 52, complete: 53, accept: 54 });

async function writeJson(target, value) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function syntheticEvidencePack() {
  const text = "Schedule the next MAP wave from complete provider timing.";
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
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/provider-timing-pt4.jsonl",
    sourceChars: text.length,
    sourceBytes: text.length,
    sourceRevision,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/provider-timing-pt4",
      startedAt: "2026-08-10T00:00:00.000Z",
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

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function acceptedReceipt(stage, index) {
  return {
    dispatchId: stage.dispatch.dispatchId,
    segmentId: stage.segmentId,
    status: "validated",
    summaryDigest: digest(String(index + 1)),
    completedSummaryDigest: digest(String(index + 5)),
    rawMapOutputChars: 100 + index,
    completedMapOutputChars: 200 + index,
  };
}

function stageDefinition(manifest, ordinal) {
  const segmentId = `pt4-map-${String(ordinal).padStart(3, "0")}`;
  const base = path.join(manifest.workDir, "pt4", segmentId);
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
    stage: ordinal <= FIRST_WAVE_SLOTS ? "fragment_map" : "progress_map",
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
    workerStatus: ordinal <= FIRST_WAVE_SLOTS ? "validated" : "pending",
  };
}

async function prepareSchedulingWorkflow(root, { providerLatencyMs = 10_000 } = {}) {
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    evidenceIndexPath: path.join(root, "handoff.evidence.json"),
    workRoot: root,
    mapResultMode: "continuation-map-v1",
  }, { buildEvidencePack: async () => syntheticEvidencePack() });
  const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
  manifest.createdAt = "2026-08-10T00:00:00.000Z";
  manifest.frameValidatedAt = "2026-08-10T00:00:45.000Z";
  manifest.frameId = "frame-provider-timing-pt4";
  manifest.frameDigest = FRAME_DIGEST;
  manifest.turnAggregates = [];
  manifest.segments = Array.from({ length: 4 }, (_, index) => (
    stageDefinition(manifest, index + 1)
  ));
  manifest.reduceStages = manifest.segments.map((stage) => ({
    stage: stage.stage,
    segmentId: stage.segmentId,
  }));

  const receiptTexts = new Map();
  for (let index = 0; index < FIRST_WAVE_SLOTS; index += 1) {
    const stage = manifest.segments[index];
    const receipt = acceptedReceipt(stage, index);
    stage.receiptAcceptedAt = `2026-08-10T00:01:0${index}.000Z`;
    stage.checkDurationMs = WORKFLOW_DURATION_MS.check;
    stage.completeDurationMs = WORKFLOW_DURATION_MS.complete;
    stage.acceptDurationMs = WORKFLOW_DURATION_MS.accept;
    stage.summaryDigest = receipt.summaryDigest;
    stage.completedSummaryDigest = receipt.completedSummaryDigest;
    stage.rawMapOutputChars = receipt.rawMapOutputChars;
    stage.completedMapOutputChars = receipt.completedMapOutputChars;
    await writeJson(stage.receiptPath, receipt);
    receiptTexts.set(stage.segmentId, await fs.promises.readFile(stage.receiptPath, "utf8"));
  }
  await writeJson(prepared.manifestPath, manifest);

  for (let index = 0; index < FIRST_WAVE_SLOTS; index += 1) {
    const stage = manifest.segments[index];
    await recordMapGenerationMetric(
      prepared.workDir,
      stage.segmentId,
      stage.dispatch.dispatchId,
      {
        providerObservationId: `provider-observation-pt4-${index + 1}`,
        dispatchId: stage.dispatch.dispatchId,
        segmentId: stage.segmentId,
        providerLatencyMs,
        source: "provider",
        model: "configured-worker-model",
        reasoningEffort: "high",
        wave: 1,
        availableSlots: FIRST_WAVE_SLOTS,
      },
    );
  }
  return { ...prepared, receiptTexts };
}

function recomputeMetricDigest(stage) {
  stage.mapGenerationMetric.metricDigest = `sha256:${sha256Text(canonicalStringify({
    kind: "codex-handoff-map-generation-metric",
    formatVersion: 1,
    dispatch: stage.dispatch,
    receiptDigest: stage.mapGenerationMetric.receiptDigest,
    observation: stage.mapGenerationMetric.observation,
  }))}`;
}

async function streamText(stream) {
  let output = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) output += chunk;
  return output;
}

async function runProductionCli(args) {
  const worker = new Worker(pathToFileURL(CLI_PATH), {
    argv: args,
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  const [[exitCode], stdout, stderr] = await Promise.all([
    once(worker, "exit"),
    streamText(worker.stdout),
    streamText(worker.stderr),
  ]);
  return { exitCode, stdout, stderr };
}

test("PT4 collects the exact first-wave samples and dispatches only within fresh capacity", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "provider-timing-pt4-ready-"));
  try {
    const prepared = await prepareSchedulingWorkflow(root);
    const manifestText = await fs.promises.readFile(prepared.manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    const scheduled = await scheduleNextMapWave(prepared.workDir, 1);
    assert.equal(scheduled.status, "ready");
    assert.equal(scheduled.availableSlots, 1);
    assert.equal(scheduled.wave, 2);
    assert.deepEqual(
      scheduled.dispatches.map((dispatch) => dispatch.segmentId),
      [manifest.segments[3].segmentId],
    );
    assert.equal(scheduled.projection.abort, false);
    assert.equal(scheduled.projection.completedDispatches, FIRST_WAVE_SLOTS);
    assert.equal(scheduled.projection.remainingDispatches, 1);
    assert.equal(scheduled.projection.maxMapGenerationMs, 10_000);
    assert.equal(scheduled.projection.maxCheckAcceptMs, 159);
    assert.equal(scheduled.projection.reduceMs, 60_000);
    assert.equal(scheduled.projection.publicationMs, 20_000);
    assert.equal(scheduled.projection.projectedTotalMs, 145_636);
    assert.equal(await fs.promises.readFile(prepared.manifestPath, "utf8"), manifestText);

    const cli = await runProductionCli([
      "schedule-map",
      prepared.workDir,
      "1",
    ]);
    assert.equal(cli.exitCode, 0);
    assert.equal(cli.stderr, "");
    assert.deepEqual(JSON.parse(cli.stdout), scheduled);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("PT4 maps missing, duplicate, and non-correlated first-wave samples to one diagnostic", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "provider-timing-pt4-incomplete-"));
  try {
    const prepared = await prepareSchedulingWorkflow(root);
    const original = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const cases = [
      (manifest) => {
        delete manifest.segments[1].mapGenerationMetric;
      },
      (manifest) => {
        manifest.segments[1].mapGenerationMetric.observation.providerObservationId =
          manifest.segments[0].mapGenerationMetric.observation.providerObservationId;
        recomputeMetricDigest(manifest.segments[1]);
      },
      (manifest) => {
        manifest.segments[1].mapGenerationMetric.observation.segmentId = "other-segment";
        recomputeMetricDigest(manifest.segments[1]);
      },
    ];
    for (const mutate of cases) {
      const manifest = structuredClone(original);
      mutate(manifest);
      await writeJson(prepared.manifestPath, manifest);
      await assert.rejects(
        scheduleNextMapWave(prepared.workDir, 1),
        { code: "INCOMPLETE_FIRST_WAVE_METRICS" },
      );
    }

    const missing = structuredClone(original);
    delete missing.segments[1].mapGenerationMetric;
    await writeJson(prepared.manifestPath, missing);
    await assert.rejects(
      scheduleNextMapWave(prepared.workDir, 1),
      { code: "INCOMPLETE_FIRST_WAVE_METRICS" },
    );
    const report = JSON.parse(await fs.promises.readFile(
      path.join(prepared.workDir, "failure-report.json"),
      "utf8",
    ));
    assert.equal(report.phase, "schedule-map");
    assert.equal(report.diagnostic.code, "INCOMPLETE_FIRST_WAVE_METRICS");
    assert.equal(report.workerMetrics.acceptedMaps, FIRST_WAVE_SLOTS);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("PT4 persists unreachable and unavailable scheduling failures without retry or publication", async () => {
  for (const scenario of [
    { slots: 1, providerLatencyMs: 260_000, code: "LIVE_BUDGET_UNREACHABLE" },
    { slots: 0, providerLatencyMs: 10_000, code: "MAP_WORKER_UNAVAILABLE" },
  ]) {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "provider-timing-pt4-fail-"));
    try {
      const prepared = await prepareSchedulingWorkflow(root, scenario);
      const before = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
      await assert.rejects(
        scheduleNextMapWave(prepared.workDir, scenario.slots),
        { code: scenario.code },
      );
      const after = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
      assert.deepEqual(after, before);
      assert.equal(after.segments[3].dispatch.attempt, 1);
      assert.equal(after.segments[3].workerStatus, "pending");

      for (const [segmentId, receiptText] of prepared.receiptTexts) {
        const stage = after.segments.find((item) => item.segmentId === segmentId);
        assert.equal(await fs.promises.readFile(stage.receiptPath, "utf8"), receiptText);
      }
      await assert.rejects(fs.promises.access(prepared.outputPath), { code: "ENOENT" });
      await assert.rejects(fs.promises.access(prepared.evidenceIndexPath), { code: "ENOENT" });

      const report = JSON.parse(await fs.promises.readFile(
        path.join(prepared.workDir, "failure-report.json"),
        "utf8",
      ));
      assert.equal(report.phase, "schedule-map");
      assert.equal(report.diagnostic.code, scenario.code);
      assert.equal(report.workDir, prepared.workDir);
      assert.equal(report.workerMetrics.acceptedMaps, FIRST_WAVE_SLOTS);
      assert.deepEqual(Object.keys(report.performanceMetrics), [
        "mapGeneration",
        "checkAccept",
        "reduce",
        "publication",
      ]);
      assert.equal(report.performanceMetrics.mapGeneration.sampleCount, FIRST_WAVE_SLOTS);
      if (scenario.code === "LIVE_BUDGET_UNREACHABLE") {
        assert.ok(report.diagnostic.details.projection.projectedTotalMs > 600_000);
      }
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }
});

test("PT4 leaves exact plan, architecture, and code-trail residue", async () => {
  const [plan, architecture, codeTrail] = await Promise.all([
    fs.promises.readFile(
      path.join(REPO_ROOT, "docs", "slice-plan-provider-timing-capability.md"),
      "utf8",
    ),
    fs.promises.readFile(path.join(REPO_ROOT, "docs", "architecture.md"), "utf8"),
    fs.promises.readFile(path.join(REPO_ROOT, "docs", "code-trail.md"), "utf8"),
  ]);
  assert.match(plan, /PT0-PT4 ready for controller verification; PT5 pending/);
  assert.match(plan, /\*\*PT4 implementation evidence\*\*:/);
  assert.match(plan, /\*\*PT4 exact verification evidence\*\*:/);
  assert.match(architecture, /schedule-map <WORK_DIR> <AVAILABLE_SLOTS>/);
  assert.match(architecture, /schedule-map terminal failure report/);
  assert.match(codeTrail, /## 2026-08-10 Slice PT4 later-wave scheduling and terminal diagnostics/);
  for (const residue of [
    "task-workflow-core.mjs:scheduleNextMapWave",
    "provider-timing-pt4.test.mjs:PT4 acceptance tests",
  ]) {
    assert.match(codeTrail, new RegExp(residue.replaceAll(".", "\\.")));
  }
});
