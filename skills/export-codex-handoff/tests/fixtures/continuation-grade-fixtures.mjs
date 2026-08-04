import {
  buildPreservationLedger,
  createEvidenceEntry,
} from "../../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../../scripts/lib/evidence-index.mjs";

const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const FRAME_DIGEST = `sha256:${"f".repeat(64)}`;
const SESSION_ID = "00000000-0000-7000-8000-0000000000a0";

export const RETAINED_BASELINE_METRICS = Object.freeze({
  sourceThreadChars: 7_368_652,
  evidencePackChars: 2_030_898,
  frameBytes: 916_115,
  requiredAnchors: 376,
  exactIdentifiers: 2_793,
  criticalCategories: 0,
  initialMapDispatches: 10,
  evidenceInputChars: 1_487_513,
  frameProjectionChars: 1_291_712,
  aggregateMapInputChars: 2_779_225,
  rawMapOutputChars: 95_571,
  normalizedMapOutputChars: 180_820,
  reduceInputBytes: 2_098_212,
  reduceCandidateBytes: 27_575,
  prepareAndFrameMs: 115_345,
  mapThroughPrepareReduceMs: 1_749_646,
  reduceWriteMs: 266_819,
  prepublicationLowerBoundMs: 2_131_810,
  preservationCoverageDefaults: 6,
});

export const CONTINUATION_ACCEPTANCE_TARGETS = Object.freeze({
  evidencePackChars: 800_000,
  maxFrameProjectionChars: 20_000,
  maxMapInputChars: 100_000,
  reduceInputChars: 300_000,
  initialMapDispatches: 6,
  phaseTimingsTotalMs: 600_000,
});

export const RETAINED_METRIC_COMPARATOR = Object.freeze([
  {
    metric: "evidencePackChars",
    baseline: RETAINED_BASELINE_METRICS.evidencePackChars,
    baselineUnit: "characters",
    candidateField: "evidencePackChars",
    candidateUnit: "characters",
    targetMaximum: CONTINUATION_ACCEPTANCE_TARGETS.evidencePackChars,
    targetUnit: "characters",
  },
  {
    metric: "frameBytes",
    baseline: RETAINED_BASELINE_METRICS.frameBytes,
    baselineUnit: "bytes",
    candidateField: "frameBytes",
    candidateUnit: "bytes",
    targetMaximum: null,
    targetUnit: null,
  },
  {
    metric: "initialMapDispatches",
    baseline: RETAINED_BASELINE_METRICS.initialMapDispatches,
    baselineUnit: "count",
    candidateField: "initialMapDispatches",
    candidateUnit: "count",
    targetMaximum: CONTINUATION_ACCEPTANCE_TARGETS.initialMapDispatches,
    targetUnit: "count",
  },
  {
    metric: "aggregateMapInputChars",
    baseline: RETAINED_BASELINE_METRICS.aggregateMapInputChars,
    baselineUnit: "characters",
    candidateField: "aggregateMapInputChars",
    candidateUnit: "characters",
    targetMaximum: null,
    targetUnit: null,
  },
  {
    metric: "rawMapOutputChars",
    baseline: RETAINED_BASELINE_METRICS.rawMapOutputChars,
    baselineUnit: "characters",
    candidateField: "rawMapOutputChars",
    candidateUnit: "characters",
    targetMaximum: null,
    targetUnit: "configured REDUCE target",
  },
  {
    metric: "normalizedMapOutputChars",
    baseline: RETAINED_BASELINE_METRICS.normalizedMapOutputChars,
    baselineUnit: "characters",
    candidateField: "normalizedMapOutputChars",
    candidateUnit: "characters",
    targetMaximum: null,
    targetUnit: null,
  },
  {
    metric: "reduceInput",
    baseline: RETAINED_BASELINE_METRICS.reduceInputBytes,
    baselineUnit: "bytes",
    candidateField: "reduceInputChars",
    candidateUnit: "characters",
    targetMaximum: CONTINUATION_ACCEPTANCE_TARGETS.reduceInputChars,
    targetUnit: "characters",
  },
  {
    metric: "prepublicationLowerBoundMs",
    baseline: RETAINED_BASELINE_METRICS.prepublicationLowerBoundMs,
    baselineUnit: "milliseconds",
    candidateField: "phaseTimingsTotalMs",
    candidateUnit: "milliseconds",
    targetMaximum: CONTINUATION_ACCEPTANCE_TARGETS.phaseTimingsTotalMs,
    targetUnit: "milliseconds",
  },
]);

export function compareRetainedMetrics(candidate) {
  return RETAINED_METRIC_COMPARATOR.map((definition) => {
    const candidateValue = candidate[definition.candidateField];
    const hasCandidate = Number.isFinite(candidateValue);
    const comparableToBaseline = hasCandidate
      && definition.baselineUnit === definition.candidateUnit;
    const comparableToTarget = hasCandidate
      && definition.targetMaximum !== null
      && definition.targetUnit === definition.candidateUnit;
    return {
      ...definition,
      candidate: hasCandidate ? candidateValue : null,
      deltaFromBaseline: comparableToBaseline ? candidateValue - definition.baseline : null,
      ratioToBaseline: comparableToBaseline ? candidateValue / definition.baseline : null,
      comparableToBaseline,
      targetPassed: comparableToTarget
        ? candidateValue <= definition.targetMaximum
        : null,
      comparableToTarget,
    };
  });
}

function syntheticAnchor(index) {
  return `anchor-${index.toString(16).padStart(64, "0")}`;
}

function syntheticLongPath(identifierIndex, entryIndex) {
  const token = `${identifierIndex.toString(16).padStart(8, "0")}${"a1b2c3d4".repeat(22)}`;
  return `C:\\synthetic\\growth\\entry-${entryIndex.toString().padStart(3, "0")}\\${token}.bin`;
}

export function allAnchorsRequiredGrowthFixture() {
  const entries = Array.from(
    { length: RETAINED_BASELINE_METRICS.requiredAnchors },
    (_, entryIndex) => ({
      anchor: { anchorId: syntheticAnchor(entryIndex + 1) },
      exactIdentifiers: [],
    }),
  );
  for (let identifierIndex = 0; identifierIndex < RETAINED_BASELINE_METRICS.exactIdentifiers; identifierIndex += 1) {
    const entryIndex = identifierIndex % entries.length;
    entries[entryIndex].exactIdentifiers.push({
      kind: "path",
      value: syntheticLongPath(identifierIndex, entryIndex),
    });
  }
  const preservationLedger = buildPreservationLedger(SOURCE_REVISION, entries);
  const frame = {
    frameId: "frame-all-anchors-required-growth",
    currentGoal: {
      claimId: "goal-r0-growth",
      kind: "current_goal",
      text: "Reproduce all-anchors-required growth with synthetic data.",
      anchors: [entries.at(-1).anchor.anchorId],
    },
    explicitExclusions: [],
    preservationPolicy: preservationLedger,
  };
  return { entries, preservationLedger, frame };
}

const HIGH_ENTROPY_SEGMENT_A = "Qz7_".repeat(24);
const HIGH_ENTROPY_SEGMENT_B = "Yx9-".repeat(24);
const HIGH_ENTROPY_SEGMENT_C = "Rv2.".repeat(24);

export const HIGH_ENTROPY_PATH_FALSE_POSITIVE = Object.freeze({
  text: `opaque-token=${HIGH_ENTROPY_SEGMENT_A}/${HIGH_ENTROPY_SEGMENT_B}/${HIGH_ENTROPY_SEGMENT_C}`,
  falsePath: `/${HIGH_ENTROPY_SEGMENT_B}/${HIGH_ENTROPY_SEGMENT_C}`,
});

export const REDUCE_DEFAULT_CATEGORIES = Object.freeze([
  "constraint",
  "decision",
  "change",
  "verification",
  "open_work",
  "rollback",
]);

export function emptyCriticalCategoriesReduceFixture() {
  const entry = createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId: "turn-r0-publication",
    eventOrdinal: 1,
    rolloutLine: 1,
    payloadPath: "/payload/content/0/text",
    value: "Synthetic current goal for the empty-category publication failure.",
    locator: { kind: "rollout_payload" },
  });
  const preservationLedger = buildPreservationLedger(SOURCE_REVISION, [entry]);
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/rollout.jsonl",
    sourceChars: 64,
    sourceBytes: 64,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/workspace",
      startedAt: "2026-07-30T00:00:00Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: "C:/synthetic/workspace",
    checkpoint: { status: "missing" },
    git: { status: "not_repository" },
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source,
    workspace,
    entries: [entry],
    preservationLedger,
  });
  const anchorId = entry.anchor.anchorId;
  const expectedFrame = {
    frameId: "frame-empty-critical-categories",
    frameDigest: FRAME_DIGEST,
    frame: {
      frameId: "frame-empty-critical-categories",
      currentGoal: {
        claimId: "goal-empty-critical-categories",
        kind: "current_goal",
        text: "Reproduce the empty-category REDUCE default failure.",
        anchors: [anchorId],
      },
      explicitExclusions: [],
    },
  };
  const reduced = {
    frameId: expectedFrame.frameId,
    frameDigest: expectedFrame.frameDigest,
    continuationDirective: "Stop before publication when coverage shape is invalid.",
    objective: {
      goal: expectedFrame.frame.currentGoal.text,
      explicitExclusions: [],
    },
    constraints: [],
    workspaceState: {
      summary: {
        claimId: "workspace-empty-critical-categories",
        kind: "workspace_state",
        text: "Synthetic workspace state is available.",
        anchors: [anchorId],
      },
      evidenceStatus: "full",
      conflicts: [],
    },
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: [],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    preservationCoverage: REDUCE_DEFAULT_CATEGORIES.map((category) => ({
      category,
      status: "absent",
      claimIds: [],
      reason: "synthetic REDUCE default",
    })),
    provenance: { notes: [] },
    compressionNotes: [],
  };
  return {
    expectedFrame,
    evidenceIndex,
    preservationLedger,
    reduced,
    turnIds: ["turn-r0-publication"],
  };
}

export function repeatedClaimBookkeepingFixture() {
  const anchorId = syntheticAnchor(900);
  const claim = {
    claimId: "claim-repeated-bookkeeping",
    kind: "objective",
    text: "Retain one continuation-critical objective exactly once.",
    anchors: [anchorId],
  };
  const reduceInput = {
    preservationLedger: {
      sourceRevision: SOURCE_REVISION,
      requiredAnchors: [anchorId],
      exactIdentifiers: [],
      criticalCategories: [],
    },
    semanticCoverage: {
      turns: [{
        turnId: "turn-repeated-bookkeeping",
        status: "summarized",
        claimIds: [claim.claimId],
        reason: "captured by sparse MAP claim bindings",
      }],
      claims: [{ claimId: claim.claimId, anchors: [anchorId] }],
    },
    segmentSummaries: [{
      frameId: "frame-repeated-bookkeeping",
      frameDigest: FRAME_DIGEST,
      segmentId: "segment-repeated-bookkeeping",
      turnCoverage: [{
        turnId: "turn-repeated-bookkeeping",
        status: "summarized",
        claimIds: [claim.claimId],
        reason: "captured by sparse MAP claim bindings",
      }],
      objectiveFacts: [claim],
      userConstraints: [],
      completedWork: [],
      openWork: [],
      nextActions: [],
      importantLocations: [],
      conflicts: [],
      archivalLedger: { decisions: [], attempts: [], verification: [] },
      compressionNotes: [],
    }],
  };
  return { anchorId, claim, reduceInput };
}
