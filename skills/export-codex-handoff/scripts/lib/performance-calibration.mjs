import { ExportHandoffError } from "./source-thread.mjs";

export const LIVE_ACCEPTANCE_TARGET_MS = 600_000;
export const PRE_DISPATCH_REDUCE_RESERVE_MS = 60_000;
export const PRE_DISPATCH_PUBLICATION_RESERVE_MS = 20_000;

const REPRESENTATIVE_SAMPLE_CLASSES = ["smallest", "median", "largest"];
const CONFIG_FACTORS = ["model", "reasoningEffort", "slotCount"];
const UTC_PHASE_BOUNDARY_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function requireObject(value, label, code = "INVALID_CALIBRATION_RUN") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExportHandoffError(code, `${label} must be an object`);
  }
  return value;
}

function requireString(value, label, code = "INVALID_CALIBRATION_RUN") {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExportHandoffError(code, `${label} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeDuration(value, label, code = "INVALID_CALIBRATION_RUN") {
  if (!Number.isFinite(value) || value < 0) {
    throw new ExportHandoffError(code, `${label} must be a non-negative duration`);
  }
  return value;
}

function requirePositiveInteger(value, label, code = "INVALID_CALIBRATION_RUN") {
  if (!Number.isInteger(value) || value < 1) {
    throw new ExportHandoffError(code, `${label} must be a positive integer`);
  }
  return value;
}

function requirePhaseBoundary(value, label) {
  const match = typeof value === "string" ? UTC_PHASE_BOUNDARY_PATTERN.exec(value) : null;
  const parsed = match ? Date.parse(value) : Number.NaN;
  const date = Number.isFinite(parsed) ? new Date(parsed) : null;
  const milliseconds = Number((match?.[7] || "0").padEnd(3, "0"));
  const invalidBoundary = !match || !date ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6]) ||
    date.getUTCMilliseconds() !== milliseconds;
  if (invalidBoundary) {
    throw new ExportHandoffError(
      "INVALID_PRE_DISPATCH_PHASE_BOUNDARY",
      `${label} must be an ISO-8601 UTC timestamp`,
    );
  }
  return parsed;
}

function validateProviderSource(value, label) {
  if (value !== "provider") {
    throw new ExportHandoffError(
      "INVALID_PROVIDER_LATENCY",
      `${label} must come from provider timing, not harness elapsed time`,
    );
  }
}

export function validateMapGenerationMetric(metric) {
  requireObject(metric, "MAP generation metric", "INVALID_MAP_GENERATION_METRIC");
  requireNonNegativeDuration(
    metric.providerLatencyMs,
    "providerLatencyMs",
    "INVALID_MAP_GENERATION_METRIC",
  );
  validateProviderSource(metric.source, "MAP generation metric source");
  requireString(metric.model, "model", "INVALID_MAP_GENERATION_METRIC");
  requireString(
    metric.reasoningEffort,
    "reasoningEffort",
    "INVALID_MAP_GENERATION_METRIC",
  );
  requirePositiveInteger(metric.wave, "wave", "INVALID_MAP_GENERATION_METRIC");
  requirePositiveInteger(
    metric.availableSlots,
    "availableSlots",
    "INVALID_MAP_GENERATION_METRIC",
  );
  return {
    providerLatencyMs: metric.providerLatencyMs,
    source: "provider",
    model: metric.model,
    reasoningEffort: metric.reasoningEffort,
    wave: metric.wave,
    availableSlots: metric.availableSlots,
  };
}

export function validateReduceGenerationMetric(metric) {
  requireObject(metric, "REDUCE generation metric", "INVALID_REDUCE_GENERATION_METRIC");
  requireNonNegativeDuration(
    metric.providerLatencyMs,
    "providerLatencyMs",
    "INVALID_REDUCE_GENERATION_METRIC",
  );
  validateProviderSource(metric.source, "REDUCE generation metric source");
  requireString(metric.model, "model", "INVALID_REDUCE_GENERATION_METRIC");
  requireString(
    metric.reasoningEffort,
    "reasoningEffort",
    "INVALID_REDUCE_GENERATION_METRIC",
  );
  return {
    providerLatencyMs: metric.providerLatencyMs,
    source: "provider",
    model: metric.model,
    reasoningEffort: metric.reasoningEffort,
  };
}

function validateCalibrationRun(run) {
  requireObject(run, "Calibration run");
  requireString(run.fixtureDigest, "fixtureDigest");
  requirePositiveInteger(run.totalDispatches, "totalDispatches");
  requireNonNegativeDuration(run.prepareAndFrameMs, "prepareAndFrameMs");
  requireObject(run.config, "config");
  requireString(run.config.model, "config.model");
  requireString(run.config.reasoningEffort, "config.reasoningEffort");
  requirePositiveInteger(run.config.slotCount, "config.slotCount");
  if (!Array.isArray(run.dispatchSamples)) {
    throw new ExportHandoffError(
      "INVALID_CALIBRATION_RUN",
      "dispatchSamples must be an array",
    );
  }
  const sampleClasses = run.dispatchSamples.map((sample, index) => {
    requireObject(sample, `dispatchSamples[${index}]`);
    requireString(sample.sampleClass, `dispatchSamples[${index}].sampleClass`);
    requireNonNegativeDuration(
      sample.mapGenerationMs,
      `dispatchSamples[${index}].mapGenerationMs`,
    );
    validateProviderSource(
      sample.mapGenerationSource,
      `dispatchSamples[${index}].mapGenerationSource`,
    );
    requireNonNegativeDuration(
      sample.checkAcceptMs,
      `dispatchSamples[${index}].checkAcceptMs`,
    );
    return sample.sampleClass;
  });
  if (
    sampleClasses.length !== REPRESENTATIVE_SAMPLE_CLASSES.length ||
    sampleClasses.some((sampleClass, index) => (
      sampleClass !== REPRESENTATIVE_SAMPLE_CLASSES[index]
    ))
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_CALIBRATION_SAMPLE",
      `dispatchSamples must contain ${REPRESENTATIVE_SAMPLE_CLASSES.join(", ")} in order`,
    );
  }
  requireObject(run.reduce, "reduce");
  requireNonNegativeDuration(run.reduce.generationMs, "reduce.generationMs");
  validateProviderSource(run.reduce.generationSource, "reduce.generationSource");
  requireNonNegativeDuration(run.reduce.deterministicMs, "reduce.deterministicMs");
  requireNonNegativeDuration(run.publicationMs, "publicationMs");
  return run;
}

function projectCalibrationRun(run) {
  validateCalibrationRun(run);
  const maxMapGenerationMs = Math.max(
    ...run.dispatchSamples.map((sample) => sample.mapGenerationMs),
  );
  const maxCheckAcceptMs = Math.max(
    ...run.dispatchSamples.map((sample) => sample.checkAcceptMs),
  );
  const projectedMapWaves = Math.ceil(
    run.totalDispatches / run.config.slotCount,
  );
  const mapGenerationMs = projectedMapWaves * maxMapGenerationMs;
  const checkAcceptMs = run.totalDispatches * maxCheckAcceptMs;
  const reduceMs = run.reduce.generationMs + run.reduce.deterministicMs;
  const projectedTotalMs = run.prepareAndFrameMs
    + mapGenerationMs
    + checkAcceptMs
    + reduceMs
    + run.publicationMs;
  return {
    config: structuredClone(run.config),
    projectedMapWaves,
    mapGenerationMs,
    checkAcceptMs,
    reduceMs,
    publicationMs: run.publicationMs,
    projectedTotalMs,
    targetMs: LIVE_ACCEPTANCE_TARGET_MS,
    withinTarget: projectedTotalMs <= LIVE_ACCEPTANCE_TARGET_MS,
  };
}

export function compareCalibrationRuns(baselineRun, candidateRun) {
  const baseline = projectCalibrationRun(baselineRun);
  const candidate = projectCalibrationRun(candidateRun);
  if (
    baselineRun.fixtureDigest !== candidateRun.fixtureDigest ||
    baselineRun.totalDispatches !== candidateRun.totalDispatches
  ) {
    throw new ExportHandoffError(
      "UNCONTROLLED_CALIBRATION_COMPARISON",
      "Calibration comparisons must use the same fixture and dispatch count",
    );
  }
  const changedFactors = CONFIG_FACTORS.filter((factor) => (
    baselineRun.config[factor] !== candidateRun.config[factor]
  ));
  if (changedFactors.length !== 1) {
    throw new ExportHandoffError(
      "UNCONTROLLED_CALIBRATION_COMPARISON",
      "Calibration comparisons must change exactly one of model, reasoningEffort, or slotCount",
      { changedFactors },
    );
  }
  return {
    changedFactor: changedFactors[0],
    winner: candidate.projectedTotalMs < baseline.projectedTotalMs
      ? "candidate"
      : candidate.projectedTotalMs > baseline.projectedTotalMs
        ? "baseline"
        : "tie",
    deltaMs: candidate.projectedTotalMs - baseline.projectedTotalMs,
    baseline,
    candidate,
  };
}

export function projectPreDispatchLowerBound(input) {
  requireObject(input, "Pre-dispatch projection", "INVALID_PRE_DISPATCH_PROJECTION");
  const createdAtMs = requirePhaseBoundary(input.createdAt, "createdAt");
  const frameValidatedAtMs = requirePhaseBoundary(
    input.frameValidatedAt,
    "frameValidatedAt",
  );
  if (frameValidatedAtMs < createdAtMs) {
    throw new ExportHandoffError(
      "INVALID_PRE_DISPATCH_PHASE_BOUNDARY",
      "frameValidatedAt must not precede createdAt",
    );
  }

  const targetMs = input.targetMs ?? LIVE_ACCEPTANCE_TARGET_MS;
  requirePositiveInteger(
    targetMs,
    "targetMs",
    "INVALID_PRE_DISPATCH_PROJECTION",
  );
  const reduceReserveMs = requireNonNegativeDuration(
    input.reduceReserveMs ?? PRE_DISPATCH_REDUCE_RESERVE_MS,
    "reduceReserveMs",
    "INVALID_PRE_DISPATCH_PROJECTION",
  );
  const publicationReserveMs = requireNonNegativeDuration(
    input.publicationReserveMs ?? PRE_DISPATCH_PUBLICATION_RESERVE_MS,
    "publicationReserveMs",
    "INVALID_PRE_DISPATCH_PROJECTION",
  );
  const prepareAndFrameMs = frameValidatedAtMs - createdAtMs;
  const projectedTotalMs = prepareAndFrameMs + reduceReserveMs + publicationReserveMs;
  if (!Number.isFinite(projectedTotalMs)) {
    throw new ExportHandoffError(
      "INVALID_PRE_DISPATCH_PROJECTION",
      "Pre-dispatch lower bound must be a finite duration",
    );
  }
  return {
    createdAt: input.createdAt,
    frameValidatedAt: input.frameValidatedAt,
    prepareAndFrameMs,
    reduceReserveMs,
    publicationReserveMs,
    projectedTotalMs,
    targetMs,
    abort: projectedTotalMs > targetMs,
  };
}

function requireDurationArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ExportHandoffError(
      "INCOMPLETE_FIRST_WAVE_METRICS",
      `${label} must contain at least one duration`,
    );
  }
  return value.map((duration, index) => requireNonNegativeDuration(
    duration,
    `${label}[${index}]`,
    "INCOMPLETE_FIRST_WAVE_METRICS",
  ));
}

export function projectFirstWaveBudget(input) {
  requireObject(input, "First-wave projection", "INCOMPLETE_FIRST_WAVE_METRICS");
  const totalDispatches = requirePositiveInteger(
    input.totalDispatches,
    "totalDispatches",
    "INCOMPLETE_FIRST_WAVE_METRICS",
  );
  const completedDispatches = requirePositiveInteger(
    input.completedDispatches,
    "completedDispatches",
    "INCOMPLETE_FIRST_WAVE_METRICS",
  );
  const availableSlots = requirePositiveInteger(
    input.availableSlots,
    "availableSlots",
    "INVALID_WORKER_CAPACITY",
  );
  if (completedDispatches > totalDispatches) {
    throw new ExportHandoffError(
      "INCOMPLETE_FIRST_WAVE_METRICS",
      "completedDispatches cannot exceed totalDispatches",
    );
  }
  const mapGenerationSamples = requireDurationArray(
    input.mapGenerationSamples,
    "mapGenerationSamples",
  );
  const checkAcceptSamples = requireDurationArray(
    input.checkAcceptSamples,
    "checkAcceptSamples",
  );
  if (
    mapGenerationSamples.length !== completedDispatches ||
    checkAcceptSamples.length !== completedDispatches
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_FIRST_WAVE_METRICS",
      "First-wave timing arrays must cover every completed dispatch exactly once",
    );
  }
  const prepareAndFrameMs = requireNonNegativeDuration(
    input.prepareAndFrameMs,
    "prepareAndFrameMs",
    "INCOMPLETE_FIRST_WAVE_METRICS",
  );
  const reduceMs = requireNonNegativeDuration(
    input.reduceMs,
    "reduceMs",
    "INCOMPLETE_FIRST_WAVE_METRICS",
  );
  const publicationMs = requireNonNegativeDuration(
    input.publicationMs,
    "publicationMs",
    "INCOMPLETE_FIRST_WAVE_METRICS",
  );
  const targetMs = input.targetMs ?? LIVE_ACCEPTANCE_TARGET_MS;
  requirePositiveInteger(targetMs, "targetMs", "INCOMPLETE_FIRST_WAVE_METRICS");

  const remainingDispatches = totalDispatches - completedDispatches;
  const projectedMapWaves = 1 + Math.ceil(remainingDispatches / availableSlots);
  const maxMapGenerationMs = Math.max(...mapGenerationSamples);
  const maxCheckAcceptMs = Math.max(...checkAcceptSamples);
  const mapGenerationMs = projectedMapWaves * maxMapGenerationMs;
  const checkAcceptMs = totalDispatches * maxCheckAcceptMs;
  const projectedTotalMs = prepareAndFrameMs
    + mapGenerationMs
    + checkAcceptMs
    + reduceMs
    + publicationMs;
  return {
    targetMs,
    availableSlots,
    totalDispatches,
    completedDispatches,
    remainingDispatches,
    projectedMapWaves,
    maxMapGenerationMs,
    maxCheckAcceptMs,
    mapGenerationMs,
    checkAcceptMs,
    reduceMs,
    publicationMs,
    projectedTotalMs,
    abort: projectedTotalMs > targetMs,
  };
}

function optionalDuration(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sumKnown(values) {
  const known = values.filter((value) => value !== null);
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null;
}

export function buildPerformanceMetrics(state = {}, failure = {}) {
  const stages = Array.isArray(state.stages) ? state.stages : [];
  const generationSamples = stages
    .map((stage) => ({
      wave: Number.isInteger(stage.wave) && stage.wave > 0 ? stage.wave : 1,
      durationMs: optionalDuration(stage.providerMapGenerationMs),
    }))
    .filter((sample) => sample.durationMs !== null);
  const byWave = new Map();
  for (const sample of generationSamples) {
    byWave.set(
      sample.wave,
      Math.max(byWave.get(sample.wave) ?? 0, sample.durationMs),
    );
  }
  const mapGenerationMs = byWave.size > 0
    ? [...byWave.values()].reduce((total, value) => total + value, 0)
    : null;
  const checkAcceptDurations = stages.flatMap((stage) => [
    optionalDuration(stage.checkDurationMs),
    optionalDuration(stage.completeDurationMs),
    optionalDuration(stage.acceptDurationMs),
  ]);
  const checkAcceptMs = sumKnown(checkAcceptDurations);

  const reduceGenerationMs = optionalDuration(state.reduceGenerationMs);
  let reducePrepareMs = optionalDuration(state.reducePrepareDurationMs);
  let reduceCheckMs = optionalDuration(state.reduceCheckDurationMs);
  if (failure.failurePhase === "prepare-reduce") {
    reducePrepareMs = optionalDuration(failure.failureDurationMs) ?? reducePrepareMs;
  }
  if (failure.failurePhase === "validate-reduce") {
    reduceCheckMs = optionalDuration(failure.failureDurationMs) ?? reduceCheckMs;
  }
  const reduceDeterministicMs = sumKnown([reducePrepareMs, reduceCheckMs]);
  const reduceMs = sumKnown([reduceGenerationMs, reduceDeterministicMs]);

  let publicationMs = optionalDuration(state.publicationDurationMs);
  if (failure.failurePhase === "publish") {
    publicationMs = optionalDuration(failure.failureDurationMs) ?? publicationMs;
  }
  return {
    mapGeneration: {
      durationMs: mapGenerationMs,
      source: "provider",
      complete: stages.length > 0 && generationSamples.length === stages.length,
      sampleCount: generationSamples.length,
    },
    checkAccept: {
      durationMs: checkAcceptMs,
      source: "workflow",
      complete: stages.length > 0 && checkAcceptDurations.every((value) => value !== null),
      sampleCount: stages.length,
    },
    reduce: {
      durationMs: reduceMs,
      generationMs: reduceGenerationMs,
      deterministicMs: reduceDeterministicMs,
      source: "provider+workflow",
      complete: reduceGenerationMs !== null && reduceDeterministicMs !== null &&
        !["prepare-reduce", "validate-reduce"].includes(failure.failurePhase),
    },
    publication: {
      durationMs: publicationMs,
      source: "workflow",
      complete: publicationMs !== null && failure.failurePhase !== "publish",
    },
  };
}
