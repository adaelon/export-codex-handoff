import childProcess from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { promisify } from "node:util";

import {
  canonicalStringify,
  computeWorkspaceRevision,
  hashFileRevision,
  sha256Text,
  stringifyEvidenceValue,
} from "./evidence-addressing.mjs";
import { ExportHandoffError } from "./source-thread.mjs";

const execFile = promisify(childProcess.execFile);

function fail(code, message, details) {
  throw new ExportHandoffError(code, message, details);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_EVIDENCE_INDEX", `${label} must be an object`);
  }
}

function baseIndexDigest(index) {
  const clone = structuredClone(index);
  if (clone.integrity) delete clone.integrity.indexDigest;
  return sha256Text(canonicalStringify(clone));
}

export function buildEvidenceIndex({
  sessionId,
  source,
  workspace,
  entries,
  preservationLedger,
}) {
  const anchors = entries.map((entry) => ({
    anchor: entry.anchor,
    locator: entry.locator,
  }));
  const index = {
    formatVersion: 1,
    kind: "codex-handoff-evidence-index",
    sessionId,
    source: {
      rolloutPath: source.rolloutPath,
      sourceRevision: source.sourceRevision,
      sourceBytes: source.sourceBytes,
    },
    workspace: {
      cwd: workspace.cwd ?? null,
      sourceRevision: workspace.sourceRevision ?? null,
    },
    anchors,
    preservationLedger,
    integrity: {
      algorithm: "sha256",
      anchorsDigest: sha256Text(canonicalStringify(anchors.map((entry) => entry.anchor))),
    },
  };
  index.integrity.indexDigest = baseIndexDigest(index);
  return index;
}

export function validateEvidenceIndex(index) {
  requireObject(index, "Evidence Index");
  requireObject(index.source, "Evidence Index source");
  requireObject(index.workspace, "Evidence Index workspace");
  requireObject(index.preservationLedger, "Preservation Ledger");
  requireObject(index.integrity, "Evidence Index integrity");
  if (index.kind !== "codex-handoff-evidence-index" || index.formatVersion !== 1) {
    fail("INVALID_EVIDENCE_INDEX", "Unsupported Evidence Index kind or version");
  }
  if (!Array.isArray(index.anchors)) {
    fail("INVALID_EVIDENCE_INDEX", "Evidence Index anchors must be an array");
  }
  const ids = index.anchors.map((entry) => entry?.anchor?.anchorId);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
    fail("INVALID_EVIDENCE_INDEX", "Evidence Anchor IDs must be unique non-empty strings");
  }
  const anchorDigest = sha256Text(
    canonicalStringify(index.anchors.map((entry) => entry.anchor)),
  );
  if (index.integrity.algorithm !== "sha256" || index.integrity.anchorsDigest !== anchorDigest) {
    fail("EVIDENCE_INDEX_INTEGRITY_MISMATCH", "Evidence Anchor digest does not match the index");
  }
  if (index.integrity.indexDigest !== baseIndexDigest(index)) {
    fail("EVIDENCE_INDEX_INTEGRITY_MISMATCH", "Evidence Index digest does not match its content");
  }

  const known = new Set(ids);
  for (const anchorId of index.preservationLedger.requiredAnchors || []) {
    if (!known.has(anchorId)) fail("UNKNOWN_EVIDENCE_ANCHOR", `Unknown required anchor ${anchorId}`);
  }
  for (const identifier of index.preservationLedger.exactIdentifiers || []) {
    if (typeof identifier.value !== "string" || !identifier.value) {
      fail("INVALID_EVIDENCE_INDEX", "Preservation Ledger identifiers must retain exact values");
    }
    for (const anchorId of identifier.anchors || []) {
      if (!known.has(anchorId)) {
        fail("UNKNOWN_EVIDENCE_ANCHOR", `Identifier references unknown anchor ${anchorId}`);
      }
    }
  }
  for (const entry of index.anchors) {
    requireObject(entry.anchor, "Evidence Anchor");
    requireObject(entry.locator, "Evidence Anchor locator");
    const expectedRevision = entry.anchor.sourceKind === "source_thread"
      ? index.source.sourceRevision
      : index.workspace.sourceRevision;
    if (!expectedRevision || entry.anchor.sourceRevision !== expectedRevision) {
      fail("INVALID_EVIDENCE_INDEX", `${entry.anchor.anchorId} has a mismatched source revision`);
    }
    const range = entry.anchor.rangeUtf16;
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start) {
      fail("INVALID_EVIDENCE_INDEX", `${entry.anchor.anchorId} has an invalid UTF-16 range`);
    }
    if (!/^[0-9a-f]{64}$/.test(entry.anchor.sha256 || "")) {
      fail("INVALID_EVIDENCE_INDEX", `${entry.anchor.anchorId} has an invalid digest`);
    }
  }
  return index;
}

export async function readEvidenceIndex(indexPath) {
  let index;
  try {
    index = JSON.parse(await fs.promises.readFile(indexPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") fail("EVIDENCE_INDEX_NOT_FOUND", `Evidence Index not found: ${indexPath}`);
    if (error instanceof SyntaxError) fail("INVALID_EVIDENCE_INDEX", `Evidence Index is not valid JSON: ${indexPath}`);
    throw error;
  }
  return validateEvidenceIndex(index);
}

function resolvePointer(record, pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    fail("INVALID_EVIDENCE_INDEX", `Invalid payload path ${pointer}`);
  }
  let value = record;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !(key in value)) {
      fail("EVIDENCE_SOURCE_MISSING", `Payload path no longer resolves: ${pointer}`);
    }
    value = value[key];
  }
  return value;
}

function verifyAnchoredValue(entry, value) {
  const text = stringifyEvidenceValue(value);
  const { start, end } = entry.anchor.rangeUtf16;
  if (end > text.length) {
    fail("EVIDENCE_SOURCE_MISSING", `${entry.anchor.anchorId} range exceeds its source value`);
  }
  const content = text.slice(start, end);
  if (sha256Text(content) !== entry.anchor.sha256) {
    fail("EVIDENCE_DIGEST_MISMATCH", `${entry.anchor.anchorId} content digest changed`);
  }
  return content;
}

async function verifySourceRevision(index) {
  const current = await hashFileRevision(index.source.rolloutPath);
  if (
    current.sourceRevision !== index.source.sourceRevision ||
    current.sourceBytes !== index.source.sourceBytes
  ) {
    fail("SOURCE_CHANGED", "Source Thread rollout no longer matches the indexed revision", {
      expectedRevision: index.source.sourceRevision,
      actualRevision: current.sourceRevision,
      expectedBytes: index.source.sourceBytes,
      actualBytes: current.sourceBytes,
    });
  }
}

async function readRolloutLine(rolloutPath, targetLine) {
  const input = fs.createReadStream(rolloutPath, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber !== targetLine) continue;
      try {
        return JSON.parse(line);
      } catch (error) {
        fail("INVALID_ROLLOUT_JSONL", `Indexed rollout line ${targetLine} is invalid JSON: ${error.message}`);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  fail("EVIDENCE_SOURCE_MISSING", `Indexed rollout line ${targetLine} no longer exists`);
}

async function defaultCommandRunner(cwd, args) {
  try {
    const result = await execFile("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trimEnd(),
      stderr: String(error.stderr || error.message || "").trimEnd(),
      code: error.code ?? null,
    };
  }
}

async function observeWorkspaceEntry(entry, dependencies) {
  const locator = entry.locator;
  if (locator.kind === "command") {
    const runner = dependencies.commandRunner || defaultCommandRunner;
    const result = await runner(locator.cwd, locator.args);
    if (result.ok !== locator.expectedOk) {
      fail("WORKSPACE_CHANGED", `${locator.observationId} command status changed`);
    }
    return locator.stream === "stderr" ? result.stderr : result.stdout;
  }
  if (locator.kind === "file") {
    try {
      return await fs.promises.readFile(locator.path, "utf8");
    } catch (error) {
      fail("WORKSPACE_CHANGED", `${locator.observationId} file is unavailable: ${error.message}`);
    }
  }
  fail("INVALID_EVIDENCE_INDEX", `Unknown workspace locator kind: ${locator.kind}`);
}

async function observeWorkspace(index, dependencies) {
  const entries = index.anchors.filter((entry) => entry.anchor.sourceKind === "workspace");
  const observations = [];
  const values = new Map();
  for (const entry of entries) {
    const value = await observeWorkspaceEntry(entry, dependencies);
    values.set(entry.anchor.anchorId, value);
    observations.push({
      observationId: entry.locator.observationId,
      locator: entry.locator,
      value,
    });
  }
  const revision = computeWorkspaceRevision(observations);
  if (revision !== index.workspace.sourceRevision) {
    fail("WORKSPACE_CHANGED", "Workspace observations no longer match the indexed revision", {
      expectedRevision: index.workspace.sourceRevision,
      actualRevision: revision,
    });
  }
  return values;
}

function findAnchor(index, anchorId) {
  const entry = index.anchors.find((item) => item.anchor.anchorId === anchorId);
  if (!entry) fail("UNKNOWN_EVIDENCE_ANCHOR", `Unknown Evidence Anchor: ${anchorId}`);
  return entry;
}

export async function retrieveEvidence(index, anchorId, dependencies = {}) {
  validateEvidenceIndex(index);
  const entry = findAnchor(index, anchorId);
  let content;
  if (entry.anchor.sourceKind === "source_thread") {
    await verifySourceRevision(index);
    const record = await readRolloutLine(index.source.rolloutPath, entry.anchor.rolloutLine);
    content = verifyAnchoredValue(entry, resolvePointer(record, entry.anchor.payloadPath));
  } else if (entry.anchor.sourceKind === "workspace") {
    const observations = await observeWorkspace(index, dependencies);
    content = verifyAnchoredValue(entry, observations.get(entry.anchor.anchorId));
  } else {
    fail("INVALID_EVIDENCE_INDEX", `Unknown source kind ${entry.anchor.sourceKind}`);
  }
  return {
    anchorId,
    sourceKind: entry.anchor.sourceKind,
    sourceRevision: entry.anchor.sourceRevision,
    sha256: entry.anchor.sha256,
    content,
    verified: true,
  };
}

export async function retrieveEvidenceFromFile(indexPath, anchorId, dependencies = {}) {
  return retrieveEvidence(await readEvidenceIndex(indexPath), anchorId, dependencies);
}

export async function verifyEvidenceIndex(index, dependencies = {}) {
  validateEvidenceIndex(index);
  const sourceEntries = index.anchors.filter((entry) => entry.anchor.sourceKind === "source_thread");
  const workspaceEntries = index.anchors.filter((entry) => entry.anchor.sourceKind === "workspace");

  if (sourceEntries.length > 0) {
    await verifySourceRevision(index);
    const byLine = new Map();
    for (const entry of sourceEntries) {
      const list = byLine.get(entry.anchor.rolloutLine) || [];
      list.push(entry);
      byLine.set(entry.anchor.rolloutLine, list);
    }
    const input = fs.createReadStream(index.source.rolloutPath, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      const entries = byLine.get(lineNumber);
      if (!entries) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        fail("INVALID_ROLLOUT_JSONL", `Indexed rollout line ${lineNumber} is invalid JSON: ${error.message}`);
      }
      for (const entry of entries) {
        verifyAnchoredValue(entry, resolvePointer(record, entry.anchor.payloadPath));
      }
      byLine.delete(lineNumber);
    }
    if (byLine.size > 0) fail("EVIDENCE_SOURCE_MISSING", "One or more indexed rollout lines are missing");
  }

  if (workspaceEntries.length > 0) {
    const observations = await observeWorkspace(index, dependencies);
    for (const entry of workspaceEntries) {
      verifyAnchoredValue(entry, observations.get(entry.anchor.anchorId));
    }
  }

  return {
    valid: true,
    anchors: index.anchors.length,
    sourceAnchors: sourceEntries.length,
    workspaceAnchors: workspaceEntries.length,
    exactIdentifiers: index.preservationLedger.exactIdentifiers.length,
    sourceRevision: index.source.sourceRevision,
    workspaceRevision: index.workspace.sourceRevision,
  };
}

export async function verifyEvidenceIndexFile(indexPath, dependencies = {}) {
  return verifyEvidenceIndex(await readEvidenceIndex(indexPath), dependencies);
}
