const FRAME_DIGEST = `sha256:${"f".repeat(64)}`;

const WORKFLOW_DURATIONS_MS = Object.freeze({
  check: 52,
  complete: 53,
  accept: 54,
});

const DISPATCH_DEFINITIONS = Object.freeze([
  Object.freeze({
    ordinal: 1,
    segmentId: "pt0-fragment-001",
    stage: "fragment_map",
    status: "accepted",
  }),
  Object.freeze({
    ordinal: 2,
    segmentId: "pt0-fragment-002",
    stage: "fragment_map",
    status: "accepted",
  }),
  Object.freeze({
    ordinal: 3,
    segmentId: "pt0-workspace-001",
    stage: "workspace_map",
    status: "accepted",
  }),
  Object.freeze({
    ordinal: 4,
    segmentId: "pt0-progress-001",
    stage: "progress_map",
    status: "pending",
  }),
]);

const STAGES = Object.freeze(DISPATCH_DEFINITIONS.map((definition) => Object.freeze({
  segmentId: definition.segmentId,
  stage: definition.stage,
  status: definition.status,
  ...(definition.status === "accepted"
    ? {
      checkDurationMs: WORKFLOW_DURATIONS_MS.check,
      completeDurationMs: WORKFLOW_DURATIONS_MS.complete,
      acceptDurationMs: WORKFLOW_DURATIONS_MS.accept,
    }
    : {}),
})));

export const PROVIDER_TIMING_PT0_FIXTURE = Object.freeze({
  totalDispatches: 4,
  freshSlots: 3,
  prepareAndFrameElapsedMs: 644_844,
  workflowDurationsMs: WORKFLOW_DURATIONS_MS,
  dispatchDefinitions: DISPATCH_DEFINITIONS,
  stages: STAGES,
  calibrationObjects: Object.freeze([]),
  unavailableProviderTimingCapability: Object.freeze({
    available: false,
    source: null,
    observationPoint: null,
    reasonCode: "not_exposed",
  }),
  diagnostics: Object.freeze({
    overBudget: "LIVE_BUDGET_UNREACHABLE",
    unavailableCapability: "PROVIDER_TIMING_UNAVAILABLE",
    incompleteObservation: "INCOMPLETE_FIRST_WAVE_METRICS",
  }),
});

export const PROVIDER_TIMING_PT1_FIXTURE = Object.freeze({
  targetMs: 600_000,
  reduceReserveMs: 60_000,
  publicationReserveMs: 20_000,
  unreachable: Object.freeze({
    createdAt: "2026-08-10T00:00:00.000Z",
    frameValidatedAt: "2026-08-10T00:10:44.844Z",
    prepareAndFrameMs: 644_844,
    projectedTotalMs: 724_844,
  }),
  withinBudget: Object.freeze({
    createdAt: "2026-08-10T00:00:00.000Z",
    frameValidatedAt: "2026-08-10T00:00:45.000Z",
    prepareAndFrameMs: 45_000,
    projectedTotalMs: 125_000,
  }),
  diagnostics: Object.freeze({
    invalidPhaseBoundary: "INVALID_PRE_DISPATCH_PHASE_BOUNDARY",
    invalidProjection: "INVALID_PRE_DISPATCH_PROJECTION",
  }),
});

export const PROVIDER_TIMING_PT2_FIXTURE = Object.freeze({
  freshSlots: PROVIDER_TIMING_PT0_FIXTURE.freshSlots,
  availableProviderTimingCapability: Object.freeze({
    available: true,
    source: "provider",
    observationPoint: "post_worker",
    reasonCode: null,
  }),
  unavailableProviderTimingCapability:
    PROVIDER_TIMING_PT0_FIXTURE.unavailableProviderTimingCapability,
  diagnostics: Object.freeze({
    invalidCapability: "INVALID_PROVIDER_TIMING_CAPABILITY",
    unavailableCapability:
      PROVIDER_TIMING_PT0_FIXTURE.diagnostics.unavailableCapability,
  }),
});

export const PROVIDER_TIMING_PT3_FIXTURE = Object.freeze({
  mapGenerationMetricMode: "provider-observation-v1",
  observation: Object.freeze({
    providerObservationId: "provider-observation-pt3-001",
    providerLatencyMs: 12_345,
    source: "provider",
    model: "configured-worker-model",
    reasoningEffort: "high",
    wave: 1,
    availableSlots: PROVIDER_TIMING_PT0_FIXTURE.freshSlots,
  }),
  diagnostics: Object.freeze({
    invalidObservation: "INVALID_MAP_GENERATION_OBSERVATION",
    correlationMismatch: "MAP_GENERATION_OBSERVATION_MISMATCH",
    conflictingReplay: "MAP_GENERATION_METRIC_CONFLICT",
    receiptNotAccepted: "MAP_RECEIPT_NOT_ACCEPTED",
    ingressUnavailable: "PROVIDER_TIMING_INGRESS_UNAVAILABLE",
    oversizedDocument: "MAP_GENERATION_OBSERVATION_TOO_LARGE",
  }),
});

export function createMapGenerationObservation(dispatch, overrides = {}) {
  if (!dispatch || typeof dispatch !== "object") {
    throw new TypeError("dispatch must be a production MapDispatch");
  }
  return {
    providerObservationId:
      PROVIDER_TIMING_PT3_FIXTURE.observation.providerObservationId,
    dispatchId: dispatch.dispatchId,
    segmentId: dispatch.segmentId,
    providerLatencyMs:
      PROVIDER_TIMING_PT3_FIXTURE.observation.providerLatencyMs,
    source: PROVIDER_TIMING_PT3_FIXTURE.observation.source,
    model: PROVIDER_TIMING_PT3_FIXTURE.observation.model,
    reasoningEffort:
      PROVIDER_TIMING_PT3_FIXTURE.observation.reasoningEffort,
    wave: PROVIDER_TIMING_PT3_FIXTURE.observation.wave,
    availableSlots:
      PROVIDER_TIMING_PT3_FIXTURE.observation.availableSlots,
    ...overrides,
  };
}

export function createProviderTimingDispatches(createMapDispatch) {
  if (typeof createMapDispatch !== "function") {
    throw new TypeError("createMapDispatch must be the production dispatch factory");
  }
  return PROVIDER_TIMING_PT0_FIXTURE.dispatchDefinitions.map((definition) => {
    const basePath = `C:/synthetic/provider-timing-pt0/${definition.segmentId}`;
    return createMapDispatch({
      segmentId: definition.segmentId,
      chunkPath: `${basePath}.json`,
      summaryPath: `${basePath}-summary.json`,
      framePath: "C:/synthetic/provider-timing-pt0/frame.json",
      frameDigest: FRAME_DIGEST,
      attempt: 1,
      mapResultMode: "continuation-map-v2",
      maxMapOutputChars: 4_000,
    });
  });
}

export function firstWaveProjectionInput() {
  const acceptedStages = PROVIDER_TIMING_PT0_FIXTURE.stages.filter(
    (stage) => stage.status === "accepted",
  );
  return {
    totalDispatches: PROVIDER_TIMING_PT0_FIXTURE.totalDispatches,
    completedDispatches: acceptedStages.length,
    availableSlots: PROVIDER_TIMING_PT0_FIXTURE.freshSlots,
    prepareAndFrameMs: PROVIDER_TIMING_PT0_FIXTURE.prepareAndFrameElapsedMs,
    mapGenerationSamples: PROVIDER_TIMING_PT0_FIXTURE.calibrationObjects.map(
      (calibration) => calibration.providerLatencyMs,
    ),
    checkAcceptSamples: acceptedStages.map((stage) => (
      stage.checkDurationMs + stage.completeDurationMs + stage.acceptDurationMs
    )),
    reduceMs: 0,
    publicationMs: 0,
  };
}
