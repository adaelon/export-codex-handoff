import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  PROVIDER_TIMING_PT0_FIXTURE,
  PROVIDER_TIMING_PT2_FIXTURE,
  createProviderTimingDispatches,
  firstWaveProjectionInput,
} from "./fixtures/provider-timing-fixtures.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(TEST_DIR, "..", "scripts", "export-handoff.mjs");

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

async function productionModules() {
  const [mapWorker, performanceCalibration, taskWorkflow] = await Promise.all([
    import("../scripts/lib/map-worker.mjs"),
    import("../scripts/lib/performance-calibration.mjs"),
    import("../scripts/lib/task-workflow.mjs"),
  ]);
  return { mapWorker, performanceCalibration, taskWorkflow };
}

test("PT0 synthetic fixture reproduces the production empty-sample boundary", async () => {
  const { mapWorker, performanceCalibration } = await productionModules();
  const dispatches = createProviderTimingDispatches(mapWorker.createMapDispatch);

  assert.equal(dispatches.length, PROVIDER_TIMING_PT0_FIXTURE.totalDispatches);
  for (const dispatch of dispatches) {
    assert.equal(mapWorker.validateMapDispatch(dispatch), dispatch);
  }
  assert.deepEqual(
    PROVIDER_TIMING_PT0_FIXTURE.stages.map((stage) => stage.status),
    ["accepted", "accepted", "accepted", "pending"],
  );
  assert.deepEqual(PROVIDER_TIMING_PT0_FIXTURE.workflowDurationsMs, {
    check: 52,
    complete: 53,
    accept: 54,
  });
  assert.equal(PROVIDER_TIMING_PT0_FIXTURE.prepareAndFrameElapsedMs, 644_844);
  assert.equal(PROVIDER_TIMING_PT0_FIXTURE.calibrationObjects.length, 0);
  assert.equal(
    PROVIDER_TIMING_PT0_FIXTURE.stages.some((stage) => Object.hasOwn(stage, "calibration")),
    false,
  );
  assert.deepEqual(PROVIDER_TIMING_PT0_FIXTURE.diagnostics, {
    overBudget: "LIVE_BUDGET_UNREACHABLE",
    unavailableCapability: "PROVIDER_TIMING_UNAVAILABLE",
    incompleteObservation: "INCOMPLETE_FIRST_WAVE_METRICS",
  });

  const scheduled = mapWorker.scheduleMapDispatches(
    dispatches,
    PROVIDER_TIMING_PT0_FIXTURE.freshSlots,
    {
      providerTimingCapability:
        PROVIDER_TIMING_PT2_FIXTURE.availableProviderTimingCapability,
    },
  );
  assert.equal(scheduled.status, "ready");
  assert.equal(scheduled.availableSlots, 3);
  assert.deepEqual(scheduled.dispatches, dispatches.slice(0, 3));

  const metrics = performanceCalibration.buildPerformanceMetrics({
    stages: PROVIDER_TIMING_PT0_FIXTURE.stages,
  });
  assert.deepEqual(metrics.mapGeneration, {
    durationMs: null,
    source: "provider",
    complete: false,
    sampleCount: 0,
  });
  assert.deepEqual(metrics.checkAccept, {
    durationMs: 477,
    source: "workflow",
    complete: false,
    sampleCount: 4,
  });
  assert.throws(
    () => performanceCalibration.projectFirstWaveBudget(firstWaveProjectionInput()),
    (error) => {
      assert.equal(
        error.code,
        PROVIDER_TIMING_PT0_FIXTURE.diagnostics.incompleteObservation,
      );
      assert.equal(
        error.message,
        "mapGenerationSamples must contain at least one duration",
      );
      return true;
    },
  );
});

test("PT0 multi-wave admission treats unavailable provider timing as optional telemetry", async () => {
  const { mapWorker } = await productionModules();
  const dispatches = createProviderTimingDispatches(mapWorker.createMapDispatch);
  const scheduled = mapWorker.scheduleMapDispatches(
    dispatches,
    PROVIDER_TIMING_PT0_FIXTURE.freshSlots,
    {
      providerTimingCapability:
        PROVIDER_TIMING_PT0_FIXTURE.unavailableProviderTimingCapability,
    },
  );

  assert.equal(scheduled.status, "ready");
  assert.equal(scheduled.availableSlots, PROVIDER_TIMING_PT0_FIXTURE.freshSlots);
  assert.deepEqual(scheduled.dispatches, dispatches.slice(
    0,
    PROVIDER_TIMING_PT0_FIXTURE.freshSlots,
  ));
  assert.equal(Object.hasOwn(scheduled, "projection"), false);
});

test("PT0 production CLI has no provider-observation argument on worker-side check", async () => {
  const { mapWorker } = await productionModules();
  const [dispatch] = createProviderTimingDispatches(mapWorker.createMapDispatch);
  const syntheticWorkDir = path.join(
    TEST_DIR,
    "fixtures",
    "codex-handoff-task-pt0-provider-timing",
  );

  const result = await runProductionCli([
    "validate-map",
    syntheticWorkDir,
    dispatch.segmentId,
    "--check",
    dispatch.dispatchId,
    "--provider-observation",
    "{}",
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    code: "ERROR",
    message: "Unknown option: --provider-observation",
  });
});

test("PT0 post-worker provider-observation ingress is exported independently", async () => {
  const { taskWorkflow } = await productionModules();
  assert.equal(
    typeof taskWorkflow.recordMapGenerationMetric,
    "function",
    "recordMapGenerationMetric must be a post-worker, dispatch-bound ingress",
  );
});
