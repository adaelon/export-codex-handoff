import {
  canonicalStringify,
  sha256Text,
} from "./evidence-addressing.mjs";
import { validateEvidenceIndex } from "./evidence-index.mjs";

export const DEFAULT_PROGRESS_INPUT_CHARS = 32_000;
export const DEFAULT_PROGRESS_DISPATCH_CHARS = 24_000;

const OPERATION_CLASSES = Object.freeze([
  "content_inspection",
  "existence_probe",
  "verification",
  "mutation",
  "mechanical_success",
]);

const CONTENT_TOOL_NAMES = new Set([
  "find",
  "open",
  "read_file",
  "read_mcp_resource",
  "read_text_file",
  "screenshot",
  "search_query",
  "select_string",
  "view_file",
  "view_image",
]);
const EXISTENCE_TOOL_NAMES = new Set([
  "file_exists",
  "find_files",
  "glob",
  "list_directory",
  "list_files",
  "path_exists",
  "stat",
]);
const VERIFICATION_TOOL_NAMES = new Set([
  "build",
  "check",
  "compile",
  "lint",
  "run_tests",
  "test",
  "validate",
  "verify",
]);
const MUTATION_TOOL_NAMES = new Set([
  "apply_patch",
  "create_file",
  "delete_file",
  "edit_file",
  "move_file",
  "patch_apply",
  "rename_file",
  "write_file",
]);
const HIDDEN_ASSISTANT_PHASES = new Set(["analysis", "reasoning"]);

function invalidBudget(value, label) {
  if (!Number.isInteger(value) || value < 64) {
    throw new TypeError(`${label} must be an integer >= 64`);
  }
  return value;
}

function normalizeToolName(toolName) {
  return String(toolName || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function receiptText(receipt) {
  if (!receipt) return "";
  const head = typeof receipt.previewHead === "string" ? receipt.previewHead : "";
  const tail = typeof receipt.previewTail === "string" ? receipt.previewTail : "";
  return tail ? `${head}\n…[bounded evidence omitted]…\n${tail}` : head;
}

function parseInputValue(receipt) {
  if (!receipt || receipt.previewTail) return null;
  let value = receipt.previewHead;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (typeof value !== "string") break;
    const trimmed = value.trim();
    if (!trimmed || !/^(?:\{|\[|")/u.test(trimmed)) break;
    try {
      value = JSON.parse(trimmed);
    } catch {
      break;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function commandText(inputReceipt) {
  const parsed = parseInputValue(inputReceipt);
  if (parsed) {
    for (const key of ["command", "cmd", "query", "input"]) {
      if (typeof parsed[key] === "string") return parsed[key];
    }
  }
  return receiptText(inputReceipt);
}

function nameMatches(name, candidates) {
  if (candidates.has(name)) return true;
  return [...candidates].some((candidate) => (
    name.startsWith(`${candidate}_`) || name.endsWith(`_${candidate}`)
  ));
}

export function classifyToolOperation({ toolName, inputReceipt = null } = {}) {
  const name = normalizeToolName(toolName || inputReceipt?.toolName);
  const command = commandText(inputReceipt);

  if (
    nameMatches(name, MUTATION_TOOL_NAMES) ||
    /\b(?:tools\.)?apply_patch\b/iu.test(command) ||
    /(?:^|[;&|]\s*)(?:set-content|add-content|remove-item|move-item|rename-item|new-item|git\s+(?:add|commit|merge|rebase)|npm\s+publish)\b/iu.test(command)
  ) {
    return "mutation";
  }
  if (
    nameMatches(name, EXISTENCE_TOOL_NAMES) ||
    /\b(?:test-path|get-item|get-childitem|resolve-path|rg\s+--files)\b/iu.test(command)
  ) {
    return "existence_probe";
  }
  if (
    nameMatches(name, VERIFICATION_TOOL_NAMES) ||
    /\b(?:node\s+--test|npm\s+(?:test|run\s+(?:test|lint|build))|pytest|cargo\s+test|go\s+test|git\s+diff\s+--check|tsc\b|eslint\b|quick_validate\.py|run\s+tests?)\b/iu.test(command)
  ) {
    return "verification";
  }
  if (
    nameMatches(name, CONTENT_TOOL_NAMES) ||
    /\b(?:get-content|select-string|git\s+(?:diff|show)|rg\b|read_file\b)\b/iu.test(command)
  ) {
    return "content_inspection";
  }
  return "mechanical_success";
}

export const classifyOperation = classifyToolOperation;

function firstString(value, keys) {
  for (const key of keys) {
    if (typeof value?.[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

function strings(value) {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
}

function commandLocation(command) {
  for (const pattern of [
    /(?:get-content|read_file)\s+(?:-[a-z]+\s+)*(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/iu,
    /(?:-literalpath|-path)\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/iu,
  ]) {
    const match = command.match(pattern);
    const location = match?.slice(1).find(Boolean);
    if (location) return location;
  }
  return null;
}

function inspectionScope(input, operationClass) {
  const explicit = firstString(input, ["scope", "range", "lineRange"]);
  if (explicit) return explicit;
  const line = input?.line ?? input?.lineno ?? input?.lineNumber;
  if (Number.isInteger(line)) return `line:${line}`;
  const start = input?.startLine ?? input?.lineStart ?? input?.start;
  const end = input?.endLine ?? input?.lineEnd ?? input?.end;
  if (Number.isInteger(start) || Number.isInteger(end)) {
    return `lines:${Number.isInteger(start) ? start : "?"}-${Number.isInteger(end) ? end : "?"}`;
  }
  if (Number.isInteger(input?.offset) || Number.isInteger(input?.limit)) {
    return [
      `offset:${Number.isInteger(input?.offset) ? input.offset : 0}`,
      `limit:${Number.isInteger(input?.limit) ? input.limit : "?"}`,
    ].join(";");
  }
  const pattern = firstString(input, ["pattern", "search", "query"]);
  if (pattern) return `pattern:${pattern}`;
  return operationClass === "content_inspection" ? "full" : null;
}

function inspectionCoordinates(inputReceipt, operationClass) {
  const input = parseInputValue(inputReceipt) || {};
  const command = commandText(inputReceipt);
  const location = firstString(input, [
    "path",
    "filePath",
    "file",
    "location",
    "uri",
    "url",
    "ref_id",
  ]) || commandLocation(command);
  const symbols = [...new Set([
    ...strings(input.symbols),
    ...strings(input.symbol),
    ...strings(input.functionName),
    ...strings(input.methodName),
  ])].sort((left, right) => left.localeCompare(right));
  return {
    location,
    symbols,
    scope: inspectionScope(input, operationClass),
  };
}

function evidenceReference({ referenceId, text, anchors, sourceChars, truncated }) {
  return {
    referenceId,
    text,
    anchors: [...anchors],
    sourceChars,
    truncated,
  };
}

function assistantReference(turn, message) {
  const anchors = Array.isArray(message?.anchors) ? message.anchors : [];
  const text = String(message?.text || "");
  return evidenceReference({
    referenceId: `progress-${sha256Text(canonicalStringify({
      turnId: turn.turnId,
      anchors,
    }))}`,
    text,
    anchors,
    sourceChars: text.length,
    truncated: false,
  });
}

function outputReference(receipt) {
  return evidenceReference({
    referenceId: receipt.receiptId,
    text: receiptText(receipt),
    anchors: [receipt.outputAnchor],
    sourceChars: receipt.outputChars,
    truncated: Boolean(receipt.previewTail),
  });
}

function anchorOrder(anchorId, anchorsById) {
  const anchor = anchorsById.get(anchorId);
  return Number.isInteger(anchor?.eventOrdinal) ? anchor.eventOrdinal : Number.MAX_SAFE_INTEGER;
}

function referenceOrder(reference, anchorsById) {
  const ordinals = reference.anchors.map((anchorId) => anchorOrder(anchorId, anchorsById));
  return ordinals.length > 0 ? Math.min(...ordinals) : Number.MAX_SAFE_INTEGER;
}

function operationCounts(classifications) {
  const counts = Object.fromEntries(OPERATION_CLASSES.map((operationClass) => [operationClass, 0]));
  for (const classification of classifications) counts[classification.operationClass] += 1;
  return counts;
}

function coverageDigest(values) {
  return `sha256:${sha256Text(canonicalStringify(values))}`;
}

function dispatchPayload(candidates) {
  const ordered = [...candidates].sort((left, right) => (
    left.eventOrdinal - right.eventOrdinal || left.key.localeCompare(right.key)
  ));
  return {
    assistantProgress: ordered
      .filter((candidate) => candidate.kind === "assistant_progress")
      .map((candidate) => candidate.value),
    inspections: ordered
      .filter((candidate) => candidate.kind === "inspection")
      .map((candidate) => candidate.value),
  };
}

function knownAnchor(anchorId, anchorsById, label) {
  if (typeof anchorId !== "string" || !anchorsById.has(anchorId)) {
    throw new TypeError(`${label} references unknown Evidence Anchor ${anchorId ?? "<missing>"}`);
  }
}

function collectCandidates(turns, evidenceIndex) {
  const anchorsById = new Map(
    evidenceIndex.anchors.map((entry) => [entry.anchor.anchorId, entry.anchor]),
  );
  const candidates = [];
  const classifications = [];

  for (const turn of turns) {
    for (const message of Array.isArray(turn?.assistantMessages) ? turn.assistantMessages : []) {
      if (typeof message?.text !== "string" || !message.text.trim()) continue;
      if (HIDDEN_ASSISTANT_PHASES.has(String(message.phase || "").toLowerCase())) continue;
      const reference = assistantReference(turn, message);
      for (const anchorId of reference.anchors) knownAnchor(anchorId, anchorsById, "Assistant progress");
      candidates.push({
        kind: "assistant_progress",
        key: reference.referenceId,
        eventOrdinal: referenceOrder(reference, anchorsById),
        value: reference,
      });
    }

    const receipts = Array.isArray(turn?.toolReceipts) ? turn.toolReceipts : [];
    const inputByCallId = new Map(
      receipts
        .filter((receipt) => receipt?.valueKind === "input")
        .map((receipt) => [receipt.callId, receipt]),
    );
    for (const receipt of receipts) {
      if (receipt?.valueKind === "input" || receipt?.status !== "ok") continue;
      knownAnchor(receipt.outputAnchor, anchorsById, "Successful Tool Receipt");
      const inputReceipt = inputByCallId.get(receipt.callId) || null;
      const operationClass = classifyToolOperation({
        toolName: receipt.toolName,
        inputReceipt,
      });
      const coordinates = inspectionCoordinates(inputReceipt, operationClass);
      classifications.push({
        receipt,
        operationClass,
        coordinates,
        eventOrdinal: anchorOrder(receipt.outputAnchor, anchorsById),
        scopeKey: operationClass === "content_inspection"
          ? canonicalStringify(
            coordinates.location !== null ||
              coordinates.symbols.length > 0 ||
              coordinates.scope !== "full"
              ? coordinates
              : { ...coordinates, unknownReceiptId: receipt.receiptId },
          )
          : null,
        disposition: operationClass === "content_inspection" ? "candidate" : "cold",
      });
    }
  }

  classifications.sort((left, right) => (
    left.eventOrdinal - right.eventOrdinal ||
    left.receipt.receiptId.localeCompare(right.receipt.receiptId)
  ));
  const latestByScope = new Map();
  for (const classification of classifications) {
    if (classification.operationClass !== "content_inspection") continue;
    const previous = latestByScope.get(classification.scopeKey);
    if (previous) previous.disposition = "folded_cold";
    latestByScope.set(classification.scopeKey, classification);
  }
  for (const classification of latestByScope.values()) {
    const outputEvidence = outputReference(classification.receipt);
    candidates.push({
      kind: "inspection",
      key: classification.receipt.receiptId,
      eventOrdinal: classification.eventOrdinal,
      classification,
      value: {
        operationClass: "content_inspection",
        location: classification.coordinates.location,
        symbols: classification.coordinates.symbols,
        scope: classification.coordinates.scope,
        outputEvidence,
      },
    });
  }
  return { candidates, classifications, uniqueInspectionScopes: latestByScope.size };
}

export function buildProgressEvidence(turns, evidenceIndex, options = {}) {
  if (!Array.isArray(turns)) throw new TypeError("Progress Evidence turns must be an array");
  validateEvidenceIndex(evidenceIndex);
  const maxInputChars = invalidBudget(
    options.maxInputChars ?? DEFAULT_PROGRESS_INPUT_CHARS,
    "maxInputChars",
  );
  const maxDispatchChars = invalidBudget(
    options.maxDispatchChars ?? DEFAULT_PROGRESS_DISPATCH_CHARS,
    "maxDispatchChars",
  );
  const budgetValues = { maxInputChars, maxDispatchChars };
  const { candidates, classifications, uniqueInspectionScopes } = collectCandidates(
    turns,
    evidenceIndex,
  );
  for (const candidate of candidates) {
    candidate.inputChars = JSON.stringify(candidate.value).length;
  }

  const selected = [];
  let selectedInputChars = 0;
  for (const candidate of [...candidates].sort((left, right) => (
    right.eventOrdinal - left.eventOrdinal || right.key.localeCompare(left.key)
  ))) {
    if (selectedInputChars + candidate.inputChars > maxInputChars) continue;
    const tentative = [...selected, candidate];
    if (JSON.stringify(dispatchPayload(tentative)).length > maxDispatchChars) continue;
    selected.push(candidate);
    selectedInputChars += candidate.inputChars;
  }
  const selectedKeys = new Set(selected.map((candidate) => candidate.key));
  for (const classification of classifications) {
    if (classification.disposition !== "candidate") continue;
    classification.disposition = selectedKeys.has(classification.receipt.receiptId)
      ? "selected"
      : "budget_cold";
  }

  const payload = dispatchPayload(selected);
  const classificationCoverage = classifications.map((classification) => ({
    receiptId: classification.receipt.receiptId,
    operationClass: classification.operationClass,
    disposition: classification.disposition,
    ...(classification.scopeKey
      ? { scopeDigest: `sha256:${sha256Text(classification.scopeKey)}` }
      : {}),
  }));
  const duplicateScopesFolded = classifications.filter((classification) => (
    classification.disposition === "folded_cold"
  )).length;
  const inputMetrics = {
    candidateInputChars: candidates.reduce((total, candidate) => total + candidate.inputChars, 0),
    selectedInputChars,
    dispatchChars: JSON.stringify(payload).length,
    assistantProgressCandidates: candidates.filter((candidate) => (
      candidate.kind === "assistant_progress"
    )).length,
    selectedAssistantProgress: payload.assistantProgress.length,
    successfulToolReceipts: classifications.length,
    classifiedReceiptCount: classificationCoverage.length,
    contentInspectionCandidates: uniqueInspectionScopes,
    selectedInspections: payload.inspections.length,
    duplicateScopesFolded,
    coldReceipts: classifications.filter((classification) => (
      classification.disposition !== "selected"
    )).length,
    operationClassCounts: operationCounts(classifications),
  };
  return {
    formatVersion: 1,
    kind: "codex-handoff-progress-evidence",
    sourceRevision: evidenceIndex.source.sourceRevision,
    evidenceIndexDigest: evidenceIndex.integrity.indexDigest,
    budgets: {
      ...budgetValues,
      digest: `sha256:${sha256Text(canonicalStringify(budgetValues))}`,
    },
    ...payload,
    coverage: {
      assistantProgress: {
        count: payload.assistantProgress.length,
        digest: coverageDigest(payload.assistantProgress.map((reference) => reference.referenceId)),
      },
      inspections: {
        count: payload.inspections.length,
        digest: coverageDigest(payload.inspections),
      },
      receiptClassifications: {
        count: classificationCoverage.length,
        digest: coverageDigest(classificationCoverage),
      },
    },
    inputMetrics,
  };
}

export function validateProgressEvidence(progressEvidence, turns, evidenceIndex) {
  const budgets = progressEvidence?.budgets;
  const expected = buildProgressEvidence(turns, evidenceIndex, {
    maxInputChars: budgets?.maxInputChars,
    maxDispatchChars: budgets?.maxDispatchChars,
  });
  if (canonicalStringify(progressEvidence) !== canonicalStringify(expected)) {
    throw new TypeError("Progress Evidence does not match its source and budgets");
  }
  return progressEvidence;
}
