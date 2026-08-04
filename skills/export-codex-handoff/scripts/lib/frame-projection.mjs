import {
  canonicalStringify,
  sha256Text,
} from "./evidence-addressing.mjs";
import { ExportHandoffError } from "./source-thread.mjs";

function collectAnchorIds(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectAnchorIds(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "compressionFrame" || key === "frameProjection") continue;
    if (key === "anchors" && Array.isArray(nested)) {
      for (const anchorId of nested) {
        if (typeof anchorId === "string" && anchorId) output.add(anchorId);
      }
    } else if (
      typeof nested === "string" &&
      (key === "anchorId" || key.endsWith("Anchor"))
    ) {
      output.add(nested);
    } else {
      collectAnchorIds(nested, output);
    }
  }
  return output;
}

function validatedFrame(frozenFrame) {
  const frame = frozenFrame?.frame;
  if (!frame || frozenFrame.frameId !== frame.frameId || !frozenFrame.frameDigest) {
    throw new ExportHandoffError(
      "FRAME_NOT_VALIDATED",
      "A validated Compression Frame is required to project MAP context",
    );
  }
  return frame;
}

function collectSegmentAnchorIds(chunk) {
  return [...collectAnchorIds(chunk)].sort();
}

function evidenceIndexByAnchor(dictionary) {
  const byAnchor = new Map();
  for (const reference of dictionary.evidenceReferences || []) {
    if (
      !Number.isInteger(reference?.index) ||
      reference.index < 1 ||
      typeof reference.anchorId !== "string" ||
      !reference.anchorId ||
      byAnchor.has(reference.anchorId)
    ) {
      throw new ExportHandoffError(
        "INVALID_EVIDENCE_REFERENCE",
        "Evidence Reference Dictionary contains an invalid evidence reference",
      );
    }
    byAnchor.set(reference.anchorId, reference.index);
  }
  return byAnchor;
}

function projectClaim(claim, byAnchor) {
  return {
    claimId: claim.claimId,
    kind: claim.kind,
    text: claim.text,
    evidenceIndexes: (claim.anchors || [])
      .filter((anchorId) => byAnchor.has(anchorId))
      .map((anchorId) => byAnchor.get(anchorId)),
  };
}

export function evidenceReferenceDictionaryDigest(dictionary) {
  return `sha256:${sha256Text(canonicalStringify(dictionary))}`;
}

export function buildEvidenceReferenceDictionary(frozenFrame, chunk) {
  const frame = validatedFrame(frozenFrame);
  if (typeof chunk?.segmentId !== "string" || !chunk.segmentId) {
    throw new ExportHandoffError(
      "INVALID_EVIDENCE_REFERENCE",
      "A segment ID is required to build an Evidence Reference Dictionary",
    );
  }
  const anchors = collectSegmentAnchorIds(chunk);
  const evidenceReferences = anchors.map((anchorId, index) => ({
    index: index + 1,
    anchorId,
  }));
  const byAnchor = new Map(
    evidenceReferences.map((reference) => [reference.anchorId, reference.index]),
  );
  const exactIdentifierReferences = frame.preservationPolicy.exactIdentifiers
    .map((identifier) => ({
      kind: identifier.kind,
      value: identifier.value,
      evidenceIndexes: identifier.anchors
        .filter((anchorId) => byAnchor.has(anchorId))
        .map((anchorId) => byAnchor.get(anchorId)),
    }))
    .filter((identifier) => identifier.evidenceIndexes.length > 0)
    .map((identifier, index) => ({ index: index + 1, ...identifier }));
  return {
    formatVersion: 1,
    kind: "codex-handoff-evidence-reference-dictionary",
    frameId: frozenFrame.frameId,
    frameDigest: frozenFrame.frameDigest,
    segmentId: chunk.segmentId,
    evidenceReferences,
    exactIdentifierReferences,
  };
}

export function validateEvidenceReferenceDictionary(dictionary, frozenFrame, chunk) {
  const expected = buildEvidenceReferenceDictionary(frozenFrame, chunk);
  if (canonicalStringify(dictionary) !== canonicalStringify(expected)) {
    throw new ExportHandoffError(
      "MAP_DICTIONARY_CHANGED",
      `${chunk.segmentId} Evidence Reference Dictionary does not match its frozen frame and evidence`,
    );
  }
  return {
    dictionary,
    dictionaryDigest: evidenceReferenceDictionaryDigest(dictionary),
  };
}

export function resolveEvidenceReferences(dictionary, indexes) {
  if (!Array.isArray(indexes)) {
    throw new ExportHandoffError(
      "INVALID_EVIDENCE_REFERENCE",
      "Evidence references must be an array of local integer indexes",
    );
  }
  const references = new Map();
  for (const [offset, reference] of (dictionary?.evidenceReferences || []).entries()) {
    if (
      reference?.index !== offset + 1 ||
      typeof reference.anchorId !== "string" ||
      !reference.anchorId
    ) {
      throw new ExportHandoffError(
        "INVALID_EVIDENCE_REFERENCE",
        "Evidence Reference Dictionary indexes must be consecutive positive integers",
      );
    }
    references.set(reference.index, reference.anchorId);
  }
  const resolved = [];
  const seen = new Set();
  for (const index of indexes) {
    if (!Number.isInteger(index) || !references.has(index) || seen.has(index)) {
      throw new ExportHandoffError(
        "INVALID_EVIDENCE_REFERENCE",
        `Unknown or duplicate local evidence reference ${index}`,
      );
    }
    seen.add(index);
    resolved.push(references.get(index));
  }
  return resolved;
}

export function resolveExactIdentifierReferences(dictionary, indexes) {
  if (!Array.isArray(indexes)) {
    throw new ExportHandoffError(
      "INVALID_EVIDENCE_REFERENCE",
      "Exact identifier references must be an array of local integer indexes",
    );
  }
  const references = new Map();
  for (const [offset, reference] of (dictionary?.exactIdentifierReferences || []).entries()) {
    if (
      reference?.index !== offset + 1 ||
      typeof reference.kind !== "string" ||
      !reference.kind ||
      typeof reference.value !== "string" ||
      !reference.value
    ) {
      throw new ExportHandoffError(
        "INVALID_EVIDENCE_REFERENCE",
        "Evidence Reference Dictionary exact-identifier indexes must be consecutive positive integers",
      );
    }
    references.set(reference.index, reference);
  }
  const resolved = [];
  const seen = new Set();
  for (const index of indexes) {
    const reference = references.get(index);
    if (!Number.isInteger(index) || !reference || seen.has(index)) {
      throw new ExportHandoffError(
        "INVALID_EVIDENCE_REFERENCE",
        `Unknown or duplicate local exact-identifier reference ${index}`,
      );
    }
    seen.add(index);
    resolved.push({
      kind: reference.kind,
      value: reference.value,
      anchors: resolveEvidenceReferences(dictionary, reference.evidenceIndexes),
    });
  }
  return resolved;
}

export function buildReferenceFrameProjection(frozenFrame, chunk, dictionary) {
  const frame = validatedFrame(frozenFrame);
  validateEvidenceReferenceDictionary(dictionary, frozenFrame, chunk);
  const byAnchor = evidenceIndexByAnchor(dictionary);
  const terminalContract = frame.formatVersion === 2;
  return {
    formatVersion: terminalContract ? 3 : 2,
    kind: "codex-handoff-frame-projection",
    frameId: frozenFrame.frameId,
    frameDigest: frozenFrame.frameDigest,
    segmentId: chunk.segmentId,
    currentGoal: projectClaim(frame.currentGoal, byAnchor),
    ...(terminalContract ? {
      acceptedProposal: frame.acceptedProposal
        ? projectClaim(frame.acceptedProposal, byAnchor)
        : null,
      terminalStateClaim: projectClaim(frame.terminalStateClaim, byAnchor),
    } : {}),
    taskType: frame.taskType,
    taskPhase: frame.taskPhase,
    explicitExclusions: frame.explicitExclusions.map((claim) => projectClaim(claim, byAnchor)),
    preservationProjection: {
      sourceRevision: frame.preservationPolicy.sourceRevision,
      requiredEvidenceIndexes: frame.preservationPolicy.requiredAnchors
        .filter((anchorId) => byAnchor.has(anchorId))
        .map((anchorId) => byAnchor.get(anchorId)),
      exactIdentifierIndexes: dictionary.exactIdentifierReferences.map(({ index }) => index),
      criticalCategories: frame.preservationPolicy.criticalCategories,
    },
    globalObligationCounts: {
      requiredAnchors: frame.preservationPolicy.requiredAnchors.length,
      exactIdentifiers: frame.preservationPolicy.exactIdentifiers.length,
    },
  };
}

export function validateReferenceFrameProjection(
  projection,
  frozenFrame,
  chunk,
  dictionary,
) {
  const expected = buildReferenceFrameProjection(frozenFrame, chunk, dictionary);
  if (canonicalStringify(projection) !== canonicalStringify(expected)) {
    throw new ExportHandoffError(
      "MAP_CONTEXT_CHANGED",
      `${chunk.segmentId} Frame Projection does not match its dictionary, frozen frame, and evidence`,
    );
  }
  return {
    projection,
    contextDigest: frameProjectionDigest(projection),
  };
}

export function frameProjectionDigest(projection) {
  return `sha256:${sha256Text(canonicalStringify(projection))}`;
}

export function buildFrameProjection(frozenFrame, chunk) {
  const frame = validatedFrame(frozenFrame);
  const segmentAnchorIds = collectSegmentAnchorIds(chunk);
  const segmentAnchors = new Set(segmentAnchorIds);
  const policy = frame.preservationPolicy;
  const terminalContract = frame.formatVersion === 2;
  return {
    formatVersion: terminalContract ? 2 : 1,
    kind: "codex-handoff-frame-projection",
    frameId: frozenFrame.frameId,
    frameDigest: frozenFrame.frameDigest,
    currentGoal: frame.currentGoal,
    ...(terminalContract ? {
      acceptedProposal: frame.acceptedProposal,
      terminalStateClaim: frame.terminalStateClaim,
    } : {}),
    taskType: frame.taskType,
    taskPhase: frame.taskPhase,
    explicitExclusions: frame.explicitExclusions,
    preservationProjection: {
      sourceRevision: policy.sourceRevision,
      requiredAnchors: policy.requiredAnchors.filter((anchorId) => segmentAnchors.has(anchorId)),
      exactIdentifiers: policy.exactIdentifiers.filter((identifier) => (
        identifier.anchors.some((anchorId) => segmentAnchors.has(anchorId))
      )),
      criticalCategories: policy.criticalCategories,
    },
    segmentAnchorIds,
    globalObligationCounts: {
      requiredAnchors: policy.requiredAnchors.length,
      exactIdentifiers: policy.exactIdentifiers.length,
    },
  };
}

export function validateFrameProjection(projection, frozenFrame, chunk) {
  const expected = buildFrameProjection(frozenFrame, chunk);
  if (canonicalStringify(projection) !== canonicalStringify(expected)) {
    throw new ExportHandoffError(
      "MAP_CONTEXT_CHANGED",
      `${chunk.segmentId} Frame Projection does not match its frozen frame and evidence`,
    );
  }
  return {
    projection,
    contextDigest: frameProjectionDigest(projection),
  };
}
