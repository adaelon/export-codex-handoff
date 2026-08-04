import {
  buildEvidenceIndex as buildEvidenceIndexCore,
  readEvidenceIndex as readEvidenceIndexCore,
  retrieveEvidence as retrieveEvidenceCore,
  validateEvidenceIndex as validateEvidenceIndexCore,
  verifyEvidenceIndex as verifyIndexedAnchors,
} from "./evidence-index-core.mjs";
import {
  canonicalStringify,
  hashFileRevision,
  sha256Text,
} from "./evidence-addressing.mjs";
import { ExportHandoffError } from "./source-thread.mjs";

function invalid(message) {
  throw new ExportHandoffError("INVALID_EVIDENCE_INDEX", message);
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${label} contains unsupported field ${key}`);
  }
}

function validateStrictShape(index) {
  assertKeys(index, new Set([
    "formatVersion",
    "kind",
    "sessionId",
    "source",
    "workspace",
    "anchors",
    "preservationLedger",
    "semanticCoverage",
    "evidenceKeyMap",
    "integrity",
  ]), "Evidence Index");
  assertKeys(index.source, new Set(["rolloutPath", "sourceRevision", "sourceBytes"]), "Evidence Index source");
  assertKeys(index.workspace, new Set(["cwd", "sourceRevision"]), "Evidence Index workspace");
  assertKeys(index.integrity, new Set(["algorithm", "anchorsDigest", "indexDigest"]), "Evidence Index integrity");
  assertKeys(index.preservationLedger, new Set([
    "sourceRevision",
    "requiredAnchors",
    "exactIdentifiers",
    "criticalCategories",
  ]), "Preservation Ledger");

  const anchorKeys = new Set([
    "anchorId",
    "sourceKind",
    "sourceRevision",
    "turnId",
    "eventOrdinal",
    "rolloutLine",
    "payloadPath",
    "callId",
    "rangeUtf16",
    "sha256",
  ]);
  for (const entry of index.anchors) {
    assertKeys(entry, new Set(["anchor", "locator"]), "Evidence Index anchor entry");
    assertKeys(entry.anchor, anchorKeys, `Evidence Anchor ${entry.anchor.anchorId}`);
    if (entry.locator.kind === "rollout_payload") {
      assertKeys(entry.locator, new Set(["kind"]), `${entry.anchor.anchorId} rollout locator`);
    } else if (entry.locator.kind === "command") {
      assertKeys(entry.locator, new Set([
        "kind",
        "observationId",
        "executable",
        "cwd",
        "args",
        "expectedOk",
        "stream",
      ]), `${entry.anchor.anchorId} command locator`);
    } else if (entry.locator.kind === "file") {
      assertKeys(entry.locator, new Set(["kind", "observationId", "path"]), `${entry.anchor.anchorId} file locator`);
    } else {
      invalid(`${entry.anchor.anchorId} has unknown locator kind ${entry.locator.kind}`);
    }
  }
  for (const identifier of index.preservationLedger.exactIdentifiers) {
    assertKeys(identifier, new Set(["kind", "value", "anchors"]), "Preservation Ledger identifier");
  }
  if (index.semanticCoverage !== undefined) {
    validateSemanticCoverageShape(index.semanticCoverage, index);
  }
  if (index.evidenceKeyMap !== undefined) {
    validateEvidenceKeyMapShape(index.evidenceKeyMap, index);
  }
}

function validateEvidenceKeyMapShape(map, index) {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    invalid("Handoff Evidence Key map must be an object");
  }
  assertKeys(map, new Set(["formatVersion", "kind", "entries"]), "Handoff Evidence Key map");
  if (
    map.formatVersion !== 1 ||
    map.kind !== "codex-handoff-evidence-key-map" ||
    !Array.isArray(map.entries) ||
    map.entries.length === 0
  ) {
    invalid("Handoff Evidence Key map must be a non-empty v1 map");
  }
  const knownAnchors = new Set(index.anchors.map((entry) => entry.anchor.anchorId));
  const claimIds = new Set();
  for (const [entryIndex, entry] of map.entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid(`Handoff Evidence Key E${entryIndex + 1} must be an object`);
    }
    assertKeys(entry, new Set(["key", "claimId", "anchors"]), "Handoff Evidence Key entry");
    if (
      entry.key !== `E${entryIndex + 1}` ||
      typeof entry.claimId !== "string" ||
      !entry.claimId ||
      claimIds.has(entry.claimId) ||
      !Array.isArray(entry.anchors) ||
      entry.anchors.length === 0 ||
      entry.anchors.some((anchorId) => typeof anchorId !== "string" || !knownAnchors.has(anchorId)) ||
      new Set(entry.anchors).size !== entry.anchors.length
    ) {
      invalid(`Handoff Evidence Key ${entry.key ?? "<missing>"} does not resolve exactly`);
    }
    claimIds.add(entry.claimId);
  }
}

function validateSemanticCoverageShape(coverage, index) {
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    invalid("Semantic Coverage must be an object");
  }
  assertKeys(coverage, new Set(["turns", "claims"]), "Semantic Coverage");
  if (!Array.isArray(coverage.turns) || !Array.isArray(coverage.claims)) {
    invalid("Semantic Coverage turns and claims must be arrays");
  }

  const knownAnchors = new Map(
    index.anchors.map((entry) => [entry.anchor.anchorId, entry.anchor]),
  );
  const claimsById = new Map();
  for (const claim of coverage.claims) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
      invalid("Semantic Coverage claim must be an object");
    }
    assertKeys(claim, new Set(["claimId", "anchors"]), "Semantic Coverage claim");
    if (
      typeof claim.claimId !== "string" ||
      !claim.claimId ||
      !Array.isArray(claim.anchors) ||
      claim.anchors.length === 0 ||
      claim.anchors.some((anchorId) => typeof anchorId !== "string" || !knownAnchors.has(anchorId)) ||
      new Set(claim.anchors).size !== claim.anchors.length
    ) {
      invalid(`Semantic Coverage claim ${claim.claimId ?? "<missing>"} is invalid`);
    }
    if (claimsById.has(claim.claimId)) {
      invalid(`Semantic Coverage contains duplicate claim ${claim.claimId}`);
    }
    claimsById.set(claim.claimId, claim);
  }

  const seenTurns = new Set();
  const reachableClaims = new Set();
  for (const entry of coverage.turns) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid("Semantic Coverage turn must be an object");
    }
    assertKeys(
      entry,
      new Set(["turnId", "status", "claimIds", "reason"]),
      "Semantic Coverage turn",
    );
    if (
      typeof entry.turnId !== "string" ||
      !entry.turnId ||
      seenTurns.has(entry.turnId) ||
      !["summarized", "ignored"].includes(entry.status) ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      !Array.isArray(entry.claimIds) ||
      entry.claimIds.some((claimId) => typeof claimId !== "string") ||
      new Set(entry.claimIds).size !== entry.claimIds.length
    ) {
      invalid(`Semantic Coverage turn ${entry.turnId ?? "<missing>"} is invalid`);
    }
    seenTurns.add(entry.turnId);
    if (
      (entry.status === "summarized" && entry.claimIds.length === 0) ||
      (entry.status === "ignored" && entry.claimIds.length > 0)
    ) {
      invalid(`Semantic Coverage turn ${entry.turnId} has invalid claim reachability`);
    }
    for (const claimId of entry.claimIds) {
      const claim = claimsById.get(claimId);
      if (!claim) invalid(`Semantic Coverage turn ${entry.turnId} references unknown claim ${claimId}`);
      if (!claim.anchors.some((anchorId) => knownAnchors.get(anchorId)?.turnId === entry.turnId)) {
        invalid(`Semantic Coverage claim ${claimId} does not support turn ${entry.turnId}`);
      }
      reachableClaims.add(claimId);
    }
  }
  for (const claimId of claimsById.keys()) {
    if (!reachableClaims.has(claimId)) {
      invalid(`Semantic Coverage claim ${claimId} is unreachable`);
    }
  }
}

export function buildEvidenceIndex(options) {
  const index = buildEvidenceIndexCore(options);
  validateStrictShape(index);
  return index;
}

export function validateEvidenceIndex(index) {
  validateEvidenceIndexCore(index);
  validateStrictShape(index);
  return index;
}

export function attachSemanticCoverage(index, semanticCoverage) {
  const next = structuredClone(index);
  next.semanticCoverage = structuredClone(semanticCoverage);
  delete next.integrity.indexDigest;
  next.integrity.indexDigest = sha256Text(canonicalStringify(next));
  return validateEvidenceIndex(next);
}

export function attachEvidenceKeyMap(index, evidenceKeyMap) {
  const next = structuredClone(index);
  next.evidenceKeyMap = structuredClone(evidenceKeyMap);
  delete next.integrity.indexDigest;
  next.integrity.indexDigest = sha256Text(canonicalStringify(next));
  return validateEvidenceIndex(next);
}

export async function readEvidenceIndex(indexPath) {
  return validateEvidenceIndex(await readEvidenceIndexCore(indexPath));
}

export async function retrieveEvidence(index, anchorId, dependencies = {}) {
  validateEvidenceIndex(index);
  return retrieveEvidenceCore(index, anchorId, dependencies);
}

export async function retrieveEvidenceFromFile(indexPath, anchorId, dependencies = {}) {
  return retrieveEvidence(await readEvidenceIndex(indexPath), anchorId, dependencies);
}

async function verifySourceRevision(index) {
  const current = await hashFileRevision(index.source.rolloutPath);
  if (
    current.sourceRevision !== index.source.sourceRevision ||
    current.sourceBytes !== index.source.sourceBytes
  ) {
    throw new ExportHandoffError(
      "SOURCE_CHANGED",
      "Source Thread rollout no longer matches the indexed revision",
      {
        expectedRevision: index.source.sourceRevision,
        actualRevision: current.sourceRevision,
        expectedBytes: index.source.sourceBytes,
        actualBytes: current.sourceBytes,
      },
    );
  }
}

export async function verifyEvidenceIndex(index, dependencies = {}) {
  validateEvidenceIndex(index);
  await verifySourceRevision(index);
  return verifyIndexedAnchors(index, dependencies);
}

export async function verifyEvidenceIndexFile(indexPath, dependencies = {}) {
  return verifyEvidenceIndex(await readEvidenceIndex(indexPath), dependencies);
}
