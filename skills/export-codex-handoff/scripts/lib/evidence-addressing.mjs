import crypto from "node:crypto";
import fs from "node:fs";

export function stringifyEvidenceValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export async function hashFileRevision(filePath) {
  const hash = crypto.createHash("sha256");
  let sourceBytes = 0;
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) {
    sourceBytes += chunk.length;
    hash.update(chunk);
  }
  return { sourceRevision: `sha256:${hash.digest("hex")}`, sourceBytes };
}

export function boundedPreview(value, maxChars) {
  const text = stringifyEvidenceValue(value);
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new TypeError("maxChars must be a positive integer");
  }
  if (text.length <= maxChars) {
    return { previewHead: text, previewTail: "", outputChars: text.length };
  }
  const headChars = Math.ceil(maxChars * 0.7);
  const tailChars = maxChars - headChars;
  return {
    previewHead: text.slice(0, headChars),
    previewTail: text.slice(-tailChars),
    outputChars: text.length,
  };
}

function collectMatches(text, kind, regex, valueGroup = 0, validate = () => true) {
  const matches = [];
  for (const match of text.matchAll(regex)) {
    const value = match[valueGroup];
    if (!value || !validate(value)) continue;
    const offset = valueGroup === 0 ? 0 : match[0].indexOf(value);
    matches.push({ kind, value, start: match.index + offset, end: match.index + offset + value.length });
  }
  return matches;
}

function overlaps(candidate, occupied) {
  return occupied.some(({ start, end }) => candidate.start < end && candidate.end > start);
}

function isOpaqueIdentifierSegment(value) {
  const segment = value.replace(/\.[A-Za-z0-9]{1,10}$/u, "");
  if (
    segment.length >= 24 &&
    segment.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(segment)
  ) {
    return true;
  }
  if (segment.length < 64 || !/^[A-Za-z0-9+_.=-]+$/u.test(segment)) return false;
  return segment.replace(/[-_.=+]/gu, "").length >= 48;
}

function hasOpaqueIdentifierSegment(value) {
  return value
    .split(/[\\/]/u)
    .filter(Boolean)
    .some(isOpaqueIdentifierSegment);
}

function hasOpaqueIdentifierToken(value) {
  return value
    .split(/[^A-Za-z0-9+_.=-]+/u)
    .filter(Boolean)
    .some(isOpaqueIdentifierSegment);
}

function validUrlIdentifier(value) {
  let parsed;
  try {
    parsed = new URL(value);
    decodeURI(value);
  } catch {
    return false;
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname) return false;
  if (
    parsed.username ||
    parsed.password ||
    hasOpaqueIdentifierSegment(parsed.pathname) ||
    hasOpaqueIdentifierToken(`${parsed.search}\n${parsed.hash}`)
  ) {
    return false;
  }
  if (parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")) return true;
  return parsed.hostname.split(".").every((label) => (
    label.length >= 1 &&
    label.length <= 63 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
  ));
}

function validPathSegments(segments, { windows = false } = {}) {
  const reservedWindowsNames = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
  return segments.length >= 2 && segments.every((segment) => (
    segment &&
    segment !== "." &&
    segment !== ".." &&
    !isOpaqueIdentifierSegment(segment) &&
    (!windows || (!/[. ]$/u.test(segment) && !reservedWindowsNames.test(segment)))
  ));
}

function validWindowsPathIdentifier(value) {
  if (!/^[A-Za-z]:\\/u.test(value) || /[<>:"|?*\u0000-\u001f]/u.test(value.slice(3))) {
    return false;
  }
  return validPathSegments(value.slice(3).split("\\"), { windows: true });
}

function validPosixPathIdentifier(value) {
  if (!value.startsWith("/") || value.includes("//") || /[\u0000-\u001f]/u.test(value)) {
    return false;
  }
  return validPathSegments(value.slice(1).split("/"));
}

export function extractExactIdentifiers(value) {
  const text = stringifyEvidenceValue(value);
  const prioritized = [
    ...collectMatches(
      text,
      "uuid",
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    ),
    ...collectMatches(
      text,
      "url",
      /\bhttps?:\/\/[^\s<>"'`\])}]+/gi,
      0,
      validUrlIdentifier,
    ),
    ...collectMatches(
      text,
      "path",
      /\b[A-Za-z]:\\[^\s"<>|:*?]+/g,
      0,
      validWindowsPathIdentifier,
    ),
    ...collectMatches(
      text,
      "path",
      /(?:\/[A-Za-z0-9._=+-]+){2,}/g,
      0,
      validPosixPathIdentifier,
    ),
    ...collectMatches(
      text,
      "ip",
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
      0,
      (ip) => ip.split(".").every((part) => Number(part) <= 255),
    ),
    ...collectMatches(text, "port", /\bport\s*[:=]\s*(\d{1,5})\b/gi, 1, (port) => Number(port) <= 65535),
    ...collectMatches(text, "symbol", /\bsymbol\s*[:=]\s*([A-Za-z_$][\w$]*(?:[.#:][A-Za-z_$][\w$]*)*)/g, 1),
    ...collectMatches(text, "symbol", /`([A-Za-z_$][\w$]*(?:[.#:][A-Za-z_$][\w$]*)+)`/g, 1),
    ...collectMatches(text, "hash", /\b[0-9a-f]{7,64}\b/gi, 0, (hash) => /[a-f]/i.test(hash)),
  ];

  const kindPriority = new Map([
    ["uuid", 0],
    ["url", 1],
    ["path", 2],
    ["ip", 3],
    ["port", 4],
    ["symbol", 5],
    ["hash", 6],
  ]);
  prioritized.sort((left, right) =>
    kindPriority.get(left.kind) - kindPriority.get(right.kind) || left.start - right.start,
  );

  const occupied = [];
  const accepted = [];
  const seen = new Set();
  for (const candidate of prioritized) {
    if (overlaps(candidate, occupied)) continue;
    const key = `${candidate.kind}\u0000${candidate.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    occupied.push(candidate);
    accepted.push(candidate);
  }
  return accepted
    .sort((left, right) => left.start - right.start || left.kind.localeCompare(right.kind))
    .map(({ kind, value: identifier }) => ({ kind, value: identifier }));
}

export function createEvidenceEntry({
  sourceKind,
  sourceRevision,
  turnId,
  eventOrdinal,
  rolloutLine,
  payloadPath,
  callId,
  value,
  locator,
}) {
  const text = stringifyEvidenceValue(value);
  const sha256 = sha256Text(text);
  const rangeUtf16 = { start: 0, end: text.length };
  const identity = canonicalStringify({
    sourceKind,
    sourceRevision,
    turnId: turnId ?? null,
    eventOrdinal: eventOrdinal ?? null,
    rolloutLine: rolloutLine ?? null,
    payloadPath: payloadPath ?? null,
    callId: callId ?? null,
    rangeUtf16,
    sha256,
  });
  const anchor = {
    anchorId: `anchor-${sha256Text(identity)}`,
    sourceKind,
    sourceRevision,
    ...(turnId ? { turnId } : {}),
    ...(eventOrdinal !== undefined ? { eventOrdinal } : {}),
    ...(rolloutLine !== undefined ? { rolloutLine } : {}),
    ...(payloadPath ? { payloadPath } : {}),
    ...(callId ? { callId } : {}),
    rangeUtf16,
    sha256,
  };
  return { anchor, locator, exactIdentifiers: extractExactIdentifiers(text) };
}

export function createToolReceipt({ entry, toolName, callId, status, valueKind, value, maxChars }) {
  const preview = boundedPreview(value, maxChars);
  return {
    receiptId: `receipt-${sha256Text(`${callId}\u0000${valueKind}\u0000${entry.anchor.anchorId}`)}`,
    toolName,
    callId,
    status,
    previewHead: preview.previewHead,
    previewTail: preview.previewTail,
    outputChars: preview.outputChars,
    outputAnchor: entry.anchor.anchorId,
    exactIdentifiers: entry.exactIdentifiers.map((item) => item.value),
    valueKind,
  };
}

export function computeWorkspaceRevision(observations) {
  const revisionInput = observations.map((observation) => ({
    observationId: observation.observationId,
    locator: observation.locator,
    sha256: sha256Text(observation.value),
  }));
  return `sha256:${sha256Text(canonicalStringify(revisionInput))}`;
}

export function buildPreservationLedger(sourceRevision, entries) {
  return buildLedgerFromEntries(sourceRevision, entries);
}

const EXPLICIT_PRESERVE_PATTERN = /\b(?:preserve|retain|keep\s+exact(?:ly)?|must\s+keep|do\s+not\s+drop|don't\s+drop|never\s+omit)\b|(?:保留|原样保留|不得省略|不要丢失|必须保留)/iu;

function messageAnchors(message) {
  return Array.isArray(message?.anchors)
    ? message.anchors.filter((anchorId) => typeof anchorId === "string" && anchorId)
    : [];
}

export function selectCriticalAnchors(entries, options = {}) {
  const knownAnchors = new Set(entries.map((entry) => entry?.anchor?.anchorId).filter(Boolean));
  const selected = new Set();
  const select = (anchorId) => {
    if (typeof anchorId !== "string" || !anchorId) {
      throw new TypeError("Critical Anchor selection received an empty anchor ID");
    }
    if (!knownAnchors.has(anchorId)) {
      throw new TypeError(`Critical Anchor selection received unknown anchor ${anchorId}`);
    }
    selected.add(anchorId);
  };
  const turns = Array.isArray(options.turns) ? options.turns : [];
  const userMessages = turns.flatMap((turn) => (
    Array.isArray(turn?.userMessages) ? turn.userMessages : []
  ));
  if (turns.length > 0 && userMessages.length === 0) {
    throw new TypeError("Critical Anchor selection requires at least one user message");
  }
  for (const anchorId of messageAnchors(userMessages.at(-1))) select(anchorId);
  for (const message of userMessages) {
    if (!EXPLICIT_PRESERVE_PATTERN.test(String(message?.text || ""))) continue;
    for (const anchorId of messageAnchors(message)) select(anchorId);
  }
  for (const turn of turns) {
    for (const receipt of Array.isArray(turn?.toolReceipts) ? turn.toolReceipts : []) {
      if (receipt?.status === "error") select(receipt.outputAnchor);
    }
  }
  for (const entry of entries) {
    const anchor = entry?.anchor;
    if (
      anchor?.sourceKind === "workspace" &&
      (
        anchor.payloadPath?.startsWith("/git/") ||
        (
          anchor.payloadPath === "/checkpoint/content" &&
          (
            options.workspace?.checkpoint?.freshness === undefined ||
            options.workspace.checkpoint.freshness === "fresh"
          )
        )
      )
    ) {
      select(anchor.anchorId);
    }
  }
  for (const anchorId of options.additionalRequiredAnchors || []) select(anchorId);
  return entries
    .map((entry) => entry?.anchor?.anchorId)
    .filter((anchorId) => selected.has(anchorId));
}

function buildLedgerFromEntries(sourceRevision, requiredEntries) {
  const byIdentifier = new Map();
  const requiredAnchors = requiredEntries.map((entry) => entry.anchor.anchorId);
  const requiredAnchorSet = new Set(requiredAnchors);
  for (const entry of requiredEntries) {
    for (const identifier of entry.exactIdentifiers || []) {
      const key = `${identifier.kind}\u0000${identifier.value}`;
      const existing = byIdentifier.get(key) || { ...identifier, anchors: [] };
      if (
        requiredAnchorSet.has(entry.anchor.anchorId) &&
        !existing.anchors.includes(entry.anchor.anchorId)
      ) {
        existing.anchors.push(entry.anchor.anchorId);
      }
      byIdentifier.set(key, existing);
    }
  }
  return {
    sourceRevision,
    requiredAnchors,
    exactIdentifiers: [...byIdentifier.values()],
    criticalCategories: [],
  };
}

export function buildContinuationPreservationLedger(sourceRevision, entries, options = {}) {
  const requiredAnchors = selectCriticalAnchors(entries, options);
  const requiredAnchorSet = new Set(requiredAnchors);
  const requiredEntries = entries.filter((entry) => requiredAnchorSet.has(entry.anchor.anchorId));
  return buildLedgerFromEntries(sourceRevision, requiredEntries);
}

export function preservationLedgerMetrics(ledger) {
  return {
    requiredAnchorCount: ledger.requiredAnchors.length,
    requiredAnchorDigest: `sha256:${sha256Text(canonicalStringify(ledger.requiredAnchors))}`,
    exactIdentifierCount: ledger.exactIdentifiers.length,
    exactIdentifierDigest: `sha256:${sha256Text(canonicalStringify(ledger.exactIdentifiers))}`,
  };
}
