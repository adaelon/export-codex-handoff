import { sha256Text } from "./evidence-addressing.mjs";
import {
  projectFirstWaveBudget,
  validateProviderTimingCapability,
} from "./performance-calibration.mjs";
import { ExportHandoffError } from "./source-thread.mjs";

export const MAP_RECEIPT_MAX_CHARS = 2_048;
export const SPARSE_MAP_RESULT_MODE = "sparse-map-v1";
export const CONTINUATION_MAP_RESULT_MODE = "continuation-map-v1";
export const CONTINUATION_MAP_V2_RESULT_MODE = "continuation-map-v2";
export const CONTINUATION_MAP_CANDIDATE_MAX_CHARS = 4_000;
export const CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS = 16_000;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DISPATCH_ID_PATTERN = /^dispatch-[0-9a-f]{64}$/;

function isCompactMapResultMode(mode) {
  return mode === SPARSE_MAP_RESULT_MODE || isContinuationMapResultMode(mode);
}

export function isContinuationMapResultMode(mode) {
  return mode === CONTINUATION_MAP_RESULT_MODE || mode === CONTINUATION_MAP_V2_RESULT_MODE;
}

function compactMapResultModes() {
  return [
    SPARSE_MAP_RESULT_MODE,
    CONTINUATION_MAP_RESULT_MODE,
    CONTINUATION_MAP_V2_RESULT_MODE,
  ].join(", ");
}

function requireString(value, label, code = "INVALID_MAP_DISPATCH") {
  if (typeof value !== "string" || value.length === 0) {
    throw new ExportHandoffError(code, `${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, label, code) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ExportHandoffError(code, `${label} must be a positive integer`);
  }
  return value;
}

function canonicalDispatchIdentity(dispatch) {
  const identity = {
    segmentId: dispatch.segmentId,
    chunkPath: dispatch.chunkPath,
    summaryPath: dispatch.summaryPath,
    frameDigest: dispatch.frameDigest,
    attempt: dispatch.attempt,
  };
  if (dispatch.mapResultMode) identity.mapResultMode = dispatch.mapResultMode;
  if (dispatch.maxMapOutputChars) {
    identity.maxMapOutputChars = dispatch.maxMapOutputChars;
  }
  if (dispatch.contextPath) {
    identity.contextPath = dispatch.contextPath;
    identity.contextDigest = dispatch.contextDigest;
    if (dispatch.dictionaryPath) {
      identity.dictionaryPath = dispatch.dictionaryPath;
      identity.dictionaryDigest = dispatch.dictionaryDigest;
    }
  } else {
    identity.framePath = dispatch.framePath;
  }
  return JSON.stringify(identity);
}

export function createMapDispatch(input) {
  const candidate = {
    segmentId: requireString(input.segmentId, "segmentId"),
    chunkPath: requireString(input.chunkPath, "chunkPath"),
    summaryPath: requireString(input.summaryPath, "summaryPath"),
    frameDigest: requireString(input.frameDigest, "frameDigest"),
    attempt: input.attempt,
  };
  if (input.mapResultMode !== undefined) {
    candidate.mapResultMode = requireString(input.mapResultMode, "mapResultMode");
    if (!isCompactMapResultMode(candidate.mapResultMode)) {
      throw new ExportHandoffError(
        "INVALID_MAP_DISPATCH",
        `mapResultMode must be one of ${compactMapResultModes()}`,
      );
    }
  }
  if (input.maxMapOutputChars !== undefined) {
    if (!isCompactMapResultMode(candidate.mapResultMode)) {
      throw new ExportHandoffError(
        "INVALID_MAP_DISPATCH",
        "maxMapOutputChars requires a compact MAP result mode",
      );
    }
    candidate.maxMapOutputChars = requirePositiveInteger(
      input.maxMapOutputChars,
      "maxMapOutputChars",
      "INVALID_MAP_DISPATCH",
    );
    if (
      isContinuationMapResultMode(candidate.mapResultMode) &&
      candidate.maxMapOutputChars > CONTINUATION_MAP_CANDIDATE_MAX_CHARS
    ) {
      throw new ExportHandoffError(
        "INVALID_MAP_DISPATCH",
        `${candidate.mapResultMode} candidates are capped at ${CONTINUATION_MAP_CANDIDATE_MAX_CHARS} characters`,
      );
    }
  }
  if (
    isContinuationMapResultMode(candidate.mapResultMode) &&
    candidate.maxMapOutputChars === undefined
  ) {
    throw new ExportHandoffError(
      "INVALID_MAP_DISPATCH",
      `${candidate.mapResultMode} requires a maxMapOutputChars binding`,
    );
  }
  if (
    input.contextPath ||
    input.contextDigest ||
    input.dictionaryPath ||
    input.dictionaryDigest
  ) {
    candidate.contextPath = requireString(input.contextPath, "contextPath");
    candidate.contextDigest = requireString(input.contextDigest, "contextDigest");
    if (!SHA256_PATTERN.test(candidate.contextDigest)) {
      throw new ExportHandoffError(
        "INVALID_MAP_DISPATCH",
        "contextDigest must be a canonical SHA-256 digest",
      );
    }
    if (input.dictionaryPath || input.dictionaryDigest) {
      candidate.dictionaryPath = requireString(input.dictionaryPath, "dictionaryPath");
      candidate.dictionaryDigest = requireString(input.dictionaryDigest, "dictionaryDigest");
      if (!SHA256_PATTERN.test(candidate.dictionaryDigest)) {
        throw new ExportHandoffError(
          "INVALID_MAP_DISPATCH",
          "dictionaryDigest must be a canonical SHA-256 digest",
        );
      }
    }
  } else {
    candidate.framePath = requireString(input.framePath, "framePath");
  }
  if (!SHA256_PATTERN.test(candidate.frameDigest)) {
    throw new ExportHandoffError(
      "INVALID_MAP_DISPATCH",
      "frameDigest must be a canonical SHA-256 digest",
    );
  }
  if (![1, 2].includes(candidate.attempt)) {
    throw new ExportHandoffError("INVALID_MAP_DISPATCH", "attempt must be 1 or 2");
  }
  return {
    dispatchId: `dispatch-${sha256Text(canonicalDispatchIdentity(candidate))}`,
    ...candidate,
  };
}

export function validateMapDispatch(dispatch, expected = {}) {
  if (!dispatch || typeof dispatch !== "object" || Array.isArray(dispatch)) {
    throw new ExportHandoffError("INVALID_MAP_DISPATCH", "MapDispatch must be an object");
  }
  const expectedKeys = dispatch.contextPath ? [
    "dispatchId",
    "segmentId",
    "chunkPath",
    "summaryPath",
    "contextPath",
    "contextDigest",
    "frameDigest",
    "attempt",
  ] : [
    "dispatchId",
    "segmentId",
    "chunkPath",
    "summaryPath",
    "framePath",
    "frameDigest",
    "attempt",
  ];
  if (Object.hasOwn(dispatch, "dictionaryPath") || Object.hasOwn(dispatch, "dictionaryDigest")) {
    expectedKeys.push("dictionaryPath", "dictionaryDigest");
  }
  if (Object.hasOwn(dispatch, "mapResultMode")) expectedKeys.push("mapResultMode");
  if (Object.hasOwn(dispatch, "maxMapOutputChars")) expectedKeys.push("maxMapOutputChars");
  const keys = Object.keys(dispatch);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !keys.includes(key))) {
    throw new ExportHandoffError(
      "INVALID_MAP_DISPATCH",
      `MapDispatch fields must be exactly ${expectedKeys.join(", ")}`,
    );
  }
  requireString(dispatch.dispatchId, "dispatchId");
  if (!DISPATCH_ID_PATTERN.test(dispatch.dispatchId)) {
    throw new ExportHandoffError("INVALID_MAP_DISPATCH", "dispatchId is malformed");
  }
  if (
    Object.hasOwn(dispatch, "mapResultMode") &&
    !isCompactMapResultMode(dispatch.mapResultMode)
  ) {
      throw new ExportHandoffError(
        "INVALID_MAP_DISPATCH",
        `mapResultMode must be one of ${compactMapResultModes()}`,
      );
  }
  if (Object.hasOwn(dispatch, "maxMapOutputChars")) {
    requirePositiveInteger(
      dispatch.maxMapOutputChars,
      "maxMapOutputChars",
      "INVALID_MAP_DISPATCH",
    );
    if (!isCompactMapResultMode(dispatch.mapResultMode)) {
      throw new ExportHandoffError(
        "INVALID_MAP_DISPATCH",
        "maxMapOutputChars requires a compact MAP result mode",
      );
    }
    if (
      isContinuationMapResultMode(dispatch.mapResultMode) &&
      dispatch.maxMapOutputChars > CONTINUATION_MAP_CANDIDATE_MAX_CHARS
    ) {
      throw new ExportHandoffError(
        "INVALID_MAP_DISPATCH",
        `${dispatch.mapResultMode} candidates are capped at ${CONTINUATION_MAP_CANDIDATE_MAX_CHARS} characters`,
      );
    }
  }
  if (
    isContinuationMapResultMode(dispatch.mapResultMode) &&
    !Object.hasOwn(dispatch, "maxMapOutputChars")
  ) {
    throw new ExportHandoffError(
      "INVALID_MAP_DISPATCH",
      `${dispatch.mapResultMode} requires a maxMapOutputChars binding`,
    );
  }
  if (Object.hasOwn(expected, "mapResultMode")) {
    const actualMode = dispatch.mapResultMode;
    const expectedMode = expected.mapResultMode ?? undefined;
    if (actualMode !== expectedMode) {
      throw new ExportHandoffError(
        "MAP_RESULT_MODE_MISMATCH",
        `Expected mapResultMode ${expectedMode ?? "<legacy-full-map>"}; received ${actualMode ?? "<legacy-full-map>"}`,
      );
    }
  }
  if (expected.frameDigest && dispatch.frameDigest !== expected.frameDigest) {
    throw new ExportHandoffError(
      "FRAME_DIGEST_MISMATCH",
      `Expected frameDigest ${expected.frameDigest}; received ${dispatch.frameDigest}`,
    );
  }
  if (
    Object.hasOwn(expected, "maxMapOutputChars") &&
    dispatch.maxMapOutputChars !== expected.maxMapOutputChars
  ) {
    throw new ExportHandoffError(
      "MAP_OUTPUT_BUDGET_MISMATCH",
      `Expected maxMapOutputChars ${expected.maxMapOutputChars ?? "<unbounded>"}; received ${dispatch.maxMapOutputChars ?? "<unbounded>"}`,
    );
  }
  if (expected.contextDigest && dispatch.contextDigest !== expected.contextDigest) {
    throw new ExportHandoffError(
      "MAP_CONTEXT_CHANGED",
      `Expected contextDigest ${expected.contextDigest}; received ${dispatch.contextDigest}`,
    );
  }
  if (
    Object.hasOwn(expected, "dictionaryDigest") &&
    dispatch.dictionaryDigest !== expected.dictionaryDigest
  ) {
    throw new ExportHandoffError(
      "MAP_DICTIONARY_CHANGED",
      `Expected dictionaryDigest ${expected.dictionaryDigest ?? "<none>"}; received ${dispatch.dictionaryDigest ?? "<none>"}`,
    );
  }
  const rebuilt = createMapDispatch(dispatch);
  if (rebuilt.dispatchId !== dispatch.dispatchId) {
    throw new ExportHandoffError(
      "MAP_DISPATCH_IDENTITY_MISMATCH",
      "MapDispatch identity does not match its bound fields",
    );
  }
  if (expected.dispatchId && dispatch.dispatchId !== expected.dispatchId) {
    throw new ExportHandoffError(
      "MAP_DISPATCH_IDENTITY_MISMATCH",
      `Expected dispatch ${expected.dispatchId}; received ${dispatch.dispatchId}`,
    );
  }
  if (expected.segmentId && dispatch.segmentId !== expected.segmentId) {
    throw new ExportHandoffError(
      "MAP_DISPATCH_SEGMENT_MISMATCH",
      `Expected segment ${expected.segmentId}; received ${dispatch.segmentId}`,
    );
  }
  if (expected.attempt && dispatch.attempt !== expected.attempt) {
    throw new ExportHandoffError(
      "MAP_DISPATCH_ATTEMPT_MISMATCH",
      `Expected attempt ${expected.attempt}; received ${dispatch.attempt}`,
    );
  }
  return dispatch;
}

export function scheduleMapDispatches(dispatches, availableSlots, options = {}) {
  if (!Array.isArray(dispatches)) {
    throw new ExportHandoffError("INVALID_MAP_DISPATCH", "dispatches must be an array");
  }
  if (!Number.isInteger(availableSlots) || availableSlots < 0) {
    throw new ExportHandoffError(
      "INVALID_WORKER_CAPACITY",
      "availableSlots must be a freshly observed non-negative integer",
    );
  }
  for (const dispatch of dispatches) validateMapDispatch(dispatch);
  if (dispatches.length > 0 && availableSlots === 0) {
    return {
      status: "needs-user",
      diagnosticCode: "MAP_WORKER_UNAVAILABLE",
      dispatches: [],
    };
  }
  if (dispatches.length > availableSlots) {
    const capability = validateProviderTimingCapability(
      options.providerTimingCapability,
    );
    if (!capability.available) {
      return {
        status: "needs-user",
        diagnosticCode: "PROVIDER_TIMING_UNAVAILABLE",
        dispatches: [],
      };
    }
  }
  if (options.firstWave) {
    const projection = projectFirstWaveBudget({
      ...options.firstWave,
      availableSlots,
    });
    if (projection.abort) {
      return {
        status: "aborted",
        diagnosticCode: "LIVE_BUDGET_UNREACHABLE",
        dispatches: [],
        projection,
      };
    }
  }
  return {
    status: "ready",
    availableSlots,
    dispatches: dispatches.slice(0, availableSlots),
  };
}

export function validateMapReceipt(receipt, dispatch, options = {}) {
  validateMapDispatch(dispatch);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new ExportHandoffError("INVALID_MAP_RECEIPT", "MapReceipt must be an object");
  }
  const maxChars = options.maxChars ?? MAP_RECEIPT_MAX_CHARS;
  const receiptChars = JSON.stringify(receipt).length;
  if (receiptChars > maxChars) {
    throw new ExportHandoffError(
      "MAP_RECEIPT_TOO_LARGE",
      `MapReceipt is ${receiptChars} characters; limit is ${maxChars}`,
    );
  }
  requireString(receipt.dispatchId, "receipt.dispatchId", "INVALID_MAP_RECEIPT");
  requireString(receipt.segmentId, "receipt.segmentId", "INVALID_MAP_RECEIPT");
  if (receipt.dispatchId !== dispatch.dispatchId) {
    throw new ExportHandoffError(
      "MAP_RECEIPT_DISPATCH_MISMATCH",
      `Receipt belongs to ${receipt.dispatchId}, not ${dispatch.dispatchId}`,
    );
  }
  if (receipt.segmentId !== dispatch.segmentId) {
    throw new ExportHandoffError(
      "MAP_RECEIPT_SEGMENT_MISMATCH",
      `Receipt belongs to ${receipt.segmentId}, not ${dispatch.segmentId}`,
    );
  }
  if (!["validated", "failed"].includes(receipt.status)) {
    throw new ExportHandoffError(
      "INVALID_MAP_RECEIPT",
      "MapReceipt status must be validated or failed",
    );
  }
  if (receipt.status === "validated") {
    const isSparse = dispatch.mapResultMode === SPARSE_MAP_RESULT_MODE;
    const isContinuation = isContinuationMapResultMode(dispatch.mapResultMode);
    const allowed = new Set([
      "dispatchId",
      "segmentId",
      "status",
      "summaryDigest",
      ...(isSparse
        ? [
          "normalizedSummaryDigest",
          ...(Object.hasOwn(dispatch, "maxMapOutputChars")
            ? ["rawMapOutputChars", "normalizedMapOutputChars"]
            : []),
        ]
        : []),
      ...(isContinuation
        ? [
          "completedSummaryDigest",
          "rawMapOutputChars",
          "completedMapOutputChars",
        ]
        : []),
    ]);
    if (Object.keys(receipt).some((key) => !allowed.has(key))) {
      throw new ExportHandoffError(
        "INVALID_MAP_RECEIPT",
        "A validated MapReceipt may contain only summaryDigest",
      );
    }
    if (!SHA256_PATTERN.test(receipt.summaryDigest ?? "")) {
      throw new ExportHandoffError(
        "INVALID_MAP_RECEIPT",
        "A validated MapReceipt requires a canonical summaryDigest",
      );
    }
    if (
      isSparse &&
      !SHA256_PATTERN.test(receipt.normalizedSummaryDigest ?? "")
    ) {
      throw new ExportHandoffError(
        "INVALID_MAP_RECEIPT",
        "A sparse validated MapReceipt requires a canonical normalizedSummaryDigest",
      );
    }
    if (
      isSparse &&
      Object.hasOwn(dispatch, "maxMapOutputChars")
    ) {
      requirePositiveInteger(
        receipt.rawMapOutputChars,
        "receipt.rawMapOutputChars",
        "INVALID_MAP_RECEIPT",
      );
      requirePositiveInteger(
        receipt.normalizedMapOutputChars,
        "receipt.normalizedMapOutputChars",
        "INVALID_MAP_RECEIPT",
      );
      if (receipt.rawMapOutputChars > dispatch.maxMapOutputChars) {
        throw new ExportHandoffError(
          "MAP_OUTPUT_TOO_LARGE",
          `MAP output is ${receipt.rawMapOutputChars} characters; limit is ${dispatch.maxMapOutputChars}`,
        );
      }
    }
    if (isContinuation) {
      if (!SHA256_PATTERN.test(receipt.completedSummaryDigest ?? "")) {
        throw new ExportHandoffError(
          "INVALID_MAP_RECEIPT",
          "A continuation validated MapReceipt requires a canonical completedSummaryDigest",
        );
      }
      requirePositiveInteger(
        receipt.rawMapOutputChars,
        "receipt.rawMapOutputChars",
        "INVALID_MAP_RECEIPT",
      );
      requirePositiveInteger(
        receipt.completedMapOutputChars,
        "receipt.completedMapOutputChars",
        "INVALID_MAP_RECEIPT",
      );
      if (receipt.rawMapOutputChars > dispatch.maxMapOutputChars) {
        throw new ExportHandoffError(
          "MAP_OUTPUT_TOO_LARGE",
          `MAP output is ${receipt.rawMapOutputChars} characters; limit is ${dispatch.maxMapOutputChars}`,
        );
      }
      if (
        dispatch.mapResultMode === CONTINUATION_MAP_V2_RESULT_MODE &&
        receipt.completedMapOutputChars > CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS
      ) {
        throw new ExportHandoffError(
          "MAP_OUTPUT_TOO_LARGE",
          `Completed continuation-map-v2 output is ${receipt.completedMapOutputChars} characters; limit is ${CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS}`,
        );
      }
    }
  } else {
    const allowed = new Set(["dispatchId", "segmentId", "status", "diagnosticCode"]);
    if (Object.keys(receipt).some((key) => !allowed.has(key))) {
      throw new ExportHandoffError(
        "INVALID_MAP_RECEIPT",
        "A failed MapReceipt may contain only diagnosticCode",
      );
    }
    requireString(
      receipt.diagnosticCode,
      "receipt.diagnosticCode",
      "INVALID_MAP_RECEIPT",
    );
  }
  return receipt;
}
