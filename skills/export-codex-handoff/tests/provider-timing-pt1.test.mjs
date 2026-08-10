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
  PRE_DISPATCH_PUBLICATION_RESERVE_MS,
  PRE_DISPATCH_REDUCE_RESERVE_MS,
  projectPreDispatchLowerBound,
} from "../scripts/lib/performance-calibration.mjs";
import {
  claimMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  PROVIDER_TIMING_PT0_FIXTURE,
  PROVIDER_TIMING_PT1_FIXTURE,
} from "./fixtures/provider-timing-fixtures.mjs";

const SESSION_ID = "00000000-0000-7000-8000-0000000000d1";
const TURN_ID = "00000000-0000-7000-8000-0000000000d2";

function syntheticEvidencePack() {
  const sourceRevision = `sha256:${"a".repeat(64)}`;
  const entry = createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision,
    turnId: TURN_ID,
    eventOrdinal: 1,
    rolloutLine: 2,
    payloadPath: "/payload/content",
    value: [{ type: "input_text", text: "Exercise the PT1 lower-bound gate." }],
    locator: { kind: "rollout_payload" },
  });
  const preservationLedger = buildPreservationLedger(sourceRevision, [entry]);
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/provider-timing-pt1.jsonl",
    sourceChars: 128,
    sourceBytes: 128,
    sourceRevision,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/provider-timing-pt1",
      startedAt: "2026-08-10T00:00:00.000Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: source.session.cwd,
    checkpoint: { status: "missing" },
    git: {
      status: "available",
      branchAndStatus: "## main",
      recentCommits: "abc synthetic",
    },
  };
  const pack = {
    formatVersion: 1,
    source,
    turns: [{
      turnId: TURN_ID,
      userMessages: [{
        text: "Exercise the PT1 lower-bound gate.",
        anchors: [entry.anchor.anchorId],
      }],
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

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function prepareFrameCandidate(root, timing) {
  const pack = syntheticEvidencePack();
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    evidenceIndexPath: path.join(root, "handoff.evidence.json"),
    workRoot: root,
  }, { buildEvidencePack: async () => pack });
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
  manifest.createdAt = timing.createdAt;
  manifest.frameValidatedAt = timing.frameValidatedAt;
  await writeJson(prepared.manifestPath, manifest);
  return prepared;
}

async function claimFiles(workDir) {
  try {
    return await fs.promises.readdir(path.join(workDir, "claims"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("PT1 projection validates boundaries and applies conservative reserves", () => {
  assert.equal(
    PRE_DISPATCH_REDUCE_RESERVE_MS,
    PROVIDER_TIMING_PT1_FIXTURE.reduceReserveMs,
  );
  assert.equal(
    PRE_DISPATCH_PUBLICATION_RESERVE_MS,
    PROVIDER_TIMING_PT1_FIXTURE.publicationReserveMs,
  );

  for (const [timing, abort] of [
    [PROVIDER_TIMING_PT1_FIXTURE.unreachable, true],
    [PROVIDER_TIMING_PT1_FIXTURE.withinBudget, false],
  ]) {
    const projected = projectPreDispatchLowerBound({
      createdAt: timing.createdAt,
      frameValidatedAt: timing.frameValidatedAt,
      targetMs: PROVIDER_TIMING_PT1_FIXTURE.targetMs,
      reduceReserveMs: PROVIDER_TIMING_PT1_FIXTURE.reduceReserveMs,
      publicationReserveMs: PROVIDER_TIMING_PT1_FIXTURE.publicationReserveMs,
    });
    assert.equal(projected.prepareAndFrameMs, timing.prepareAndFrameMs);
    assert.equal(projected.projectedTotalMs, timing.projectedTotalMs);
    assert.equal(projected.abort, abort);
  }

  const valid = {
    createdAt: PROVIDER_TIMING_PT1_FIXTURE.withinBudget.createdAt,
    frameValidatedAt: PROVIDER_TIMING_PT1_FIXTURE.withinBudget.frameValidatedAt,
  };
  for (const invalid of [
    { ...valid, createdAt: undefined },
    { ...valid, frameValidatedAt: "not-a-timestamp" },
    { ...valid, frameValidatedAt: "2026-02-30T00:00:45.000Z" },
    { ...valid, createdAt: valid.frameValidatedAt, frameValidatedAt: valid.createdAt },
  ]) {
    assert.throws(
      () => projectPreDispatchLowerBound(invalid),
      { code: PROVIDER_TIMING_PT1_FIXTURE.diagnostics.invalidPhaseBoundary },
    );
  }
  for (const invalid of [
    { ...valid, targetMs: 0 },
    { ...valid, reduceReserveMs: -1 },
    { ...valid, publicationReserveMs: Number.NaN },
  ]) {
    assert.throws(
      () => projectPreDispatchLowerBound(invalid),
      { code: PROVIDER_TIMING_PT1_FIXTURE.diagnostics.invalidProjection },
    );
  }
});

test("PT1 rejects an unreachable budget after Frame validation with zero MAP claims", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "provider-timing-pt1-over-"));
  try {
    const prepared = await prepareFrameCandidate(
      root,
      PROVIDER_TIMING_PT1_FIXTURE.unreachable,
    );
    await assert.rejects(
      validateFrameStage(prepared.workDir),
      { code: PROVIDER_TIMING_PT0_FIXTURE.diagnostics.overBudget },
    );

    assert.equal((await fs.promises.stat(prepared.workDir)).isDirectory(), true);
    assert.deepEqual(await claimFiles(prepared.workDir), []);
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    assert.ok(manifest.frameDigest);
    assert.equal(manifest.segments.every((segment) => segment.dispatch === null), true);
    assert.equal(manifest.segments.every((segment) => segment.workerStatus === "unprepared"), true);

    const report = JSON.parse(await fs.promises.readFile(
      path.join(prepared.workDir, "failure-report.json"),
      "utf8",
    ));
    assert.equal(report.phase, "pre-dispatch");
    assert.equal(report.diagnostic.code, "LIVE_BUDGET_UNREACHABLE");
    assert.deepEqual(Object.keys(report.phaseTimingsMs), [
      "prepareAndFrame",
      "map",
      "reduceAndPublish",
      "total",
    ]);
    assert.equal(
      report.phaseTimingsMs.prepareAndFrame,
      PROVIDER_TIMING_PT1_FIXTURE.unreachable.prepareAndFrameMs,
    );
    assert.equal(report.workerMetrics.acceptedMaps, 0);
    assert.equal(report.performanceMetrics.mapGeneration.sampleCount, 0);
    await assert.rejects(fs.promises.access(prepared.outputPath), { code: "ENOENT" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("PT1 preserves Frame validation and claiming when the lower bound is within budget", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "provider-timing-pt1-within-"));
  try {
    const prepared = await prepareFrameCandidate(
      root,
      PROVIDER_TIMING_PT1_FIXTURE.withinBudget,
    );
    const validated = await validateFrameStage(prepared.workDir);

    assert.ok(validated.mapDispatches.length > 0);
    assert.deepEqual(await claimFiles(prepared.workDir), []);
    const [dispatch] = validated.mapDispatches;
    const claimed = await claimMapDispatch(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
      "pt1-within-budget-worker",
    );
    assert.equal(claimed.claimed, true);
    assert.deepEqual(await claimFiles(prepared.workDir), [`${dispatch.dispatchId}.json`]);
    await assert.rejects(
      fs.promises.access(path.join(prepared.workDir, "failure-report.json")),
      { code: "ENOENT" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
