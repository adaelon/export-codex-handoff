import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildEvidencePack } from "./evidence-pack.mjs";
import { canonicalStringify, sha256Text } from "./evidence-addressing.mjs";
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
  validateMapGenerationMetric,
  validateReduceGenerationMetric,
} from "./performance-calibration.mjs";
import { renderHandoff } from "./render-handoff.mjs";
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
    ].filter((stage) => stage.dispatch).map((stage) => ({
      wave: stage.calibration?.wave,
      providerMapGenerationMs: stage.calibration?.providerLatencyMs,
      checkDurationMs: stage.checkDurationMs,
      completeDurationMs: stage.completeDurationMs,
      acceptDurationMs: stage.acceptDurationMs,
    })),
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

async function recordTerminalFailure(workDir, phase, error, timing = {}) {
  try {
    const resolvedWorkDir = path.resolve(workDir);
    const manifest = await readJson(
      path.join(resolvedWorkDir, MANIFEST_FILE),
      "Compression Task manifest",
    );
    if (path.resolve(manifest.workDir) !== resolvedWorkDir) return null;
    const failedAt = new Date().toISOString();
    const outputMetrics = mapOutputMetrics(manifest);
    const failureReportPath = manifest.paths?.failureReport || path.join(
      resolvedWorkDir,
      "failure-report.json",
    );
    assertInsideWorkDir(resolvedWorkDir, failureReportPath, "Failure report path");
    await writeJson(failureReportPath, {
      formatVersion: 1,
      kind: "codex-handoff-terminal-failure",
      failedAt,
      phase,
      diagnostic: {
        code: error?.code || "ERROR",
        message: error?.message || String(error),
        details: serializableDetails(error?.details),
      },
      phaseTimingsMs: workflowPhaseTimings(manifest, failedAt),
      performanceMetrics: buildPerformanceMetrics(
        workflowPerformanceState(manifest),
        {
          failurePhase: phase,
          failureDurationMs: timing.failureDurationMs,
        },
      ),
      workerMetrics: {
        initialMaps: Array.isArray(manifest.segments) ? manifest.segments.length : 0,
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

async function withTerminalFailureReport(workDir, phase, operation) {
  const startedAtMs = Date.now();
  try {
    return await operation();
  } catch (error) {
    await recordTerminalFailure(workDir, phase, error, {
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
  assertMapOutputBudgetPlan(manifest);
  for (const segment of manifest.segments || []) {
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
  if (segment.workerStatus === "pending" && segment.lastDiagnosticCode) {
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
    const manifest = {
      formatVersion: CURRENT_WORKFLOW_VERSION,
      kind: "codex-handoff-compression-task",
      managedWorkDir: true,
      createdAt: new Date().toISOString(),
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
      maxAggregateMapOutputChars: manifest.maxAggregateMapOutputChars,
      mapContextMode: manifest.mapContextMode,
      maxFrameProjectionChars: manifest.maxFrameProjectionChars,
      maxMapInputChars: manifest.maxMapInputChars,
      ...(frameContractVersion ? { frameContractVersion } : {}),
    }, { exclusive: true });
    await writeJson(path.join(workDir, MANIFEST_FILE), manifest, { exclusive: true });

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

export async function claimMapDispatch(workDir, segmentId, dispatchId, workerId) {
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
  const prefix = `attempt-${stage.dispatch.attempt}`;
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
  delete stage.checkedSummaryDigest;
  delete stage.summaryCheckedAt;
  if (stage.dispatch.attempt === 1) {
    stage.dispatch = createStageDispatch(manifest, stage, 2);
    stage.workerStatus = "pending";
    await writeManifest(manifest);
    return { receipt, nextDispatch: stage.dispatch, exhausted: false };
  }
  stage.workerStatus = "exhausted";
  await writeManifest(manifest);
  return { receipt, nextDispatch: null, exhausted: true };
}

export async function checkMapDispatch(
  workDir,
  segmentId,
  dispatchId,
  calibration = undefined,
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
  if (calibration !== undefined) {
    stage.calibration = validateMapGenerationMetric(calibration);
  }
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
    ...(stage.calibration ? { calibration: stage.calibration } : {}),
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
    if (failure.exhausted) {
      throw new ExportHandoffError(
        "MAP_WORKER_EXHAUSTED",
        `${segmentId} failed both MAP Worker attempts`,
        {
          diagnosticCode: failure.receipt.diagnosticCode,
          diagnosticsDir: stage.diagnosticsDir,
        },
      );
    }
    throw new ExportHandoffError(error.code || "MAP_WORKER_FAILED", error.message, {
      ...error.details,
      receipt: failure.receipt,
      nextDispatch: failure.nextDispatch,
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
  const refreshed = await loadManifest(workDir);
  const current = findMapStage(refreshed, segmentId);
  const claimPath = dispatchClaimPath(refreshed, current.dispatch.dispatchId);
  if (!(await pathExists(claimPath))) {
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
  return withTerminalFailureReport(
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
  return withTerminalFailureReport(
    workDir,
    "validate-reduce",
    () => checkReduceStageInternal(workDir, calibration),
  );
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
  for (const target of [manifest.outputPath, manifest.evidenceIndexPath]) {
    if (await pathExists(target)) {
      throw new ExportHandoffError("OUTPUT_EXISTS", `Refusing to overwrite ${target}`);
    }
  }

  if (manifest.formatVersion === LEGACY_WORKFLOW_VERSION) {
    await publishAtomically(manifest.outputPath, handoff);
    await publishAtomically(manifest.evidenceIndexPath, evidenceIndexText);
  } else {
    await publishPairTransactionally([
      { path: manifest.outputPath, content: handoff },
      { path: manifest.evidenceIndexPath, content: evidenceIndexText },
    ], dependencies);
  }
  manifest.publicationDurationMs = durationSince(startedAtMs);

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
  const publishedAt = new Date().toISOString();
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
    structuralDigest: `sha256:${sha256Text(canonicalStringify({
      formatVersion: manifest.formatVersion,
      sourceRevision: manifest.sourceRevision,
      frameDigest: frozenFrame.frameDigest,
      semanticCoverage,
      reduced,
      evidenceIndexDigest: publishedEvidenceIndex.integrity.indexDigest,
    }))}`,
    handoffDigest: `sha256:${sha256Text(handoff)}`,
    evidenceIndexDigest: `sha256:${sha256Text(evidenceIndexText)}`,
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
  return withTerminalFailureReport(
    workDir,
    "publish",
    () => publishHandoffInternal(workDir, options, dependencies),
  );
}
