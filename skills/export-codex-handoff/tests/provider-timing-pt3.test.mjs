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
  createEvidenceEntry,
  sha256Text,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import {
  MAP_GENERATION_OBSERVATION_MAX_BYTES,
  validateMapGenerationObservation,
} from "../scripts/lib/performance-calibration.mjs";
import {
  acceptMapReceipt,
  checkMapDispatch,
  claimMapDispatch,
  completeMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  recordMapGenerationMetric,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  PROVIDER_TIMING_PT3_FIXTURE,
  createMapGenerationObservation,
} from "./fixtures/provider-timing-fixtures.mjs";
import { sparseFromFullMapResult } from "./fixtures/sparse-map-fixtures.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "..", "..", "..");
const CLI_PATH = path.resolve(TEST_DIR, "..", "scripts", "export-handoff.mjs");
const SESSION_ID = "00000000-0000-7000-8000-0000000000e1";
const TURN_ID = "00000000-0000-7000-8000-0000000000e2";

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function syntheticEvidencePack() {
  const text = "Record one accepted dispatch-bound provider observation.";
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
    rolloutPath: "C:/synthetic/provider-timing-pt3.jsonl",
    sourceChars: text.length,
    sourceBytes: text.length,
    sourceRevision,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/provider-timing-pt3",
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

function validMap(prepared) {
  const anchorId = syntheticEvidencePack().turns[0].userMessages[0].anchors[0];
  return sparseFromFullMapResult({
    frameId: prepared.frameId,
    frameDigest: prepared.frameDigest,
    segmentId: prepared.dispatch.segmentId,
    turnCoverage: [{
      turnId: TURN_ID,
      status: "summarized",
      claimIds: ["pt3-provider-observation"],
      reason: "captured the provider-observation ingress objective",
    }],
    objectiveFacts: [{
      claimId: "pt3-provider-observation",
      kind: "objective",
      text: "Record one accepted dispatch-bound provider observation.",
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
  });
}

async function prepareCompletedMap(root, { accept = true, checkObservation = false } = {}) {
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    workRoot: root,
    maxChunkChars: 4_000,
  }, { buildEvidencePack: async () => syntheticEvidencePack() });
  const frameStage = await prepareFrameStage(prepared.workDir);
  const frameInput = JSON.parse(
    await fs.promises.readFile(frameStage.frameInputPath, "utf8"),
  );
  await writeJson(frameStage.framePath, {
    frameId: frameInput.expectedFrameId,
    currentGoal: frameInput.latestUserGoal,
    taskType: "implementation",
    taskPhase: "implementing",
    explicitExclusions: frameInput.explicitExclusions,
    preservationPolicy: frameInput.preservationPolicy,
    anchors: frameInput.requiredFrameAnchors,
  });
  const validated = await validateFrameStage(prepared.workDir);
  assert.equal(validated.mapDispatches.length, 1);
  const dispatch = validated.mapDispatches[0];
  const observation = createMapGenerationObservation(dispatch);
  await claimMapDispatch(
    prepared.workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
    "pt3-worker",
  );
  await writeJson(dispatch.summaryPath, validMap({ ...validated, dispatch }));
  if (checkObservation) {
    await checkMapDispatch(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
      observation,
    );
    const checkedManifest = JSON.parse(
      await fs.promises.readFile(prepared.manifestPath, "utf8"),
    );
    assert.equal(Object.hasOwn(checkedManifest.segments[0], "calibration"), false);
    assert.equal(
      Object.hasOwn(checkedManifest.segments[0], "mapGenerationMetric"),
      false,
    );
  }
  const receipt = await completeMapDispatch(
    prepared.workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
  );
  if (accept) {
    await acceptMapReceipt(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
    );
  }
  return { ...prepared, ...validated, dispatch, observation, receipt };
}

async function removePrivateMapCandidates(prepared) {
  const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
  const stage = manifest.segments[0];
  for (const target of [
    stage.chunkPath,
    stage.summaryPath,
    stage.normalizedSummaryPath,
    stage.completedSummaryPath,
  ].filter(Boolean)) {
    await fs.promises.rm(target, { force: true });
  }
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

function occurrenceCount(text, value) {
  return text.split(value).length - 1;
}

test("PT3 validates the complete bounded MapGenerationObservation shape", () => {
  const dispatch = {
    dispatchId: `map-dispatch-sha256:${"b".repeat(64)}`,
    segmentId: "pt3-segment-001",
  };
  const valid = createMapGenerationObservation(dispatch);
  assert.deepEqual(validateMapGenerationObservation(valid), valid);
  assert.ok(Buffer.byteLength(JSON.stringify(valid)) < MAP_GENERATION_OBSERVATION_MAX_BYTES);

  for (const field of Object.keys(valid)) {
    const missing = { ...valid };
    delete missing[field];
    assert.throws(
      () => validateMapGenerationObservation(missing),
      { code: PROVIDER_TIMING_PT3_FIXTURE.diagnostics.invalidObservation },
      `missing ${field}`,
    );
  }
  for (const invalid of [
    { ...valid, providerObservationId: "" },
    { ...valid, dispatchId: "" },
    { ...valid, segmentId: "" },
    { ...valid, providerLatencyMs: -1 },
    { ...valid, providerLatencyMs: Number.NaN },
    { ...valid, model: "" },
    { ...valid, reasoningEffort: "" },
    { ...valid, wave: 0 },
    { ...valid, wave: 1.5 },
    { ...valid, availableSlots: 0 },
    { ...valid, harnessElapsedMs: valid.providerLatencyMs },
  ]) {
    assert.throws(
      () => validateMapGenerationObservation(invalid),
      { code: PROVIDER_TIMING_PT3_FIXTURE.diagnostics.invalidObservation },
    );
  }
  assert.throws(
    () => validateMapGenerationObservation({ ...valid, source: "harness" }),
    { code: "INVALID_PROVIDER_LATENCY" },
  );
});

test("PT3 records after acceptance without private candidate access and replays stably through the CLI", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "provider-timing-pt3-record-"));
  try {
    const prepared = await prepareCompletedMap(root, { checkObservation: true });
    const receiptTextBefore = await fs.promises.readFile(
      path.join(prepared.workDir, "receipts", `${prepared.dispatch.segmentId}.json`),
      "utf8",
    );
    const receiptDigestBefore = `sha256:${sha256Text(receiptTextBefore)}`;
    await removePrivateMapCandidates(prepared);

    const recorded = await recordMapGenerationMetric(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      prepared.observation,
    );
    assert.deepEqual(Object.keys(recorded), ["recorded", "metricDigest"]);
    assert.equal(recorded.recorded, true);
    assert.match(recorded.metricDigest, /^sha256:[a-f0-9]{64}$/);

    const manifestAfterRecord = await fs.promises.readFile(prepared.manifestPath, "utf8");
    const manifest = JSON.parse(manifestAfterRecord);
    assert.equal(
      manifest.mapGenerationMetricMode,
      PROVIDER_TIMING_PT3_FIXTURE.mapGenerationMetricMode,
    );
    assert.deepEqual(manifest.segments[0].mapGenerationMetric, {
      observation: prepared.observation,
      receiptDigest: receiptDigestBefore,
      metricDigest: recorded.metricDigest,
    });
    assert.equal(Object.hasOwn(manifest.segments[0], "calibration"), false);

    const replayed = await recordMapGenerationMetric(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      prepared.observation,
    );
    assert.deepEqual(replayed, recorded);
    assert.equal(await fs.promises.readFile(prepared.manifestPath, "utf8"), manifestAfterRecord);

    const observationPath = path.join(root, "provider-observation.json");
    await writeJson(observationPath, prepared.observation);
    const cliReplay = await runProductionCli([
      "record-map-metric",
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      observationPath,
    ]);
    assert.equal(cliReplay.exitCode, 0);
    assert.equal(cliReplay.stderr, "");
    assert.deepEqual(JSON.parse(cliReplay.stdout), recorded);

    const oversizedPath = path.join(root, "oversized-provider-observation.json");
    await fs.promises.writeFile(
      oversizedPath,
      "x".repeat(MAP_GENERATION_OBSERVATION_MAX_BYTES + 1),
      "utf8",
    );
    const oversized = await runProductionCli([
      "record-map-metric",
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      oversizedPath,
    ]);
    assert.equal(oversized.exitCode, 1);
    assert.equal(oversized.stdout, "");
    assert.equal(
      JSON.parse(oversized.stderr).code,
      PROVIDER_TIMING_PT3_FIXTURE.diagnostics.oversizedDocument,
    );

    const receiptTextAfter = await fs.promises.readFile(
      path.join(prepared.workDir, "receipts", `${prepared.dispatch.segmentId}.json`),
      "utf8",
    );
    assert.equal(receiptTextAfter, receiptTextBefore);
    assert.equal(`sha256:${sha256Text(receiptTextAfter)}`, receiptDigestBefore);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("PT3 fails closed for unaccepted receipts, correlation mismatches, and conflicting replay", async () => {
  const unacceptedRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "provider-timing-pt3-unaccepted-"),
  );
  try {
    const unaccepted = await prepareCompletedMap(unacceptedRoot, { accept: false });
    await assert.rejects(
      recordMapGenerationMetric(
        unaccepted.workDir,
        unaccepted.dispatch.segmentId,
        unaccepted.dispatch.dispatchId,
        unaccepted.observation,
      ),
      { code: PROVIDER_TIMING_PT3_FIXTURE.diagnostics.receiptNotAccepted },
    );
  } finally {
    await fs.promises.rm(unacceptedRoot, { recursive: true, force: true });
  }

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "provider-timing-pt3-conflict-"));
  try {
    const prepared = await prepareCompletedMap(root);
    await recordMapGenerationMetric(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      prepared.observation,
    );
    const manifestBefore = await fs.promises.readFile(prepared.manifestPath, "utf8");
    const receiptPath = path.join(
      prepared.workDir,
      "receipts",
      `${prepared.dispatch.segmentId}.json`,
    );
    const receiptBefore = await fs.promises.readFile(receiptPath, "utf8");
    const cases = [
      [
        { ...prepared.observation, dispatchId: `${prepared.dispatch.dispatchId}-other` },
        PROVIDER_TIMING_PT3_FIXTURE.diagnostics.correlationMismatch,
      ],
      [
        { ...prepared.observation, segmentId: `${prepared.dispatch.segmentId}-other` },
        PROVIDER_TIMING_PT3_FIXTURE.diagnostics.correlationMismatch,
      ],
      [{ ...prepared.observation, source: "harness" }, "INVALID_PROVIDER_LATENCY"],
      [
        { ...prepared.observation, providerObservationId: "provider-observation-pt3-002" },
        PROVIDER_TIMING_PT3_FIXTURE.diagnostics.conflictingReplay,
      ],
      [
        { ...prepared.observation, providerLatencyMs: 12_346 },
        PROVIDER_TIMING_PT3_FIXTURE.diagnostics.conflictingReplay,
      ],
      [
        { ...prepared.observation, model: "other-model" },
        PROVIDER_TIMING_PT3_FIXTURE.diagnostics.conflictingReplay,
      ],
      [
        { ...prepared.observation, reasoningEffort: "medium" },
        PROVIDER_TIMING_PT3_FIXTURE.diagnostics.conflictingReplay,
      ],
      [
        { ...prepared.observation, wave: 2 },
        PROVIDER_TIMING_PT3_FIXTURE.diagnostics.conflictingReplay,
      ],
      [
        { ...prepared.observation, availableSlots: 2 },
        PROVIDER_TIMING_PT3_FIXTURE.diagnostics.conflictingReplay,
      ],
    ];
    for (const [observation, code] of cases) {
      await assert.rejects(
        recordMapGenerationMetric(
          prepared.workDir,
          prepared.dispatch.segmentId,
          prepared.dispatch.dispatchId,
          observation,
        ),
        { code },
      );
      assert.equal(await fs.promises.readFile(prepared.manifestPath, "utf8"), manifestBefore);
      assert.equal(await fs.promises.readFile(receiptPath, "utf8"), receiptBefore);
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("PT3 refuses to retrofit a work directory without the immutable ingress binding", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "provider-timing-pt3-frozen-"));
  try {
    const prepared = await prepareCompletedMap(root);
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const versionPath = path.join(prepared.workDir, "workflow-version.json");
    const version = JSON.parse(await fs.promises.readFile(versionPath, "utf8"));
    delete manifest.mapGenerationMetricMode;
    delete version.mapGenerationMetricMode;
    await writeJson(prepared.manifestPath, manifest);
    await writeJson(versionPath, version);

    await assert.rejects(
      recordMapGenerationMetric(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
        prepared.observation,
      ),
      { code: PROVIDER_TIMING_PT3_FIXTURE.diagnostics.ingressUnavailable },
    );
    const unchanged = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    assert.equal(Object.hasOwn(unchanged.segments[0], "mapGenerationMetric"), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("PT3 leaves the exact plan, architecture, and code-trail residue", async () => {
  const [plan, architecture, codeTrail] = await Promise.all([
    fs.promises.readFile(
      path.join(REPO_ROOT, "docs", "slice-plan-provider-timing-capability.md"),
      "utf8",
    ),
    fs.promises.readFile(path.join(REPO_ROOT, "docs", "architecture.md"), "utf8"),
    fs.promises.readFile(path.join(REPO_ROOT, "docs", "code-trail.md"), "utf8"),
  ]);
  assert.equal(
    occurrenceCount(
      plan,
      "Status: accepted; PT0-PT3 ready for controller verification; PT4-PT5 pending",
    ),
    1,
  );
  assert.equal(occurrenceCount(plan, "**PT3 implementation evidence**:"), 1);
  assert.equal(occurrenceCount(plan, "**PT3 exact verification evidence**:"), 1);
  assert.equal(
    occurrenceCount(
      architecture,
      "record-map-metric <WORK_DIR> <SEGMENT_ID> <DISPATCH_ID> <OBSERVATION_FILE>",
    ),
    1,
  );
  assert.equal(
    occurrenceCount(
      architecture,
      "[Provider Timing Capability for Multi-Wave MAP](./adr/0014-provider-timing-capability-for-multi-wave-map.md)",
    ),
    1,
  );
  assert.equal(
    occurrenceCount(
      codeTrail,
      "## 2026-08-10 Slice PT3 post-worker provider-observation ingress",
    ),
    1,
  );
  for (const residue of [
    "task-workflow-core.mjs:recordMapGenerationMetric",
    "export-handoff.mjs:record-map-metric",
    "provider-timing-pt3.test.mjs:PT3 acceptance tests",
    "without reading a private MAP candidate",
  ]) {
    assert.match(codeTrail, new RegExp(residue.replaceAll(".", "\\.")));
  }
});
