import test from "node:test";
import assert from "node:assert/strict";

import {
  createMapDispatch,
  scheduleMapDispatches,
} from "../scripts/lib/map-worker.mjs";
import {
  buildPerformanceMetrics,
  compareCalibrationRuns,
  projectFirstWaveBudget,
} from "../scripts/lib/performance-calibration.mjs";

const FIXTURE_DIGEST = `sha256:${"6".repeat(64)}`;

function calibrationRun(overrides = {}) {
  const config = {
    model: "configured-worker-model",
    reasoningEffort: "high",
    slotCount: 3,
    ...overrides.config,
  };
  return {
    fixtureDigest: FIXTURE_DIGEST,
    totalDispatches: 6,
    prepareAndFrameMs: 45_000,
    config,
    dispatchSamples: [
      {
        sampleClass: "smallest",
        mapGenerationMs: 70_000,
        mapGenerationSource: "provider",
        checkAcceptMs: 2_000,
      },
      {
        sampleClass: "median",
        mapGenerationMs: 90_000,
        mapGenerationSource: "provider",
        checkAcceptMs: 3_000,
      },
      {
        sampleClass: "largest",
        mapGenerationMs: 110_000,
        mapGenerationSource: "provider",
        checkAcceptMs: 4_000,
      },
    ],
    reduce: {
      generationMs: 55_000,
      generationSource: "provider",
      deterministicMs: 5_000,
    },
    publicationMs: 8_000,
    ...overrides,
    config,
  };
}

function dispatch(index) {
  const digest = (value) => `sha256:${value.repeat(64)}`;
  const segmentId = `segment-r6-${index}`;
  return createMapDispatch({
    segmentId,
    chunkPath: `C:/work/${segmentId}.json`,
    summaryPath: `C:/work/${segmentId}-summary.json`,
    contextPath: `C:/work/${segmentId}-context.json`,
    contextDigest: digest("c"),
    dictionaryPath: `C:/work/${segmentId}-dictionary.json`,
    dictionaryDigest: digest("d"),
    frameDigest: digest("f"),
    attempt: 1,
    mapResultMode: "continuation-map-v1",
    maxMapOutputChars: 4_000,
  });
}

test("R6 comparator changes one model, reasoning, or slot factor and rejects harness latency", () => {
  const baseline = calibrationRun();
  const modelCandidate = calibrationRun({
    config: { model: "candidate-worker-model", reasoningEffort: "high", slotCount: 3 },
    dispatchSamples: calibrationRun().dispatchSamples.map((sample) => ({
      ...sample,
      mapGenerationMs: sample.mapGenerationMs - 20_000,
    })),
  });
  const compared = compareCalibrationRuns(baseline, modelCandidate);

  assert.equal(compared.changedFactor, "model");
  assert.equal(compared.winner, "candidate");
  assert.ok(compared.candidate.projectedTotalMs < compared.baseline.projectedTotalMs);

  const reasoningCompared = compareCalibrationRuns(baseline, calibrationRun({
    config: { model: "configured-worker-model", reasoningEffort: "medium", slotCount: 3 },
  }));
  assert.equal(reasoningCompared.changedFactor, "reasoningEffort");
  assert.equal(reasoningCompared.winner, "tie");

  const slotCompared = compareCalibrationRuns(baseline, calibrationRun({
    config: { model: "configured-worker-model", reasoningEffort: "high", slotCount: 6 },
  }));
  assert.equal(slotCompared.changedFactor, "slotCount");
  assert.equal(slotCompared.winner, "candidate");
  assert.equal(slotCompared.candidate.projectedMapWaves, 1);

  assert.throws(
    () => compareCalibrationRuns(baseline, calibrationRun({
      config: { model: "candidate-worker-model", reasoningEffort: "medium", slotCount: 3 },
    })),
    { code: "UNCONTROLLED_CALIBRATION_COMPARISON" },
  );

  const harnessTimed = calibrationRun();
  harnessTimed.dispatchSamples[0].mapGenerationSource = "harness";
  assert.throws(
    () => compareCalibrationRuns(baseline, harnessTimed),
    { code: "INVALID_PROVIDER_LATENCY" },
  );
});

test("R6 first-wave projection reports over-budget without controlling admission", () => {
  const firstWave = {
    totalDispatches: 6,
    completedDispatches: 3,
    prepareAndFrameMs: 115_345,
    mapGenerationSamples: [180_000, 210_000, 220_000],
    checkAcceptSamples: [8_000, 9_000, 10_000],
    reduceMs: 60_000,
    publicationMs: 20_000,
    targetMs: 600_000,
  };
  const projected = projectFirstWaveBudget({ ...firstWave, availableSlots: 3 });

  assert.equal(projected.projectedMapWaves, 2);
  assert.equal(projected.projectedTotalMs, 695_345);
  assert.equal(projected.abort, true);
  assert.equal(
    projectFirstWaveBudget({ ...firstWave, availableSlots: 6 }).projectedMapWaves,
    2,
  );

  const scheduled = scheduleMapDispatches(
    [dispatch(4), dispatch(5), dispatch(6)],
    3,
    { firstWave },
  );
  assert.equal(scheduled.status, "ready");
  assert.deepEqual(scheduled.dispatches, [dispatch(4), dispatch(5), dispatch(6)]);
  assert.equal(scheduled.projection.projectedTotalMs, 695_345);
  assert.equal(scheduled.projection.abort, true);
});

test("R6 failure performance metrics always expose all four phase boundaries", () => {
  const metrics = buildPerformanceMetrics({
    stages: [
      {
        wave: 1,
        providerMapGenerationMs: 70_000,
        checkDurationMs: 100,
        completeDurationMs: 200,
        acceptDurationMs: 50,
      },
      {
        wave: 1,
        providerMapGenerationMs: 90_000,
        checkDurationMs: 120,
        completeDurationMs: 180,
        acceptDurationMs: 60,
      },
    ],
    reduceGenerationMs: 40_000,
    reducePrepareDurationMs: 500,
    reduceCheckDurationMs: 250,
    publicationDurationMs: 75,
  }, {
    failurePhase: "publish",
    failureDurationMs: 75,
  });

  assert.deepEqual(Object.keys(metrics), [
    "mapGeneration",
    "checkAccept",
    "reduce",
    "publication",
  ]);
  assert.deepEqual(metrics.mapGeneration, {
    durationMs: 90_000,
    source: "provider",
    complete: true,
    sampleCount: 2,
  });
  assert.equal(metrics.checkAccept.durationMs, 710);
  assert.equal(metrics.reduce.durationMs, 40_750);
  assert.deepEqual(metrics.publication, {
    durationMs: 75,
    source: "workflow",
    complete: false,
  });

  const earlyFailure = buildPerformanceMetrics({}, {
    failurePhase: "prepare-reduce",
    failureDurationMs: 12,
  });
  assert.deepEqual(Object.keys(earlyFailure), Object.keys(metrics));
  assert.equal(earlyFailure.mapGeneration.durationMs, null);
  assert.equal(earlyFailure.reduce.durationMs, 12);
  assert.equal(earlyFailure.publication.durationMs, null);
});
