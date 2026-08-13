import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  initializeAdjudicationContract,
  inspectAdjudication,
  recordNormalPublication,
} from "./adjudication.mjs";
import { buildEvidencePack } from "./evidence-pack.mjs";
import {
  canonicalStringify,
  hashFileRevision,
  sha256Text,
} from "./evidence-addressing.mjs";
import {
  buildFrameInput,
  compressionFrameDigest,
  frameInputDigest,
  validateCompressionFrame,
} from "./compression-frame.mjs";
import {
  attachEvidenceKeyMap,
  attachSemanticCoverage,
  buildEvidenceIndex,
  retrieveEvidence,
  validateEvidenceIndex,
  verifyEvidenceIndex,
} from "./evidence-index.mjs";
import { chunkEvidencePack } from "./chunking.mjs";
import {
  CONTINUATION_MAP_CANDIDATE_MAX_CHARS,
  CONTINUATION_MAP_RESULT_MODE,
  CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS,
  CONTINUATION_MAP_V2_RESULT_MODE,
  createMapDispatch,
  isContinuationMapResultMode,
  scheduleMapDispatches,
  SPARSE_MAP_RESULT_MODE,
  validateMapDispatch,
  validateMapReceipt,
} from "./map-worker.mjs";
import {
  buildEvidenceReferenceDictionary,
  buildFrameProjection,
  buildReferenceFrameProjection,
  evidenceReferenceDictionaryDigest,
  frameProjectionDigest,
  validateEvidenceReferenceDictionary,
  validateFrameProjection,
  validateReferenceFrameProjection,
} from "./frame-projection.mjs";
import {
  buildActionReadyContinuationDownstream,
  buildActionReadyContinuationParentCoverage,
  buildContinuationDownstream,
  buildContinuationParentCoverage,
  buildContinuationReduceProjections,
  buildSemanticCoverageGraph,
  completeActionReadyContinuationMapResult,
  completeContinuationMapResult,
  deriveFinalProvenance,
  expandSparseMapResult,
  listMapClaims,
  validateActionReadyHandoffGates,
  validateMapResult,
  validateReduceResult,
} from "./validation.mjs";
import { validateProgressEvidence } from "./progress-evidence.mjs";
import {
  buildPerformanceMetrics,
  LIVE_ACCEPTANCE_TARGET_MS,
  PRE_DISPATCH_PUBLICATION_RESERVE_MS,
  PRE_DISPATCH_REDUCE_RESERVE_MS,
  projectPreDispatchLowerBound,
  validateMapGenerationObservation,
  validateReduceGenerationMetric,
} from "./performance-calibration.mjs";
import { renderHandoff } from "./render-handoff.mjs";
import { renderDegradedHandoff } from "./render-degraded-handoff.mjs";
import {
  buildActionReadyConsumerContract,
  buildActionReadySuggestedContinuation,
  renderActionReadyHandoff,
} from "./render-action-ready-handoff.mjs";
import { ExportHandoffError, validateSessionId } from "./source-thread.mjs";

const WORKDIR_PREFIX = "codex-handoff-task-";
const MANIFEST_FILE = "manifest.json";
const WORKFLOW_VERSION_FILE = "workflow-version.json";
const LEGACY_WORKFLOW_VERSION = 1;
const CURRENT_WORKFLOW_VERSION = 2;
const LEGACY_FRAME_PROJECTION_MODE = "frame-projection-v1";
const REFERENCE_FRAME_PROJECTION_MODE = "reference-frame-projection-v1";
const DETERMINISTIC_PARENT_COVERAGE_MODE = "deterministic-parent-coverage-v1";
const MAX_CONTINUATION_REDUCE_INPUT_CHARS = 300_000;
const TERMINAL_AUTHORITY_FRAME_VERSION = 2;
const ACTION_READY_PROGRESS_STAGE = "progress_map";
const MAP_GENERATION_METRIC_MODE = "provider-observation-v1";
const MAP_GENERATION_METRIC_KIND = "codex-handoff-map-generation-metric";
const MAP_GENERATION_METRIC_FORMAT_VERSION = 1;
const MAP_GENERATION_METRIC_STATE_FIELDS = [
  "observation",
  "receiptDigest",
  "metricDigest",
];
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_DEGRADED_ACCEPTED_CLAIMS = 8;

const ACTION_READY_OUTPUT_CONTRACT = Object.freeze({
  formatVersion: 1,
  kind: "codex-handoff-action-ready-output-contract",
  requiredFields: [
    "workingSynthesis",
    "deliverableStatus",
    "inspectedEvidenceMap",
    "resumePolicy",
  ],
  workingSynthesisStatuses: ["draft_ready", "partial", "blocked"],
  deliverableStatuses: ["ready", "partial", "blocked"],
  rereadPolicies: ["do_not_reread", "verify_only", "targeted_followup"],
  resumeModes: ["synthesize_first", "execute_next", "resolve_blocker"],
  allowedReadReasons: ["claim_verification", "named_uncertainty"],
});

function durationSince(startedAtMs) {
  return Math.max(0, Date.now() - startedAtMs);
}

function workflowPerformanceState(manifest) {
  return {
    stages: [
      ...(manifest.segments || []),
      ...(manifest.turnAggregates || []),
    ].filter((stage) => stage.dispatch).map((stage) => {
      const observation = stage.mapGenerationMetric?.observation || stage.calibration;
      return {
        wave: observation?.wave,
        providerMapGenerationMs: observation?.providerLatencyMs,
        checkDurationMs: stage.checkDurationMs,
        completeDurationMs: stage.completeDurationMs,
        acceptDurationMs: stage.acceptDurationMs,
      };
    }),
    reduceGenerationMs: manifest.reduceCalibration?.providerLatencyMs,
    reducePrepareDurationMs: manifest.reducePrepareDurationMs,
    reduceCheckDurationMs: manifest.reduceCheckDurationMs,
    publicationDurationMs: manifest.publicationDurationMs,
  };
}

async function pathExists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

function requireInteger(value, fallback, minimum, code, label) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum) {
    throw new ExportHandoffError(code, `${label} must be an integer >= ${minimum}`);
  }
  return resolved;
}

function elapsedMs(start, end) {
  const startMs = Date.parse(start || "");
  const endMs = Date.parse(end || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

function workflowPhaseTimings(manifest, publishedAt) {
  return {
    prepareAndFrame: elapsedMs(manifest.createdAt, manifest.frameValidatedAt),
    map: elapsedMs(manifest.frameValidatedAt, manifest.reducePreparedAt),
    reduceAndPublish: elapsedMs(manifest.reducePreparedAt, publishedAt),
    total: elapsedMs(manifest.createdAt, publishedAt),
  };
}

function reduceTargetMaxChars(maxChars) {
  return Math.floor(maxChars * 0.85);
}

function allocateMapOutputBudgets(totalChars, stageCount) {
  if (stageCount < 1 || totalChars < stageCount) {
    throw new ExportHandoffError(
      "INVALID_MAP_OUTPUT_BUDGET",
      `Aggregate MAP output budget ${totalChars} cannot fund ${stageCount} dispatches`,
    );
  }
  const base = Math.floor(totalChars / stageCount);
  const remainder = totalChars % stageCount;
  return Array.from(
    { length: stageCount },
    (_, index) => base + (index < remainder ? 1 : 0),
  );
}

function allocateContinuationMapOutputBudgets(totalChars, stageCount) {
  if (stageCount < 1 || totalChars < stageCount) {
    throw new ExportHandoffError(
      "INVALID_MAP_OUTPUT_BUDGET",
      `Aggregate MAP output budget ${totalChars} cannot fund ${stageCount} dispatches`,
    );
  }
  const perDispatch = Math.min(
    CONTINUATION_MAP_CANDIDATE_MAX_CHARS,
    Math.floor(totalChars / stageCount),
  );
  return Array.from({ length: stageCount }, () => perDispatch);
}

function mapOutputMetrics(manifest) {
  const accepted = manifest.segments.filter((segment) => segment.receiptAcceptedAt);
  const raw = accepted.map((segment) => segment.rawMapOutputChars);
  const rawMapOutputChars = accepted.length > 0 && raw.every(Number.isInteger)
    ? raw.reduce((total, value) => total + value, 0)
    : null;
  if (isContinuationMapResultMode(manifest.mapResultMode)) {
    const completed = accepted.map((segment) => segment.completedMapOutputChars);
    return {
      rawMapOutputChars,
      completedMapOutputChars: accepted.length > 0 && completed.every(Number.isInteger)
        ? completed.reduce((total, value) => total + value, 0)
        : null,
    };
  }
  const normalized = accepted.map((segment) => segment.normalizedMapOutputChars);
  return {
    rawMapOutputChars,
    normalizedMapOutputChars: accepted.length > 0 && normalized.every(Number.isInteger)
      ? normalized.reduce((total, value) => total + value, 0)
      : null,
  };
}

function serializableDetails(details) {
  if (details === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(details));
  } catch {
    return { note: "Failure details were not JSON-serializable" };
  }
}

async function recordCapturedWorkflowDiagnostic(workDir, phase, error, timing = {}) {
  try {
    const resolvedWorkDir = path.resolve(workDir);
    const manifest = await readJson(
      path.join(resolvedWorkDir, MANIFEST_FILE),
      "Compression Task manifest",
    );
    if (path.resolve(manifest.workDir) !== resolvedWorkDir) return null;
    const capturedAt = new Date().toISOString();
    const outputMetrics = mapOutputMetrics(manifest);
    const failureReportPath = manifest.paths?.failureReport || path.join(
      resolvedWorkDir,
      "failure-report.json",
    );
    assertInsideWorkDir(resolvedWorkDir, failureReportPath, "Failure report path");
    await writeJson(failureReportPath, {
      formatVersion: 1,
      kind: "codex-handoff-captured-workflow-diagnostic",
      capturedAt,
      phase,
      diagnostic: {
        code: error?.code || "ERROR",
        message: error?.message || String(error),
        details: serializableDetails(error?.details),
      },
      phaseTimingsMs: workflowPhaseTimings(manifest, capturedAt),
      performanceMetrics: buildPerformanceMetrics(
        workflowPerformanceState(manifest),
        {
          failurePhase: phase,
          failureDurationMs: timing.failureDurationMs,
        },
      ),
      workerMetrics: {
        initialMaps: Array.isArray(manifest.segments) ? manifest.segments.length : 0,
        acceptedMaps: [
          ...(manifest.segments || []),
          ...(manifest.turnAggregates || []),
        ].filter((stage) => stage.receiptAcceptedAt).length,
        maxAggregateMapOutputChars: manifest.maxAggregateMapOutputChars || null,
        ...outputMetrics,
        maxObservedFrameProjectionChars: Math.max(
          0,
          ...(manifest.segments || []).map((segment) => segment.contextChars || 0),
        ),
        maxObservedMapInputChars: Math.max(
          0,
          ...(manifest.segments || []).map((segment) => segment.mapInputChars || 0),
        ),
      },
      workDir: resolvedWorkDir,
    });
    return failureReportPath;
  } catch {
    return null;
  }
}

async function withCapturedWorkflowDiagnostic(workDir, phase, operation) {
  const startedAtMs = Date.now();
  try {
    return await operation();
  } catch (error) {
    await recordCapturedWorkflowDiagnostic(workDir, phase, error, {
      failureDurationMs: durationSince(startedAtMs),
    });
    throw error;
  }
}

function validateAggregateMapOutputMetrics(manifest) {
  const metrics = mapOutputMetrics(manifest);
  if (!Object.hasOwn(manifest, "maxAggregateMapOutputChars")) return metrics;
  const derivedMetric = isContinuationMapResultMode(manifest.mapResultMode)
    ? metrics.completedMapOutputChars
    : metrics.normalizedMapOutputChars;
  if (metrics.rawMapOutputChars === null || derivedMetric === null) {
    throw new ExportHandoffError(
      "MAP_OUTPUT_METRICS_MISSING",
      "Every accepted compact MAP result must carry raw and derived output metrics",
    );
  }
  if (metrics.rawMapOutputChars > manifest.maxAggregateMapOutputChars) {
    throw new ExportHandoffError(
      "MAP_OUTPUT_TOO_LARGE",
      `Accepted MAP output is ${metrics.rawMapOutputChars} characters; aggregate limit is ${manifest.maxAggregateMapOutputChars}`,
      {
        rawMapOutputChars: metrics.rawMapOutputChars,
        maxAggregateMapOutputChars: manifest.maxAggregateMapOutputChars,
      },
    );
  }
  return metrics;
}

async function readJson(target, label) {
  try {
    return JSON.parse(await fs.promises.readFile(target, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ExportHandoffError("WORKFLOW_FILE_MISSING", `${label} is missing: ${target}`);
    }
    if (error instanceof SyntaxError) {
      throw new ExportHandoffError("INVALID_WORKFLOW_JSON", `${label} is not valid JSON: ${target}`);
    }
    throw error;
  }
}

async function readJsonDocument(target, label) {
  let text;
  try {
    text = await fs.promises.readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ExportHandoffError("WORKFLOW_FILE_MISSING", `${label} is missing: ${target}`);
    }
    throw error;
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ExportHandoffError("INVALID_WORKFLOW_JSON", `${label} is not valid JSON: ${target}`);
    }
    throw error;
  }
}

async function writeJson(target, value, options = {}) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: options.exclusive ? "wx" : "w",
  });
}

function assertInsideWorkDir(workDir, target, label) {
  const relative = path.relative(workDir, path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ExportHandoffError("INVALID_WORKFLOW_PATH", `${label} escapes the work directory`);
  }
}

function assertManagedWorkDir(manifest, workDir) {
  const resolved = path.resolve(workDir);
  if (
    manifest.managedWorkDir !== true ||
    path.resolve(manifest.workDir) !== resolved ||
    path.dirname(resolved) !== path.resolve(manifest.workRoot) ||
    !path.basename(resolved).startsWith(WORKDIR_PREFIX)
  ) {
    throw new ExportHandoffError(
      "UNSAFE_WORKDIR",
      `Refusing to manage an unrecognized work directory: ${resolved}`,
    );
  }
}

function workflowVersionPath(workDir) {
  return path.join(workDir, WORKFLOW_VERSION_FILE);
}

function workflowVersionMismatch(message, details = {}) {
  throw new ExportHandoffError("WORKFLOW_VERSION_MISMATCH", message, details);
}

async function assertWorkflowVersionBinding(manifest, workDir) {
  const versionPath = workflowVersionPath(workDir);
  const hasVersionBinding = await pathExists(versionPath);
  if (manifest.formatVersion === LEGACY_WORKFLOW_VERSION) {
    if (hasVersionBinding || Object.hasOwn(manifest, "mapResultMode")) {
      workflowVersionMismatch(
        "A v1 manifest cannot use v2 workflow state or a MAP result mode binding",
        { manifestVersion: manifest.formatVersion, versionPath },
      );
    }
    return;
  }
  if (manifest.formatVersion !== CURRENT_WORKFLOW_VERSION) {
    workflowVersionMismatch(
      `Unsupported Compression Task manifest version ${manifest.formatVersion ?? "<missing>"}`,
      { manifestVersion: manifest.formatVersion },
    );
  }
  if (!hasVersionBinding) {
    workflowVersionMismatch(
      "A v2 manifest requires an immutable workflow version binding",
      { manifestVersion: manifest.formatVersion, versionPath },
    );
  }
  const binding = await readJson(versionPath, "Workflow version binding");
  const bindingHasMapResultMode = Object.hasOwn(binding, "mapResultMode");
  const manifestHasMapResultMode = Object.hasOwn(manifest, "mapResultMode");
  const bindingHasMapOutputBudget = Object.hasOwn(binding, "maxAggregateMapOutputChars");
  const manifestHasMapOutputBudget = Object.hasOwn(manifest, "maxAggregateMapOutputChars");
  const bindingHasMapContextMode = Object.hasOwn(binding, "mapContextMode");
  const bindingHasProjectionBudget = Object.hasOwn(binding, "maxFrameProjectionChars");
  const bindingHasMapInputBudget = Object.hasOwn(binding, "maxMapInputChars");
  const bindingHasFrameContract = Object.hasOwn(binding, "frameContractVersion");
  const manifestHasFrameContract = Object.hasOwn(manifest, "frameContractVersion");
  const bindingHasWorkflowDeadline = Object.hasOwn(binding, "workflowDeadlineAt");
  const manifestHasWorkflowDeadline = Object.hasOwn(manifest, "workflowDeadlineAt");
  const expectedKeys = [
    "kind",
    "formatVersion",
    "sessionId",
    "workDir",
    ...(bindingHasMapResultMode ? ["mapResultMode"] : []),
    ...(bindingHasMapOutputBudget ? ["maxAggregateMapOutputChars"] : []),
    ...(bindingHasMapContextMode ? ["mapContextMode"] : []),
    ...(bindingHasProjectionBudget ? ["maxFrameProjectionChars"] : []),
    ...(bindingHasMapInputBudget ? ["maxMapInputChars"] : []),
    ...(bindingHasFrameContract ? ["frameContractVersion"] : []),
    ...(bindingHasWorkflowDeadline ? ["createdAt", "workflowDeadlineAt"] : []),
  ];
  const validContextBinding = bindingHasMapContextMode
    ? (
      binding.mapContextMode === REFERENCE_FRAME_PROJECTION_MODE &&
      manifest.mapContextMode === binding.mapContextMode &&
      bindingHasProjectionBudget &&
      bindingHasMapInputBudget &&
      Number.isInteger(binding.maxFrameProjectionChars) &&
      binding.maxFrameProjectionChars >= 1 &&
      binding.maxFrameProjectionChars === manifest.maxFrameProjectionChars &&
      Number.isInteger(binding.maxMapInputChars) &&
      binding.maxMapInputChars >= 4_000 &&
      binding.maxMapInputChars === manifest.maxMapInputChars
    )
    : !bindingHasProjectionBudget && !bindingHasMapInputBudget;
  if (
    Object.keys(binding).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(binding, key)) ||
    binding.kind !== "codex-handoff-workflow-version" ||
    binding.formatVersion !== CURRENT_WORKFLOW_VERSION ||
    binding.sessionId !== manifest.sessionId ||
    path.resolve(binding.workDir) !== path.resolve(workDir) ||
    bindingHasMapResultMode !== manifestHasMapResultMode ||
    bindingHasMapOutputBudget !== manifestHasMapOutputBudget ||
    bindingHasFrameContract !== manifestHasFrameContract ||
    bindingHasWorkflowDeadline !== manifestHasWorkflowDeadline ||
    (
      bindingHasWorkflowDeadline &&
      (
        binding.createdAt !== manifest.createdAt ||
        binding.workflowDeadlineAt !== manifest.workflowDeadlineAt ||
        Date.parse(binding.workflowDeadlineAt) !==
          Date.parse(binding.createdAt) + LIVE_ACCEPTANCE_TARGET_MS
      )
    ) ||
    (
      bindingHasFrameContract &&
      (
        binding.frameContractVersion !== TERMINAL_AUTHORITY_FRAME_VERSION ||
        manifest.frameContractVersion !== binding.frameContractVersion
      )
    ) ||
    !validContextBinding ||
    (
      bindingHasMapResultMode &&
      (
        ![
          SPARSE_MAP_RESULT_MODE,
          CONTINUATION_MAP_RESULT_MODE,
          CONTINUATION_MAP_V2_RESULT_MODE,
        ].includes(binding.mapResultMode) ||
        manifest.mapResultMode !== binding.mapResultMode
      )
    ) ||
    (
      bindingHasMapOutputBudget &&
      (
        !Number.isInteger(binding.maxAggregateMapOutputChars) ||
        binding.maxAggregateMapOutputChars < 1 ||
        binding.maxAggregateMapOutputChars !== manifest.maxAggregateMapOutputChars ||
        ![
          SPARSE_MAP_RESULT_MODE,
          CONTINUATION_MAP_RESULT_MODE,
          CONTINUATION_MAP_V2_RESULT_MODE,
        ].includes(binding.mapResultMode)
      )
    )
  ) {
    workflowVersionMismatch(
      "Compression Task manifest and workflow version binding disagree",
      {
        manifestVersion: manifest.formatVersion,
        bindingVersion: binding.formatVersion,
        versionPath,
      },
    );
  }
}

function assertMapOutputBudgetPlan(manifest) {
  if (!Object.hasOwn(manifest, "maxAggregateMapOutputChars")) return;
  if (![
    SPARSE_MAP_RESULT_MODE,
    CONTINUATION_MAP_RESULT_MODE,
    CONTINUATION_MAP_V2_RESULT_MODE,
  ].includes(
    manifest.mapResultMode,
  )) {
    workflowVersionMismatch("A MAP output budget requires a compact MAP result mode");
  }
  const budgets = (manifest.segments || []).map((segment) => segment.maxMapOutputChars);
  const allocated = budgets.reduce((total, value) => total + value, 0);
  const validAllocation = isContinuationMapResultMode(manifest.mapResultMode)
    ? (
      budgets.every((value) => value <= CONTINUATION_MAP_CANDIDATE_MAX_CHARS) &&
      allocated <= manifest.maxAggregateMapOutputChars
    )
    : allocated === manifest.maxAggregateMapOutputChars;
  if (
    budgets.length === 0 ||
    budgets.some((value) => !Number.isInteger(value) || value < 1) ||
    !validAllocation
  ) {
    workflowVersionMismatch(
      "Per-dispatch MAP output budgets do not match the immutable aggregate budget",
      { maxAggregateMapOutputChars: manifest.maxAggregateMapOutputChars },
    );
  }
}

async function loadManifest(workDir) {
  const resolved = path.resolve(workDir);
  const manifest = await readJson(path.join(resolved, MANIFEST_FILE), "Compression Task manifest");
  assertManagedWorkDir(manifest, resolved);
  await assertWorkflowVersionBinding(manifest, resolved);
  if (
    Object.hasOwn(manifest, "mapGenerationMetricMode") &&
    manifest.mapGenerationMetricMode !== MAP_GENERATION_METRIC_MODE
  ) {
    workflowVersionMismatch(
      `Unsupported MAP generation metric mode ${manifest.mapGenerationMetricMode}`,
    );
  }
  assertMapOutputBudgetPlan(manifest);
  for (const segment of manifest.segments || []) {
    if (
      segment.mapGenerationMetric &&
      manifest.mapGenerationMetricMode !== MAP_GENERATION_METRIC_MODE
    ) {
      workflowVersionMismatch(
        `${segment.segmentId} has provider-observation state without its workflow binding`,
      );
    }
    assertInsideWorkDir(resolved, segment.chunkPath, "Segment path");
    assertInsideWorkDir(resolved, segment.summaryPath, "Summary path");
    if (segment.normalizedSummaryPath) {
      assertInsideWorkDir(resolved, segment.normalizedSummaryPath, "Normalized summary path");
    }
    if (segment.completedSummaryPath) {
      assertInsideWorkDir(resolved, segment.completedSummaryPath, "Completed MAP path");
    }
    assertInsideWorkDir(resolved, segment.receiptPath, "Receipt path");
    assertInsideWorkDir(resolved, segment.diagnosticsDir, "Diagnostics path");
    if (segment.contextPath) {
      assertInsideWorkDir(resolved, segment.contextPath, "Frame Projection path");
    }
    if (segment.dictionaryPath) {
      assertInsideWorkDir(
        resolved,
        segment.dictionaryPath,
        "Evidence Reference Dictionary path",
      );
    }
    if (segment.dispatch) {
      validateMapDispatch(segment.dispatch, {
        segmentId: segment.segmentId,
        ...(manifest.frameDigest ? { frameDigest: manifest.frameDigest } : {}),
        mapResultMode: manifest.mapResultMode,
        maxMapOutputChars: segment.maxMapOutputChars,
        ...(segment.dictionaryDigest
          ? { dictionaryDigest: segment.dictionaryDigest }
          : {}),
      });
    }
  }
  for (const aggregate of manifest.turnAggregates || []) {
    if (
      aggregate.mapGenerationMetric &&
      manifest.mapGenerationMetricMode !== MAP_GENERATION_METRIC_MODE
    ) {
      workflowVersionMismatch(
        `${aggregate.segmentId} has provider-observation state without its workflow binding`,
      );
    }
    assertInsideWorkDir(resolved, aggregate.chunkPath, "Turn aggregate path");
    assertInsideWorkDir(resolved, aggregate.summaryPath, "Turn aggregate summary path");
    if (aggregate.normalizedSummaryPath) {
      assertInsideWorkDir(
        resolved,
        aggregate.normalizedSummaryPath,
        "Turn aggregate normalized summary path",
      );
    }
    if (aggregate.completedSummaryPath) {
      assertInsideWorkDir(
        resolved,
        aggregate.completedSummaryPath,
        "Turn aggregate completed MAP path",
      );
    }
    assertInsideWorkDir(resolved, aggregate.receiptPath, "Turn aggregate receipt path");
    assertInsideWorkDir(resolved, aggregate.diagnosticsDir, "Turn aggregate diagnostics path");
    if (aggregate.dispatch) {
      validateMapDispatch(aggregate.dispatch, {
        segmentId: aggregate.segmentId,
        ...(manifest.frameDigest ? { frameDigest: manifest.frameDigest } : {}),
        mapResultMode: manifest.mapResultMode,
        maxMapOutputChars: aggregate.maxMapOutputChars,
      });
    }
  }
  for (const [label, target] of Object.entries(manifest.paths || {})) {
    assertInsideWorkDir(resolved, target, label);
  }
  return manifest;
}

async function loadMapGenerationMetricManifest(workDir) {
  const resolved = path.resolve(workDir);
  const manifest = await readJson(
    path.join(resolved, MANIFEST_FILE),
    "Compression Task manifest",
  );
  assertManagedWorkDir(manifest, resolved);
  if (
    manifest.formatVersion !== CURRENT_WORKFLOW_VERSION ||
    manifest.kind !== "codex-handoff-compression-task" ||
    !Array.isArray(manifest.segments) ||
    !Array.isArray(manifest.turnAggregates)
  ) {
    workflowVersionMismatch(
      "Post-worker provider observations require a valid v2 Compression Task manifest",
    );
  }
  return manifest;
}

async function writeManifest(manifest) {
  await writeJson(path.join(manifest.workDir, MANIFEST_FILE), manifest);
}

function findSegment(manifest, segmentId) {
  const segment = manifest.segments.find((item) => item.segmentId === segmentId);
  if (!segment) {
    throw new ExportHandoffError("UNKNOWN_SEGMENT", `Unknown segment: ${segmentId}`);
  }
  return segment;
}

function findTurnAggregate(manifest, segmentId) {
  const aggregate = (manifest.turnAggregates || []).find((item) => item.segmentId === segmentId);
  if (!aggregate) {
    throw new ExportHandoffError("UNKNOWN_SEGMENT", `Unknown segment: ${segmentId}`);
  }
  return aggregate;
}

function findMapStage(manifest, segmentId) {
  return manifest.segments.find((item) => item.segmentId === segmentId)
    || (manifest.turnAggregates || []).find((item) => item.segmentId === segmentId)
    || null;
}

function dispatchClaimPath(manifest, dispatchId) {
  const target = path.join(manifest.workDir, "claims", `${dispatchId}.json`);
  assertInsideWorkDir(manifest.workDir, target, "Map dispatch claim path");
  return target;
}

function createStageDispatch(manifest, stage, attempt) {
  const input = {
    segmentId: stage.segmentId,
    chunkPath: stage.chunkPath,
    summaryPath: stage.summaryPath,
    frameDigest: manifest.frameDigest,
    attempt,
  };
  if (manifest.mapResultMode) input.mapResultMode = manifest.mapResultMode;
  if (stage.maxMapOutputChars) input.maxMapOutputChars = stage.maxMapOutputChars;
  if (stage.contextPath && stage.contextDigest) {
    input.contextPath = stage.contextPath;
    input.contextDigest = stage.contextDigest;
    if (stage.dictionaryPath && stage.dictionaryDigest) {
      input.dictionaryPath = stage.dictionaryPath;
      input.dictionaryDigest = stage.dictionaryDigest;
    }
  } else {
    input.framePath = manifest.paths.frame;
  }
  return createMapDispatch(input);
}

function measuredEvidence(value) {
  let evidenceChars = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = { ...value, evidenceChars };
    const next = JSON.stringify(candidate).length;
    if (next === evidenceChars) return candidate;
    evidenceChars = next;
  }
  return { ...value, evidenceChars: JSON.stringify({ ...value, evidenceChars }).length };
}

function createActionReadyProgressSegment(sessionId, progressEvidence) {
  return measuredEvidence({
    segmentId: "progress-map-001",
    stage: ACTION_READY_PROGRESS_STAGE,
    sourceSessionId: sessionId,
    progressEvidence: structuredClone(progressEvidence),
  });
}

async function validateWorkerSummary(segment, frozenFrame, options = {}) {
  const summaryDocument = options.summaryDocument || await readJsonDocument(
    segment.summaryPath,
    `${segment.segmentId} summary`,
  );
  const rawMapOutputChars = summaryDocument.text.length;
  if (
    segment.dispatch?.maxMapOutputChars &&
    rawMapOutputChars > segment.dispatch.maxMapOutputChars
  ) {
    throw new ExportHandoffError(
      "MAP_OUTPUT_TOO_LARGE",
      `${segment.segmentId} MAP output is ${rawMapOutputChars} characters; limit is ${segment.dispatch.maxMapOutputChars}`,
      {
        segmentId: segment.segmentId,
        rawMapOutputChars,
        maxMapOutputChars: segment.dispatch.maxMapOutputChars,
      },
    );
  }
  const summaryDigest = `sha256:${sha256Text(summaryDocument.text)}`;
  if (
    options.expectedSummaryDigest &&
    summaryDigest !== options.expectedSummaryDigest
  ) {
    throw new ExportHandoffError(
      "MAP_SUMMARY_CHANGED",
      `${segment.segmentId} summary changed after its non-consuming check`,
    );
  }
  const chunk = await readJson(segment.chunkPath, `${segment.segmentId} evidence`);
  let dictionary = null;
  if (segment.contextPath) {
    const projection = await readJson(segment.contextPath, `${segment.segmentId} Frame Projection`);
    let validated;
    if (segment.dictionaryPath) {
      dictionary = await readJson(
        segment.dictionaryPath,
        `${segment.segmentId} Evidence Reference Dictionary`,
      );
      const checkedDictionary = validateEvidenceReferenceDictionary(
        dictionary,
        frozenFrame,
        chunk,
      );
      if (
        checkedDictionary.dictionaryDigest !== segment.dictionaryDigest ||
        segment.dispatch?.dictionaryDigest !== segment.dictionaryDigest
      ) {
        throw new ExportHandoffError(
          "MAP_DICTIONARY_CHANGED",
          `${segment.segmentId} Evidence Reference Dictionary digest changed after dispatch`,
        );
      }
      validated = validateReferenceFrameProjection(
        projection,
        frozenFrame,
        chunk,
        dictionary,
      );
    } else {
      validated = validateFrameProjection(projection, frozenFrame, chunk);
    }
    if (
      validated.contextDigest !== segment.contextDigest ||
      segment.dispatch?.contextDigest !== segment.contextDigest
    ) {
      throw new ExportHandoffError(
        "MAP_CONTEXT_CHANGED",
        `${segment.segmentId} Frame Projection digest changed after dispatch`,
      );
    }
  } else if (
    chunk.frameDigest !== frozenFrame.frameDigest ||
    chunk.compressionFrame?.frameId !== frozenFrame.frameId ||
    compressionFrameDigest(chunk.compressionFrame) !== frozenFrame.frameDigest
  ) {
    throw new ExportHandoffError(
      "FRAME_DIGEST_MISMATCH",
      `${segment.segmentId} is not bound to the frozen Compression Frame`,
    );
  }
  const summary = summaryDocument.value;
  let normalized = null;
  let completed = null;
  if (segment.dispatch?.mapResultMode === SPARSE_MAP_RESULT_MODE) {
    normalized = expandSparseMapResult(summary, chunk, frozenFrame);
  } else if (segment.dispatch?.mapResultMode === CONTINUATION_MAP_RESULT_MODE) {
    if (!dictionary) {
      throw new ExportHandoffError(
        "WORKFLOW_FILE_MISSING",
        `${segment.segmentId} continuation MAP requires an Evidence Reference Dictionary`,
      );
    }
    completed = completeContinuationMapResult(summary, dictionary, frozenFrame);
  } else if (segment.dispatch?.mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE) {
    if (!dictionary) {
      throw new ExportHandoffError(
        "WORKFLOW_FILE_MISSING",
        `${segment.segmentId} continuation-map-v2 requires an Evidence Reference Dictionary`,
      );
    }
    completed = completeActionReadyContinuationMapResult(
      summary,
      dictionary,
      frozenFrame,
      chunk.stage === ACTION_READY_PROGRESS_STAGE ? chunk.progressEvidence : null,
    );
    const completedMapOutputChars = `${JSON.stringify(completed, null, 2)}\n`.length;
    if (completedMapOutputChars > CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS) {
      throw new ExportHandoffError(
        "MAP_OUTPUT_TOO_LARGE",
        `${segment.segmentId} completed continuation-map-v2 output is ${completedMapOutputChars} characters; limit is ${CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS}`,
        {
          segmentId: segment.segmentId,
          completedMapOutputChars,
          maxCompletedMapOutputChars: CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS,
        },
      );
    }
  } else {
    validateMapResult(summary, chunk, frozenFrame);
  }
  return {
    summary,
    normalized,
    completed,
    summaryDigest,
    rawMapOutputChars,
  };
}

async function readAcceptedMap(segment, frozenFrame, options = {}) {
  if (segment.workerStatus === "exhausted") {
    throw new ExportHandoffError(
      "MAP_WORKER_EXHAUSTED",
      `${segment.segmentId} exhausted both MAP Worker attempts`,
      { diagnosticsDir: segment.diagnosticsDir },
    );
  }
  if (["pending", "failed"].includes(segment.workerStatus) && segment.lastDiagnosticCode) {
    throw new ExportHandoffError(
      segment.lastDiagnosticCode,
      `${segment.segmentId} awaits a corrected MAP Worker attempt`,
      { diagnosticsDir: segment.diagnosticsDir, dispatch: segment.dispatch },
    );
  }
  if (options.requireAccepted !== false && !segment.receiptAcceptedAt) {
    throw new ExportHandoffError(
      "MAP_RECEIPT_NOT_ACCEPTED",
      `${segment.segmentId} receipt has not been accepted by the coordinator`,
    );
  }
  if (!segment.dispatch) {
    throw new ExportHandoffError(
      "MAP_DISPATCH_MISSING",
      `${segment.segmentId} has no frame-bound MAP dispatch`,
    );
  }
  validateMapDispatch(segment.dispatch, {
    segmentId: segment.segmentId,
    frameDigest: frozenFrame.frameDigest,
    ...(segment.contextDigest ? { contextDigest: segment.contextDigest } : {}),
    ...(segment.dictionaryDigest ? { dictionaryDigest: segment.dictionaryDigest } : {}),
  });
  const receipt = await readJson(segment.receiptPath, `${segment.segmentId} MAP receipt`);
  validateMapReceipt(receipt, segment.dispatch);
  if (receipt.status !== "validated") {
    throw new ExportHandoffError(
      receipt.diagnosticCode || "MAP_WORKER_FAILED",
      `${segment.segmentId} has no validated MAP receipt`,
      { receipt },
    );
  }
  const summaryDocument = await readJsonDocument(
    segment.summaryPath,
    `${segment.segmentId} validated summary`,
  );
  const summaryDigest = `sha256:${sha256Text(summaryDocument.text)}`;
  if (summaryDigest !== receipt.summaryDigest) {
    throw new ExportHandoffError(
      "MAP_SUMMARY_CHANGED",
      `${segment.segmentId} summary changed after worker validation`,
    );
  }
  if (segment.dispatch.mapResultMode === SPARSE_MAP_RESULT_MODE) {
    if (
      Object.hasOwn(segment.dispatch, "maxMapOutputChars") &&
      summaryDocument.text.length !== receipt.rawMapOutputChars
    ) {
      throw new ExportHandoffError(
        "MAP_OUTPUT_METRICS_MISMATCH",
        `${segment.segmentId} raw MAP output size changed after worker validation`,
      );
    }
    if (!segment.normalizedSummaryPath) {
      throw new ExportHandoffError(
        "WORKFLOW_FILE_MISSING",
        `${segment.segmentId} has no normalized sparse MAP path`,
      );
    }
    const normalizedDocument = await readJsonDocument(
      segment.normalizedSummaryPath,
      `${segment.segmentId} normalized sparse MAP summary`,
    );
    const normalizedDigest = `sha256:${sha256Text(normalizedDocument.text)}`;
    if (normalizedDigest !== receipt.normalizedSummaryDigest) {
      throw new ExportHandoffError(
        "MAP_SUMMARY_CHANGED",
        `${segment.segmentId} normalized summary changed after worker validation`,
      );
    }
    if (
      Object.hasOwn(segment.dispatch, "maxMapOutputChars") &&
      normalizedDocument.text.length !== receipt.normalizedMapOutputChars
    ) {
      throw new ExportHandoffError(
        "MAP_OUTPUT_METRICS_MISMATCH",
        `${segment.segmentId} normalized MAP output size changed after worker validation`,
      );
    }
    return normalizedDocument.value;
  }
  if (isContinuationMapResultMode(segment.dispatch.mapResultMode)) {
    if (summaryDocument.text.length !== receipt.rawMapOutputChars) {
      throw new ExportHandoffError(
        "MAP_OUTPUT_METRICS_MISMATCH",
        `${segment.segmentId} raw MAP output size changed after worker validation`,
      );
    }
    if (!segment.completedSummaryPath) {
      throw new ExportHandoffError(
        "WORKFLOW_FILE_MISSING",
        `${segment.segmentId} has no completed continuation MAP path`,
      );
    }
    const completedDocument = await readJsonDocument(
      segment.completedSummaryPath,
      `${segment.segmentId} completed continuation MAP result`,
    );
    const completedDigest = `sha256:${sha256Text(completedDocument.text)}`;
    if (completedDigest !== receipt.completedSummaryDigest) {
      throw new ExportHandoffError(
        "MAP_SUMMARY_CHANGED",
        `${segment.segmentId} completed MAP result changed after worker validation`,
      );
    }
    if (completedDocument.text.length !== receipt.completedMapOutputChars) {
      throw new ExportHandoffError(
        "MAP_OUTPUT_METRICS_MISMATCH",
        `${segment.segmentId} completed MAP output size changed after worker validation`,
      );
    }
    return completedDocument.value;
  }
  return summaryDocument.value;
}

async function loadFrozenFrame(manifest) {
  if (!manifest.frameInputDigest || !manifest.frameId || !manifest.frameDigest) {
    throw new ExportHandoffError(
      "FRAME_NOT_VALIDATED",
      "Run prepare-frame and validate-frame before MAP or REDUCE",
    );
  }
  const frameInput = await readJson(manifest.paths.frameInput, "Compression Frame input");
  const actualInputDigest = frameInputDigest(frameInput);
  if (actualInputDigest !== manifest.frameInputDigest) {
    throw new ExportHandoffError(
      "FRAME_INPUT_CHANGED",
      "Compression Frame input changed after deterministic preparation",
    );
  }
  const frame = await readJson(manifest.paths.frame, "Compression Frame");
  const validated = validateCompressionFrame(frame, frameInput);
  if (
    validated.frameId !== manifest.frameId ||
    validated.frameDigest !== manifest.frameDigest
  ) {
    throw new ExportHandoffError(
      "FRAME_MUTATED",
      "Compression Frame changed after validation",
    );
  }
  return validated;
}

async function prepareTurnAggregate(manifest, aggregate, frozenFrame) {
  if (aggregate.ready && aggregate.dispatch) return aggregate;
  const fragmentSummaries = [];
  for (const childSegmentId of aggregate.childSegmentIds) {
    const child = findSegment(manifest, childSegmentId);
    if (!(await pathExists(child.receiptPath))) return null;
    const summary = await readAcceptedMap(child, frozenFrame);
    fragmentSummaries.push({
      segmentId: summary.segmentId,
      fragmentCoverage: summary.fragmentCoverage.map((entry) => ({
        fragmentId: entry.fragmentId,
        status: entry.status,
        claimIds: [...entry.claimIds],
        reason: entry.reason,
      })),
      claims: listMapClaims(summary),
    });
  }
  const aggregateEvidence = measuredEvidence({
    segmentId: aggregate.segmentId,
    stage: "turn_aggregate_map",
    sourceSessionId: manifest.sessionId,
    parentTurnId: aggregate.parentTurnId,
    expectedTurnIds: [...aggregate.expectedTurnIds],
    expectedFragmentIds: [...aggregate.expectedFragmentIds],
    fragmentSummaries,
  });
  if (aggregateEvidence.evidenceChars > manifest.maxChunkChars) {
    throw new ExportHandoffError(
      "OVERSIZE_EVIDENCE_UNSPLITTABLE",
      `${aggregate.segmentId} evidence is ${aggregateEvidence.evidenceChars} characters; limit is ${manifest.maxChunkChars}`,
    );
  }
  const aggregateChunk = {
    ...aggregateEvidence,
    compressionFrame: frozenFrame.frame,
    frameDigest: frozenFrame.frameDigest,
  };

  if (await pathExists(aggregate.chunkPath)) {
    const existing = await readJson(aggregate.chunkPath, `${aggregate.segmentId} evidence`);
    if (JSON.stringify(existing) !== JSON.stringify(aggregateChunk)) {
      throw new ExportHandoffError(
        "FRAGMENT_AGGREGATE_CHANGED",
        `${aggregate.segmentId} changed after preparation`,
      );
    }
  } else {
    await writeJson(aggregate.chunkPath, aggregateChunk, { exclusive: true });
  }
  aggregate.evidenceChars = aggregateChunk.evidenceChars;
  aggregate.ready = true;
  aggregate.dispatch ??= createStageDispatch(manifest, aggregate, 1);
  aggregate.workerStatus ??= "pending";
  await writeManifest(manifest);
  return aggregate;
}

const MAP_CLAIM_FIELDS = [
  "objectiveFacts",
  "userConstraints",
  "completedWork",
  "openWork",
  "nextActions",
  "importantLocations",
  "conflicts",
];

async function buildDeterministicParentCoverage(manifest, aggregate, frozenFrame) {
  const childSummaries = [];
  for (const childSegmentId of aggregate.childSegmentIds) {
    const child = findSegment(manifest, childSegmentId);
    childSummaries.push(await readAcceptedMap(child, frozenFrame));
  }
  const fragmentCoverage = childSummaries.flatMap((summary) => (
    summary.fragmentCoverage.map((entry) => ({
      fragmentId: entry.fragmentId,
      status: entry.status,
      claimIds: [...entry.claimIds],
      reason: entry.reason,
    }))
  ));
  const retainedClaimIds = [...new Set(
    fragmentCoverage
      .filter((entry) => entry.status === "summarized")
      .flatMap((entry) => entry.claimIds),
  )];
  const result = {
    frameId: frozenFrame.frameId,
    frameDigest: frozenFrame.frameDigest,
    segmentId: aggregate.segmentId,
    fragmentCoverage,
    turnCoverage: [{
      turnId: aggregate.parentTurnId,
      status: retainedClaimIds.length > 0 ? "summarized" : "ignored",
      claimIds: retainedClaimIds,
      reason: retainedClaimIds.length > 0
        ? "derived from complete validated fragment coverage"
        : "all validated fragments were explicitly excluded",
    }],
    ...Object.fromEntries(MAP_CLAIM_FIELDS.map((field) => [
      field,
      childSummaries.flatMap((summary) => summary[field]),
    ])),
    archivalLedger: {
      decisions: childSummaries.flatMap((summary) => summary.archivalLedger.decisions),
      attempts: childSummaries.flatMap((summary) => summary.archivalLedger.attempts),
      verification: childSummaries.flatMap((summary) => summary.archivalLedger.verification),
    },
    compressionNotes: [...new Set(childSummaries.flatMap((summary) => summary.compressionNotes))],
  };
  const validationChunk = measuredEvidence({
    segmentId: aggregate.segmentId,
    stage: "turn_aggregate_map",
    sourceSessionId: manifest.sessionId,
    parentTurnId: aggregate.parentTurnId,
    expectedTurnIds: [...aggregate.expectedTurnIds],
    expectedFragmentIds: [...aggregate.expectedFragmentIds],
    fragmentSummaries: childSummaries.map((summary) => ({
      segmentId: summary.segmentId,
      fragmentCoverage: summary.fragmentCoverage.map((entry) => ({
        fragmentId: entry.fragmentId,
        status: entry.status,
        claimIds: [...entry.claimIds],
        reason: entry.reason,
      })),
      claims: listMapClaims(summary),
    })),
  });
  validateMapResult(result, validationChunk, frozenFrame);
  return result;
}

async function collectReduceStageSummaries(manifest, frozenFrame) {
  const segmentSummaries = [];
  for (const stage of manifest.reduceStages || manifest.segments) {
    if (stage.stage === "turn_aggregate_map") {
      const aggregate = findTurnAggregate(manifest, stage.segmentId);
      if (manifest.parentCoverageMode === DETERMINISTIC_PARENT_COVERAGE_MODE) {
        segmentSummaries.push(await buildDeterministicParentCoverage(
          manifest,
          aggregate,
          frozenFrame,
        ));
        continue;
      }
      const ready = await prepareTurnAggregate(manifest, aggregate, frozenFrame);
      if (!ready) {
        throw new ExportHandoffError(
          "WORKFLOW_FILE_MISSING",
          `${aggregate.segmentId} awaits one or more fragment MAP summaries`,
        );
      }
      segmentSummaries.push(await readAcceptedMap(aggregate, frozenFrame));
    } else {
      segmentSummaries.push(await readAcceptedMap(
        findSegment(manifest, stage.segmentId),
        frozenFrame,
      ));
    }
  }
  return segmentSummaries;
}

async function collectContinuationReduceData(manifest, frozenFrame, evidenceIndex) {
  const completedMaps = [];
  const segmentSummaries = [];
  const deterministicClaims = continuationAuthorityClaims(frozenFrame.frame);
  const parentCoverage = manifest.mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE
    ? buildActionReadyContinuationParentCoverage
    : buildContinuationParentCoverage;
  for (const stage of manifest.reduceStages || manifest.segments) {
    if (stage.stage === "turn_aggregate_map") {
      const aggregate = findTurnAggregate(manifest, stage.segmentId);
      const childMaps = [];
      for (const childSegmentId of aggregate.childSegmentIds) {
        const completed = await readAcceptedMap(
          findSegment(manifest, childSegmentId),
          frozenFrame,
        );
        childMaps.push(completed);
        completedMaps.push(completed);
      }
      segmentSummaries.push({
        segmentId: aggregate.segmentId,
        turnCoverage: [parentCoverage(
          childMaps,
          aggregate.parentTurnId,
          evidenceIndex,
          deterministicClaims,
        )],
      });
      continue;
    }
    const segment = findSegment(manifest, stage.segmentId);
    const completed = await readAcceptedMap(segment, frozenFrame);
    completedMaps.push(completed);
    segmentSummaries.push({
      segmentId: segment.segmentId,
      turnCoverage: (segment.expectedTurnIds || []).map((turnId) => (
        parentCoverage(
          [completed],
          turnId,
          evidenceIndex,
          deterministicClaims,
        )
      )),
    });
  }
  return { completedMaps, segmentSummaries };
}

function continuationAuthorityClaims(frame) {
  if (frame?.formatVersion !== TERMINAL_AUTHORITY_FRAME_VERSION) return {};
  return {
    claims: [frame.acceptedProposal, frame.terminalStateClaim].filter(Boolean),
    requireAcceptedProposal: frame.acceptedProposal !== null,
    requireTerminalState: true,
  };
}

async function publishAtomically(outputPath, content) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  const identity = await fs.promises.stat(temporary);
  try {
    await fs.promises.link(temporary, outputPath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new ExportHandoffError("OUTPUT_EXISTS", `Refusing to overwrite ${outputPath}`);
    }
    throw error;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
  return {
    path: outputPath,
    dev: identity.dev,
    ino: identity.ino,
    size: identity.size,
  };
}

async function removeAttemptPublication(created) {
  let current;
  try {
    current = await fs.promises.stat(created.path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    current.dev !== created.dev ||
    current.ino !== created.ino ||
    current.size !== created.size
  ) {
    throw new ExportHandoffError(
      "PUBLICATION_ROLLBACK_CONFLICT",
      `Refusing to remove a publication file that changed after creation: ${created.path}`,
    );
  }
  await fs.promises.rm(created.path);
}

async function publishPairTransactionally(files, dependencies = {}) {
  const created = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      await dependencies.beforePublish?.({ index, path: file.path });
      created.push(await publishAtomically(file.path, file.content));
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const file of [...created].reverse()) {
      try {
        await removeAttemptPublication(file);
      } catch (rollbackError) {
        rollbackErrors.push({ path: file.path, message: rollbackError.message });
      }
    }
    if (rollbackErrors.length > 0) {
      throw new ExportHandoffError(
        "PUBLICATION_ROLLBACK_FAILED",
        "Publication failed and one or more attempt-owned files could not be removed",
        {
          publicationError: error.message,
          rollbackErrors,
        },
      );
    }
    if (error instanceof ExportHandoffError) throw error;
    throw new ExportHandoffError(
      "PUBLICATION_FAILED",
      error.message,
      { rolledBack: created.map((file) => file.path) },
    );
  }
}

async function removeManagedWorkDir(manifest) {
  assertManagedWorkDir(manifest, manifest.workDir);
  await fs.promises.rm(manifest.workDir, { recursive: true, force: true });
}

function evidenceIndexOutputPath(outputPath) {
  const extension = path.extname(outputPath);
  if (extension.toLowerCase() === ".md") {
    return `${outputPath.slice(0, -extension.length)}.evidence.json`;
  }
  return `${outputPath}.evidence.json`;
}

function injectedBuilderIndex(evidencePack) {
  const sourceRevision = evidencePack.source.sourceRevision || `sha256:${sha256Text(JSON.stringify({
    sessionId: evidencePack.source.sessionId,
    sourceChars: evidencePack.source.sourceChars,
  }))}`;
  const preservationLedger = evidencePack.preservationLedger || {
    sourceRevision,
    requiredAnchors: [],
    exactIdentifiers: [],
    criticalCategories: [],
  };
  evidencePack.source.sourceRevision = sourceRevision;
  evidencePack.source.sourceBytes ??= evidencePack.source.sourceChars;
  evidencePack.evidenceAnchors ??= [];
  evidencePack.preservationLedger = preservationLedger;
  return buildEvidenceIndex({
    sessionId: evidencePack.source.sessionId,
    source: evidencePack.source,
    workspace: evidencePack.workspace,
    entries: [],
    preservationLedger,
  });
}

function collectEvidenceReferences(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceReferences(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "anchors") {
      if (!Array.isArray(nested) || nested.some((item) => typeof item !== "string" || !item)) {
        throw new ExportHandoffError(
          "INVALID_EVIDENCE_REFERENCE",
          "Claim anchors must be an array of non-empty Evidence Anchor IDs",
        );
      }
      output.push(...nested);
    } else {
      collectEvidenceReferences(nested, output);
    }
  }
  return output;
}

function validateEvidenceReferences(value, evidenceIndex) {
  const known = new Set(evidenceIndex.anchors.map((entry) => entry.anchor.anchorId));
  for (const anchorId of collectEvidenceReferences(value)) {
    if (!known.has(anchorId)) {
      throw new ExportHandoffError(
        "UNKNOWN_EVIDENCE_ANCHOR",
        `Handoff claim references unknown Evidence Anchor ${anchorId}`,
      );
    }
  }
}

export async function prepareCompressionTask(options, dependencies = {}) {
  const sessionId = validateSessionId(options.sessionId);
  const maxChars = requireInteger(
    options.maxChars,
    40_000,
    4_000,
    "INVALID_OUTPUT_BUDGET",
    "maxChars",
  );
  const maxChunkChars = requireInteger(
    options.maxChunkChars,
    140_000,
    4_000,
    "INVALID_CHUNK_BUDGET",
    "maxChunkChars",
  );
  const maxMapInputChars = requireInteger(
    options.maxMapInputChars,
    100_000,
    4_000,
    "INVALID_MAP_INPUT_BUDGET",
    "maxMapInputChars",
  );
  const maxFrameProjectionChars = requireInteger(
    options.maxFrameProjectionChars,
    20_000,
    1,
    "INVALID_FRAME_PROJECTION_BUDGET",
    "maxFrameProjectionChars",
  );
  const maxEvidenceIndexChars = requireInteger(
    options.maxEvidenceIndexChars,
    1_000_000,
    4_000,
    "INVALID_EVIDENCE_INDEX_BUDGET",
    "maxEvidenceIndexChars",
  );
  const mapResultMode = options.mapResultMode ?? SPARSE_MAP_RESULT_MODE;
  if (![
    SPARSE_MAP_RESULT_MODE,
    CONTINUATION_MAP_RESULT_MODE,
    CONTINUATION_MAP_V2_RESULT_MODE,
  ].includes(mapResultMode)) {
    throw new ExportHandoffError(
      "INVALID_MAP_RESULT_MODE",
      `mapResultMode must be ${SPARSE_MAP_RESULT_MODE}, ${CONTINUATION_MAP_RESULT_MODE}, or ${CONTINUATION_MAP_V2_RESULT_MODE}`,
    );
  }
  const continuationMode = isContinuationMapResultMode(mapResultMode);
  const actionReadyMode = mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE;
  const maximumAggregateMapOutputChars = continuationMode
    ? reduceTargetMaxChars(maxChars)
    : reduceTargetMaxChars(maxChars) * 3;
  const maxAggregateMapOutputChars = requireInteger(
    options.maxAggregateMapOutputChars,
    maximumAggregateMapOutputChars,
    1,
    "INVALID_MAP_OUTPUT_BUDGET",
    "maxAggregateMapOutputChars",
  );
  if (maxAggregateMapOutputChars > maximumAggregateMapOutputChars) {
    throw new ExportHandoffError(
      "INVALID_MAP_OUTPUT_BUDGET",
      `maxAggregateMapOutputChars cannot exceed the ${mapResultMode} ceiling (${maximumAggregateMapOutputChars})`,
    );
  }
  const effectiveMaxChunkChars = continuationMode
    ? Math.min(
      maxChunkChars,
      Math.floor((maxMapInputChars - maxFrameProjectionChars) * 0.75),
    )
    : maxChunkChars;
  if (effectiveMaxChunkChars < 4_000) {
    throw new ExportHandoffError(
      "INVALID_CHUNK_BUDGET",
      "Continuation MAP input and projection budgets leave less than 4000 characters for evidence",
    );
  }
  const outputPath = path.resolve(
    options.outputPath || path.join(process.cwd(), `handoff-${sessionId}.md`),
  );
  const publishedEvidenceIndexPath = path.resolve(
    options.evidenceIndexPath || evidenceIndexOutputPath(outputPath),
  );
  for (const target of [outputPath, publishedEvidenceIndexPath]) {
    if (await pathExists(target)) {
      throw new ExportHandoffError("OUTPUT_EXISTS", `Refusing to overwrite ${target}`);
    }
  }

  const packBuilder = dependencies.buildEvidencePack || buildEvidencePack;
  const builtPack = await packBuilder(sessionId, {
    codexHome: options.codexHome,
    maxToolChars: options.maxToolChars,
    maxCheckpointChars: options.maxCheckpointChars,
    maxObservationChars: options.maxObservationChars,
    publicationOutputPaths: [outputPath, publishedEvidenceIndexPath],
  });
  let evidenceIndex = builtPack.evidenceIndex;
  const evidencePack = { ...builtPack };
  delete evidencePack.evidenceIndex;
  if (!evidenceIndex) {
    if (!dependencies.buildEvidencePack) {
      throw new ExportHandoffError("EVIDENCE_INDEX_MISSING", "Evidence Pack builder returned no Evidence Index");
    }
    evidenceIndex = injectedBuilderIndex(evidencePack);
  }
  validateEvidenceIndex(evidenceIndex);

  let actionReadyProgressEvidence = null;
  if (actionReadyMode) {
    actionReadyProgressEvidence = validateProgressEvidence(
      evidencePack.progressEvidence,
      evidencePack.turns,
      evidenceIndex,
    );
  }

  const chunkPlan = chunkEvidencePack(evidencePack, {
    maxChunkChars: effectiveMaxChunkChars,
    criticalOnly: continuationMode,
  });
  const progressSegment = actionReadyMode
    ? createActionReadyProgressSegment(sessionId, actionReadyProgressEvidence)
    : null;
  if (progressSegment && progressSegment.evidenceChars > effectiveMaxChunkChars) {
    throw new ExportHandoffError(
      "MAP_INPUT_TOO_LARGE",
      `Progress Evidence MAP input is ${progressSegment.evidenceChars} characters; evidence limit is ${effectiveMaxChunkChars}`,
    );
  }
  const chunks = [
    ...chunkPlan.segments,
    ...(progressSegment ? [progressSegment] : []),
  ];
  const reduceStages = [
    ...chunkPlan.reduceStages,
    ...(progressSegment
      ? [{ stage: ACTION_READY_PROGRESS_STAGE, segmentId: progressSegment.segmentId }]
      : []),
  ];
  const mapOutputBudgets = continuationMode
    ? allocateContinuationMapOutputBudgets(maxAggregateMapOutputChars, chunks.length)
    : allocateMapOutputBudgets(maxAggregateMapOutputChars, chunks.length);
  const workRoot = path.resolve(options.workRoot || os.tmpdir());
  await fs.promises.mkdir(workRoot, { recursive: true });
  const workDir = await fs.promises.mkdtemp(path.join(workRoot, WORKDIR_PREFIX));
  const frameContractVersion = continuationMode &&
    evidencePack.sourceContinuation?.currentGoal &&
    evidencePack.terminalStateClaim
    ? TERMINAL_AUTHORITY_FRAME_VERSION
    : null;

  try {
    const paths = {
      evidencePack: path.join(workDir, "evidence-pack.json"),
      evidenceIndex: path.join(workDir, "evidence-index.json"),
      frameInput: path.join(workDir, "frame-input.json"),
      frame: path.join(workDir, "frame.json"),
      reduceInput: path.join(workDir, "reduce-input.json"),
      reduced: path.join(workDir, "reduced.json"),
      failureReport: path.join(workDir, "failure-report.json"),
    };
    const segments = chunks.map((chunk, index) => ({
      segmentId: chunk.segmentId,
      stage: chunk.stage,
      ...(chunk.expectedTurnIds ? { expectedTurnIds: chunk.expectedTurnIds } : {}),
      ...(chunk.expectedFragmentIds ? { expectedFragmentIds: chunk.expectedFragmentIds } : {}),
      ...(chunk.parentTurnId ? { parentTurnId: chunk.parentTurnId } : {}),
      chunkPath: path.join(workDir, "segments", `${chunk.segmentId}.json`),
      summaryPath: path.join(workDir, "summaries", `${chunk.segmentId}.json`),
      ...(mapResultMode === SPARSE_MAP_RESULT_MODE
        ? {
          normalizedSummaryPath: path.join(
            workDir,
            "normalized-summaries",
            `${chunk.segmentId}.json`,
          ),
        }
        : {
          completedSummaryPath: path.join(
            workDir,
            "completed-maps",
            `${chunk.segmentId}.json`,
          ),
        }),
      receiptPath: path.join(workDir, "receipts", `${chunk.segmentId}.json`),
      diagnosticsDir: path.join(workDir, "diagnostics", chunk.segmentId),
      contextPath: path.join(workDir, "contexts", `${chunk.segmentId}.json`),
      dictionaryPath: path.join(workDir, "dictionaries", `${chunk.segmentId}.json`),
      contextDigest: null,
      contextChars: null,
      dictionaryDigest: null,
      dictionaryChars: null,
      evidenceInputChars: null,
      mapInputChars: null,
      evidenceChars: chunk.evidenceChars,
      maxMapOutputChars: mapOutputBudgets[index],
      dispatch: null,
      workerStatus: "unprepared",
    }));
    const turnAggregates = chunkPlan.turnAggregates.map((aggregate) => ({
      ...aggregate,
      chunkPath: path.join(workDir, "aggregates", `${aggregate.segmentId}.json`),
      summaryPath: path.join(workDir, "summaries", `${aggregate.segmentId}.json`),
      ...(mapResultMode === SPARSE_MAP_RESULT_MODE
        ? {
          normalizedSummaryPath: path.join(
            workDir,
            "normalized-summaries",
            `${aggregate.segmentId}.json`,
          ),
        }
        : {
          completedSummaryPath: path.join(
            workDir,
            "completed-maps",
            `${aggregate.segmentId}.json`,
          ),
        }),
      receiptPath: path.join(workDir, "receipts", `${aggregate.segmentId}.json`),
      diagnosticsDir: path.join(workDir, "diagnostics", aggregate.segmentId),
      evidenceChars: null,
      ready: false,
      dispatch: null,
      workerStatus: "not_required",
    }));
    const createdAt = new Date().toISOString();
    const manifest = {
      formatVersion: CURRENT_WORKFLOW_VERSION,
      kind: "codex-handoff-compression-task",
      managedWorkDir: true,
      createdAt,
      workflowDeadlineAt: new Date(
        Date.parse(createdAt) + LIVE_ACCEPTANCE_TARGET_MS,
      ).toISOString(),
      mapWaveAdmissions: [],
      sessionId,
      workRoot,
      workDir,
      outputPath,
      evidenceIndexPath: publishedEvidenceIndexPath,
      maxChars,
      maxEvidenceIndexChars,
      maxChunkChars: effectiveMaxChunkChars,
      maxMapInputChars,
      maxFrameProjectionChars,
      maxAggregateMapOutputChars,
      mapResultMode,
      mapContextMode: REFERENCE_FRAME_PROJECTION_MODE,
      parentCoverageMode: DETERMINISTIC_PARENT_COVERAGE_MODE,
      mapGenerationMetricMode: MAP_GENERATION_METRIC_MODE,
      ...(frameContractVersion ? { frameContractVersion } : {}),
      expectedTurnIds: evidencePack.turns.map((turn) => turn.turnId),
      sourceChars: evidencePack.source.sourceChars,
      sourceRevision: evidencePack.source.sourceRevision,
      evidenceChars: evidencePack.evidenceChars,
      sourceCwd: evidencePack.source.session.cwd,
      workspaceStatus: evidencePack.workspace.status,
      gitStatus: evidencePack.workspace.git?.status || null,
      frameInputDigest: null,
      frameId: null,
      frameDigest: null,
      paths,
      segments,
      turnAggregates,
      reduceStages,
    };

    await writeJson(paths.evidencePack, evidencePack, { exclusive: true });
    await writeJson(paths.evidenceIndex, evidenceIndex, { exclusive: true });
    for (let index = 0; index < chunks.length; index += 1) {
      await writeJson(segments[index].chunkPath, chunks[index], { exclusive: true });
    }
    await fs.promises.mkdir(path.join(workDir, "summaries"), { recursive: true });
    await writeJson(workflowVersionPath(workDir), {
      kind: "codex-handoff-workflow-version",
      formatVersion: CURRENT_WORKFLOW_VERSION,
      sessionId,
      workDir,
      mapResultMode: manifest.mapResultMode,
      createdAt: manifest.createdAt,
      workflowDeadlineAt: manifest.workflowDeadlineAt,
      maxAggregateMapOutputChars: manifest.maxAggregateMapOutputChars,
      mapContextMode: manifest.mapContextMode,
      maxFrameProjectionChars: manifest.maxFrameProjectionChars,
      maxMapInputChars: manifest.maxMapInputChars,
      ...(frameContractVersion ? { frameContractVersion } : {}),
    }, { exclusive: true });
    await writeJson(path.join(workDir, MANIFEST_FILE), manifest, { exclusive: true });
    const adjudicationContract = await initializeAdjudicationContract(manifest);

    return {
      formatVersion: manifest.formatVersion,
      sessionId,
      workDir,
      manifestPath: path.join(workDir, MANIFEST_FILE),
      outputPath,
      evidenceIndexPath: publishedEvidenceIndexPath,
      frameInputPath: paths.frameInput,
      framePath: paths.frame,
      sourceCwd: manifest.sourceCwd,
      sourceChars: manifest.sourceChars,
      sourceRevision: manifest.sourceRevision,
      evidenceChars: manifest.evidenceChars,
      maxEvidenceIndexChars: manifest.maxEvidenceIndexChars,
      maxMapInputChars: manifest.maxMapInputChars,
      maxFrameProjectionChars: manifest.maxFrameProjectionChars,
      maxAggregateMapOutputChars: manifest.maxAggregateMapOutputChars,
      mapResultMode: manifest.mapResultMode,
      mapContextMode: manifest.mapContextMode,
      parentCoverageMode: manifest.parentCoverageMode,
      frameContractVersion: manifest.frameContractVersion || null,
      workspaceStatus: manifest.workspaceStatus,
      gitStatus: manifest.gitStatus,
      segments,
      turnAggregates,
      reduceInputPath: paths.reduceInput,
      reducedPath: paths.reduced,
      failureReportPath: paths.failureReport,
      ...adjudicationContract,
    };
  } catch (error) {
    const provisional = { managedWorkDir: true, workRoot, workDir };
    await removeManagedWorkDir(provisional).catch(() => {});
    throw error;
  }
}

export async function prepareFrameStage(workDir) {
  const manifest = await loadManifest(workDir);
  const evidencePack = await readJson(manifest.paths.evidencePack, "Evidence Pack");
  const evidenceIndex = validateEvidenceIndex(
    await readJson(manifest.paths.evidenceIndex, "Evidence Index"),
  );
  const frameInput = buildFrameInput(evidencePack, evidenceIndex, {
    terminalAuthority: manifest.frameContractVersion === TERMINAL_AUTHORITY_FRAME_VERSION,
  });
  const digest = frameInputDigest(frameInput);
  if (manifest.frameInputDigest) {
    const existing = await readJson(manifest.paths.frameInput, "Compression Frame input");
    if (frameInputDigest(existing) !== manifest.frameInputDigest || digest !== manifest.frameInputDigest) {
      throw new ExportHandoffError(
        "FRAME_INPUT_CHANGED",
        "Deterministic Compression Frame input changed after preparation",
      );
    }
  } else {
    await writeJson(manifest.paths.frameInput, frameInput, { exclusive: true });
    manifest.frameInputDigest = digest;
    await writeManifest(manifest);
  }
  return {
    ready: true,
    frameInputPath: manifest.paths.frameInput,
    framePath: manifest.paths.frame,
    frameInputDigest: digest,
    expectedFrameId: frameInput.expectedFrameId,
  };
}

export async function validateFrameStage(workDir) {
  const manifest = await loadManifest(workDir);
  if (!manifest.frameInputDigest) {
    throw new ExportHandoffError("FRAME_INPUT_MISSING", "Run prepare-frame before validate-frame");
  }
  const frameInput = await readJson(manifest.paths.frameInput, "Compression Frame input");
  if (frameInputDigest(frameInput) !== manifest.frameInputDigest) {
    throw new ExportHandoffError(
      "FRAME_INPUT_CHANGED",
      "Compression Frame input changed after deterministic preparation",
    );
  }
  const frame = await readJson(manifest.paths.frame, "Compression Frame");
  const validated = validateCompressionFrame(frame, frameInput);
  if (
    manifest.frameDigest &&
    (manifest.frameId !== validated.frameId || manifest.frameDigest !== validated.frameDigest)
  ) {
    throw new ExportHandoffError("FRAME_MUTATED", "Compression Frame changed after validation");
  }
  manifest.frameId = validated.frameId;
  manifest.frameDigest = validated.frameDigest;
  manifest.frameValidatedAt ??= new Date().toISOString();
  await writeManifest(manifest);

  try {
    const projection = projectPreDispatchLowerBound({
      createdAt: manifest.createdAt,
      frameValidatedAt: manifest.frameValidatedAt,
    });
    if (projection.abort) {
      throw new ExportHandoffError(
        "LIVE_BUDGET_UNREACHABLE",
        `Pre-dispatch lower bound ${projection.projectedTotalMs} ms exceeds the ${projection.targetMs} ms live acceptance target`,
        { projection },
      );
    }
  } catch (error) {
    await recordCapturedWorkflowDiagnostic(workDir, "pre-dispatch", error);
    throw error;
  }

  const chunks = [];
  for (const segment of manifest.segments) {
    const chunkDocument = await readJsonDocument(
      segment.chunkPath,
      `${segment.segmentId} evidence`,
    );
    const chunk = chunkDocument.value;
    if (chunk.frameDigest && chunk.frameDigest !== validated.frameDigest) {
      throw new ExportHandoffError(
        "FRAME_MUTATED",
        `${segment.segmentId} is already bound to another Compression Frame`,
      );
    }
    chunks.push({ segment, chunk, evidenceInputChars: chunkDocument.text.length });
  }
  for (const { segment, chunk, evidenceInputChars } of chunks) {
    if (manifest.mapContextMode === REFERENCE_FRAME_PROJECTION_MODE) {
      const dictionary = buildEvidenceReferenceDictionary(validated, chunk);
      const dictionaryDigest = evidenceReferenceDictionaryDigest(dictionary);
      const dictionaryChars = `${JSON.stringify(dictionary, null, 2)}\n`.length;
      const projection = buildReferenceFrameProjection(validated, chunk, dictionary);
      const contextDigest = frameProjectionDigest(projection);
      const contextChars = `${JSON.stringify(projection, null, 2)}\n`.length;
      if (contextChars > manifest.maxFrameProjectionChars) {
        throw new ExportHandoffError(
          "FRAME_PROJECTION_TOO_LARGE",
          `${segment.segmentId} Frame Projection is ${contextChars} characters; limit is ${manifest.maxFrameProjectionChars}`,
          {
            segmentId: segment.segmentId,
            contextChars,
            maxFrameProjectionChars: manifest.maxFrameProjectionChars,
          },
        );
      }
      const mapInputChars = evidenceInputChars + dictionaryChars + contextChars;
      if (mapInputChars > manifest.maxMapInputChars) {
        throw new ExportHandoffError(
          "MAP_INPUT_TOO_LARGE",
          `${segment.segmentId} MAP input is ${mapInputChars} characters; limit is ${manifest.maxMapInputChars}`,
          {
            segmentId: segment.segmentId,
            evidenceInputChars,
            dictionaryChars,
            contextChars,
            mapInputChars,
            maxMapInputChars: manifest.maxMapInputChars,
          },
        );
      }
      if (await pathExists(segment.dictionaryPath)) {
        const existing = await readJson(
          segment.dictionaryPath,
          `${segment.segmentId} Evidence Reference Dictionary`,
        );
        const checked = validateEvidenceReferenceDictionary(
          existing,
          validated,
          chunk,
        );
        if (checked.dictionaryDigest !== dictionaryDigest) {
          throw new ExportHandoffError(
            "MAP_DICTIONARY_CHANGED",
            `${segment.segmentId} Evidence Reference Dictionary changed after preparation`,
          );
        }
      } else {
        await writeJson(segment.dictionaryPath, dictionary, { exclusive: true });
      }
      if (await pathExists(segment.contextPath)) {
        const existing = await readJson(
          segment.contextPath,
          `${segment.segmentId} Frame Projection`,
        );
        const checked = validateReferenceFrameProjection(
          existing,
          validated,
          chunk,
          dictionary,
        );
        if (checked.contextDigest !== contextDigest) {
          throw new ExportHandoffError(
            "MAP_CONTEXT_CHANGED",
            `${segment.segmentId} Frame Projection changed after preparation`,
          );
        }
      } else {
        await writeJson(segment.contextPath, projection, { exclusive: true });
      }
      segment.dictionaryDigest = dictionaryDigest;
      segment.dictionaryChars = dictionaryChars;
      segment.contextDigest = contextDigest;
      segment.contextChars = contextChars;
      segment.evidenceInputChars = evidenceInputChars;
      segment.mapInputChars = mapInputChars;
    } else if (manifest.mapContextMode === LEGACY_FRAME_PROJECTION_MODE) {
      const projection = buildFrameProjection(validated, chunk);
      const contextDigest = frameProjectionDigest(projection);
      const contextChars = `${JSON.stringify(projection, null, 2)}\n`.length;
      const mapInputChars = evidenceInputChars + contextChars;
      if (mapInputChars > manifest.maxMapInputChars) {
        throw new ExportHandoffError(
          "MAP_INPUT_TOO_LARGE",
          `${segment.segmentId} MAP input is ${mapInputChars} characters; limit is ${manifest.maxMapInputChars}`,
          {
            segmentId: segment.segmentId,
            evidenceInputChars,
            contextChars,
            mapInputChars,
            maxMapInputChars: manifest.maxMapInputChars,
          },
        );
      }
      if (await pathExists(segment.contextPath)) {
        const existing = await readJson(
          segment.contextPath,
          `${segment.segmentId} Frame Projection`,
        );
        const checked = validateFrameProjection(existing, validated, chunk);
        if (checked.contextDigest !== contextDigest) {
          throw new ExportHandoffError(
            "MAP_CONTEXT_CHANGED",
            `${segment.segmentId} Frame Projection changed after preparation`,
          );
        }
      } else {
        await writeJson(segment.contextPath, projection, { exclusive: true });
      }
      segment.contextDigest = contextDigest;
      segment.contextChars = contextChars;
      segment.evidenceInputChars = evidenceInputChars;
      segment.mapInputChars = mapInputChars;
    } else {
      await writeJson(segment.chunkPath, {
        ...chunk,
        compressionFrame: validated.frame,
        frameDigest: validated.frameDigest,
      });
    }
    if (segment.dispatch) {
      validateMapDispatch(segment.dispatch, {
        segmentId: segment.segmentId,
        frameDigest: validated.frameDigest,
        ...(segment.contextDigest ? { contextDigest: segment.contextDigest } : {}),
        ...(segment.dictionaryDigest ? { dictionaryDigest: segment.dictionaryDigest } : {}),
      });
    } else {
      segment.dispatch = createStageDispatch(manifest, segment, 1);
      segment.workerStatus = "pending";
    }
  }
  await writeManifest(manifest);
  return {
    valid: true,
    frameId: validated.frameId,
    frameDigest: validated.frameDigest,
    framePath: manifest.paths.frame,
    mapResultMode: manifest.mapResultMode,
    mapContextMode: manifest.mapContextMode || "embedded-frame-v1",
    maxFrameProjectionChars: manifest.maxFrameProjectionChars || null,
    maxMapInputChars: manifest.maxMapInputChars || null,
    maxAggregateMapOutputChars: manifest.maxAggregateMapOutputChars || null,
    maxObservedMapInputChars: Math.max(
      0,
      ...manifest.segments.map((segment) => segment.mapInputChars || 0),
    ),
    maxObservedFrameProjectionChars: Math.max(
      0,
      ...manifest.segments.map((segment) => segment.contextChars || 0),
    ),
    segments: manifest.segments,
    turnAggregates: manifest.turnAggregates || [],
    mapDispatches: manifest.segments
      .filter((segment) => segment.workerStatus === "pending")
      .map((segment) => segment.dispatch),
  };
}

export async function claimMapDispatch(
  workDir,
  segmentId,
  dispatchId,
  workerId,
) {
  const manifest = await loadManifest(workDir);
  const frozenFrame = await loadFrozenFrame(manifest);
  const stage = findMapStage(manifest, segmentId);
  if (!stage) {
    throw new ExportHandoffError("UNKNOWN_SEGMENT", `Unknown segment: ${segmentId}`);
  }
  if (!stage.dispatch) {
    throw new ExportHandoffError("MAP_DISPATCH_MISSING", `${segmentId} has no MAP dispatch`);
  }
  validateMapDispatch(stage.dispatch, {
    dispatchId,
    segmentId,
    frameDigest: frozenFrame.frameDigest,
    ...(stage.contextDigest ? { contextDigest: stage.contextDigest } : {}),
    ...(stage.dictionaryDigest ? { dictionaryDigest: stage.dictionaryDigest } : {}),
  });
  const stages = [
    ...(manifest.segments || []),
    ...(manifest.turnAggregates || []),
  ].filter((candidate) => candidate.dispatch);
  const { admissionsBySegment, stagesById } = requireMapWaveAdmissions(manifest, stages);
  const activeAdmission = currentUnacceptedMapAdmission(manifest, stagesById);
  const admission = admissionsBySegment.get(segmentId);
  if (!activeAdmission || admission !== activeAdmission) {
    throw new ExportHandoffError(
      "MAP_DISPATCH_NOT_ADMITTED",
      `${segmentId} is not part of the current unaccepted durable MAP wave admission`,
    );
  }
  if (stage.workerStatus === "validated" || await pathExists(stage.receiptPath)) {
    throw new ExportHandoffError(
      "DUPLICATE_MAP_RECEIPT",
      `${segmentId} already has a validated MAP receipt`,
    );
  }
  if (stage.workerStatus === "exhausted") {
    throw new ExportHandoffError(
      "MAP_WORKER_EXHAUSTED",
      `${segmentId} exhausted both MAP Worker attempts`,
      { diagnosticsDir: stage.diagnosticsDir },
    );
  }
  if (typeof workerId !== "string" || workerId.length === 0 || workerId.length > 256) {
    throw new ExportHandoffError(
      "INVALID_MAP_WORKER_ID",
      "workerId must be a non-empty string of at most 256 characters",
    );
  }
  const claimPath = dispatchClaimPath(manifest, dispatchId);
  try {
    await writeJson(claimPath, {
      dispatchId,
      segmentId,
      workerId,
      claimedAt: new Date().toISOString(),
    }, { exclusive: true });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new ExportHandoffError(
        "MAP_DISPATCH_ALREADY_CLAIMED",
        `${dispatchId} is already claimed by another MAP Worker`,
      );
    }
    throw error;
  }
  return {
    claimed: true,
    segmentId,
    dispatch: stage.dispatch,
    claimPath,
  };
}

async function recordMapFailure(manifest, stage, error) {
  const receipt = {
    dispatchId: stage.dispatch.dispatchId,
    segmentId: stage.segmentId,
    status: "failed",
    diagnosticCode: error.code || "MAP_WORKER_FAILED",
  };
  validateMapReceipt(receipt, stage.dispatch);
  await fs.promises.mkdir(stage.diagnosticsDir, { recursive: true });
  const prefix = `attempt-${stage.dispatch.attempt}-failure-${crypto.randomUUID()}`;
  await writeJson(path.join(stage.diagnosticsDir, `${prefix}.receipt.json`), receipt, {
    exclusive: true,
  });
  if (await pathExists(stage.summaryPath)) {
    await fs.promises.copyFile(
      stage.summaryPath,
      path.join(stage.diagnosticsDir, `${prefix}.summary.json`),
      fs.constants.COPYFILE_EXCL,
    );
    await fs.promises.rm(stage.summaryPath, { force: true });
  }
  stage.lastDiagnosticCode = receipt.diagnosticCode;
  stage.workerStatus = "failed";
  delete stage.checkedSummaryDigest;
  delete stage.summaryCheckedAt;
  await writeManifest(manifest);
  return { receipt };
}

export async function checkMapDispatch(
  workDir,
  segmentId,
  dispatchId,
) {
  const startedAtMs = Date.now();
  const manifest = await loadManifest(workDir);
  const frozenFrame = await loadFrozenFrame(manifest);
  const stage = findMapStage(manifest, segmentId);
  if (!stage) {
    throw new ExportHandoffError("UNKNOWN_SEGMENT", `Unknown segment: ${segmentId}`);
  }
  if (!stage.dispatch) {
    throw new ExportHandoffError("MAP_DISPATCH_MISSING", `${segmentId} has no MAP dispatch`);
  }
  validateMapDispatch(stage.dispatch, {
    dispatchId,
    segmentId,
    frameDigest: frozenFrame.frameDigest,
    ...(stage.contextDigest ? { contextDigest: stage.contextDigest } : {}),
    ...(stage.dictionaryDigest ? { dictionaryDigest: stage.dictionaryDigest } : {}),
    mapResultMode: manifest.mapResultMode,
  });
  if (stage.workerStatus === "validated" || await pathExists(stage.receiptPath)) {
    throw new ExportHandoffError(
      "DUPLICATE_MAP_RECEIPT",
      `${segmentId} already has a validated MAP receipt`,
    );
  }
  if (stage.workerStatus === "exhausted") {
    throw new ExportHandoffError(
      "MAP_WORKER_EXHAUSTED",
      `${segmentId} exhausted both MAP Worker attempts`,
      { diagnosticsDir: stage.diagnosticsDir },
    );
  }
  const claimPath = dispatchClaimPath(manifest, dispatchId);
  if (!(await pathExists(claimPath))) {
    throw new ExportHandoffError(
      "MAP_DISPATCH_NOT_CLAIMED",
      `${dispatchId} must be atomically claimed before checking its candidate`,
    );
  }

  const checked = await validateWorkerSummary(stage, frozenFrame);
  stage.checkDurationMs = durationSince(startedAtMs);
  stage.checkedSummaryDigest = checked.summaryDigest;
  stage.summaryCheckedAt = new Date().toISOString();
  await writeManifest(manifest);
  return {
    valid: true,
    dispatchId,
    segmentId,
    summaryDigest: checked.summaryDigest,
    checkDurationMs: stage.checkDurationMs,
    ...(stage.dispatch.maxMapOutputChars
      ? { rawMapOutputChars: checked.rawMapOutputChars }
      : {}),
  };
}

export async function completeMapDispatch(workDir, segmentId, dispatchId) {
  const startedAtMs = Date.now();
  const manifest = await loadManifest(workDir);
  const frozenFrame = await loadFrozenFrame(manifest);
  const stage = findMapStage(manifest, segmentId);
  if (!stage) {
    throw new ExportHandoffError("UNKNOWN_SEGMENT", `Unknown segment: ${segmentId}`);
  }
  if (!stage.dispatch) {
    throw new ExportHandoffError("MAP_DISPATCH_MISSING", `${segmentId} has no MAP dispatch`);
  }
  validateMapDispatch(stage.dispatch, {
    dispatchId,
    segmentId,
    frameDigest: frozenFrame.frameDigest,
    ...(stage.contextDigest ? { contextDigest: stage.contextDigest } : {}),
    ...(stage.dictionaryDigest ? { dictionaryDigest: stage.dictionaryDigest } : {}),
    mapResultMode: manifest.mapResultMode,
  });
  if (stage.workerStatus === "validated" || await pathExists(stage.receiptPath)) {
    throw new ExportHandoffError(
      "DUPLICATE_MAP_RECEIPT",
      `${segmentId} already has a validated MAP receipt`,
    );
  }
  if (stage.workerStatus === "exhausted") {
    throw new ExportHandoffError(
      "MAP_WORKER_EXHAUSTED",
      `${segmentId} exhausted both MAP Worker attempts`,
      { diagnosticsDir: stage.diagnosticsDir },
    );
  }
  const claimPath = dispatchClaimPath(manifest, dispatchId);
  if (!(await pathExists(claimPath))) {
    throw new ExportHandoffError(
      "MAP_DISPATCH_NOT_CLAIMED",
      `${dispatchId} must be atomically claimed before reading its evidence`,
    );
  }

  let validatedSummary;
  try {
    validatedSummary = await validateWorkerSummary(stage, frozenFrame, {
      expectedSummaryDigest: stage.checkedSummaryDigest,
    });
  } catch (error) {
    stage.completeDurationMs = durationSince(startedAtMs);
    const failure = await recordMapFailure(manifest, stage, error);
    throw new ExportHandoffError(error.code || "MAP_WORKER_FAILED", error.message, {
      ...error.details,
      receipt: failure.receipt,
    });
  }

  const receipt = {
    dispatchId,
    segmentId,
    status: "validated",
    summaryDigest: validatedSummary.summaryDigest,
  };
  if (Object.hasOwn(stage.dispatch, "maxMapOutputChars")) {
    receipt.rawMapOutputChars = validatedSummary.rawMapOutputChars;
  }
  let normalizedSummaryCreated = false;
  let completedSummaryCreated = false;
  if (stage.dispatch.mapResultMode === SPARSE_MAP_RESULT_MODE) {
    if (!stage.normalizedSummaryPath) {
      throw new ExportHandoffError(
        "WORKFLOW_FILE_MISSING",
        `${segmentId} has no normalized sparse MAP path`,
      );
    }
    await writeJson(stage.normalizedSummaryPath, validatedSummary.normalized, {
      exclusive: true,
    });
    normalizedSummaryCreated = true;
    const normalizedDocument = await readJsonDocument(
      stage.normalizedSummaryPath,
      `${segmentId} normalized sparse MAP summary`,
    );
    receipt.normalizedSummaryDigest = `sha256:${sha256Text(normalizedDocument.text)}`;
    if (Object.hasOwn(stage.dispatch, "maxMapOutputChars")) {
      receipt.normalizedMapOutputChars = normalizedDocument.text.length;
    }
  } else if (isContinuationMapResultMode(stage.dispatch.mapResultMode)) {
    if (!stage.completedSummaryPath) {
      throw new ExportHandoffError(
        "WORKFLOW_FILE_MISSING",
        `${segmentId} has no completed continuation MAP path`,
      );
    }
    await writeJson(stage.completedSummaryPath, validatedSummary.completed, {
      exclusive: true,
    });
    completedSummaryCreated = true;
    const completedDocument = await readJsonDocument(
      stage.completedSummaryPath,
      `${segmentId} completed continuation MAP result`,
    );
    receipt.completedSummaryDigest = `sha256:${sha256Text(completedDocument.text)}`;
    receipt.completedMapOutputChars = completedDocument.text.length;
  }
  validateMapReceipt(receipt, stage.dispatch);
  try {
    await writeJson(stage.receiptPath, receipt, { exclusive: true });
  } catch (error) {
    if (normalizedSummaryCreated) {
      await fs.promises.rm(stage.normalizedSummaryPath, { force: true }).catch(() => {});
    }
    if (completedSummaryCreated) {
      await fs.promises.rm(stage.completedSummaryPath, { force: true }).catch(() => {});
    }
    if (error.code === "EEXIST") {
      throw new ExportHandoffError(
        "DUPLICATE_MAP_RECEIPT",
        `${segmentId} already has a validated MAP receipt`,
      );
    }
    throw error;
  }
  stage.workerStatus = "validated";
  stage.completeDurationMs = durationSince(startedAtMs);
  stage.summaryDigest = receipt.summaryDigest;
  if (receipt.normalizedSummaryDigest) {
    stage.normalizedSummaryDigest = receipt.normalizedSummaryDigest;
  }
  if (receipt.completedSummaryDigest) {
    stage.completedSummaryDigest = receipt.completedSummaryDigest;
  }
  if (receipt.rawMapOutputChars) {
    stage.rawMapOutputChars = receipt.rawMapOutputChars;
    if (receipt.normalizedMapOutputChars) {
      stage.normalizedMapOutputChars = receipt.normalizedMapOutputChars;
    }
    if (receipt.completedMapOutputChars) {
      stage.completedMapOutputChars = receipt.completedMapOutputChars;
    }
  }
  delete stage.lastDiagnosticCode;
  await writeManifest(manifest);
  return receipt;
}

export async function acceptMapReceipt(workDir, segmentId, dispatchId) {
  const startedAtMs = Date.now();
  const manifest = await loadManifest(workDir);
  const frozenFrame = await loadFrozenFrame(manifest);
  const stage = findMapStage(manifest, segmentId);
  if (!stage) {
    throw new ExportHandoffError("UNKNOWN_SEGMENT", `Unknown segment: ${segmentId}`);
  }
  if (!stage.dispatch) {
    throw new ExportHandoffError("MAP_DISPATCH_MISSING", `${segmentId} has no MAP dispatch`);
  }
  validateMapDispatch(stage.dispatch, {
    dispatchId,
    segmentId,
    frameDigest: frozenFrame.frameDigest,
    ...(stage.contextDigest ? { contextDigest: stage.contextDigest } : {}),
    ...(stage.dictionaryDigest ? { dictionaryDigest: stage.dictionaryDigest } : {}),
  });
  if (stage.receiptAcceptedAt) {
    throw new ExportHandoffError(
      "DUPLICATE_MAP_RECEIPT",
      `${segmentId} receipt was already accepted by the coordinator`,
    );
  }
  const summary = await readAcceptedMap(stage, frozenFrame, { requireAccepted: false });
  const receipt = await readJson(stage.receiptPath, `${segmentId} MAP receipt`);
  stage.receiptAcceptedAt = new Date().toISOString();
  stage.acceptDurationMs = durationSince(startedAtMs);
  await writeManifest(manifest);

  let nextDispatch = null;
  if (
    stage.stage === "fragment_map" &&
    manifest.parentCoverageMode !== DETERMINISTIC_PARENT_COVERAGE_MODE
  ) {
    const aggregate = (manifest.turnAggregates || []).find((item) => (
      item.parentTurnId === stage.parentTurnId
    ));
    const preparedAggregate = await prepareTurnAggregate(manifest, aggregate, frozenFrame);
    nextDispatch = preparedAggregate?.dispatch || null;
  }
  return {
    accepted: true,
    receipt,
    coveredTurns: summary.turnCoverage?.length || 0,
    coveredFragments: summary.fragmentCoverage?.length || 0,
    acceptDurationMs: stage.acceptDurationMs,
    nextDispatch,
  };
}

function mapGenerationMetricDigest(dispatch, receiptDigest, observation) {
  return `sha256:${sha256Text(canonicalStringify({
    kind: MAP_GENERATION_METRIC_KIND,
    formatVersion: MAP_GENERATION_METRIC_FORMAT_VERSION,
    dispatch,
    receiptDigest,
    observation,
  }))}`;
}

function validateMapGenerationMetricState(state, stage) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new ExportHandoffError(
      "MAP_GENERATION_METRIC_INTEGRITY_MISMATCH",
      `${stage.segmentId} MAP generation metric state must be an object`,
    );
  }
  const keys = Object.keys(state);
  if (
    keys.length !== MAP_GENERATION_METRIC_STATE_FIELDS.length ||
    MAP_GENERATION_METRIC_STATE_FIELDS.some((field) => !keys.includes(field))
  ) {
    throw new ExportHandoffError(
      "MAP_GENERATION_METRIC_INTEGRITY_MISMATCH",
      `${stage.segmentId} MAP generation metric state has an invalid shape`,
    );
  }
  const observation = validateMapGenerationObservation(state.observation);
  if (
    observation.dispatchId !== stage.dispatch?.dispatchId ||
    observation.segmentId !== stage.segmentId
  ) {
    throw new ExportHandoffError(
      "MAP_GENERATION_METRIC_INTEGRITY_MISMATCH",
      `${stage.segmentId} MAP generation metric is not bound to its immutable dispatch`,
    );
  }
  if (
    !SHA256_DIGEST_PATTERN.test(state.receiptDigest) ||
    !SHA256_DIGEST_PATTERN.test(state.metricDigest)
  ) {
    throw new ExportHandoffError(
      "MAP_GENERATION_METRIC_INTEGRITY_MISMATCH",
      `${stage.segmentId} MAP generation metric digests are malformed`,
    );
  }
  const expectedMetricDigest = mapGenerationMetricDigest(
    stage.dispatch,
    state.receiptDigest,
    observation,
  );
  if (state.metricDigest !== expectedMetricDigest) {
    throw new ExportHandoffError(
      "MAP_GENERATION_METRIC_INTEGRITY_MISMATCH",
      `${stage.segmentId} MAP generation metric digest does not match its integrity state`,
    );
  }
  return {
    observation,
    receiptDigest: state.receiptDigest,
    metricDigest: state.metricDigest,
  };
}

function validateAcceptedReceiptMetadata(stage, receipt) {
  if (
    !stage.receiptAcceptedAt ||
    stage.workerStatus !== "validated" ||
    receipt.status !== "validated"
  ) {
    throw new ExportHandoffError(
      "MAP_RECEIPT_NOT_ACCEPTED",
      `${stage.segmentId} requires an accepted validated MapReceipt before provider timing can be recorded`,
    );
  }
  for (const field of [
    "summaryDigest",
    "normalizedSummaryDigest",
    "completedSummaryDigest",
    "rawMapOutputChars",
    "normalizedMapOutputChars",
    "completedMapOutputChars",
  ]) {
    if (Object.hasOwn(stage, field) && stage[field] !== receipt[field]) {
      throw new ExportHandoffError(
        "MAP_RECEIPT_INTEGRITY_MISMATCH",
        `${stage.segmentId} accepted receipt metadata changed at ${field}`,
      );
    }
  }
}

function validateObservationCorrelation(manifest, stage, observation) {
  if (
    observation.dispatchId !== stage.dispatch.dispatchId ||
    observation.segmentId !== stage.segmentId
  ) {
    throw new ExportHandoffError(
      "MAP_GENERATION_OBSERVATION_MISMATCH",
      "MapGenerationObservation dispatchId and segmentId must match the immutable MapDispatch",
    );
  }
  const stages = [
    ...(manifest.segments || []),
    ...(manifest.turnAggregates || []),
  ].filter((candidate) => candidate.dispatch);
  const { admissionsBySegment } = requireMapWaveAdmissions(manifest, stages);
  const admission = admissionsBySegment.get(stage.segmentId);
  if (!admission) {
    throw new ExportHandoffError(
      "MAP_GENERATION_OBSERVATION_MISMATCH",
      "MapGenerationObservation requires a durable MAP wave admission for its dispatch",
    );
  }
  if (
    observation.wave !== admission.wave ||
    observation.availableSlots !== admission.availableSlots
  ) {
    throw new ExportHandoffError(
      "MAP_GENERATION_OBSERVATION_MISMATCH",
      "MapGenerationObservation wave and availableSlots must match its durable MAP wave admission",
    );
  }
  let observationsInWave = 0;
  for (const candidate of stages) {
    if (!candidate.mapGenerationMetric || candidate === stage) continue;
    validateMapDispatch(candidate.dispatch, {
      segmentId: candidate.segmentId,
      ...(manifest.frameDigest ? { frameDigest: manifest.frameDigest } : {}),
      ...(candidate.contextDigest ? { contextDigest: candidate.contextDigest } : {}),
      ...(candidate.dictionaryDigest
        ? { dictionaryDigest: candidate.dictionaryDigest }
        : {}),
      mapResultMode: manifest.mapResultMode,
    });
    const existing = validateMapGenerationMetricState(
      candidate.mapGenerationMetric,
      candidate,
    ).observation;
    if (existing.providerObservationId === observation.providerObservationId) {
      throw new ExportHandoffError(
        "MAP_GENERATION_OBSERVATION_MISMATCH",
        `${observation.providerObservationId} is already bound to another MapDispatch`,
      );
    }
    if (
      existing.model !== observation.model ||
      existing.reasoningEffort !== observation.reasoningEffort
    ) {
      throw new ExportHandoffError(
        "MAP_GENERATION_OBSERVATION_MISMATCH",
        "Provider model and reasoning effort must correlate across one Compression Run",
      );
    }
    if (existing.wave === observation.wave) {
      observationsInWave += 1;
      if (existing.availableSlots !== observation.availableSlots) {
        throw new ExportHandoffError(
          "MAP_GENERATION_OBSERVATION_MISMATCH",
          "Provider observations in one wave must bind the same fresh availableSlots count",
        );
      }
    }
  }
  if (observationsInWave + 1 > observation.availableSlots) {
    throw new ExportHandoffError(
      "MAP_GENERATION_OBSERVATION_MISMATCH",
      "A provider-observation wave cannot contain more dispatches than its fresh availableSlots count",
    );
  }
}

export async function recordMapGenerationMetric(
  workDir,
  segmentId,
  dispatchId,
  observation,
) {
  const manifest = await loadMapGenerationMetricManifest(workDir);
  if (manifest.mapGenerationMetricMode !== MAP_GENERATION_METRIC_MODE) {
    throw new ExportHandoffError(
      "PROVIDER_TIMING_INGRESS_UNAVAILABLE",
      "This work directory predates the post-worker provider-observation binding and will not be retrofitted",
    );
  }
  const stage = findMapStage(manifest, segmentId);
  if (!stage) {
    throw new ExportHandoffError("UNKNOWN_SEGMENT", `Unknown segment: ${segmentId}`);
  }
  if (!stage.dispatch) {
    throw new ExportHandoffError("MAP_DISPATCH_MISSING", `${segmentId} has no MAP dispatch`);
  }
  assertInsideWorkDir(manifest.workDir, stage.receiptPath, "Accepted MAP receipt path");
  validateMapDispatch(stage.dispatch, {
    dispatchId,
    segmentId,
    ...(manifest.frameDigest ? { frameDigest: manifest.frameDigest } : {}),
    ...(stage.contextDigest ? { contextDigest: stage.contextDigest } : {}),
    ...(stage.dictionaryDigest ? { dictionaryDigest: stage.dictionaryDigest } : {}),
    mapResultMode: manifest.mapResultMode,
  });
  const validatedObservation = validateMapGenerationObservation(observation);
  validateObservationCorrelation(manifest, stage, validatedObservation);
  if (!stage.receiptAcceptedAt || stage.workerStatus !== "validated") {
    throw new ExportHandoffError(
      "MAP_RECEIPT_NOT_ACCEPTED",
      `${segmentId} requires an accepted validated MapReceipt before provider timing can be recorded`,
    );
  }

  const receiptDocument = await readJsonDocument(
    stage.receiptPath,
    `${segmentId} accepted MAP receipt`,
  );
  validateMapReceipt(receiptDocument.value, stage.dispatch);
  validateAcceptedReceiptMetadata(stage, receiptDocument.value);
  const receiptDigest = `sha256:${sha256Text(receiptDocument.text)}`;
  const metricDigest = mapGenerationMetricDigest(
    stage.dispatch,
    receiptDigest,
    validatedObservation,
  );
  if (stage.mapGenerationMetric) {
    const existing = validateMapGenerationMetricState(
      stage.mapGenerationMetric,
      stage,
    );
    if (existing.receiptDigest !== receiptDigest) {
      throw new ExportHandoffError(
        "MAP_RECEIPT_INTEGRITY_MISMATCH",
        `${segmentId} accepted MapReceipt changed after its provider metric was recorded`,
      );
    }
    if (existing.metricDigest !== metricDigest) {
      throw new ExportHandoffError(
        "MAP_GENERATION_METRIC_CONFLICT",
        `${segmentId} already has a different provider observation`,
      );
    }
    return { recorded: true, metricDigest };
  }

  stage.mapGenerationMetric = {
    observation: validatedObservation,
    receiptDigest,
    metricDigest,
  };
  await writeManifest(manifest);
  return { recorded: true, metricDigest };
}

function incompleteFirstWaveMetrics(message, details = {}) {
  throw new ExportHandoffError(
    "INCOMPLETE_FIRST_WAVE_METRICS",
    message,
    details,
  );
}

function requireStageDuration(stage, field) {
  const value = stage[field];
  if (!Number.isFinite(value) || value < 0) {
    incompleteFirstWaveMetrics(
      `${stage.segmentId} requires a non-negative ${field} observation`,
      { segmentId: stage.segmentId, field },
    );
  }
  return value;
}

async function validatedAcceptedStageMetric(stage) {
  let metric;
  try {
    metric = validateMapGenerationMetricState(
      stage.mapGenerationMetric,
      stage,
    );
  } catch (error) {
    incompleteFirstWaveMetrics(
      `${stage.segmentId} has a broken or non-correlated provider observation`,
      {
        segmentId: stage.segmentId,
        causeCode: error.code || "ERROR",
      },
    );
  }
  const receiptDocument = await readJsonDocument(
    stage.receiptPath,
    `${stage.segmentId} accepted MAP receipt`,
  );
  validateMapReceipt(receiptDocument.value, stage.dispatch);
  validateAcceptedReceiptMetadata(stage, receiptDocument.value);
  const receiptDigest = `sha256:${sha256Text(receiptDocument.text)}`;
  if (metric.receiptDigest !== receiptDigest) {
    throw new ExportHandoffError(
      "MAP_RECEIPT_INTEGRITY_MISMATCH",
      `${stage.segmentId} accepted MapReceipt changed after its provider metric was recorded`,
    );
  }
  return {
    stage,
    observation: metric.observation,
    metricDigest: metric.metricDigest,
    checkAcceptMs: requireStageDuration(stage, "checkDurationMs")
      + requireStageDuration(stage, "completeDurationMs")
      + requireStageDuration(stage, "acceptDurationMs"),
  };
}

function validateAcceptedWaveGroups(stageMetrics, totalDispatches) {
  const providerObservationIds = new Set();
  const dispatchIds = new Set();
  const waves = new Map();
  let expectedModel = null;
  let expectedReasoningEffort = null;

  for (const sample of stageMetrics) {
    const { observation } = sample;
    if (
      providerObservationIds.has(observation.providerObservationId) ||
      dispatchIds.has(observation.dispatchId)
    ) {
      incompleteFirstWaveMetrics(
        "Every accepted MAP dispatch must contribute exactly one unique provider observation",
        {
          providerObservationId: observation.providerObservationId,
          dispatchId: observation.dispatchId,
        },
      );
    }
    providerObservationIds.add(observation.providerObservationId);
    dispatchIds.add(observation.dispatchId);
    if (expectedModel === null) {
      expectedModel = observation.model;
      expectedReasoningEffort = observation.reasoningEffort;
    } else if (
      observation.model !== expectedModel ||
      observation.reasoningEffort !== expectedReasoningEffort
    ) {
      incompleteFirstWaveMetrics(
        "Accepted MAP observations must use one correlated model and reasoning effort",
      );
    }
    const group = waves.get(observation.wave) || {
      wave: observation.wave,
      availableSlots: observation.availableSlots,
      samples: [],
    };
    if (group.availableSlots !== observation.availableSlots) {
      incompleteFirstWaveMetrics(
        `Wave ${observation.wave} observations do not share one fresh slot count`,
        { wave: observation.wave },
      );
    }
    group.samples.push(sample);
    waves.set(observation.wave, group);
  }

  const orderedWaves = [...waves.values()].sort((left, right) => (
    left.wave - right.wave
  ));
  if (
    orderedWaves.length === 0 ||
    orderedWaves.some((group, index) => group.wave !== index + 1)
  ) {
    incompleteFirstWaveMetrics(
      "Accepted MAP observations must form contiguous waves beginning at wave 1",
    );
  }
  let completedDispatches = 0;
  for (const group of orderedWaves) {
    const expectedDispatches = Math.min(
      totalDispatches - completedDispatches,
      group.availableSlots,
    );
    if (group.samples.length !== expectedDispatches) {
      incompleteFirstWaveMetrics(
        `Wave ${group.wave} has ${group.samples.length} observations; expected ${expectedDispatches}`,
        {
          wave: group.wave,
          observedDispatches: group.samples.length,
          expectedDispatches,
          availableSlots: group.availableSlots,
        },
      );
    }
    completedDispatches += group.samples.length;
  }
  return orderedWaves;
}

function requireWorkflowDeadline(manifest) {
  const createdAtMs = Date.parse(manifest.createdAt || "");
  const deadlineAtMs = Date.parse(manifest.workflowDeadlineAt || "");
  if (
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(deadlineAtMs) ||
    deadlineAtMs !== createdAtMs + LIVE_ACCEPTANCE_TARGET_MS ||
    new Date(deadlineAtMs).toISOString() !== manifest.workflowDeadlineAt
  ) {
    throw new ExportHandoffError(
      "INVALID_WORKFLOW_DEADLINE",
      `Workflow deadline must be the canonical createdAt + ${LIVE_ACCEPTANCE_TARGET_MS} ms boundary`,
    );
  }
  return { deadlineAt: manifest.workflowDeadlineAt, deadlineAtMs };
}

function requireMapWaveAdmissions(manifest, stages) {
  if (!Array.isArray(manifest.mapWaveAdmissions)) {
    throw new ExportHandoffError(
      "INVALID_MAP_WAVE_STATE",
      "MAP wave admissions must be a durable ordered array",
    );
  }
  const stagesById = new Map(stages.map((stage) => [stage.segmentId, stage]));
  const admitted = new Set();
  const admissionsBySegment = new Map();
  let nextStageIndex = 0;
  for (const [index, admission] of manifest.mapWaveAdmissions.entries()) {
    const expectedKeys = ["wave", "availableSlots", "admittedAt", "segmentIds"];
    const expectedDispatches = Math.min(
      stages.length - nextStageIndex,
      admission?.availableSlots || 0,
    );
    const expectedSegmentIds = stages
      .slice(nextStageIndex, nextStageIndex + expectedDispatches)
      .map((stage) => stage.segmentId);
    if (
      !admission ||
      typeof admission !== "object" ||
      Array.isArray(admission) ||
      Object.keys(admission).length !== expectedKeys.length ||
      expectedKeys.some((key) => !Object.hasOwn(admission, key)) ||
      admission.wave !== index + 1 ||
      !Number.isInteger(admission.availableSlots) ||
      admission.availableSlots < 1 ||
      !Number.isFinite(Date.parse(admission.admittedAt || "")) ||
      new Date(Date.parse(admission.admittedAt)).toISOString() !== admission.admittedAt ||
      !Array.isArray(admission.segmentIds) ||
      admission.segmentIds.length !== expectedDispatches ||
      new Set(admission.segmentIds).size !== admission.segmentIds.length
    ) {
      throw new ExportHandoffError(
        "INVALID_MAP_WAVE_STATE",
        `MAP wave admission ${index + 1} is invalid`,
      );
    }
    for (let segmentIndex = 0; segmentIndex < admission.segmentIds.length; segmentIndex += 1) {
      const segmentId = admission.segmentIds[segmentIndex];
      if (
        !stagesById.has(segmentId) ||
        admitted.has(segmentId) ||
        segmentId !== expectedSegmentIds[segmentIndex]
      ) {
        throw new ExportHandoffError(
          "INVALID_MAP_WAVE_STATE",
          `MAP wave admission ${admission.wave} does not contain the next ordered pending segments`,
        );
      }
      admitted.add(segmentId);
      admissionsBySegment.set(segmentId, admission);
    }
    nextStageIndex += admission.segmentIds.length;
  }
  return { admitted, admissionsBySegment, stagesById };
}

function currentUnacceptedMapAdmission(manifest, stagesById) {
  const unacceptedAdmissions = manifest.mapWaveAdmissions.filter((admission) => (
    admission.segmentIds.some(
      (segmentId) => !stagesById.get(segmentId)?.receiptAcceptedAt,
    )
  ));
  if (unacceptedAdmissions.length > 1) {
    throw new ExportHandoffError(
      "INVALID_MAP_WAVE_STATE",
      "Only one durable MAP wave admission may await receipt acceptance",
      { waves: unacceptedAdmissions.map((admission) => admission.wave) },
    );
  }
  return unacceptedAdmissions[0] || null;
}

function validateAcceptedProviderWaveGroups(stageMetrics, admissions, totalDispatches) {
  const waveGroups = validateAcceptedWaveGroups(stageMetrics, totalDispatches);
  if (waveGroups.length !== admissions.length) {
    incompleteFirstWaveMetrics(
      "Provider observations must cover every accepted MAP wave before projection",
    );
  }
  for (let index = 0; index < admissions.length; index += 1) {
    const admission = admissions[index];
    const group = waveGroups[index];
    if (
      group.wave !== admission.wave ||
      group.availableSlots !== admission.availableSlots ||
      group.samples.length !== admission.segmentIds.length ||
      group.samples.some(
        (sample, sampleIndex) => sample.stage.segmentId !== admission.segmentIds[sampleIndex],
      )
    ) {
      incompleteFirstWaveMetrics(
        `Provider observations do not match durable MAP wave admission ${admission.wave}`,
      );
    }
  }
  return waveGroups;
}

async function collectMapWaveSchedulingInput(manifest) {
  const stages = [
    ...(manifest.segments || []),
    ...(manifest.turnAggregates || []),
  ].filter((stage) => stage.dispatch);
  if (stages.length === 0) {
    throw new ExportHandoffError(
      "MAP_DISPATCH_MISSING",
      "MAP wave scheduling requires at least one MapDispatch",
    );
  }
  const acceptedStages = stages.filter((stage) => stage.receiptAcceptedAt);
  const exhausted = stages.find((stage) => stage.workerStatus === "exhausted");
  if (exhausted) {
    throw new ExportHandoffError(
      "MAP_WORKER_EXHAUSTED",
      `${exhausted.segmentId} exhausted both MAP Worker attempts`,
      { diagnosticsDir: exhausted.diagnosticsDir },
    );
  }
  const admissions = manifest.mapWaveAdmissions;
  const { admitted, stagesById } = requireMapWaveAdmissions(manifest, stages);
  const unadmittedAccepted = acceptedStages.filter(
    (stage) => !admitted.has(stage.segmentId),
  );
  if (unadmittedAccepted.length > 0) {
    throw new ExportHandoffError(
      "INVALID_MAP_WAVE_STATE",
      "Accepted MAP dispatches must belong to a durable wave admission",
      { segmentIds: unadmittedAccepted.map((stage) => stage.segmentId) },
    );
  }
  const activeAdmission = currentUnacceptedMapAdmission(manifest, stagesById);
  const activeStages = activeAdmission
    ? activeAdmission.segmentIds.map((segmentId) => (
      stages.find((stage) => stage.segmentId === segmentId)
    ))
    : [];
  const awaitingAcceptance = activeStages.filter((stage) => !stage.receiptAcceptedAt);
  if (awaitingAcceptance.length > 0) {
    return {
      complete: false,
      awaitingAcceptance: true,
      wave: activeAdmission.wave,
      acceptedDispatches: acceptedStages.length,
      pendingDispatches: stages
        .filter((stage) => !stage.receiptAcceptedAt && !admitted.has(stage.segmentId))
        .map((stage) => stage.dispatch),
      activeDispatches: awaitingAcceptance.map((stage) => stage.dispatch),
    };
  }
  const pendingStages = stages.filter((stage) => (
    !stage.receiptAcceptedAt && !admitted.has(stage.segmentId) && stage.workerStatus === "pending"
  ));
  const nonSchedulable = stages.filter((stage) => (
    !stage.receiptAcceptedAt && !admitted.has(stage.segmentId) && stage.workerStatus !== "pending"
  ));
  if (nonSchedulable.length > 0) {
    incompleteFirstWaveMetrics(
      "Every unfinished MAP dispatch must remain pending before a later wave is scheduled",
      { segmentIds: nonSchedulable.map((stage) => stage.segmentId) },
    );
  }
  const metricStages = acceptedStages.filter((stage) => stage.mapGenerationMetric);
  let waveGroups = null;
  if (metricStages.length > 0) {
    if (metricStages.length !== acceptedStages.length) {
      incompleteFirstWaveMetrics(
        "Provider timing is optional, but a partial accepted-wave observation set is invalid",
        {
          missingDispatchIds: acceptedStages
            .filter((stage) => !stage.mapGenerationMetric)
            .map((stage) => stage.dispatch.dispatchId),
        },
      );
    }
    const stageMetrics = [];
    for (const stage of acceptedStages) {
      stageMetrics.push(await validatedAcceptedStageMetric(stage));
    }
    waveGroups = validateAcceptedProviderWaveGroups(
      stageMetrics,
      admissions,
      stages.length,
    );
  }
  if (pendingStages.length === 0 && acceptedStages.length === stages.length) {
    return {
      complete: true,
      totalDispatches: stages.length,
      acceptedDispatches: acceptedStages.length,
      pendingDispatches: [],
    };
  }
  let firstWave = null;
  if (waveGroups) {
    const firstWaveGroup = waveGroups[0];
    const prepareAndFrameMs = elapsedMs(
      manifest.createdAt,
      manifest.frameValidatedAt,
    );
    if (prepareAndFrameMs === null) {
      incompleteFirstWaveMetrics(
        "Performance projection requires valid prepare/frame phase boundaries",
      );
    }
    firstWave = {
      totalDispatches: stages.length,
      completedDispatches: firstWaveGroup.samples.length,
      prepareAndFrameMs,
      mapGenerationSamples: firstWaveGroup.samples.map(
        (sample) => sample.observation.providerLatencyMs,
      ),
      checkAcceptSamples: firstWaveGroup.samples.map(
        (sample) => sample.checkAcceptMs,
      ),
      reduceMs: PRE_DISPATCH_REDUCE_RESERVE_MS,
      publicationMs: PRE_DISPATCH_PUBLICATION_RESERVE_MS,
    };
  }
  return {
    complete: false,
    awaitingAcceptance: false,
    nextWave: admissions.length + 1,
    pendingDispatches: pendingStages.map((stage) => stage.dispatch),
    firstWave,
  };
}

async function scheduleNextMapWaveInternal(workDir, availableSlots) {
  const manifest = await loadManifest(workDir);
  const input = await collectMapWaveSchedulingInput(manifest);
  if (input.complete) {
    return {
      status: "complete",
      availableSlots,
      dispatches: [],
      totalDispatches: input.totalDispatches,
      acceptedDispatches: input.acceptedDispatches,
    };
  }
  if (input.awaitingAcceptance) {
    return {
      status: "awaiting-acceptance",
      availableSlots,
      wave: input.wave,
      dispatches: [],
      activeDispatches: input.activeDispatches,
      pendingDispatches: input.pendingDispatches.length,
      acceptedDispatches: input.acceptedDispatches,
    };
  }
  const deadline = requireWorkflowDeadline(manifest);
  const observedAt = new Date().toISOString();
  if (Date.parse(observedAt) >= deadline.deadlineAtMs) {
    throw new ExportHandoffError(
      "WORKFLOW_DEADLINE_EXCEEDED",
      `Workflow deadline ${deadline.deadlineAt} does not permit another MAP wave`,
      {
        wave: input.nextWave,
        availableSlots,
        deadlineAt: deadline.deadlineAt,
        observedAt,
      },
    );
  }
  const schedulable = input.pendingDispatches.slice(
    0,
    Number.isInteger(availableSlots) && availableSlots > 0
      ? availableSlots
      : input.pendingDispatches.length,
  );
  const scheduled = scheduleMapDispatches(
    schedulable,
    availableSlots,
    input.firstWave ? { firstWave: input.firstWave } : {},
  );
  if (scheduled.status !== "ready") {
    throw new ExportHandoffError(
      scheduled.diagnosticCode,
      "No fresh dedicated MAP Worker slot is available for the next wave",
      {
        wave: input.nextWave,
        availableSlots,
      },
    );
  }
  manifest.mapWaveAdmissions.push({
    wave: input.nextWave,
    availableSlots,
    admittedAt: observedAt,
    segmentIds: scheduled.dispatches.map((dispatch) => dispatch.segmentId),
  });
  await writeManifest(manifest);
  return {
    ...scheduled,
    wave: input.nextWave,
  };
}

export async function scheduleNextMapWave(workDir, availableSlots) {
  return withCapturedWorkflowDiagnostic(
    workDir,
    "schedule-map",
    () => scheduleNextMapWaveInternal(workDir, availableSlots),
  );
}

export async function validateMapStage(workDir, segmentId) {
  const manifest = await loadManifest(workDir);
  const stage = findMapStage(manifest, segmentId);
  if (!stage) {
    throw new ExportHandoffError("UNKNOWN_SEGMENT", `Unknown segment: ${segmentId}`);
  }
  if (!stage.dispatch) {
    if ((manifest.turnAggregates || []).includes(stage) && !stage.ready) {
      const frozenFrame = await loadFrozenFrame(manifest);
      const prepared = await prepareTurnAggregate(manifest, stage, frozenFrame);
      if (!prepared) {
        throw new ExportHandoffError(
          "INCOMPLETE_FRAGMENT_COVERAGE",
          `${segmentId} is not ready because one or more child fragments are unvalidated`,
        );
      }
    } else {
      throw new ExportHandoffError("MAP_DISPATCH_MISSING", `${segmentId} has no MAP dispatch`);
    }
  }
  let refreshed = await loadManifest(workDir);
  let current = findMapStage(refreshed, segmentId);
  let claimPath = dispatchClaimPath(refreshed, current.dispatch.dispatchId);
  if (!(await pathExists(claimPath))) {
    await scheduleNextMapWaveInternal(workDir, 1);
    refreshed = await loadManifest(workDir);
    current = findMapStage(refreshed, segmentId);
    claimPath = dispatchClaimPath(refreshed, current.dispatch.dispatchId);
    await claimMapDispatch(
      workDir,
      segmentId,
      current.dispatch.dispatchId,
      "direct-map-validator",
    );
  }
  const receipt = await completeMapDispatch(workDir, segmentId, current.dispatch.dispatchId);
  const accepted = await acceptMapReceipt(
    workDir,
    segmentId,
    current.dispatch.dispatchId,
  );
  return {
    valid: true,
    segmentId,
    summaryPath: current.summaryPath,
    coveredTurns: accepted.coveredTurns,
    coveredFragments: accepted.coveredFragments,
    receipt,
    nextStage: accepted.nextDispatch,
  };
}

async function prepareReduceStageInternal(workDir) {
  const startedAtMs = Date.now();
  const manifest = await loadManifest(workDir);
  const frozenFrame = await loadFrozenFrame(manifest);
  const evidencePack = await readJson(manifest.paths.evidencePack, "Evidence Pack");
  const evidenceIndex = validateEvidenceIndex(
    await readJson(manifest.paths.evidenceIndex, "Evidence Index"),
  );
  let reduceInput;
  if (isContinuationMapResultMode(manifest.mapResultMode)) {
    const continuationData = await collectContinuationReduceData(
      manifest,
      frozenFrame,
      evidenceIndex,
    );
    const continuationDownstream = manifest.mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE
      ? buildActionReadyContinuationDownstream(
        continuationData.completedMaps,
        manifest.expectedTurnIds,
        evidenceIndex,
        evidenceIndex.preservationLedger,
        evidencePack.progressEvidence,
        continuationAuthorityClaims(frozenFrame.frame),
      )
      : buildContinuationDownstream(
        continuationData.completedMaps,
        manifest.expectedTurnIds,
        evidenceIndex,
        evidenceIndex.preservationLedger,
        continuationAuthorityClaims(frozenFrame.frame),
      );
    const deterministicProjections = buildContinuationReduceProjections(
      continuationDownstream.claimTable,
      evidenceIndex.preservationLedger,
      continuationAuthorityClaims(frozenFrame.frame),
    );
    const frame = frozenFrame.frame;
    reduceInput = {
      compressionFrame: {
        frameId: frame.frameId,
        currentGoal: structuredClone(frame.currentGoal),
        ...(frame.formatVersion === TERMINAL_AUTHORITY_FRAME_VERSION ? {
          acceptedProposalClaimId: frame.acceptedProposal?.claimId || null,
          terminalStateClaimId: frame.terminalStateClaim.claimId,
        } : {}),
        taskType: frame.taskType,
        taskPhase: frame.taskPhase,
        explicitExclusions: structuredClone(frame.explicitExclusions),
      },
      frameDigest: frozenFrame.frameDigest,
      source: evidencePack.source,
      workspace: evidencePack.workspace,
      claimTable: continuationDownstream.claimTable,
      segmentSummaries: continuationData.segmentSummaries,
      criticalObligations: {
        continuationCoverage: continuationDownstream.continuationCoverage,
        exactIdentifiers: structuredClone(
          evidenceIndex.preservationLedger.exactIdentifiers,
        ),
      },
      deterministicProjectionPolicy: {
        importantLocations: {
          claimKind: "important_location",
          locationSource: "Claim.text",
          purpose: "Retained by continuation MAP.",
        },
        preservationCategories: [
          ...evidenceIndex.preservationLedger.criticalCategories,
        ],
        finalProvenance: deterministicProjections.finalProvenancePolicy,
        ...(deterministicProjections.continuationAuthorities ? {
          continuationAuthorities: {
            acceptedProposalClaimId:
              deterministicProjections.continuationAuthorities.acceptedProposal?.claimId || null,
            terminalStateClaimId:
              deterministicProjections.continuationAuthorities.terminalState.claimId,
          },
        } : {}),
      },
      ...(manifest.mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE ? {
        workingSynthesisInput: continuationDownstream.workingSynthesisInput,
        actionReadyOutputContract: structuredClone(ACTION_READY_OUTPUT_CONTRACT),
      } : {}),
      targetMaxChars: reduceTargetMaxChars(manifest.maxChars),
    };
  } else {
    const segmentSummaries = await collectReduceStageSummaries(manifest, frozenFrame);
    const semanticCoverage = buildSemanticCoverageGraph(
      segmentSummaries,
      manifest.expectedTurnIds,
    );
    reduceInput = {
      compressionFrame: frozenFrame.frame,
      frameDigest: frozenFrame.frameDigest,
      source: evidencePack.source,
      workspace: evidencePack.workspace,
      preservationLedger: evidenceIndex.preservationLedger,
      semanticCoverage,
      segmentSummaries,
      expectedTurnIds: manifest.expectedTurnIds,
      targetMaxChars: reduceTargetMaxChars(manifest.maxChars),
    };
  }
  const outputMetrics = validateAggregateMapOutputMetrics(manifest);
  const reduceInputChars = `${JSON.stringify(reduceInput, null, 2)}\n`.length;
  if (
    isContinuationMapResultMode(manifest.mapResultMode) &&
    reduceInputChars > MAX_CONTINUATION_REDUCE_INPUT_CHARS
  ) {
    throw new ExportHandoffError(
      "REDUCE_INPUT_TOO_LARGE",
      `Continuation REDUCE input is ${reduceInputChars} characters; limit is ${MAX_CONTINUATION_REDUCE_INPUT_CHARS}`,
      {
        reduceInputChars,
        maxReduceInputChars: MAX_CONTINUATION_REDUCE_INPUT_CHARS,
        reduceInputPath: manifest.paths.reduceInput,
      },
    );
  }
  await writeJson(manifest.paths.reduceInput, reduceInput);
  manifest.reducePreparedAt ??= new Date().toISOString();
  manifest.reducePrepareDurationMs = durationSince(startedAtMs);
  delete manifest.checkedReducedDigest;
  delete manifest.reduceCheckedAt;
  delete manifest.checkedFinalProvenance;
  await writeManifest(manifest);
  return {
    ready: true,
    reduceInputPath: manifest.paths.reduceInput,
    reducedPath: manifest.paths.reduced,
    segments: manifest.segments.length,
    expectedTurnIds: manifest.expectedTurnIds,
    targetMaxChars: reduceInput.targetMaxChars,
    frameId: frozenFrame.frameId,
    frameDigest: frozenFrame.frameDigest,
    mapResultMode: manifest.mapResultMode,
    parentCoverageMode: manifest.parentCoverageMode || "aggregate-worker-v1",
    maxFrameProjectionChars: manifest.maxFrameProjectionChars || null,
    maxMapInputChars: manifest.maxMapInputChars || null,
    maxObservedFrameProjectionChars: Math.max(
      0,
      ...manifest.segments.map((segment) => segment.contextChars || 0),
    ),
    maxObservedMapInputChars: Math.max(
      0,
      ...manifest.segments.map((segment) => segment.mapInputChars || 0),
    ),
    maxAggregateMapOutputChars: manifest.maxAggregateMapOutputChars || null,
    reduceInputChars,
    maxReduceInputChars: isContinuationMapResultMode(manifest.mapResultMode)
      ? MAX_CONTINUATION_REDUCE_INPUT_CHARS
      : null,
    reducePrepareDurationMs: manifest.reducePrepareDurationMs,
    ...outputMetrics,
  };
}

export async function prepareReduceStage(workDir) {
  return withCapturedWorkflowDiagnostic(
    workDir,
    "prepare-reduce",
    () => prepareReduceStageInternal(workDir),
  );
}

async function continuationReduceValidationContext(
  manifest,
  frozenFrame,
  evidenceIndex,
) {
  if (!isContinuationMapResultMode(manifest.mapResultMode)) return {};
  const continuationData = await collectContinuationReduceData(
    manifest,
    frozenFrame,
    evidenceIndex,
  );
  const downstream = manifest.mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE
    ? buildActionReadyContinuationDownstream(
      continuationData.completedMaps,
      manifest.expectedTurnIds,
      evidenceIndex,
      evidenceIndex.preservationLedger,
      (await readJson(manifest.paths.evidencePack, "Evidence Pack")).progressEvidence,
      continuationAuthorityClaims(frozenFrame.frame),
    )
    : buildContinuationDownstream(
      continuationData.completedMaps,
      manifest.expectedTurnIds,
      evidenceIndex,
      evidenceIndex.preservationLedger,
      continuationAuthorityClaims(frozenFrame.frame),
    );
  return {
    deterministicProjections: buildContinuationReduceProjections(
      downstream.claimTable,
      evidenceIndex.preservationLedger,
      continuationAuthorityClaims(frozenFrame.frame),
    ),
    requireDerivedProvenance: true,
    ...(manifest.mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE
      ? {
        workingSynthesisInput: downstream.workingSynthesisInput,
        actionReadyGateContext: {
          taskType: frozenFrame.frame.taskType,
          currentGoal: structuredClone(frozenFrame.frame.currentGoal),
          explicitExclusions: structuredClone(frozenFrame.frame.explicitExclusions),
          claimTable: downstream.claimTable,
          workingSynthesisInput: downstream.workingSynthesisInput,
          evidenceIndex,
        },
      }
      : {}),
  };
}

async function checkReduceStageInternal(workDir, calibration = undefined) {
  const startedAtMs = Date.now();
  const manifest = await loadManifest(workDir);
  if (!manifest.reducePreparedAt) {
    throw new ExportHandoffError(
      "REDUCE_NOT_PREPARED",
      "Run prepare-reduce before validate-reduce --check",
    );
  }
  if (calibration !== undefined) {
    manifest.reduceCalibration = validateReduceGenerationMetric(calibration);
    await writeManifest(manifest);
  }
  const frozenFrame = await loadFrozenFrame(manifest);
  const evidenceIndex = validateEvidenceIndex(
    await readJson(manifest.paths.evidenceIndex, "Evidence Index"),
  );
  const reducedDocument = await readJsonDocument(
    manifest.paths.reduced,
    "REDUCE result",
  );
  const validationContext = await continuationReduceValidationContext(
    manifest,
    frozenFrame,
    evidenceIndex,
  );
  validateReduceResult(
    reducedDocument.value,
    manifest.expectedTurnIds,
    frozenFrame,
    {
      evidenceIndex,
      preservationLedger: evidenceIndex.preservationLedger,
      ...validationContext,
    },
  );
  validateEvidenceReferences(reducedDocument.value, evidenceIndex);
  const finalProvenance = deriveFinalProvenance(
    reducedDocument.value,
    manifest.expectedTurnIds,
    evidenceIndex,
    frozenFrame,
  );
  const reducedDigest = `sha256:${sha256Text(reducedDocument.text)}`;
  manifest.checkedReducedDigest = reducedDigest;
  manifest.reduceCheckedAt = new Date().toISOString();
  manifest.checkedFinalProvenance = finalProvenance;
  manifest.reduceCheckDurationMs = durationSince(startedAtMs);
  await writeManifest(manifest);
  return {
    valid: true,
    reducedPath: manifest.paths.reduced,
    reducedDigest,
    finalProvenance,
    reduceCheckDurationMs: manifest.reduceCheckDurationMs,
    ...(manifest.reduceCalibration
      ? { calibration: manifest.reduceCalibration }
      : {}),
  };
}

export async function checkReduceStage(workDir, calibration = undefined) {
  return withCapturedWorkflowDiagnostic(
    workDir,
    "validate-reduce",
    () => checkReduceStageInternal(workDir, calibration),
  );
}

function filteredPreservationLedger(index, retainedAnchorIds, sourceRevision) {
  const retained = new Set(retainedAnchorIds);
  const complete = retained.size === index.anchors.length;
  return {
    sourceRevision,
    requiredAnchors: index.preservationLedger.requiredAnchors.filter(
      (anchorId) => retained.has(anchorId),
    ),
    exactIdentifiers: index.preservationLedger.exactIdentifiers.filter(
      (identifier) => (
        identifier.anchors.length > 0 &&
        identifier.anchors.every((anchorId) => retained.has(anchorId))
      ),
    ),
    criticalCategories: complete
      ? [...index.preservationLedger.criticalCategories]
      : [],
  };
}

function buildDegradedEvidenceSubset(index, entries, source, workspace) {
  const retainedAnchorIds = entries.map((entry) => entry.anchor.anchorId);
  return buildEvidenceIndex({
    sessionId: index.sessionId,
    source,
    workspace,
    entries,
    preservationLedger: filteredPreservationLedger(
      index,
      retainedAnchorIds,
      source.sourceRevision,
    ),
  });
}

async function tryVerifiedEvidenceCandidate(candidate, scope) {
  try {
    await verifyEvidenceIndex(candidate);
    return { index: candidate, scope };
  } catch {
    return null;
  }
}

async function selectDegradedEvidenceIndex(index) {
  try {
    await verifyEvidenceIndex(index);
    return {
      index,
      scope: "complete",
      verificationFailureCode: null,
    };
  } catch (error) {
    const candidates = [];
    const sourceEntries = index.anchors.filter(
      (entry) => entry.anchor.sourceKind === "source_thread",
    );
    const workspaceEntries = index.anchors.filter(
      (entry) => entry.anchor.sourceKind === "workspace",
    );

    if (sourceEntries.length > 0) {
      const sourceOnly = buildDegradedEvidenceSubset(
        index,
        sourceEntries,
        index.source,
        index.workspace,
      );
      const verified = await tryVerifiedEvidenceCandidate(sourceOnly, "verified subset: source");
      if (verified) candidates.push(verified);
    }

    let currentSource = null;
    try {
      currentSource = await hashFileRevision(index.source.rolloutPath);
    } catch {
      // A published Evidence Index must remain independently verifiable.
    }
    if (currentSource) {
      const currentSourceMetadata = {
        rolloutPath: index.source.rolloutPath,
        sourceRevision: currentSource.sourceRevision,
        sourceBytes: currentSource.sourceBytes,
      };
      if (workspaceEntries.length > 0) {
        const workspaceOnly = buildDegradedEvidenceSubset(
          index,
          workspaceEntries,
          currentSourceMetadata,
          index.workspace,
        );
        const verified = await tryVerifiedEvidenceCandidate(
          workspaceOnly,
          "verified subset: workspace",
        );
        if (verified) candidates.push(verified);
      }
      const empty = buildDegradedEvidenceSubset(
        index,
        [],
        currentSourceMetadata,
        { cwd: index.workspace.cwd, sourceRevision: null },
      );
      const verifiedEmpty = await tryVerifiedEvidenceCandidate(
        empty,
        "verified subset: adjudication only",
      );
      if (verifiedEmpty) candidates.push(verifiedEmpty);
    }

    candidates.sort((left, right) => (
      right.index.anchors.length - left.index.anchors.length ||
      left.scope.localeCompare(right.scope, "en")
    ));
    const selected = candidates[0];
    if (!selected) {
      throw new ExportHandoffError(
        "DEGRADED_EVIDENCE_UNAVAILABLE",
        "No independently verifiable Evidence Index subset is available",
        { verificationFailureCode: error.code || "ERROR" },
      );
    }
    return {
      ...selected,
      verificationFailureCode: error.code || "ERROR",
    };
  }
}

function allAnchorsRetained(anchors, retainedAnchorIds) {
  return (
    Array.isArray(anchors) &&
    anchors.length > 0 &&
    anchors.every((anchorId) => retainedAnchorIds.has(anchorId))
  );
}

async function degradedCurrentGoal(
  evidencePack,
  publishedIndex,
  retainedAnchorIds,
) {
  const current = evidencePack?.sourceContinuation?.currentGoal ||
    (evidencePack?.turns || [])
      .flatMap((turn) => turn.userMessages || [])
      .at(-1) ||
    null;
  if (
    typeof current?.text === "string" &&
    current.text.length > 0 &&
    allAnchorsRetained(current.anchors, retainedAnchorIds)
  ) {
    for (const anchorId of current.anchors) {
      try {
        const retrieved = await retrieveEvidence(publishedIndex, anchorId);
        if (retrieved.content === current.text) {
          return {
            status: "verified",
            text: retrieved.content,
            anchors: [...current.anchors],
          };
        }
      } catch {
        // The full Anchor set and exact text must both verify before publication.
      }
    }
  }
  return {
    status: "unavailable",
    reason: "the current goal or one of its supporting Evidence Anchors did not verify",
  };
}

function degradedTerminalState(evidencePack, retainedAnchorIds) {
  const terminalClaim = evidencePack?.terminalStateClaim;
  if (
    typeof terminalClaim?.text === "string" &&
    terminalClaim.text.length > 0 &&
    allAnchorsRetained(terminalClaim.anchors, retainedAnchorIds)
  ) {
    return {
      status: "verified",
      text: terminalClaim.text,
      anchors: [...terminalClaim.anchors],
    };
  }
  return {
    status: "unavailable",
    reason: "the deterministic Terminal-State Claim did not retain a complete verified Anchor set",
  };
}

function degradedDiagnosticChain(state) {
  const byId = new Map(state.requests.map((entry) => [entry.requestId, entry]));
  const diagnostics = [];
  let current = state.activeRequest;
  while (current) {
    diagnostics.push({
      requestId: current.requestId,
      phase: current.request.phase,
      failureOwner: current.request.failureOwner,
      code: current.request.diagnostic.code,
      message: current.request.diagnostic.message,
      ...(current.application?.status === "APPLICATION_FAILED" ? {
        applicationFailure: structuredClone(current.application.diagnostic),
      } : {}),
    });
    current = current.request.predecessor
      ? byId.get(current.request.predecessor.requestId) || null
      : null;
  }
  return diagnostics;
}

async function collectDegradedAcceptedWork(
  manifest,
  frozenFrame,
  retainedAnchorIds,
  acceptedMaps,
) {
  const acceptedWork = {
    acceptedMaps,
    verifiedMaps: 0,
    stages: [],
    omittedClaims: 0,
  };
  if (!manifest || !frozenFrame || acceptedMaps === 0) return acceptedWork;

  let retainedClaims = 0;
  const stages = [
    ...(manifest.segments || []),
    ...(manifest.turnAggregates || []),
  ].filter((stage) => stage.receiptAcceptedAt);
  for (const stage of stages) {
    try {
      const summary = await readAcceptedMap(stage, frozenFrame);
      const receiptText = await fs.promises.readFile(stage.receiptPath, "utf8");
      const claims = [];
      for (const claim of listMapClaims(summary)) {
        if (!allAnchorsRetained(claim.anchors, retainedAnchorIds)) {
          acceptedWork.omittedClaims += 1;
          continue;
        }
        if (retainedClaims >= MAX_DEGRADED_ACCEPTED_CLAIMS) {
          acceptedWork.omittedClaims += 1;
          continue;
        }
        claims.push(claim);
        retainedClaims += 1;
      }
      acceptedWork.stages.push({
        segmentId: stage.segmentId,
        receiptDigest: `sha256:${sha256Text(receiptText)}`,
        claims,
      });
      acceptedWork.verifiedMaps += 1;
    } catch {
      // The accepted count remains visible while unverified artifact bodies stay omitted.
    }
  }
  return acceptedWork;
}

function assertDegradedPublicationTarget(workDir, target, label) {
  if (!path.isAbsolute(target)) {
    throw new ExportHandoffError(
      "INVALID_PUBLICATION_TARGET",
      `${label} must be absolute`,
    );
  }
  const relative = path.relative(workDir, path.resolve(target));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new ExportHandoffError(
      "INVALID_PUBLICATION_TARGET",
      `${label} must remain outside the disposable Compression Task directory`,
    );
  }
}

function degradedPublicationTargets(state, contract, workDir) {
  let outputPath = contract.outputPath;
  let evidenceIndexPath = contract.evidenceIndexPath;
  for (const entry of state.applications) {
    const result = entry.application.result;
    if (
      entry.application.status === "APPLIED" &&
      result?.effect === "publication_relocated"
    ) {
      outputPath = result.outputPath;
      evidenceIndexPath = result.evidenceIndexPath;
    }
  }
  outputPath = path.resolve(outputPath);
  evidenceIndexPath = path.resolve(evidenceIndexPath);
  assertDegradedPublicationTarget(workDir, outputPath, "Degraded Handoff path");
  assertDegradedPublicationTarget(
    workDir,
    evidenceIndexPath,
    "Degraded Evidence Index path",
  );
  if (outputPath === evidenceIndexPath) {
    throw new ExportHandoffError(
      "INVALID_PUBLICATION_TARGET",
      "Degraded publication targets must be distinct",
    );
  }
  return { outputPath, evidenceIndexPath };
}

async function degradedManifest(workDir, contract) {
  try {
    const manifest = await loadManifest(workDir);
    if (
      manifest.sessionId !== contract.sessionId ||
      manifest.sourceRevision !== contract.sourceRevision ||
      path.resolve(manifest.workDir) !== workDir
    ) {
      throw new ExportHandoffError(
        "ADJUDICATION_RUN_INVALID",
        "Mutable manifest no longer matches the immutable Adjudication contract",
      );
    }
    return { manifest, diagnosticCode: null };
  } catch (error) {
    return { manifest: null, diagnosticCode: error.code || "ERROR" };
  }
}

export async function publishDegradedHandoff({
  workDir,
  contract,
  request,
  decision,
}) {
  const resolved = path.resolve(workDir);
  const state = await inspectAdjudication(resolved);
  if (
    state.lifecycleState !== "APPLYING_ADJUDICATION" ||
    state.activeRequest?.requestId !== request.requestId ||
    state.activeRequest?.decisionId !== decision.decisionId ||
    decision.action.type !== "publish_degraded"
  ) {
    throw new ExportHandoffError(
      "ADJUDICATION_DECISION_BINDING_MISMATCH",
      "Degraded publication requires the exact active publish_degraded decision",
    );
  }

  const { manifest, diagnosticCode: manifestDiagnostic } = await degradedManifest(
    resolved,
    contract,
  );
  const evidencePackPath = path.join(resolved, "evidence-pack.json");
  const evidenceIndexWorkPath = path.join(resolved, "evidence-index.json");
  assertInsideWorkDir(resolved, evidencePackPath, "Degraded Evidence Pack path");
  assertInsideWorkDir(resolved, evidenceIndexWorkPath, "Degraded Evidence Index path");
  const evidencePack = await readJson(evidencePackPath, "Evidence Pack");
  if (
    evidencePack?.source?.sessionId !== contract.sessionId ||
    evidencePack?.source?.sourceRevision !== contract.sourceRevision
  ) {
    throw new ExportHandoffError(
      "ADJUDICATION_ARTIFACT_INTEGRITY_MISMATCH",
      "Evidence Pack no longer matches the immutable Adjudication contract",
    );
  }
  const originalIndex = validateEvidenceIndex(
    await readJson(evidenceIndexWorkPath, "Evidence Index"),
  );
  if (
    originalIndex.sessionId !== contract.sessionId ||
    originalIndex.source.sourceRevision !== contract.sourceRevision
  ) {
    throw new ExportHandoffError(
      "ADJUDICATION_ARTIFACT_INTEGRITY_MISMATCH",
      "Evidence Index no longer matches the immutable Adjudication contract",
    );
  }
  const evidenceSelection = await selectDegradedEvidenceIndex(originalIndex);
  const publishedIndex = evidenceSelection.index;
  const retainedAnchorIds = new Set(
    publishedIndex.anchors.map((entry) => entry.anchor.anchorId),
  );

  let frozenFrame = null;
  if (manifest) {
    try {
      frozenFrame = await loadFrozenFrame(manifest);
    } catch {
      // Degraded publication never promotes a missing or invalid Frame.
    }
  }
  const acceptedMaps = Number.isSafeInteger(request.acceptedWork?.acceptedMaps)
    ? request.acceptedWork.acceptedMaps
    : 0;
  const acceptedWork = await collectDegradedAcceptedWork(
    manifest,
    frozenFrame,
    retainedAnchorIds,
    acceptedMaps,
  );
  const currentGoal = await degradedCurrentGoal(
    evidencePack,
    publishedIndex,
    retainedAnchorIds,
  );
  const terminalState = degradedTerminalState(evidencePack, retainedAnchorIds);
  const omissions = [{
    field: "normal REDUCE result",
    reason: "omitted because publish_degraded never treats a mutable or failed REDUCE candidate as verified",
  }];
  if (currentGoal.status !== "verified") {
    omissions.push({ field: "current goal", reason: currentGoal.reason });
  }
  if (terminalState.status !== "verified") {
    omissions.push({
      field: "terminal/workspace facts",
      reason: terminalState.reason,
    });
  }
  if (acceptedWork.verifiedMaps < acceptedWork.acceptedMaps) {
    omissions.push({
      field: "accepted MAP generations",
      reason:
        `${acceptedWork.acceptedMaps - acceptedWork.verifiedMaps} accepted generation(s) could not be revalidated`,
    });
  }
  if (evidenceSelection.scope !== "complete") {
    omissions.push({
      field: "Evidence Index anchors",
      reason:
        `${originalIndex.anchors.length - publishedIndex.anchors.length} anchor(s) omitted after ${evidenceSelection.verificationFailureCode}`,
    });
  }
  if (manifestDiagnostic) {
    omissions.push({
      field: "mutable manifest projection",
      reason: `omitted after ${manifestDiagnostic}; immutable contract paths remain authoritative`,
    });
  }

  const projection = {
    currentGoal,
    terminalState,
    acceptedWork,
    diagnostics: degradedDiagnosticChain(state),
    omissions,
    evidence: {
      scope: evidenceSelection.scope,
      retainedAnchors: publishedIndex.anchors.length,
      totalAnchors: originalIndex.anchors.length,
      indexDigest: `sha256:${publishedIndex.integrity.indexDigest}`,
    },
    adjudication: {
      runId: state.runId,
      decisionId: decision.decisionId,
      eventCount: state.eventChain.eventCount,
      headDigest: state.eventChain.headDigest,
    },
  };

  const maxChars = Number.isSafeInteger(manifest?.maxChars)
    ? manifest.maxChars
    : 40_000;
  let handoff = renderDegradedHandoff(projection);
  while (handoff.length > maxChars) {
    const stage = [...projection.acceptedWork.stages]
      .reverse()
      .find((entry) => entry.claims.length > 0);
    if (!stage) break;
    stage.claims.pop();
    projection.acceptedWork.omittedClaims += 1;
    handoff = renderDegradedHandoff(projection);
  }
  if (handoff.length > maxChars) {
    throw new ExportHandoffError(
      "DEGRADED_OUTPUT_TOO_LARGE",
      `Rendered Degraded Handoff was ${handoff.length} characters; limit is ${maxChars}`,
    );
  }

  const evidenceIndexText = `${JSON.stringify(publishedIndex, null, 2)}\n`;
  const maxEvidenceIndexChars = Number.isSafeInteger(manifest?.maxEvidenceIndexChars)
    ? manifest.maxEvidenceIndexChars
    : 1_000_000;
  if (evidenceIndexText.length > maxEvidenceIndexChars) {
    throw new ExportHandoffError(
      "DEGRADED_EVIDENCE_INDEX_TOO_LARGE",
      `Degraded Evidence Index was ${evidenceIndexText.length} characters; limit is ${maxEvidenceIndexChars}`,
    );
  }
  await verifyEvidenceIndex(publishedIndex);

  const targets = degradedPublicationTargets(state, contract, resolved);
  for (const target of [targets.outputPath, targets.evidenceIndexPath]) {
    if (await pathExists(target)) {
      throw new ExportHandoffError("OUTPUT_EXISTS", `Refusing to overwrite ${target}`);
    }
  }
  await publishPairTransactionally([
    { path: targets.outputPath, content: handoff },
    { path: targets.evidenceIndexPath, content: evidenceIndexText },
  ]);

  return {
    effect: "degraded_handoff_published",
    publicationState: "PUBLISHED",
    outputPath: targets.outputPath,
    evidenceIndexPath: targets.evidenceIndexPath,
    handoffDigest: `sha256:${sha256Text(handoff)}`,
    evidenceIndexDigest: `sha256:${sha256Text(evidenceIndexText)}`,
    evidenceScope: evidenceSelection.scope,
    retainedAnchors: publishedIndex.anchors.length,
    omittedAnchors: originalIndex.anchors.length - publishedIndex.anchors.length,
    acceptedMaps: acceptedWork.acceptedMaps,
    verifiedAcceptedMaps: acceptedWork.verifiedMaps,
    retainedAcceptedClaims: acceptedWork.stages.reduce(
      (total, stage) => total + stage.claims.length,
      0,
    ),
    unresolvedDiagnostics: projection.diagnostics.length,
    cleanupStatus: "kept",
  };
}

async function publishHandoffInternal(workDir, options = {}, dependencies = {}) {
  const startedAtMs = Date.now();
  const manifest = await loadManifest(workDir);
  const frozenFrame = await loadFrozenFrame(manifest);
  const evidencePack = await readJson(manifest.paths.evidencePack, "Evidence Pack");
  const evidenceIndex = validateEvidenceIndex(
    await readJson(manifest.paths.evidenceIndex, "Evidence Index"),
  );
  let semanticCoverage;
  let deterministicProjections = null;
  let actionReadyGateContext = null;
  if (isContinuationMapResultMode(manifest.mapResultMode)) {
    const continuationData = await collectContinuationReduceData(
      manifest,
      frozenFrame,
      evidenceIndex,
    );
    const continuationDownstream = manifest.mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE
      ? buildActionReadyContinuationDownstream(
        continuationData.completedMaps,
        manifest.expectedTurnIds,
        evidenceIndex,
        evidenceIndex.preservationLedger,
        evidencePack.progressEvidence,
        continuationAuthorityClaims(frozenFrame.frame),
      )
      : buildContinuationDownstream(
        continuationData.completedMaps,
        manifest.expectedTurnIds,
        evidenceIndex,
        evidenceIndex.preservationLedger,
        continuationAuthorityClaims(frozenFrame.frame),
      );
    semanticCoverage = continuationDownstream.semanticCoverage;
    deterministicProjections = buildContinuationReduceProjections(
      continuationDownstream.claimTable,
      evidenceIndex.preservationLedger,
      continuationAuthorityClaims(frozenFrame.frame),
    );
    if (manifest.mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE) {
      actionReadyGateContext = {
        taskType: frozenFrame.frame.taskType,
        currentGoal: structuredClone(frozenFrame.frame.currentGoal),
        explicitExclusions: structuredClone(frozenFrame.frame.explicitExclusions),
        claimTable: continuationDownstream.claimTable,
        workingSynthesisInput: continuationDownstream.workingSynthesisInput,
        evidenceIndex,
      };
    }
  } else {
    const segmentSummaries = await collectReduceStageSummaries(manifest, frozenFrame);
    semanticCoverage = buildSemanticCoverageGraph(
      segmentSummaries,
      manifest.expectedTurnIds,
    );
  }
  const outputMetrics = validateAggregateMapOutputMetrics(manifest);
  const reducedDocument = await readJsonDocument(
    manifest.paths.reduced,
    "REDUCE result",
  );
  const reducedDigest = `sha256:${sha256Text(reducedDocument.text)}`;
  if (isContinuationMapResultMode(manifest.mapResultMode)) {
    if (!manifest.checkedReducedDigest || !manifest.reduceCheckedAt) {
      throw new ExportHandoffError(
        "REDUCE_NOT_CHECKED",
        "Run validate-reduce --check before publishing a continuation Handoff",
      );
    }
    if (reducedDigest !== manifest.checkedReducedDigest) {
      throw new ExportHandoffError(
        "REDUCE_RESULT_CHANGED",
        "REDUCE result changed after its non-consuming prepublication check",
        {
          expectedDigest: manifest.checkedReducedDigest,
          actualDigest: reducedDigest,
        },
      );
    }
  }
  const reduced = reducedDocument.value;
  validateReduceResult(
    reduced,
    manifest.expectedTurnIds,
    frozenFrame,
    {
      evidenceIndex,
      preservationLedger: evidenceIndex.preservationLedger,
      ...(deterministicProjections
        ? { deterministicProjections, requireDerivedProvenance: true }
        : {}),
      ...(actionReadyGateContext
        ? {
          workingSynthesisInput: actionReadyGateContext.workingSynthesisInput,
          actionReadyGateContext,
        }
        : {}),
    },
  );
  const actionReadyProjection = actionReadyGateContext
    ? validateActionReadyHandoffGates(reduced, actionReadyGateContext)
    : null;
  validateEvidenceReferences(reduced, evidenceIndex);
  const provenance = deriveFinalProvenance(
    reduced,
    manifest.expectedTurnIds,
    evidenceIndex,
    frozenFrame,
  );
  if (
    isContinuationMapResultMode(manifest.mapResultMode) &&
    canonicalStringify(provenance) !== canonicalStringify(manifest.checkedFinalProvenance)
  ) {
    throw new ExportHandoffError(
      "REDUCE_RESULT_CHANGED",
      "Derived provenance changed after REDUCE prepublication validation",
    );
  }
  let publishedEvidenceIndex = attachSemanticCoverage(evidenceIndex, semanticCoverage);
  if (actionReadyProjection) {
    publishedEvidenceIndex = attachEvidenceKeyMap(
      publishedEvidenceIndex,
      actionReadyProjection.evidenceKeyMap,
    );
  }
  const consumerContract = actionReadyProjection
    ? buildActionReadyConsumerContract(actionReadyProjection.hotContext.resumePolicy)
    : null;
  const handoff = actionReadyProjection
    ? renderActionReadyHandoff({
      projection: actionReadyProjection,
      evidencePack,
      evidenceIndex: publishedEvidenceIndex,
      evidenceIndexPath: manifest.evidenceIndexPath,
      frameDigest: frozenFrame.frameDigest,
    })
    : renderHandoff({
      evidencePack,
      reduced,
      coverage: semanticCoverage.turns,
      provenance,
      generatedAt: new Date().toISOString(),
    });
  if (handoff.length > manifest.maxChars) {
    throw new ExportHandoffError(
      "OUTPUT_TOO_LARGE",
      `Rendered Handoff was ${handoff.length} characters; limit is ${manifest.maxChars}`,
      {
        renderedChars: handoff.length,
        maxChars: manifest.maxChars,
        reducedPath: manifest.paths.reduced,
      },
    );
  }
  const evidenceIndexText = `${JSON.stringify(publishedEvidenceIndex, null, 2)}\n`;
  const structuralDigest = `sha256:${sha256Text(canonicalStringify({
    formatVersion: manifest.formatVersion,
    sourceRevision: manifest.sourceRevision,
    frameDigest: frozenFrame.frameDigest,
    semanticCoverage,
    reduced,
    evidenceIndexDigest: publishedEvidenceIndex.integrity.indexDigest,
  }))}`;
  const handoffDigest = `sha256:${sha256Text(handoff)}`;
  const evidenceIndexDigest = `sha256:${sha256Text(evidenceIndexText)}`;
  if (
    manifest.formatVersion === CURRENT_WORKFLOW_VERSION &&
    evidenceIndexText.length > manifest.maxEvidenceIndexChars
  ) {
    throw new ExportHandoffError(
      "EVIDENCE_INDEX_TOO_LARGE",
      `Published Evidence Index was ${evidenceIndexText.length} characters; limit is ${manifest.maxEvidenceIndexChars}`,
      {
        renderedChars: evidenceIndexText.length,
        maxEvidenceIndexChars: manifest.maxEvidenceIndexChars,
        evidenceIndexPath: manifest.paths.evidenceIndex,
      },
    );
  }
  if (
    evidencePack.source.sourceRevision !== manifest.sourceRevision ||
    publishedEvidenceIndex.source.sourceRevision !== manifest.sourceRevision
  ) {
    throw new ExportHandoffError(
      "SOURCE_CHANGED",
      "Managed workflow artifacts do not share the prepared source revision",
      {
        manifestRevision: manifest.sourceRevision,
        evidencePackRevision: evidencePack.source.sourceRevision,
        evidenceIndexRevision: publishedEvidenceIndex.source.sourceRevision,
      },
    );
  }
  if (manifest.formatVersion === CURRENT_WORKFLOW_VERSION) {
    const verifyIndex = dependencies.verifyEvidenceIndex || verifyEvidenceIndex;
    await verifyIndex(publishedEvidenceIndex);
  }
  const outputExists = await pathExists(manifest.outputPath);
  const evidenceIndexExists = await pathExists(manifest.evidenceIndexPath);
  if (outputExists || evidenceIndexExists) {
    if (!outputExists || !evidenceIndexExists) {
      const existing = outputExists ? manifest.outputPath : manifest.evidenceIndexPath;
      throw new ExportHandoffError("OUTPUT_EXISTS", `Refusing to overwrite ${existing}`);
    }
    const [existingHandoff, existingEvidenceIndex] = await Promise.all([
      fs.promises.readFile(manifest.outputPath, "utf8"),
      fs.promises.readFile(manifest.evidenceIndexPath, "utf8"),
    ]);
    if (existingHandoff !== handoff || existingEvidenceIndex !== evidenceIndexText) {
      throw new ExportHandoffError(
        "OUTPUT_EXISTS",
        "Existing publication pair does not match the verified normal Handoff candidate",
      );
    }
  } else if (manifest.formatVersion === LEGACY_WORKFLOW_VERSION) {
    await publishAtomically(manifest.outputPath, handoff);
    await publishAtomically(manifest.evidenceIndexPath, evidenceIndexText);
  } else {
    await publishPairTransactionally([
      { path: manifest.outputPath, content: handoff },
      { path: manifest.evidenceIndexPath, content: evidenceIndexText },
    ], dependencies);
  }
  manifest.publicationDurationMs = durationSince(startedAtMs);
  const publishedAt = new Date().toISOString();

  if (manifest.formatVersion === CURRENT_WORKFLOW_VERSION) {
    await recordNormalPublication(
      workDir,
      {
        outputPath: manifest.outputPath,
        evidenceIndexPath: manifest.evidenceIndexPath,
        indexedAnchors: publishedEvidenceIndex.anchors.length,
        sourceRevision: publishedEvidenceIndex.source.sourceRevision,
        outputChars: handoff.length,
        evidenceIndexChars: evidenceIndexText.length,
        structuralDigest,
        handoffDigest,
        evidenceIndexDigest,
      },
      { verifyEvidenceIndex: dependencies.verifyEvidenceIndex || verifyEvidenceIndex },
    );
  }

  let cleanupStatus = "kept";
  if (!options.keepWorkdir) {
    try {
      if (manifest.formatVersion === CURRENT_WORKFLOW_VERSION) {
        await dependencies.beforeCleanup?.({ workDir: manifest.workDir });
      }
      await removeManagedWorkDir(manifest);
      cleanupStatus = "removed";
    } catch (error) {
      cleanupStatus = `failed: ${error.message}`;
    }
  }
  return {
    formatVersion: manifest.formatVersion,
    sessionId: manifest.sessionId,
    outputPath: manifest.outputPath,
    evidenceIndexPath: manifest.evidenceIndexPath,
    indexedAnchors: publishedEvidenceIndex.anchors.length,
    sourceRevision: publishedEvidenceIndex.source.sourceRevision,
    sourceChars: manifest.sourceChars,
    evidenceChars: manifest.evidenceChars,
    outputChars: handoff.length,
    evidenceIndexChars: evidenceIndexText.length,
    structuralDigest,
    handoffDigest,
    evidenceIndexDigest,
    reducePreflightDigest: isContinuationMapResultMode(manifest.mapResultMode)
      ? reducedDigest
      : null,
    coveredTurns: semanticCoverage.turns.length,
    retainedSourceTurns: provenance.length,
    chunks: manifest.segments.length + (
      manifest.parentCoverageMode === DETERMINISTIC_PARENT_COVERAGE_MODE
        ? 0
        : (manifest.turnAggregates || []).length
    ),
    initialMaps: manifest.segments.length,
    maxAggregateMapOutputChars: manifest.maxAggregateMapOutputChars || null,
    ...outputMetrics,
    maxFrameProjectionChars: manifest.maxFrameProjectionChars || null,
    maxMapInputChars: manifest.maxMapInputChars || null,
    maxObservedFrameProjectionChars: Math.max(
      0,
      ...manifest.segments.map((segment) => segment.contextChars || 0),
    ),
    maxObservedMapInputChars: Math.max(
      0,
      ...manifest.segments.map((segment) => segment.mapInputChars || 0),
    ),
    phaseTimingsMs: workflowPhaseTimings(manifest, publishedAt),
    performanceMetrics: buildPerformanceMetrics(workflowPerformanceState(manifest)),
    workspaceStatus: manifest.workspaceStatus,
    gitStatus: manifest.gitStatus,
    sourceCwd: manifest.sourceCwd,
    cleanupStatus,
    workDir: cleanupStatus === "removed" ? null : manifest.workDir,
    ...(consumerContract ? { consumerContract } : {}),
    suggestedContinuation: consumerContract
      ? buildActionReadySuggestedContinuation({
        workspacePath: manifest.sourceCwd,
        handoffPath: manifest.outputPath,
        evidenceIndexPath: manifest.evidenceIndexPath,
        consumerContract,
      })
      : `Start a fresh Codex task in ${manifest.sourceCwd || "the intended workspace"}, read ${manifest.outputPath}, and continue from the Handoff without resuming the Source Thread. Use ${manifest.evidenceIndexPath} to retrieve cited evidence.`,
  };
}

export async function publishHandoff(workDir, options = {}, dependencies = {}) {
  return withCapturedWorkflowDiagnostic(
    workDir,
    "publish",
    () => publishHandoffInternal(workDir, options, dependencies),
  );
}
