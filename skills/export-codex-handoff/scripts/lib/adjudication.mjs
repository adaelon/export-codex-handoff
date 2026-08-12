import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalStringify, sha256Text } from "./evidence-addressing.mjs";
import { ExportHandoffError } from "./source-thread.mjs";

const CONTRACT_FILE = "adjudication-contract.json";
const ADJUDICATION_DIR = "adjudication";
const EVENT_DIR = "events";
const REQUEST_DIR = "requests";
const DECISION_DIR = "decisions";
const CONTRACT_KIND = "codex-handoff-adjudication-contract";
const REQUEST_KIND = "codex-handoff-adjudication-request";
const DECISION_KIND = "codex-handoff-adjudication-decision";
const EVENT_KIND = "codex-handoff-adjudication-event";
const STATE_KIND = "codex-handoff-adjudication-state";
const FORMAT_VERSION = 1;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^adjudication-run-[0-9a-f]{64}$/;
const REQUEST_ID_PATTERN = /^adjudication-request-[0-9a-f-]{36}$/;
const DECISION_ID_PATTERN = /^adjudication-decision-[0-9a-f-]{36}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EVENT_FILE_PATTERN = /^[0-9]{12}\.json$/;
const WORKDIR_PREFIX = "codex-handoff-task-";

export const ADJUDICATION_DECISION_ACTIONS = Object.freeze([
  "retry_stage",
  "regenerate_stage",
  "relocate_publication",
  "publish_degraded",
]);

const LIFECYCLE_STATES = Object.freeze([
  "RUNNING",
  "AWAITING_ADJUDICATION",
  "APPLYING_ADJUDICATION",
]);

function fail(code, message, details = undefined) {
  throw new ExportHandoffError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, code, label) {
  if (!isPlainObject(value)) fail(code, `${label} must be an object`);
  return value;
}

function requireExactKeys(value, expected, code, label) {
  requirePlainObject(value, code, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(code, `${label} has an invalid shape`, { expected: wanted, actual });
  }
}

function requireString(value, maximum, code, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail(code, `${label} must be a non-empty bounded string`);
  }
  return value;
}

function requireToken(value, code, label) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    fail(code, `${label} must be a bounded identifier`);
  }
  return value;
}

function requireIsoTimestamp(value, code, label) {
  requireString(value, 64, code, label);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(code, `${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function requireDigest(value, code, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(code, `${label} must be a SHA-256 digest`);
  }
  return value;
}

function textDigest(text) {
  return `sha256:${sha256Text(text)}`;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertInsideWorkDir(workDir, target, label) {
  const relative = path.relative(workDir, path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("INVALID_WORKFLOW_PATH", `${label} escapes the work directory`);
  }
}

function contractPath(workDir) {
  const target = path.join(workDir, CONTRACT_FILE);
  assertInsideWorkDir(workDir, target, "Adjudication contract path");
  return target;
}

function adjudicationPaths(workDir) {
  const root = path.join(workDir, ADJUDICATION_DIR);
  const paths = {
    root,
    events: path.join(root, EVENT_DIR),
    requests: path.join(root, REQUEST_DIR),
    decisions: path.join(root, DECISION_DIR),
  };
  for (const [label, target] of Object.entries(paths)) {
    assertInsideWorkDir(workDir, target, `Adjudication ${label} path`);
  }
  return paths;
}

async function pathExists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonDocument(target, code, label) {
  let text;
  try {
    text = await fs.promises.readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") fail(code, `${label} is missing: ${target}`);
    throw error;
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    if (error instanceof SyntaxError) fail(code, `${label} is not valid JSON: ${target}`);
    throw error;
  }
}

async function writeJsonExclusive(target, value) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, jsonText(value), {
    encoding: "utf8",
    flag: "wx",
  });
}

async function loadManagedManifest(workDir) {
  const resolved = path.resolve(workDir);
  const document = await readJsonDocument(
    path.join(resolved, "manifest.json"),
    "ADJUDICATION_RUN_INVALID",
    "Compression Task manifest",
  );
  const manifest = document.value;
  if (
    !isPlainObject(manifest) ||
    manifest.managedWorkDir !== true ||
    manifest.kind !== "codex-handoff-compression-task" ||
    path.resolve(manifest.workDir || "") !== resolved ||
    path.dirname(resolved) !== path.resolve(manifest.workRoot || "") ||
    !path.basename(resolved).startsWith(WORKDIR_PREFIX) ||
    manifest.formatVersion !== 2
  ) {
    fail(
      "ADJUDICATION_RUN_INVALID",
      `Refusing to adjudicate an unrecognized Compression Run: ${resolved}`,
    );
  }
  return { workDir: resolved, manifest };
}

function contractRunBinding(input) {
  return {
    sessionId: input.sessionId,
    workDir: path.resolve(input.workDir),
    sourceRevision: input.sourceRevision,
    workflowVersion: input.workflowVersion,
    mapResultMode: input.mapResultMode,
    outputPath: path.resolve(input.outputPath),
    evidenceIndexPath: path.resolve(input.evidenceIndexPath),
  };
}

function runIdForBinding(binding) {
  return `adjudication-run-${sha256Text(canonicalStringify(binding))}`;
}

function buildContract(manifest) {
  const binding = contractRunBinding({
    sessionId: manifest.sessionId,
    workDir: manifest.workDir,
    sourceRevision: manifest.sourceRevision,
    workflowVersion: manifest.formatVersion,
    mapResultMode: manifest.mapResultMode,
    outputPath: manifest.outputPath,
    evidenceIndexPath: manifest.evidenceIndexPath,
  });
  return {
    formatVersion: FORMAT_VERSION,
    kind: CONTRACT_KIND,
    runId: runIdForBinding(binding),
    ...binding,
    lifecycleStates: [...LIFECYCLE_STATES],
    decisionActions: [...ADJUDICATION_DECISION_ACTIONS],
  };
}

function validateContract(contract, manifest) {
  requireExactKeys(contract, [
    "formatVersion",
    "kind",
    "runId",
    "sessionId",
    "workDir",
    "sourceRevision",
    "workflowVersion",
    "mapResultMode",
    "outputPath",
    "evidenceIndexPath",
    "lifecycleStates",
    "decisionActions",
  ], "ADJUDICATION_CONTRACT_INVALID", "Adjudication contract");
  requireString(
    contract.sessionId,
    128,
    "ADJUDICATION_CONTRACT_INVALID",
    "contract.sessionId",
  );
  requireString(
    contract.workDir,
    2048,
    "ADJUDICATION_CONTRACT_INVALID",
    "contract.workDir",
  );
  requireDigest(
    contract.sourceRevision,
    "ADJUDICATION_CONTRACT_INVALID",
    "contract.sourceRevision",
  );
  requireString(
    contract.mapResultMode,
    128,
    "ADJUDICATION_CONTRACT_INVALID",
    "contract.mapResultMode",
  );
  requireString(
    contract.outputPath,
    2048,
    "ADJUDICATION_CONTRACT_INVALID",
    "contract.outputPath",
  );
  requireString(
    contract.evidenceIndexPath,
    2048,
    "ADJUDICATION_CONTRACT_INVALID",
    "contract.evidenceIndexPath",
  );
  const binding = contractRunBinding(contract);
  if (
    contract.formatVersion !== FORMAT_VERSION ||
    contract.kind !== CONTRACT_KIND ||
    !RUN_ID_PATTERN.test(contract.runId || "") ||
    contract.runId !== runIdForBinding(binding) ||
    contract.sessionId !== manifest.sessionId ||
    path.resolve(contract.workDir || "") !== path.resolve(manifest.workDir) ||
    contract.sourceRevision !== manifest.sourceRevision ||
    contract.workflowVersion !== manifest.formatVersion ||
    contract.mapResultMode !== manifest.mapResultMode ||
    path.resolve(contract.outputPath || "") !== path.resolve(manifest.outputPath) ||
    path.resolve(contract.evidenceIndexPath || "") !== path.resolve(manifest.evidenceIndexPath) ||
    canonicalStringify(contract.lifecycleStates) !== canonicalStringify(LIFECYCLE_STATES) ||
    canonicalStringify(contract.decisionActions) !== canonicalStringify(
      ADJUDICATION_DECISION_ACTIONS,
    )
  ) {
    fail(
      "ADJUDICATION_CONTRACT_INVALID",
      "Adjudication contract is not bound to the exact Compression Run",
    );
  }
  return contract;
}

export async function initializeAdjudicationContract(manifest) {
  if (!isPlainObject(manifest)) {
    fail("ADJUDICATION_CONTRACT_INVALID", "Compression Task manifest is required");
  }
  const workDir = path.resolve(manifest.workDir || "");
  const target = contractPath(workDir);
  const expected = buildContract(manifest);
  if (await pathExists(target)) {
    const existing = await readJsonDocument(
      target,
      "ADJUDICATION_CONTRACT_INVALID",
      "Adjudication contract",
    );
    validateContract(existing.value, manifest);
    if (canonicalStringify(existing.value) !== canonicalStringify(expected)) {
      fail(
        "ADJUDICATION_CONTRACT_INVALID",
        "Existing Adjudication contract disagrees with the Compression Run",
      );
    }
    return {
      adjudicationContractPath: target,
      runId: existing.value.runId,
      contractDigest: textDigest(existing.text),
    };
  }
  await writeJsonExclusive(target, expected);
  const text = await fs.promises.readFile(target, "utf8");
  return {
    adjudicationContractPath: target,
    runId: expected.runId,
    contractDigest: textDigest(text),
  };
}

async function loadContractContext(workDir) {
  const run = await loadManagedManifest(workDir);
  const target = contractPath(run.workDir);
  const document = await readJsonDocument(
    target,
    "ADJUDICATION_CONTRACT_MISSING",
    "Adjudication contract",
  );
  const contract = validateContract(document.value, run.manifest);
  return {
    ...run,
    contract,
    contractPath: target,
    contractDigest: textDigest(document.text),
  };
}

function validateNamedScalarMap(value, options) {
  const {
    code,
    label,
    maximumEntries,
    validateValue,
  } = options;
  requirePlainObject(value, code, label);
  const entries = Object.entries(value);
  if (entries.length > maximumEntries) fail(code, `${label} has too many fields`);
  for (const [key, nested] of entries) {
    requireToken(key, code, `${label} field`);
    validateValue(nested, `${label}.${key}`);
  }
  return value;
}

function validateRequestInput(input) {
  const code = "INVALID_ADJUDICATION_REQUEST";
  requireExactKeys(input, [
    "phase",
    "failureOwner",
    "diagnostic",
    "artifact",
    "immutableDigests",
    "acceptedWork",
    "allowedActions",
  ], code, "Adjudication Request input");
  requireToken(input.phase, code, "phase");
  requireString(input.failureOwner, 128, code, "failureOwner");
  requireExactKeys(input.diagnostic, ["code", "message"], code, "diagnostic");
  requireToken(input.diagnostic.code, code, "diagnostic.code");
  requireString(input.diagnostic.message, 1024, code, "diagnostic.message");
  requireExactKeys(input.artifact, ["kind", "coordinates"], code, "artifact");
  requireToken(input.artifact.kind, code, "artifact.kind");
  validateNamedScalarMap(input.artifact.coordinates, {
    code,
    label: "artifact.coordinates",
    maximumEntries: 16,
    validateValue(value, label) {
      if (typeof value === "string") requireString(value, 512, code, label);
      else if (typeof value !== "boolean" && !Number.isSafeInteger(value)) {
        fail(code, `${label} must be a bounded scalar`);
      }
    },
  });
  validateNamedScalarMap(input.immutableDigests, {
    code,
    label: "immutableDigests",
    maximumEntries: 16,
    validateValue(value, label) {
      requireDigest(value, code, label);
    },
  });
  if (Object.keys(input.immutableDigests).length === 0) {
    fail(code, "immutableDigests must bind at least one authored artifact");
  }
  validateNamedScalarMap(input.acceptedWork, {
    code,
    label: "acceptedWork",
    maximumEntries: 16,
    validateValue(value, label) {
      if (!Number.isSafeInteger(value) || value < 0) {
        fail(code, `${label} must be a non-negative integer`);
      }
    },
  });
  if (
    !Array.isArray(input.allowedActions) ||
    input.allowedActions.length < 1 ||
    input.allowedActions.length > ADJUDICATION_DECISION_ACTIONS.length ||
    new Set(input.allowedActions).size !== input.allowedActions.length ||
    input.allowedActions.some((action) => !ADJUDICATION_DECISION_ACTIONS.includes(action))
  ) {
    fail(code, "allowedActions must contain unique bounded decision actions");
  }
  return structuredClone(input);
}

function validateRequestDocument(request, context) {
  const code = "ADJUDICATION_DOCUMENT_INVALID";
  requireExactKeys(request, [
    "formatVersion",
    "kind",
    "requestId",
    "runId",
    "contractDigest",
    "createdAt",
    "phase",
    "failureOwner",
    "diagnostic",
    "artifact",
    "immutableDigests",
    "acceptedWork",
    "allowedActions",
  ], code, "Adjudication Request document");
  if (
    request.formatVersion !== FORMAT_VERSION ||
    request.kind !== REQUEST_KIND ||
    !REQUEST_ID_PATTERN.test(request.requestId || "") ||
    request.runId !== context.contract.runId ||
    request.contractDigest !== context.contractDigest
  ) {
    fail(code, "Adjudication Request is not bound to its immutable contract");
  }
  requireIsoTimestamp(request.createdAt, code, "request.createdAt");
  validateRequestInput({
    phase: request.phase,
    failureOwner: request.failureOwner,
    diagnostic: request.diagnostic,
    artifact: request.artifact,
    immutableDigests: request.immutableDigests,
    acceptedWork: request.acceptedWork,
    allowedActions: request.allowedActions,
  });
  return request;
}

function validateDecisionInput(input) {
  const code = "INVALID_ADJUDICATION_DECISION";
  requireExactKeys(input, [
    "runId",
    "requestId",
    "requestDigest",
    "action",
    "rationale",
  ], code, "Adjudication Decision input");
  requireString(input.runId, 128, code, "runId");
  requireString(input.requestId, 128, code, "requestId");
  requireDigest(input.requestDigest, code, "requestDigest");
  requirePlainObject(input.action, code, "action");
  requireToken(input.action.type, code, "action.type");
  if (!ADJUDICATION_DECISION_ACTIONS.includes(input.action.type)) {
    fail(code, `Unknown adjudication action ${input.action.type}`);
  }
  if (["retry_stage", "regenerate_stage"].includes(input.action.type)) {
    requireExactKeys(input.action, ["type", "phase"], code, "action");
    requireToken(input.action.phase, code, "action.phase");
  } else if (input.action.type === "relocate_publication") {
    requireExactKeys(
      input.action,
      ["type", "outputPath", "evidenceIndexPath"],
      code,
      "action",
    );
    for (const [label, target] of [
      ["action.outputPath", input.action.outputPath],
      ["action.evidenceIndexPath", input.action.evidenceIndexPath],
    ]) {
      requireString(target, 2048, code, label);
      if (!path.isAbsolute(target)) fail(code, `${label} must be absolute`);
    }
    if (path.resolve(input.action.outputPath) === path.resolve(input.action.evidenceIndexPath)) {
      fail(code, "Relocated publication targets must be distinct");
    }
  } else {
    requireExactKeys(input.action, ["type"], code, "action");
  }
  requireString(input.rationale, 2000, code, "rationale");
  return structuredClone(input);
}

function validateDecisionForRequest(input, requestState) {
  if (
    input.runId !== requestState.request.runId ||
    input.requestId !== requestState.requestId ||
    input.requestDigest !== requestState.requestDigest
  ) {
    fail(
      "ADJUDICATION_DECISION_BINDING_MISMATCH",
      "Decision must bind the exact run, active request, and request digest",
    );
  }
  if (!requestState.request.allowedActions.includes(input.action.type)) {
    fail(
      "ADJUDICATION_ACTION_NOT_ALLOWED",
      `${input.action.type} is not allowed by ${input.requestId}`,
    );
  }
  if (
    ["retry_stage", "regenerate_stage"].includes(input.action.type) &&
    input.action.phase !== requestState.request.phase
  ) {
    fail(
      "ADJUDICATION_DECISION_BINDING_MISMATCH",
      "Stage action must name the exact responsible request phase",
    );
  }
}

function validateDecisionDocument(decision, context) {
  const code = "ADJUDICATION_DOCUMENT_INVALID";
  requireExactKeys(decision, [
    "formatVersion",
    "kind",
    "decisionId",
    "runId",
    "contractDigest",
    "requestId",
    "requestDigest",
    "createdAt",
    "action",
    "rationale",
  ], code, "Adjudication Decision document");
  if (
    decision.formatVersion !== FORMAT_VERSION ||
    decision.kind !== DECISION_KIND ||
    !DECISION_ID_PATTERN.test(decision.decisionId || "") ||
    decision.runId !== context.contract.runId ||
    decision.contractDigest !== context.contractDigest
  ) {
    fail(code, "Adjudication Decision is not bound to its immutable contract");
  }
  requireIsoTimestamp(decision.createdAt, code, "decision.createdAt");
  validateDecisionInput({
    runId: decision.runId,
    requestId: decision.requestId,
    requestDigest: decision.requestDigest,
    action: decision.action,
    rationale: decision.rationale,
  });
  return decision;
}

function eventDigest(eventWithoutDigest) {
  return `sha256:${sha256Text(canonicalStringify(eventWithoutDigest))}`;
}

function buildEvent(context, input) {
  const base = {
    formatVersion: FORMAT_VERSION,
    kind: EVENT_KIND,
    sequence: input.sequence,
    eventType: input.eventType,
    runId: context.contract.runId,
    contractDigest: context.contractDigest,
    previousEventDigest: input.previousEventDigest,
    documentKind: input.documentKind,
    documentId: input.documentId,
    documentDigest: input.documentDigest,
    recordedAt: input.recordedAt,
  };
  return { ...base, eventDigest: eventDigest(base) };
}

function validateEvent(event, context, expectedSequence, previousEventDigest) {
  const code = "ADJUDICATION_EVENT_CHAIN_INVALID";
  requirePlainObject(event, code, "Adjudication event");
  const { eventDigest: recordedDigest, ...base } = event;
  requireDigest(
    recordedDigest,
    "ADJUDICATION_EVENT_INTEGRITY_MISMATCH",
    "eventDigest",
  );
  if (recordedDigest !== eventDigest(base)) {
    fail(
      "ADJUDICATION_EVENT_INTEGRITY_MISMATCH",
      `Adjudication event ${expectedSequence} digest mismatch`,
    );
  }
  requireExactKeys(event, [
    "formatVersion",
    "kind",
    "sequence",
    "eventType",
    "runId",
    "contractDigest",
    "previousEventDigest",
    "documentKind",
    "documentId",
    "documentDigest",
    "recordedAt",
    "eventDigest",
  ], code, "Adjudication event");
  if (
    event.formatVersion !== FORMAT_VERSION ||
    event.kind !== EVENT_KIND ||
    event.sequence !== expectedSequence ||
    event.runId !== context.contract.runId ||
    event.contractDigest !== context.contractDigest ||
    event.previousEventDigest !== previousEventDigest ||
    !["request_opened", "decision_submitted"].includes(event.eventType) ||
    !["request", "decision"].includes(event.documentKind)
  ) {
    fail(code, `Adjudication event ${expectedSequence} breaks the append-only chain`);
  }
  requireString(event.documentId, 128, code, "event.documentId");
  requireDigest(event.documentDigest, code, "event.documentDigest");
  requireIsoTimestamp(event.recordedAt, code, "event.recordedAt");
  return event;
}

async function listJsonFiles(target, label) {
  let entries;
  try {
    entries = await fs.promises.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      fail("ADJUDICATION_EVENT_CHAIN_INVALID", `${label} is missing`);
    }
    throw error;
  }
  if (entries.some((entry) => !entry.isFile() || !entry.name.endsWith(".json"))) {
    fail("ADJUDICATION_EVENT_CHAIN_INVALID", `${label} contains an unexpected entry`);
  }
  return entries.map((entry) => entry.name).sort();
}

async function loadBoundDocument(target, expectedDigest, kind, context) {
  const document = await readJsonDocument(
    target,
    "ADJUDICATION_EVENT_CHAIN_INVALID",
    `Adjudication ${kind}`,
  );
  if (textDigest(document.text) !== expectedDigest) {
    fail(
      "ADJUDICATION_DOCUMENT_INTEGRITY_MISMATCH",
      `Adjudication ${kind} bytes changed after append`,
    );
  }
  if (kind === "request") validateRequestDocument(document.value, context);
  else validateDecisionDocument(document.value, context);
  return document.value;
}

function publicRequestState(entry) {
  return {
    requestId: entry.requestId,
    requestDigest: entry.requestDigest,
    documentPath: entry.documentPath,
    status: entry.status,
    request: entry.request,
    ...(entry.decision ? {
      decisionId: entry.decisionId,
      decisionDigest: entry.decisionDigest,
      decisionDocumentPath: entry.decisionDocumentPath,
      decision: entry.decision,
    } : {}),
  };
}

function buildPublicState(context, paths, events, requests) {
  const active = requests.find((entry) => [
    "AWAITING_ADJUDICATION",
    "APPLYING_ADJUDICATION",
  ].includes(entry.status)) || null;
  if (requests.filter((entry) => [
    "AWAITING_ADJUDICATION",
    "APPLYING_ADJUDICATION",
  ].includes(entry.status)).length > 1) {
    fail(
      "ADJUDICATION_EVENT_CHAIN_INVALID",
      "Event replay produced more than one active Adjudication Request",
    );
  }
  const publicRequests = requests.map(publicRequestState);
  const activeRequest = active
    ? publicRequests.find((entry) => entry.requestId === active.requestId)
    : null;
  return {
    formatVersion: FORMAT_VERSION,
    kind: STATE_KIND,
    runId: context.contract.runId,
    lifecycleState: active?.status || "RUNNING",
    contract: {
      documentPath: context.contractPath,
      contractDigest: context.contractDigest,
    },
    eventChain: {
      directory: paths.events,
      eventCount: events.length,
      headDigest: events.at(-1)?.eventDigest || null,
    },
    activeRequest,
    requests: publicRequests,
  };
}

async function replayAdjudication(context) {
  const paths = adjudicationPaths(context.workDir);
  if (!(await pathExists(paths.root))) {
    return buildPublicState(context, paths, [], []);
  }
  const [eventNames, requestNames, decisionNames] = await Promise.all([
    listJsonFiles(paths.events, "Adjudication event directory"),
    listJsonFiles(paths.requests, "Adjudication request directory"),
    listJsonFiles(paths.decisions, "Adjudication decision directory"),
  ]);
  const events = [];
  const requests = [];
  const requestById = new Map();
  const referencedRequests = new Set();
  const referencedDecisions = new Set();
  let previousEventDigest = null;

  for (let index = 0; index < eventNames.length; index += 1) {
    const expectedSequence = index + 1;
    const expectedName = `${String(expectedSequence).padStart(12, "0")}.json`;
    if (eventNames[index] !== expectedName || !EVENT_FILE_PATTERN.test(eventNames[index])) {
      fail(
        "ADJUDICATION_EVENT_CHAIN_INVALID",
        `Expected adjudication event ${expectedName}, found ${eventNames[index]}`,
      );
    }
    const eventDocument = await readJsonDocument(
      path.join(paths.events, eventNames[index]),
      "ADJUDICATION_EVENT_CHAIN_INVALID",
      `Adjudication event ${expectedSequence}`,
    );
    const event = validateEvent(
      eventDocument.value,
      context,
      expectedSequence,
      previousEventDigest,
    );
    events.push(event);
    previousEventDigest = event.eventDigest;

    if (event.eventType === "request_opened") {
      if (event.documentKind !== "request" || !REQUEST_ID_PATTERN.test(event.documentId)) {
        fail(
          "ADJUDICATION_EVENT_CHAIN_INVALID",
          "request_opened must reference exactly one request document",
        );
      }
      if (requests.some((entry) => [
        "AWAITING_ADJUDICATION",
        "APPLYING_ADJUDICATION",
      ].includes(entry.status))) {
        fail(
          "ADJUDICATION_EVENT_CHAIN_INVALID",
          "A new request cannot silently replace an active request",
        );
      }
      const documentPath = path.join(paths.requests, `${event.documentId}.json`);
      const request = await loadBoundDocument(
        documentPath,
        event.documentDigest,
        "request",
        context,
      );
      if (request.requestId !== event.documentId || requestById.has(request.requestId)) {
        fail("ADJUDICATION_EVENT_CHAIN_INVALID", "Duplicate or mismatched request event");
      }
      const entry = {
        requestId: request.requestId,
        requestDigest: event.documentDigest,
        documentPath,
        status: "AWAITING_ADJUDICATION",
        request,
      };
      requests.push(entry);
      requestById.set(entry.requestId, entry);
      referencedRequests.add(`${entry.requestId}.json`);
    } else {
      if (event.documentKind !== "decision" || !DECISION_ID_PATTERN.test(event.documentId)) {
        fail(
          "ADJUDICATION_EVENT_CHAIN_INVALID",
          "decision_submitted must reference exactly one decision document",
        );
      }
      const documentPath = path.join(paths.decisions, `${event.documentId}.json`);
      const decision = await loadBoundDocument(
        documentPath,
        event.documentDigest,
        "decision",
        context,
      );
      const request = requestById.get(decision.requestId);
      if (!request || request.status !== "AWAITING_ADJUDICATION") {
        fail(
          "ADJUDICATION_EVENT_CHAIN_INVALID",
          "Decision does not name one awaiting request",
        );
      }
      validateDecisionForRequest(decision, request);
      request.status = "APPLYING_ADJUDICATION";
      request.decisionId = decision.decisionId;
      request.decisionDigest = event.documentDigest;
      request.decisionDocumentPath = documentPath;
      request.decision = decision;
      referencedDecisions.add(`${decision.decisionId}.json`);
    }
  }

  if (
    canonicalStringify(requestNames) !== canonicalStringify([...referencedRequests].sort()) ||
    canonicalStringify(decisionNames) !== canonicalStringify([...referencedDecisions].sort())
  ) {
    fail(
      "ADJUDICATION_EVENT_CHAIN_INVALID",
      "Adjudication documents and append-only events do not match",
    );
  }
  return buildPublicState(context, paths, events, requests);
}

export async function inspectAdjudication(workDir) {
  const context = await loadContractContext(workDir);
  return replayAdjudication(context);
}

async function ensureAdjudicationDirectories(paths) {
  await fs.promises.mkdir(paths.events, { recursive: true });
  await fs.promises.mkdir(paths.requests, { recursive: true });
  await fs.promises.mkdir(paths.decisions, { recursive: true });
}

async function appendEvent(context, state, eventInput) {
  const paths = adjudicationPaths(context.workDir);
  const sequence = state.eventChain.eventCount + 1;
  const event = buildEvent(context, {
    ...eventInput,
    sequence,
    previousEventDigest: state.eventChain.headDigest,
  });
  const target = path.join(paths.events, `${String(sequence).padStart(12, "0")}.json`);
  try {
    await writeJsonExclusive(target, event);
  } catch (error) {
    if (error.code === "EEXIST") {
      fail(
        "ADJUDICATION_EVENT_APPEND_CONFLICT",
        "Another coordinator appended the next adjudication event first",
      );
    }
    throw error;
  }
  return event;
}

export async function createAdjudicationRequest(workDir, input) {
  const validated = validateRequestInput(input);
  const context = await loadContractContext(workDir);
  const state = await replayAdjudication(context);
  if (state.lifecycleState !== "RUNNING") {
    fail(
      "ADJUDICATION_REQUEST_ACTIVE",
      "A Compression Run may not replace its active Adjudication Request",
    );
  }
  const paths = adjudicationPaths(context.workDir);
  await ensureAdjudicationDirectories(paths);
  const createdAt = new Date().toISOString();
  const requestId = `adjudication-request-${crypto.randomUUID()}`;
  const request = {
    formatVersion: FORMAT_VERSION,
    kind: REQUEST_KIND,
    requestId,
    runId: context.contract.runId,
    contractDigest: context.contractDigest,
    createdAt,
    ...validated,
  };
  validateRequestDocument(request, context);
  const documentPath = path.join(paths.requests, `${requestId}.json`);
  await writeJsonExclusive(documentPath, request);
  const requestText = await fs.promises.readFile(documentPath, "utf8");
  const requestDigest = textDigest(requestText);
  try {
    await appendEvent(context, state, {
      eventType: "request_opened",
      documentKind: "request",
      documentId: requestId,
      documentDigest: requestDigest,
      recordedAt: createdAt,
    });
  } catch (error) {
    await fs.promises.rm(documentPath, { force: true }).catch(() => {});
    throw error;
  }
  return inspectAdjudication(context.workDir);
}

export async function submitAdjudicationDecision(workDir, input) {
  const validated = validateDecisionInput(input);
  const context = await loadContractContext(workDir);
  const state = await replayAdjudication(context);
  if (!state.activeRequest || state.activeRequest.status !== "AWAITING_ADJUDICATION") {
    fail(
      "ADJUDICATION_REQUEST_NOT_AWAITING",
      "A decision requires exactly one awaiting Adjudication Request",
    );
  }
  validateDecisionForRequest(validated, state.activeRequest);
  const paths = adjudicationPaths(context.workDir);
  const createdAt = new Date().toISOString();
  const decisionId = `adjudication-decision-${crypto.randomUUID()}`;
  const decision = {
    formatVersion: FORMAT_VERSION,
    kind: DECISION_KIND,
    decisionId,
    runId: context.contract.runId,
    contractDigest: context.contractDigest,
    requestId: validated.requestId,
    requestDigest: validated.requestDigest,
    createdAt,
    action: validated.action,
    rationale: validated.rationale,
  };
  validateDecisionDocument(decision, context);
  const documentPath = path.join(paths.decisions, `${decisionId}.json`);
  await writeJsonExclusive(documentPath, decision);
  const decisionText = await fs.promises.readFile(documentPath, "utf8");
  const decisionDigest = textDigest(decisionText);
  try {
    await appendEvent(context, state, {
      eventType: "decision_submitted",
      documentKind: "decision",
      documentId: decisionId,
      documentDigest: decisionDigest,
      recordedAt: createdAt,
    });
  } catch (error) {
    await fs.promises.rm(documentPath, { force: true }).catch(() => {});
    throw error;
  }
  return inspectAdjudication(context.workDir);
}
