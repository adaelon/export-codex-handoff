import {
  canonicalStringify,
  sha256Text,
} from "./evidence-addressing.mjs";
import { resolveEvidenceReferences } from "./frame-projection.mjs";
import { ExportHandoffError } from "./source-thread.mjs";

const MAP_CLAIM_FIELDS = [
  "objectiveFacts",
  "userConstraints",
  "completedWork",
  "openWork",
  "nextActions",
  "importantLocations",
  "conflicts",
];

const REDUCE_CLAIM_FIELDS = [
  "constraints",
  "completedWork",
  "openWork",
  "nextActions",
];

const DECISION_STATUSES = new Set(["active", "superseded", "rejected"]);
const VERIFICATION_RESULTS = new Set(["pass", "fail", "not_run", "unknown"]);
const SPARSE_MAP_KIND = "codex-handoff-sparse-map";
const CONTINUATION_MAP_KIND = "codex-handoff-continuation-map";
const COMPLETED_CONTINUATION_MAP_KIND = "codex-handoff-completed-continuation-map";
const CONTINUATION_CLAIM_TABLE_KIND = "codex-handoff-continuation-claim-table";
const CONTINUATION_COVERAGE_KIND = "codex-handoff-continuation-coverage";
const CONTINUATION_POLICY_IGNORED_REASON = "not selected by continuation policy";
const CONTINUATION_CLAIM_KINDS = new Set([
  "objective",
  "constraint",
  "completed_work",
  "open_work",
  "next_action",
  "important_location",
  "conflict",
  "decision",
  "rationale",
  "attempt_goal",
  "attempt_action",
  "attempt_outcome",
  "lesson",
  "verification",
]);
const CONTINUATION_EXCLUSION_REASONS = new Set([
  "superseded",
  "duplicate",
  "out_of_scope",
  "no_continuation_value",
]);
const SPARSE_EXCLUSION_REASONS = new Map([
  ["non_semantic", "excluded by sparse MAP: non-semantic evidence"],
  ["superseded", "excluded by sparse MAP: superseded evidence"],
  ["duplicate", "excluded by sparse MAP: duplicate evidence"],
  ["out_of_scope", "excluded by sparse MAP: out-of-scope evidence"],
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", `${label} must be an object`);
  }
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalStringify(actual) !== canonicalStringify(wanted)) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `${label} keys must be exactly ${wanted.join(", ")}`,
    );
  }
}

function requireAllowedKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `${label} has invalid fields`,
    );
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", `${label} must be a non-empty string`);
  }
}

function requireStringArray(value, label, options = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", `${label} must be a string array`);
  }
  if (options.nonEmpty && value.length === 0) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", `${label} must not be empty`);
  }
  if (new Set(value).size !== value.length) {
    throw new ExportHandoffError(
      options.duplicateCode || "DUPLICATE_PROVENANCE",
      `${label} contains duplicate values`,
    );
  }
}

function requirePositiveIntegerArray(value, label, options = {}) {
  if (
    !Array.isArray(value) ||
    value.some((item) => !Number.isInteger(item) || item < 1)
  ) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `${label} must be an array of positive integers`,
    );
  }
  if (options.nonEmpty && value.length === 0) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", `${label} must not be empty`);
  }
  if (new Set(value).size !== value.length) {
    throw new ExportHandoffError(
      options.duplicateCode || "DUPLICATE_CLAIM",
      `${label} contains duplicate values`,
    );
  }
}

function sameSet(actual, expected) {
  return actual.size === expected.size && [...actual].every((item) => expected.has(item));
}

function validateFrameBinding(result, expectedFrame) {
  if (!expectedFrame?.frameId || !expectedFrame?.frameDigest) {
    throw new ExportHandoffError(
      "FRAME_NOT_VALIDATED",
      "Compression Frame must be validated before semantic results",
    );
  }
  if (result.frameId !== expectedFrame.frameId) {
    throw new ExportHandoffError(
      "FRAME_ID_MISMATCH",
      `Expected frameId ${expectedFrame.frameId}; received ${result.frameId ?? "<missing>"}`,
    );
  }
  if (result.frameDigest !== expectedFrame.frameDigest) {
    throw new ExportHandoffError(
      "FRAME_DIGEST_MISMATCH",
      `Expected frameDigest ${expectedFrame.frameDigest}; received ${result.frameDigest ?? "<missing>"}`,
    );
  }
}

function collectAnchorIds(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectAnchorIds(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, nested] of Object.entries(value)) {
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

function claimFingerprint(claim) {
  return JSON.stringify([
    claim.kind,
    claim.text,
    [...claim.anchors].sort(),
  ]);
}

function validateClaim(claim, label, knownAnchors, unknownAnchorCode = "UNSUPPORTED_CLAIM") {
  requireObject(claim, label);
  requireString(claim.claimId, `${label}.claimId`);
  requireString(claim.kind, `${label}.kind`);
  requireString(claim.text, `${label}.text`);
  requireStringArray(claim.anchors, `${label}.anchors`, {
    nonEmpty: true,
    duplicateCode: "DUPLICATE_CLAIM",
  });
  if (knownAnchors) {
    for (const anchorId of claim.anchors) {
      if (!knownAnchors.has(anchorId)) {
        throw new ExportHandoffError(
          unknownAnchorCode,
          `${claim.claimId} references unknown Evidence Anchor ${anchorId}`,
        );
      }
    }
  }
  return claim;
}

function validateClaimArray(value, label, knownAnchors, claims, unknownAnchorCode) {
  if (!Array.isArray(value)) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", `${label} must be an array`);
  }
  for (const [index, claim] of value.entries()) {
    claims.push(validateClaim(
      claim,
      `${label}[${index}]`,
      knownAnchors,
      unknownAnchorCode,
    ));
  }
}

function verificationAsClaim(entry) {
  return {
    claimId: entry.claimId,
    kind: "verification",
    text: `${entry.command} => ${entry.result}`,
    anchors: entry.anchors,
  };
}

function validateArchivalLedger(
  ledger,
  label,
  knownAnchors,
  claims,
  unknownAnchorCode,
  options = {},
) {
  requireObject(ledger, label);
  for (const field of ["decisions", "attempts", "verification"]) {
    if (!Array.isArray(ledger[field])) {
      throw new ExportHandoffError("INVALID_ARCHIVAL_LEDGER", `${label}.${field} must be an array`);
    }
  }

  const earlierDecisions = new Set();
  const decisionsById = new Map();
  for (const [index, decision] of ledger.decisions.entries()) {
    const itemLabel = `${label}.decisions[${index}]`;
    requireObject(decision, itemLabel);
    const statement = validateClaim(
      decision.statement,
      `${itemLabel}.statement`,
      knownAnchors,
      unknownAnchorCode,
    );
    claims.push(statement);
    validateClaimArray(
      decision.rationale,
      `${itemLabel}.rationale`,
      knownAnchors,
      claims,
      unknownAnchorCode,
    );
    if (!DECISION_STATUSES.has(decision.status)) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `${itemLabel}.status must be active, superseded, or rejected`,
      );
    }
    requireStringArray(decision.supersedes, `${itemLabel}.supersedes`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    for (const supersededId of decision.supersedes) {
      if (!earlierDecisions.has(supersededId) && !options.allowExternalSupersedes) {
        throw new ExportHandoffError(
          "INVALID_ARCHIVAL_LEDGER",
          `${statement.claimId} supersedes unknown or later decision ${supersededId}`,
        );
      }
    }
    earlierDecisions.add(statement.claimId);
    decisionsById.set(statement.claimId, decision);
  }
  for (const decision of ledger.decisions) {
    for (const supersededId of decision.supersedes) {
      const superseded = decisionsById.get(supersededId);
      if (superseded && superseded.status !== "superseded") {
        throw new ExportHandoffError(
          "INVALID_ARCHIVAL_LEDGER",
          `${supersededId} must be marked superseded`,
        );
      }
    }
  }

  for (const [index, attempt] of ledger.attempts.entries()) {
    const itemLabel = `${label}.attempts[${index}]`;
    requireObject(attempt, itemLabel);
    for (const field of ["goal", "action", "outcome"]) {
      claims.push(validateClaim(
        attempt[field],
        `${itemLabel}.${field}`,
        knownAnchors,
        unknownAnchorCode,
      ));
    }
    if (attempt.failureClass !== undefined) {
      requireString(attempt.failureClass, `${itemLabel}.failureClass`);
    }
    if (attempt.lesson !== undefined && attempt.lesson !== null) {
      claims.push(validateClaim(
        attempt.lesson,
        `${itemLabel}.lesson`,
        knownAnchors,
        unknownAnchorCode,
      ));
    }
  }

  for (const [index, verification] of ledger.verification.entries()) {
    const itemLabel = `${label}.verification[${index}]`;
    requireObject(verification, itemLabel);
    requireString(verification.claimId, `${itemLabel}.claimId`);
    requireString(verification.command, `${itemLabel}.command`);
    if (!VERIFICATION_RESULTS.has(verification.result)) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `${itemLabel}.result must be pass, fail, not_run, or unknown`,
      );
    }
    const normalized = verificationAsClaim(verification);
    validateClaim(normalized, itemLabel, knownAnchors, unknownAnchorCode);
    claims.push(normalized);
  }
}

function validateUniqueClaims(claims) {
  const byId = new Set();
  const byContent = new Set();
  for (const claim of claims) {
    if (byId.has(claim.claimId)) {
      throw new ExportHandoffError("DUPLICATE_CLAIM", `Duplicate claimId ${claim.claimId}`);
    }
    byId.add(claim.claimId);
    const fingerprint = claimFingerprint(claim);
    if (byContent.has(fingerprint)) {
      throw new ExportHandoffError(
        "DUPLICATE_CLAIM",
        `Duplicate claim content for ${claim.claimId}`,
      );
    }
    byContent.add(fingerprint);
  }
}

function cloneClaim(claim) {
  return {
    claimId: claim.claimId,
    kind: claim.kind,
    text: claim.text,
    anchors: [...claim.anchors],
  };
}

function resolveSparseClaim(claimsById, referenceCounts, claimId, label) {
  requireString(claimId, label);
  const claim = claimsById.get(claimId);
  if (!claim) {
    throw new ExportHandoffError(
      "UNSUPPORTED_CLAIM",
      `${label} references unknown claim ${claimId}`,
    );
  }
  referenceCounts.set(claimId, (referenceCounts.get(claimId) || 0) + 1);
  return claim;
}

function sparseEvidenceSequence(chunk) {
  let expectedIds;
  let items;
  let idField;
  let coverageField;
  if (chunk.stage === "segment_map") {
    expectedIds = chunk.expectedTurnIds;
    items = chunk.turns;
    idField = "turnId";
    coverageField = "turnCoverage";
  } else if (chunk.stage === "fragment_map") {
    expectedIds = chunk.expectedFragmentIds;
    items = chunk.fragments;
    idField = "fragmentId";
    coverageField = "fragmentCoverage";
  } else {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `Sparse MAP does not support stage ${chunk.stage ?? "<missing>"}`,
    );
  }
  if (
    !Array.isArray(expectedIds) ||
    !Array.isArray(items) ||
    expectedIds.length !== items.length ||
    items.some((item, index) => item?.[idField] !== expectedIds[index])
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_SPARSE_COVERAGE",
      `Sparse MAP evidence must match ordered ${idField} values`,
    );
  }
  return {
    coverageField,
    expectedIds,
    anchorsByIndex: items.map((item) => collectAnchorIds(item)),
  };
}

function expandSparseArchivalLedger(ledger, claimsById, referenceCounts) {
  requireObject(ledger, "archivalLedger");
  for (const field of ["decisions", "attempts", "verification"]) {
    if (!Array.isArray(ledger[field])) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `archivalLedger.${field} must be an array`,
      );
    }
  }

  const decisions = ledger.decisions.map((decision, index) => {
    const label = `archivalLedger.decisions[${index}]`;
    requireObject(decision, label);
    const statement = resolveSparseClaim(
      claimsById,
      referenceCounts,
      decision.statementClaimId,
      `${label}.statementClaimId`,
    );
    requireStringArray(decision.rationaleClaimIds, `${label}.rationaleClaimIds`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    if (!DECISION_STATUSES.has(decision.status)) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `${label}.status must be active, superseded, or rejected`,
      );
    }
    requireStringArray(decision.supersedes, `${label}.supersedes`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    return {
      statement: cloneClaim(statement),
      rationale: decision.rationaleClaimIds.map((claimId, rationaleIndex) => cloneClaim(
        resolveSparseClaim(
          claimsById,
          referenceCounts,
          claimId,
          `${label}.rationaleClaimIds[${rationaleIndex}]`,
        ),
      )),
      status: decision.status,
      supersedes: [...decision.supersedes],
    };
  });

  const attempts = ledger.attempts.map((attempt, index) => {
    const label = `archivalLedger.attempts[${index}]`;
    requireObject(attempt, label);
    const expanded = {};
    for (const [sourceField, targetField] of [
      ["goalClaimId", "goal"],
      ["actionClaimId", "action"],
      ["outcomeClaimId", "outcome"],
    ]) {
      expanded[targetField] = cloneClaim(resolveSparseClaim(
        claimsById,
        referenceCounts,
        attempt[sourceField],
        `${label}.${sourceField}`,
      ));
    }
    if (attempt.failureClass !== undefined) {
      requireString(attempt.failureClass, `${label}.failureClass`);
      expanded.failureClass = attempt.failureClass;
    }
    if (attempt.lessonClaimId !== undefined && attempt.lessonClaimId !== null) {
      expanded.lesson = cloneClaim(resolveSparseClaim(
        claimsById,
        referenceCounts,
        attempt.lessonClaimId,
        `${label}.lessonClaimId`,
      ));
    }
    return expanded;
  });

  const verification = ledger.verification.map((entry, index) => {
    const label = `archivalLedger.verification[${index}]`;
    requireObject(entry, label);
    const claim = resolveSparseClaim(
      claimsById,
      referenceCounts,
      entry.claimId,
      `${label}.claimId`,
    );
    requireString(entry.command, `${label}.command`);
    if (!VERIFICATION_RESULTS.has(entry.result)) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `${label}.result must be pass, fail, not_run, or unknown`,
      );
    }
    if (claim.kind !== "verification" || claim.text !== `${entry.command} => ${entry.result}`) {
      throw new ExportHandoffError(
        "UNSUPPORTED_CLAIM",
        `${entry.claimId} does not match its deterministic verification representation`,
      );
    }
    return {
      claimId: claim.claimId,
      command: entry.command,
      result: entry.result,
      anchors: [...claim.anchors],
    };
  });

  return { decisions, attempts, verification };
}

function buildSparseMapExpansion(result, chunk, expectedFrame) {
  requireObject(result, "Sparse MAP result");
  if (result.formatVersion !== 1 || result.kind !== SPARSE_MAP_KIND) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `Sparse MAP result must use formatVersion 1 and kind ${SPARSE_MAP_KIND}`,
    );
  }
  validateFrameBinding(result, expectedFrame || {
    frameId: chunk.compressionFrame?.frameId,
    frameDigest: chunk.frameDigest,
  });
  if (result.segmentId !== chunk.segmentId) {
    throw new ExportHandoffError("SEGMENT_ID_MISMATCH", `MAP returned ${result.segmentId}`);
  }

  const sequence = sparseEvidenceSequence(chunk);
  const knownAnchors = collectAnchorIds(chunk);
  const claims = [];
  validateClaimArray(result.claims, "claims", knownAnchors, claims, "UNSUPPORTED_CLAIM");
  validateUniqueClaims(claims);
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const referenceCounts = new Map(claims.map((claim) => [claim.claimId, 0]));

  requireObject(result.claimGroups, "claimGroups");
  const expandedGroups = {};
  for (const field of MAP_CLAIM_FIELDS) {
    requireStringArray(result.claimGroups[field], `claimGroups.${field}`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    expandedGroups[field] = result.claimGroups[field].map((claimId, index) => cloneClaim(
      resolveSparseClaim(
        claimsById,
        referenceCounts,
        claimId,
        `claimGroups.${field}[${index}]`,
      ),
    ));
  }
  const archivalLedger = expandSparseArchivalLedger(
    result.archivalLedger,
    claimsById,
    referenceCounts,
  );
  for (const claim of claims) {
    const count = referenceCounts.get(claim.claimId);
    if (count === 0) {
      throw new ExportHandoffError(
        "UNSUPPORTED_CLAIM",
        `${claim.claimId} is not referenced by a claim group or Archival Ledger entry`,
      );
    }
    if (count > 1) {
      throw new ExportHandoffError(
        "DUPLICATE_CLAIM",
        `${claim.claimId} is referenced by more than one semantic container`,
      );
    }
  }

  if (!Array.isArray(result.claimBindings)) {
    throw new ExportHandoffError(
      "INCOMPLETE_SPARSE_COVERAGE",
      "claimBindings must be an array",
    );
  }
  const boundClaimIds = new Set();
  const claimIdsByIndex = sequence.expectedIds.map(() => []);
  for (const [bindingIndex, binding] of result.claimBindings.entries()) {
    const label = `claimBindings[${bindingIndex}]`;
    requireObject(binding, label);
    requireString(binding.claimId, `${label}.claimId`);
    const claim = claimsById.get(binding.claimId);
    if (!claim) {
      throw new ExportHandoffError(
        "UNSUPPORTED_CLAIM",
        `${label} references unknown claim ${binding.claimId}`,
      );
    }
    if (boundClaimIds.has(binding.claimId)) {
      throw new ExportHandoffError(
        "DUPLICATE_CLAIM",
        `${binding.claimId} has more than one sparse binding`,
      );
    }
    boundClaimIds.add(binding.claimId);
    if (
      !Array.isArray(binding.evidenceIndexes) ||
      binding.evidenceIndexes.length === 0 ||
      binding.evidenceIndexes.some((index) => !Number.isInteger(index)) ||
      new Set(binding.evidenceIndexes).size !== binding.evidenceIndexes.length
    ) {
      throw new ExportHandoffError(
        "INCOMPLETE_SPARSE_COVERAGE",
        `${label}.evidenceIndexes must contain unique integer indexes`,
      );
    }
    for (const evidenceIndex of binding.evidenceIndexes) {
      if (evidenceIndex < 0 || evidenceIndex >= sequence.expectedIds.length) {
        throw new ExportHandoffError(
          "INCOMPLETE_SPARSE_COVERAGE",
          `${label} references out-of-range evidence index ${evidenceIndex}`,
        );
      }
      if (!claim.anchors.some((anchorId) => sequence.anchorsByIndex[evidenceIndex].has(anchorId))) {
        throw new ExportHandoffError(
          "INCOMPLETE_SPARSE_COVERAGE",
          `${binding.claimId} has no Evidence Anchor for evidence index ${evidenceIndex}`,
        );
      }
      claimIdsByIndex[evidenceIndex].push(binding.claimId);
    }
  }
  for (const claim of claims) {
    if (!boundClaimIds.has(claim.claimId)) {
      throw new ExportHandoffError(
        "UNSUPPORTED_CLAIM",
        `${claim.claimId} is not reachable from claimBindings`,
      );
    }
  }

  if (!Array.isArray(result.exclusionRanges)) {
    throw new ExportHandoffError(
      "INCOMPLETE_SPARSE_COVERAGE",
      "exclusionRanges must be an array",
    );
  }
  const exclusionsByIndex = sequence.expectedIds.map(() => null);
  for (const [rangeIndex, range] of result.exclusionRanges.entries()) {
    const label = `exclusionRanges[${rangeIndex}]`;
    requireObject(range, label);
    if (
      !Number.isInteger(range.startIndex) ||
      !Number.isInteger(range.endIndexExclusive) ||
      range.startIndex < 0 ||
      range.endIndexExclusive <= range.startIndex ||
      range.endIndexExclusive > sequence.expectedIds.length
    ) {
      throw new ExportHandoffError(
        "INCOMPLETE_SPARSE_COVERAGE",
        `${label} is outside the ordered evidence range`,
      );
    }
    const reason = SPARSE_EXCLUSION_REASONS.get(range.reasonCode);
    if (!reason) {
      throw new ExportHandoffError(
        "INVALID_MODEL_OUTPUT",
        `${label}.reasonCode is invalid`,
      );
    }
    for (let index = range.startIndex; index < range.endIndexExclusive; index += 1) {
      if (claimIdsByIndex[index].length > 0 || exclusionsByIndex[index] !== null) {
        throw new ExportHandoffError(
          "OVERLAPPING_SPARSE_COVERAGE",
          `${label} overlaps evidence index ${index}`,
        );
      }
      exclusionsByIndex[index] = reason;
    }
  }

  const coverage = sequence.expectedIds.map((evidenceId, index) => {
    const claimIds = claimIdsByIndex[index];
    if (claimIds.length > 0) {
      return {
        [sequence.coverageField === "turnCoverage" ? "turnId" : "fragmentId"]: evidenceId,
        status: "summarized",
        claimIds: [...claimIds],
        reason: "captured by sparse MAP claim bindings",
      };
    }
    const reason = exclusionsByIndex[index];
    if (!reason) {
      throw new ExportHandoffError(
        "INCOMPLETE_SPARSE_COVERAGE",
        `Evidence index ${index} is neither bound nor excluded`,
      );
    }
    return {
      [sequence.coverageField === "turnCoverage" ? "turnId" : "fragmentId"]: evidenceId,
      status: "ignored",
      claimIds: [],
      reason,
    };
  });
  requireStringArray(result.compressionNotes, "compressionNotes");

  const expanded = {
    frameId: result.frameId,
    frameDigest: result.frameDigest,
    segmentId: result.segmentId,
    [sequence.coverageField]: coverage,
    ...expandedGroups,
    archivalLedger,
    compressionNotes: [...result.compressionNotes],
  };
  validateMapResult(expanded, chunk, expectedFrame);
  return expanded;
}

export function validateSparseMapResult(result, chunk, expectedFrame = undefined) {
  buildSparseMapExpansion(result, chunk, expectedFrame);
  return result;
}

export function expandSparseMapResult(result, chunk, expectedFrame = undefined) {
  return buildSparseMapExpansion(result, chunk, expectedFrame);
}

function continuationClaimByLocalId(claimsByLocalId, localId, label, expectedKind) {
  if (!Number.isInteger(localId) || localId < 1) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `${label} must be a positive local Claim ID`,
    );
  }
  const claim = claimsByLocalId.get(localId);
  if (!claim) {
    throw new ExportHandoffError(
      "UNSUPPORTED_CLAIM",
      `${label} references unknown local Claim ${localId}`,
    );
  }
  if (expectedKind && claim.kind !== expectedKind) {
    throw new ExportHandoffError(
      "INVALID_ARCHIVAL_LEDGER",
      `${label} must reference a ${expectedKind} Claim`,
    );
  }
  return claim;
}

function validateContinuationRelations(relations, claimsByLocalId) {
  requireObject(relations, "relations");
  requireExactKeys(relations, ["decisions", "attempts", "verification"], "relations");
  for (const field of ["decisions", "attempts", "verification"]) {
    if (!Array.isArray(relations[field])) {
      throw new ExportHandoffError("INVALID_ARCHIVAL_LEDGER", `relations.${field} must be an array`);
    }
  }

  const earlierDecisions = new Set();
  for (const [index, decision] of relations.decisions.entries()) {
    const label = `relations.decisions[${index}]`;
    requireObject(decision, label);
    requireExactKeys(
      decision,
      ["statement", "rationale", "status", "supersedes"],
      label,
    );
    const statement = continuationClaimByLocalId(
      claimsByLocalId,
      decision.statement,
      `${label}.statement`,
      "decision",
    );
    requirePositiveIntegerArray(decision.rationale, `${label}.rationale`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    for (const [rationaleIndex, localId] of decision.rationale.entries()) {
      continuationClaimByLocalId(
        claimsByLocalId,
        localId,
        `${label}.rationale[${rationaleIndex}]`,
        "rationale",
      );
    }
    if (!DECISION_STATUSES.has(decision.status)) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `${label}.status must be active, superseded, or rejected`,
      );
    }
    requirePositiveIntegerArray(decision.supersedes, `${label}.supersedes`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    for (const localId of decision.supersedes) {
      continuationClaimByLocalId(
        claimsByLocalId,
        localId,
        `${label}.supersedes`,
        "decision",
      );
      if (!earlierDecisions.has(localId)) {
        throw new ExportHandoffError(
          "INVALID_ARCHIVAL_LEDGER",
          `${statement.localId} supersedes unknown or later decision ${localId}`,
        );
      }
    }
    earlierDecisions.add(statement.localId);
  }

  for (const [index, attempt] of relations.attempts.entries()) {
    const label = `relations.attempts[${index}]`;
    requireObject(attempt, label);
    requireAllowedKeys(
      attempt,
      ["goal", "action", "outcome"],
      ["lesson", "failureClass"],
      label,
    );
    continuationClaimByLocalId(claimsByLocalId, attempt.goal, `${label}.goal`, "attempt_goal");
    continuationClaimByLocalId(
      claimsByLocalId,
      attempt.action,
      `${label}.action`,
      "attempt_action",
    );
    continuationClaimByLocalId(
      claimsByLocalId,
      attempt.outcome,
      `${label}.outcome`,
      "attempt_outcome",
    );
    if (Object.hasOwn(attempt, "lesson")) {
      continuationClaimByLocalId(
        claimsByLocalId,
        attempt.lesson,
        `${label}.lesson`,
        "lesson",
      );
    }
    if (Object.hasOwn(attempt, "failureClass")) {
      requireString(attempt.failureClass, `${label}.failureClass`);
    }
  }

  for (const [index, verification] of relations.verification.entries()) {
    const label = `relations.verification[${index}]`;
    requireObject(verification, label);
    requireExactKeys(verification, ["claim", "command", "result"], label);
    const claim = continuationClaimByLocalId(
      claimsByLocalId,
      verification.claim,
      `${label}.claim`,
      "verification",
    );
    requireString(verification.command, `${label}.command`);
    if (!VERIFICATION_RESULTS.has(verification.result)) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `${label}.result must be pass, fail, not_run, or unknown`,
      );
    }
    if (claim.text !== `${verification.command} => ${verification.result}`) {
      throw new ExportHandoffError(
        "UNSUPPORTED_CLAIM",
        `${label}.claim does not match its deterministic verification representation`,
      );
    }
  }
}

function validateContinuationCandidate(result, dictionary, expectedFrame) {
  requireObject(result, "Continuation MAP result");
  requireExactKeys(
    result,
    [
      "formatVersion",
      "kind",
      "frameId",
      "frameDigest",
      "segmentId",
      "claims",
      "relations",
      "criticalExclusions",
    ],
    "Continuation MAP result",
  );
  if (result.formatVersion !== 1 || result.kind !== CONTINUATION_MAP_KIND) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `Continuation MAP result must use formatVersion 1 and kind ${CONTINUATION_MAP_KIND}`,
    );
  }
  validateFrameBinding(result, expectedFrame);
  if (result.segmentId !== dictionary?.segmentId) {
    throw new ExportHandoffError(
      "SEGMENT_ID_MISMATCH",
      `MAP returned ${result.segmentId ?? "<missing>"}`,
    );
  }
  if (!Array.isArray(result.claims)) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", "claims must be an array");
  }

  const claimsByLocalId = new Map();
  const fingerprints = new Set();
  for (const [index, claim] of result.claims.entries()) {
    const label = `claims[${index}]`;
    requireObject(claim, label);
    requireExactKeys(claim, ["localId", "kind", "text", "evidenceIndexes"], label);
    if (!Number.isInteger(claim.localId) || claim.localId < 1) {
      throw new ExportHandoffError("INVALID_MODEL_OUTPUT", `${label}.localId must be positive`);
    }
    if (claimsByLocalId.has(claim.localId)) {
      throw new ExportHandoffError("DUPLICATE_CLAIM", `Duplicate local Claim ${claim.localId}`);
    }
    if (!CONTINUATION_CLAIM_KINDS.has(claim.kind)) {
      throw new ExportHandoffError(
        "INVALID_MODEL_OUTPUT",
        `${label}.kind is not a Continuation MAP Claim kind`,
      );
    }
    requireString(claim.text, `${label}.text`);
    requirePositiveIntegerArray(claim.evidenceIndexes, `${label}.evidenceIndexes`, {
      nonEmpty: true,
      duplicateCode: "INVALID_EVIDENCE_REFERENCE",
    });
    const anchors = resolveEvidenceReferences(dictionary, claim.evidenceIndexes);
    const fingerprint = canonicalStringify([claim.kind, claim.text, anchors]);
    if (fingerprints.has(fingerprint)) {
      throw new ExportHandoffError(
        "DUPLICATE_CLAIM",
        `${label} duplicates another Continuation MAP Claim`,
      );
    }
    fingerprints.add(fingerprint);
    claimsByLocalId.set(claim.localId, claim);
  }
  validateContinuationRelations(result.relations, claimsByLocalId);

  if (!Array.isArray(result.criticalExclusions)) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      "criticalExclusions must be an array",
    );
  }
  const excludedIndexes = new Set();
  for (const [index, exclusion] of result.criticalExclusions.entries()) {
    const label = `criticalExclusions[${index}]`;
    requireObject(exclusion, label);
    requireExactKeys(exclusion, ["evidenceIndex", "reasonCode"], label);
    if (!Number.isInteger(exclusion.evidenceIndex) || exclusion.evidenceIndex < 1) {
      throw new ExportHandoffError(
        "INVALID_EVIDENCE_REFERENCE",
        `${label}.evidenceIndex must be a positive local evidence reference`,
      );
    }
    if (excludedIndexes.has(exclusion.evidenceIndex)) {
      throw new ExportHandoffError(
        "INVALID_EVIDENCE_REFERENCE",
        `${label}.evidenceIndex is duplicated`,
      );
    }
    resolveEvidenceReferences(dictionary, [exclusion.evidenceIndex]);
    excludedIndexes.add(exclusion.evidenceIndex);
    if (!CONTINUATION_EXCLUSION_REASONS.has(exclusion.reasonCode)) {
      throw new ExportHandoffError(
        "INVALID_MODEL_OUTPUT",
        `${label}.reasonCode is invalid`,
      );
    }
  }
  return { result, claimsByLocalId };
}

export function validateContinuationMapResult(result, dictionary, expectedFrame) {
  validateContinuationCandidate(result, dictionary, expectedFrame);
  return result;
}

export function completeContinuationMapResult(result, dictionary, expectedFrame) {
  const { claimsByLocalId } = validateContinuationCandidate(
    result,
    dictionary,
    expectedFrame,
  );
  const completedClaims = result.claims.map((claim) => {
    const anchors = resolveEvidenceReferences(dictionary, claim.evidenceIndexes);
    return {
      claimId: `claim-${sha256Text(canonicalStringify({
        kind: claim.kind,
        text: claim.text,
        anchors,
      }))}`,
      kind: claim.kind,
      text: claim.text,
      evidenceIndexes: [...claim.evidenceIndexes],
      anchors,
    };
  });
  const globalIdByLocalId = new Map(
    result.claims.map((claim, index) => [claim.localId, completedClaims[index].claimId]),
  );
  if (new Set(globalIdByLocalId.values()).size !== completedClaims.length) {
    throw new ExportHandoffError(
      "DUPLICATE_CLAIM",
      "Continuation MAP completion generated duplicate global Claim IDs",
    );
  }
  const globalId = (localId) => {
    continuationClaimByLocalId(claimsByLocalId, localId, "relation reference");
    return globalIdByLocalId.get(localId);
  };
  return {
    formatVersion: 1,
    kind: COMPLETED_CONTINUATION_MAP_KIND,
    frameId: result.frameId,
    frameDigest: result.frameDigest,
    segmentId: result.segmentId,
    claims: completedClaims,
    relations: {
      decisions: result.relations.decisions.map((decision) => ({
        statement: globalId(decision.statement),
        rationale: decision.rationale.map(globalId),
        status: decision.status,
        supersedes: decision.supersedes.map(globalId),
      })),
      attempts: result.relations.attempts.map((attempt) => ({
        goal: globalId(attempt.goal),
        action: globalId(attempt.action),
        outcome: globalId(attempt.outcome),
        ...(Object.hasOwn(attempt, "lesson") ? { lesson: globalId(attempt.lesson) } : {}),
        ...(Object.hasOwn(attempt, "failureClass")
          ? { failureClass: attempt.failureClass }
          : {}),
      })),
      verification: result.relations.verification.map((verification) => ({
        claim: globalId(verification.claim),
        command: verification.command,
        result: verification.result,
      })),
    },
    criticalExclusions: result.criticalExclusions.map((exclusion) => ({
      evidenceIndex: exclusion.evidenceIndex,
      anchorId: resolveEvidenceReferences(dictionary, [exclusion.evidenceIndex])[0],
      reasonCode: exclusion.reasonCode,
    })),
  };
}

function continuationEvidenceAnchorLookup(evidenceIndex) {
  if (!Array.isArray(evidenceIndex?.anchors)) {
    throw new ExportHandoffError(
      "EVIDENCE_INDEX_REQUIRED",
      "Continuation Coverage requires the persisted Evidence Index",
    );
  }
  const byId = new Map();
  for (const entry of evidenceIndex.anchors) {
    const anchor = entry?.anchor;
    if (
      typeof anchor?.anchorId !== "string" ||
      !anchor.anchorId ||
      byId.has(anchor.anchorId)
    ) {
      throw new ExportHandoffError(
        "INVALID_EVIDENCE_REFERENCE",
        "Evidence Index contains an invalid or duplicate Evidence Anchor",
      );
    }
    byId.set(anchor.anchorId, anchor);
  }
  return byId;
}

function validateCompletedContinuationClaim(claim, label, knownAnchors) {
  requireObject(claim, label);
  requireExactKeys(
    claim,
    ["claimId", "kind", "text", "evidenceIndexes", "anchors"],
    label,
  );
  requireString(claim.claimId, `${label}.claimId`);
  if (!CONTINUATION_CLAIM_KINDS.has(claim.kind)) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `${label}.kind is not a Continuation MAP Claim kind`,
    );
  }
  requireString(claim.text, `${label}.text`);
  requirePositiveIntegerArray(claim.evidenceIndexes, `${label}.evidenceIndexes`, {
    nonEmpty: true,
    duplicateCode: "INVALID_EVIDENCE_REFERENCE",
  });
  requireStringArray(claim.anchors, `${label}.anchors`, {
    nonEmpty: true,
    duplicateCode: "INVALID_EVIDENCE_REFERENCE",
  });
  for (const anchorId of claim.anchors) {
    if (!knownAnchors.has(anchorId)) {
      throw new ExportHandoffError(
        "UNKNOWN_EVIDENCE_ANCHOR",
        `${claim.claimId} references unknown Evidence Anchor ${anchorId}`,
      );
    }
  }
}

function appendUniqueRelation(output, seen, relation) {
  const fingerprint = canonicalStringify(relation);
  if (!seen.has(fingerprint)) {
    seen.add(fingerprint);
    output.push(structuredClone(relation));
  }
}

function validateContinuationGlobalRelations(relations, claimsById, label) {
  requireObject(relations, label);
  requireExactKeys(relations, ["decisions", "attempts", "verification"], label);
  for (const field of ["decisions", "attempts", "verification"]) {
    if (!Array.isArray(relations[field])) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `${label}.${field} must be an array`,
      );
    }
  }
  const requireClaimId = (claimId, relationLabel) => {
    requireString(claimId, relationLabel);
    if (!claimsById.has(claimId)) {
      throw new ExportHandoffError(
        "UNSUPPORTED_CLAIM",
        `${relationLabel} references unknown Claim ${claimId}`,
      );
    }
  };
  for (const [index, decision] of relations.decisions.entries()) {
    const relationLabel = `${label}.decisions[${index}]`;
    requireObject(decision, relationLabel);
    requireExactKeys(
      decision,
      ["statement", "rationale", "status", "supersedes"],
      relationLabel,
    );
    requireClaimId(decision.statement, `${relationLabel}.statement`);
    requireStringArray(decision.rationale, `${relationLabel}.rationale`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    requireStringArray(decision.supersedes, `${relationLabel}.supersedes`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    for (const claimId of [...decision.rationale, ...decision.supersedes]) {
      requireClaimId(claimId, relationLabel);
    }
    if (!DECISION_STATUSES.has(decision.status)) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `${relationLabel}.status is invalid`,
      );
    }
  }
  for (const [index, attempt] of relations.attempts.entries()) {
    const relationLabel = `${label}.attempts[${index}]`;
    requireObject(attempt, relationLabel);
    requireAllowedKeys(
      attempt,
      ["goal", "action", "outcome"],
      ["lesson", "failureClass"],
      relationLabel,
    );
    for (const field of ["goal", "action", "outcome", "lesson"]) {
      if (Object.hasOwn(attempt, field)) {
        requireClaimId(attempt[field], `${relationLabel}.${field}`);
      }
    }
    if (Object.hasOwn(attempt, "failureClass")) {
      requireString(attempt.failureClass, `${relationLabel}.failureClass`);
    }
  }
  for (const [index, verification] of relations.verification.entries()) {
    const relationLabel = `${label}.verification[${index}]`;
    requireObject(verification, relationLabel);
    requireExactKeys(verification, ["claim", "command", "result"], relationLabel);
    requireClaimId(verification.claim, `${relationLabel}.claim`);
    requireString(verification.command, `${relationLabel}.command`);
    if (!VERIFICATION_RESULTS.has(verification.result)) {
      throw new ExportHandoffError(
        "INVALID_ARCHIVAL_LEDGER",
        `${relationLabel}.result is invalid`,
      );
    }
  }
}

function collectCompletedContinuationMaps(completedMaps, evidenceIndex) {
  if (!Array.isArray(completedMaps) || completedMaps.length === 0) {
    throw new ExportHandoffError(
      "INCOMPLETE_CONTINUATION_COVERAGE",
      "Continuation Coverage requires at least one completed MAP result",
    );
  }
  const knownAnchors = continuationEvidenceAnchorLookup(evidenceIndex);
  const claims = [];
  const claimsById = new Map();
  const claimIdByFingerprint = new Map();
  const exclusions = [];
  const relations = { decisions: [], attempts: [], verification: [] };
  const relationFingerprints = {
    decisions: new Set(),
    attempts: new Set(),
    verification: new Set(),
  };
  const segmentIds = new Set();
  let frameId = null;
  let frameDigest = null;

  for (const [mapIndex, completed] of completedMaps.entries()) {
    const label = `completedMaps[${mapIndex}]`;
    requireObject(completed, label);
    requireExactKeys(
      completed,
      [
        "formatVersion",
        "kind",
        "frameId",
        "frameDigest",
        "segmentId",
        "claims",
        "relations",
        "criticalExclusions",
      ],
      label,
    );
    if (
      completed.formatVersion !== 1 ||
      completed.kind !== COMPLETED_CONTINUATION_MAP_KIND
    ) {
      throw new ExportHandoffError(
        "INVALID_MODEL_OUTPUT",
        `${label} is not a completed Continuation MAP result`,
      );
    }
    requireString(completed.frameId, `${label}.frameId`);
    requireString(completed.frameDigest, `${label}.frameDigest`);
    requireString(completed.segmentId, `${label}.segmentId`);
    if (segmentIds.has(completed.segmentId)) {
      throw new ExportHandoffError(
        "DUPLICATE_FRAGMENT",
        `Duplicate completed MAP segment ${completed.segmentId}`,
      );
    }
    segmentIds.add(completed.segmentId);
    frameId ??= completed.frameId;
    frameDigest ??= completed.frameDigest;
    if (completed.frameId !== frameId || completed.frameDigest !== frameDigest) {
      throw new ExportHandoffError(
        "FRAME_DIGEST_MISMATCH",
        "Completed Continuation MAP results do not share one frozen frame",
      );
    }
    if (!Array.isArray(completed.claims)) {
      throw new ExportHandoffError("INVALID_MODEL_OUTPUT", `${label}.claims must be an array`);
    }
    for (const [claimIndex, claim] of completed.claims.entries()) {
      validateCompletedContinuationClaim(
        claim,
        `${label}.claims[${claimIndex}]`,
        knownAnchors,
      );
      const projected = {
        claimId: claim.claimId,
        kind: claim.kind,
        text: claim.text,
        anchors: [...claim.anchors],
      };
      const fingerprint = canonicalStringify([
        projected.kind,
        projected.text,
        projected.anchors,
      ]);
      const existing = claimsById.get(claim.claimId);
      if (existing && canonicalStringify(existing) !== canonicalStringify(projected)) {
        throw new ExportHandoffError(
          "DUPLICATE_CLAIM",
          `${claim.claimId} has conflicting completed Claim bodies`,
        );
      }
      const existingId = claimIdByFingerprint.get(fingerprint);
      if (existingId && existingId !== claim.claimId) {
        throw new ExportHandoffError(
          "DUPLICATE_CLAIM",
          `${claim.claimId} duplicates completed Claim ${existingId}`,
        );
      }
      if (!existing) {
        claimsById.set(claim.claimId, projected);
        claimIdByFingerprint.set(fingerprint, claim.claimId);
        claims.push(projected);
      }
    }
    validateContinuationGlobalRelations(
      completed.relations,
      new Map([
        ...claimsById,
        ...completed.claims.map((claim) => [claim.claimId, claim]),
      ]),
      `${label}.relations`,
    );
    for (const field of ["decisions", "attempts", "verification"]) {
      for (const relation of completed.relations[field]) {
        appendUniqueRelation(
          relations[field],
          relationFingerprints[field],
          relation,
        );
      }
    }
    if (!Array.isArray(completed.criticalExclusions)) {
      throw new ExportHandoffError(
        "INVALID_MODEL_OUTPUT",
        `${label}.criticalExclusions must be an array`,
      );
    }
    for (const [exclusionIndex, exclusion] of completed.criticalExclusions.entries()) {
      const exclusionLabel = `${label}.criticalExclusions[${exclusionIndex}]`;
      requireObject(exclusion, exclusionLabel);
      requireExactKeys(
        exclusion,
        ["evidenceIndex", "anchorId", "reasonCode"],
        exclusionLabel,
      );
      if (!Number.isInteger(exclusion.evidenceIndex) || exclusion.evidenceIndex < 1) {
        throw new ExportHandoffError(
          "INVALID_EVIDENCE_REFERENCE",
          `${exclusionLabel}.evidenceIndex must be positive`,
        );
      }
      requireString(exclusion.anchorId, `${exclusionLabel}.anchorId`);
      if (!knownAnchors.has(exclusion.anchorId)) {
        throw new ExportHandoffError(
          "UNKNOWN_EVIDENCE_ANCHOR",
          `${exclusionLabel} references unknown Evidence Anchor ${exclusion.anchorId}`,
        );
      }
      if (!CONTINUATION_EXCLUSION_REASONS.has(exclusion.reasonCode)) {
        throw new ExportHandoffError(
          "INVALID_MODEL_OUTPUT",
          `${exclusionLabel}.reasonCode is invalid`,
        );
      }
      exclusions.push({
        segmentId: completed.segmentId,
        anchorId: exclusion.anchorId,
        reasonCode: exclusion.reasonCode,
      });
    }
  }
  validateContinuationGlobalRelations(relations, claimsById, "claimTable.relations");
  return {
    knownAnchors,
    claimTable: {
      formatVersion: 1,
      kind: CONTINUATION_CLAIM_TABLE_KIND,
      frameId,
      frameDigest,
      claims,
      relations,
    },
    exclusions,
  };
}

function appendDeterministicContinuationClaims(collected, configuration = {}) {
  const deterministicClaims = configuration.claims || [];
  if (!Array.isArray(deterministicClaims)) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      "Deterministic continuation Claims must be an array",
    );
  }
  const terminalClaims = deterministicClaims.filter((claim) => claim?.kind === "terminal_state");
  const proposalClaims = deterministicClaims.filter((claim) => claim?.kind === "accepted_proposal");
  if (configuration.requireTerminalState === true && terminalClaims.length !== 1) {
    throw new ExportHandoffError(
      "TERMINAL_STATE_CLAIM_INVALID",
      "New continuation Frames require exactly one deterministic terminal_state Claim",
    );
  }
  if (configuration.requireAcceptedProposal === true && proposalClaims.length !== 1) {
    throw new ExportHandoffError(
      "ACCEPTED_PROPOSAL_CLAIM_INVALID",
      "Referential continuation Frames require exactly one deterministic accepted_proposal Claim",
    );
  }
  if (terminalClaims.length > 1 || proposalClaims.length > 1) {
    throw new ExportHandoffError(
      "DUPLICATE_CLAIM",
      "Deterministic continuation authorities must be unique by kind",
    );
  }
  const claims = [...collected.claimTable.claims];
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));
  const byFingerprint = new Map(claims.map((claim) => [
    canonicalStringify([claim.kind, claim.text, claim.anchors]),
    claim.claimId,
  ]));
  for (const [index, claim] of deterministicClaims.entries()) {
    validateClaim(
      claim,
      `deterministicClaims[${index}]`,
      collected.knownAnchors,
      "UNKNOWN_EVIDENCE_ANCHOR",
    );
    if (!["accepted_proposal", "terminal_state"].includes(claim.kind)) {
      throw new ExportHandoffError(
        "INVALID_MODEL_OUTPUT",
        `deterministicClaims[${index}] has unsupported kind ${claim.kind}`,
      );
    }
    const fingerprint = canonicalStringify([claim.kind, claim.text, claim.anchors]);
    const existing = byId.get(claim.claimId);
    if (existing && canonicalStringify(existing) !== canonicalStringify(claim)) {
      throw new ExportHandoffError(
        "DUPLICATE_CLAIM",
        `${claim.claimId} conflicts with a MAP-authored Claim`,
      );
    }
    const existingId = byFingerprint.get(fingerprint);
    if (existingId && existingId !== claim.claimId) {
      throw new ExportHandoffError(
        "DUPLICATE_CLAIM",
        `${claim.claimId} duplicates deterministic Claim ${existingId}`,
      );
    }
    if (!existing) {
      const projected = structuredClone(claim);
      claims.push(projected);
      byId.set(projected.claimId, projected);
      byFingerprint.set(fingerprint, projected.claimId);
    }
  }
  return {
    ...collected,
    claimTable: {
      ...collected.claimTable,
      claims,
    },
  };
}

export function buildContinuationParentCoverage(
  completedMaps,
  parentTurnId,
  evidenceIndex,
  deterministicClaims = {},
) {
  requireString(parentTurnId, "parentTurnId");
  const collected = appendDeterministicContinuationClaims(
    collectCompletedContinuationMaps(completedMaps, evidenceIndex),
    deterministicClaims,
  );
  const claimIds = collected.claimTable.claims
    .filter((claim) => claim.anchors.some(
      (anchorId) => collected.knownAnchors.get(anchorId)?.turnId === parentTurnId,
    ))
    .map((claim) => claim.claimId);
  return {
    turnId: parentTurnId,
    status: claimIds.length > 0 ? "summarized" : "ignored",
    claimIds,
    reason: claimIds.length > 0
      ? "derived from continuation Claim edges"
      : CONTINUATION_POLICY_IGNORED_REASON,
  };
}

export function buildContinuationDownstream(
  completedMaps,
  expectedTurnIds,
  evidenceIndex,
  preservationLedger,
  deterministicClaims = {},
) {
  if (
    !Array.isArray(expectedTurnIds) ||
    expectedTurnIds.some((turnId) => typeof turnId !== "string" || !turnId) ||
    new Set(expectedTurnIds).size !== expectedTurnIds.length
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_SEMANTIC_COVERAGE",
      "Expected Source Thread turn IDs must be unique non-empty strings",
    );
  }
  const collected = appendDeterministicContinuationClaims(
    collectCompletedContinuationMaps(completedMaps, evidenceIndex),
    deterministicClaims,
  );
  const expectedTurns = new Set(expectedTurnIds);
  const claimIdsByTurn = new Map(expectedTurnIds.map((turnId) => [turnId, []]));
  const sourceClaims = [];
  for (const claim of collected.claimTable.claims) {
    const claimTurns = new Set();
    for (const anchorId of claim.anchors) {
      const anchor = collected.knownAnchors.get(anchorId);
      if (anchor?.sourceKind !== "source_thread" || !anchor.turnId) continue;
      if (!expectedTurns.has(anchor.turnId)) {
        throw new ExportHandoffError(
          "INCOMPLETE_SEMANTIC_COVERAGE",
          `${claim.claimId} reaches unexpected Source Thread turn ${anchor.turnId}`,
        );
      }
      claimTurns.add(anchor.turnId);
    }
    if (claimTurns.size === 0) continue;
    sourceClaims.push({ claimId: claim.claimId, anchors: [...claim.anchors] });
    for (const turnId of claimTurns) claimIdsByTurn.get(turnId).push(claim.claimId);
  }

  const requiredAnchors = preservationLedger?.requiredAnchors;
  if (
    !Array.isArray(requiredAnchors) ||
    requiredAnchors.some((anchorId) => typeof anchorId !== "string" || !anchorId) ||
    new Set(requiredAnchors).size !== requiredAnchors.length
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_CONTINUATION_COVERAGE",
      "Continuation Preservation Ledger requiredAnchors must be unique strings",
    );
  }
  const required = new Set(requiredAnchors);
  for (const anchorId of required) {
    if (!collected.knownAnchors.has(anchorId)) {
      throw new ExportHandoffError(
        "UNKNOWN_EVIDENCE_ANCHOR",
        `Critical Anchor ${anchorId} is missing from the Evidence Index`,
      );
    }
  }
  const claimIdsByAnchor = new Map();
  for (const claim of collected.claimTable.claims) {
    for (const anchorId of claim.anchors) {
      const claimIds = claimIdsByAnchor.get(anchorId) || [];
      if (!claimIds.includes(claim.claimId)) claimIds.push(claim.claimId);
      claimIdsByAnchor.set(anchorId, claimIds);
    }
  }
  const exclusionByAnchor = new Map();
  for (const exclusion of collected.exclusions) {
    if (!required.has(exclusion.anchorId)) {
      throw new ExportHandoffError(
        "INVALID_CRITICAL_EXCLUSION",
        `Non-critical Evidence Anchor ${exclusion.anchorId} cannot be explicitly excluded`,
      );
    }
    if (exclusionByAnchor.has(exclusion.anchorId)) {
      throw new ExportHandoffError(
        "OVERLAPPING_CONTINUATION_COVERAGE",
        `Critical Anchor ${exclusion.anchorId} has more than one exclusion`,
      );
    }
    exclusionByAnchor.set(exclusion.anchorId, exclusion);
  }
  const criticalAnchors = requiredAnchors.map((anchorId) => {
    const claimIds = claimIdsByAnchor.get(anchorId) || [];
    const exclusion = exclusionByAnchor.get(anchorId);
    if (claimIds.length > 0 && exclusion) {
      throw new ExportHandoffError(
        "OVERLAPPING_CONTINUATION_COVERAGE",
        `Critical Anchor ${anchorId} is both retained and excluded`,
      );
    }
    if (claimIds.length > 0) {
      return { anchorId, status: "retained", claimIds };
    }
    if (exclusion) {
      return {
        anchorId,
        status: "excluded",
        claimIds: [],
        reasonCode: exclusion.reasonCode,
      };
    }
    throw new ExportHandoffError(
      "INCOMPLETE_CONTINUATION_COVERAGE",
      `Critical Anchor ${anchorId} is neither retained nor explicitly excluded`,
    );
  });

  return {
    claimTable: collected.claimTable,
    continuationCoverage: {
      formatVersion: 1,
      kind: CONTINUATION_COVERAGE_KIND,
      criticalAnchors,
    },
    semanticCoverage: {
      turns: expectedTurnIds.map((turnId) => {
        const claimIds = claimIdsByTurn.get(turnId);
        return {
          turnId,
          status: claimIds.length > 0 ? "summarized" : "ignored",
          claimIds: [...claimIds],
          reason: claimIds.length > 0
            ? "captured by continuation Claim edges"
            : CONTINUATION_POLICY_IGNORED_REASON,
        };
      }),
      claims: sourceClaims,
    },
  };
}

const CONTINUATION_LOCATION_PURPOSE = "Retained by continuation MAP.";

export function buildContinuationReduceProjections(
  claimTable,
  preservationLedger,
  deterministicClaims = {},
) {
  requireObject(claimTable, "Continuation Claim table");
  if (
    claimTable.formatVersion !== 1 ||
    claimTable.kind !== CONTINUATION_CLAIM_TABLE_KIND ||
    !Array.isArray(claimTable.claims)
  ) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      "Continuation REDUCE projections require a valid Continuation Claim table",
    );
  }
  const claimsById = new Map();
  for (const [index, claim] of claimTable.claims.entries()) {
    validateClaim(claim, `claimTable.claims[${index}]`);
    if (claimsById.has(claim.claimId)) {
      throw new ExportHandoffError("DUPLICATE_CLAIM", `Duplicate claimId ${claim.claimId}`);
    }
    claimsById.set(claim.claimId, claim);
  }
  validateContinuationGlobalRelations(
    claimTable.relations,
    claimsById,
    "claimTable.relations",
  );
  let continuationAuthorities = null;
  if (
    deterministicClaims.requireTerminalState === true ||
    deterministicClaims.requireAcceptedProposal === true
  ) {
    const expected = deterministicClaims.claims || [];
    const expectedTerminal = expected.filter((claim) => claim.kind === "terminal_state");
    const expectedProposal = expected.filter((claim) => claim.kind === "accepted_proposal");
    const actualTerminal = claimTable.claims.filter((claim) => claim.kind === "terminal_state");
    const actualProposal = claimTable.claims.filter((claim) => claim.kind === "accepted_proposal");
    if (expectedTerminal.length !== 1 || actualTerminal.length !== 1) {
      throw new ExportHandoffError(
        "TERMINAL_STATE_CLAIM_INVALID",
        "Continuation Claim table must contain exactly one frozen terminal_state Claim",
      );
    }
    if (
      deterministicClaims.requireAcceptedProposal === true &&
      (expectedProposal.length !== 1 || actualProposal.length !== 1)
    ) {
      throw new ExportHandoffError(
        "ACCEPTED_PROPOSAL_CLAIM_INVALID",
        "Referential continuation must contain exactly one frozen accepted_proposal Claim",
      );
    }
    if (
      deterministicClaims.requireAcceptedProposal !== true &&
      actualProposal.length !== 0
    ) {
      throw new ExportHandoffError(
        "ACCEPTED_PROPOSAL_CLAIM_INVALID",
        "Standalone continuation cannot contain an Accepted Proposal",
      );
    }
    for (const claim of expected) {
      const actual = claimsById.get(claim.claimId);
      if (!actual || canonicalStringify(actual) !== canonicalStringify(claim)) {
        throw new ExportHandoffError(
          "DETERMINISTIC_PROJECTION_MISMATCH",
          `${claim.kind} Claim changed before REDUCE`,
        );
      }
    }
    continuationAuthorities = {
      acceptedProposal: expectedProposal[0] || null,
      terminalState: expectedTerminal[0],
    };
  }

  const claimIdsForKind = (kind) => claimTable.claims
    .filter((claim) => claim.kind === kind)
    .map((claim) => claim.claimId);
  const categoryClaims = {
    constraint: claimIdsForKind("constraint"),
    decision: claimTable.relations.decisions.map((decision) => decision.statement),
    change: claimIdsForKind("completed_work"),
    verification: claimTable.relations.verification.map((entry) => entry.claim),
    open_work: claimIdsForKind("open_work"),
    rollback: [],
  };
  const categories = preservationLedger?.criticalCategories;
  if (
    !Array.isArray(categories) ||
    categories.some((category) => typeof category !== "string" || !category) ||
    new Set(categories).size !== categories.length
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_PRESERVATION_COVERAGE",
      "Continuation preservation categories must be unique strings",
    );
  }

  return {
    importantLocations: claimTable.claims
      .filter((claim) => claim.kind === "important_location")
      .map((claim) => ({
        claimId: claim.claimId,
        kind: claim.kind,
        location: claim.text,
        purpose: CONTINUATION_LOCATION_PURPOSE,
        anchors: [...claim.anchors],
      })),
    preservationCoverage: categories.map((category) => {
      const claimIds = [...new Set(categoryClaims[category] || [])];
      return {
        category,
        status: claimIds.length > 0 ? "represented" : "absent",
        claimIds,
        reason: claimIds.length > 0
          ? "derived from retained continuation Claims"
          : "no retained continuation Claim represents this category",
      };
    }),
    finalProvenancePolicy: "derive from retained claim and frozen-frame anchors",
    ...(continuationAuthorities ? { continuationAuthorities } : {}),
  };
}

function collectMapClaims(result, knownAnchors = undefined) {
  const claims = [];
  for (const field of MAP_CLAIM_FIELDS) {
    validateClaimArray(result[field], field, knownAnchors, claims, "UNSUPPORTED_CLAIM");
  }
  validateArchivalLedger(
    result.archivalLedger,
    "archivalLedger",
    knownAnchors,
    claims,
    "UNSUPPORTED_CLAIM",
    { allowExternalSupersedes: true },
  );
  validateUniqueClaims(claims);
  return claims;
}

export function listMapClaims(result) {
  return collectMapClaims(result).map((claim) => ({
    claimId: claim.claimId,
    kind: claim.kind,
    text: claim.text,
    anchors: [...claim.anchors],
  }));
}

function validateImportantLocations(locations, knownAnchors, claims) {
  if (!Array.isArray(locations)) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", "importantLocations must be an array");
  }
  for (const [index, location] of locations.entries()) {
    const label = `importantLocations[${index}]`;
    requireObject(location, label);
    requireString(location.claimId, `${label}.claimId`);
    requireString(location.kind, `${label}.kind`);
    requireString(location.location, `${label}.location`);
    requireString(location.purpose, `${label}.purpose`);
    const normalized = {
      claimId: location.claimId,
      kind: location.kind,
      text: `${location.location} — ${location.purpose}`,
      anchors: location.anchors,
    };
    validateClaim(normalized, label, knownAnchors, "UNKNOWN_EVIDENCE_ANCHOR");
    claims.push(normalized);
  }
}

function collectReduceClaims(result, knownAnchors) {
  const claims = [];
  for (const field of REDUCE_CLAIM_FIELDS) {
    validateClaimArray(
      result[field],
      field,
      knownAnchors,
      claims,
      "UNKNOWN_EVIDENCE_ANCHOR",
    );
  }
  claims.push(validateClaim(
    result.workspaceState.summary,
    "workspaceState.summary",
    knownAnchors,
    "UNKNOWN_EVIDENCE_ANCHOR",
  ));
  validateClaimArray(
    result.workspaceState.conflicts,
    "workspaceState.conflicts",
    knownAnchors,
    claims,
    "UNKNOWN_EVIDENCE_ANCHOR",
  );
  validateImportantLocations(result.importantLocations, knownAnchors, claims);
  validateArchivalLedger(
    result.archivalLedger,
    "archivalLedger",
    knownAnchors,
    claims,
    "UNKNOWN_EVIDENCE_ANCHOR",
  );
  validateUniqueClaims(claims);
  return claims;
}

function anchorTurnLookup(evidenceIndex) {
  const lookup = new Map();
  for (const entry of evidenceIndex?.anchors || []) {
    const { anchorId, sourceKind, turnId } = entry.anchor || {};
    if (anchorId && sourceKind === "source_thread" && turnId) {
      lookup.set(anchorId, turnId);
    }
  }
  return lookup;
}

function validateCoverageShape(entries, expectedIds, idField, incompleteCode, label) {
  if (!Array.isArray(entries)) {
    throw new ExportHandoffError(incompleteCode, `${label} must be an array`);
  }
  const actualIds = entries.map((item) => item?.[idField]);
  if (new Set(actualIds).size !== actualIds.length) {
    throw new ExportHandoffError(
      idField === "fragmentId" ? "DUPLICATE_FRAGMENT" : incompleteCode,
      `${label} contains duplicate identifiers`,
    );
  }
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new ExportHandoffError(
      incompleteCode,
      `${label} must cover ${expectedIds.join(", ")} in order`,
    );
  }
}

function validateCoverageClaims(entries, options) {
  const reachable = new Set();
  for (const item of entries) {
    const itemId = item[options.idField];
    requireObject(item, `${options.label} ${itemId ?? "<missing>"}`);
    requireString(item.reason, `${options.label} ${itemId}.reason`);
    requireStringArray(item.claimIds, `${options.label} ${itemId}.claimIds`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    if (!["summarized", "ignored"].includes(item.status)) {
      throw new ExportHandoffError(
        options.invalidCode,
        `Invalid coverage status for ${itemId}`,
      );
    }
    if (item.status === "ignored") {
      if (item.claimIds.length > 0) {
        throw new ExportHandoffError(
          options.invalidCode,
          `Ignored ${options.itemName} ${itemId} cannot reference claims`,
        );
      }
      continue;
    }
    if (item.claimIds.length === 0) {
      throw new ExportHandoffError(
        options.incompleteSemanticCode,
        `Summarized ${options.itemName} ${itemId} reaches no claims`,
      );
    }
    for (const claimId of item.claimIds) {
      const claim = options.claimsById.get(claimId);
      if (!claim) {
        throw new ExportHandoffError(
          "UNSUPPORTED_CLAIM",
          `Coverage for ${itemId} references unknown claim ${claimId}`,
        );
      }
      const evidence = options.anchorsById.get(itemId) || new Set();
      if (!claim.anchors.some((anchorId) => evidence.has(anchorId))) {
        throw new ExportHandoffError(
          options.incompleteSemanticCode,
          `${claimId} has no Evidence Anchor for ${itemId}`,
        );
      }
      reachable.add(claimId);
    }
  }
  return reachable;
}

function ensureAllClaimsReachable(claims, reachable, label) {
  for (const claim of claims) {
    if (!reachable.has(claim.claimId)) {
      throw new ExportHandoffError(
        "UNSUPPORTED_CLAIM",
        `${claim.claimId} is not reachable from ${label}`,
      );
    }
  }
}

function validateFragmentMapResult(result, chunk, expectedFrame) {
  validateCoverageShape(
    result.fragmentCoverage,
    chunk.expectedFragmentIds,
    "fragmentId",
    "INCOMPLETE_FRAGMENT_COVERAGE",
    "fragmentCoverage",
  );
  const knownAnchors = collectAnchorIds(chunk);
  const claims = collectMapClaims(result, knownAnchors);
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const anchorsById = new Map(
    (chunk.fragments || []).map((fragment) => [fragment.fragmentId, collectAnchorIds(fragment)]),
  );
  const reachable = validateCoverageClaims(result.fragmentCoverage, {
    idField: "fragmentId",
    label: "fragmentCoverage",
    itemName: "fragment",
    invalidCode: "INVALID_FRAGMENT_COVERAGE",
    incompleteSemanticCode: "INCOMPLETE_FRAGMENT_COVERAGE",
    claimsById,
    anchorsById,
  });
  ensureAllClaimsReachable(claims, reachable, "fragmentCoverage");
  requireStringArray(result.compressionNotes, "compressionNotes");
  return result;
}

function aggregateFragmentAnchors(chunk) {
  const anchorsById = new Map();
  const seen = [];
  for (const summary of chunk.fragmentSummaries || []) {
    const claims = summary.claims || [];
    const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
    for (const coverage of summary.fragmentCoverage || []) {
      seen.push(coverage.fragmentId);
      const anchors = new Set();
      for (const claimId of coverage.claimIds || []) {
        for (const anchorId of claimsById.get(claimId)?.anchors || []) anchors.add(anchorId);
      }
      anchorsById.set(coverage.fragmentId, anchors);
    }
  }
  if (
    seen.length !== chunk.expectedFragmentIds.length ||
    seen.some((fragmentId, index) => fragmentId !== chunk.expectedFragmentIds[index])
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_FRAGMENT_COVERAGE",
      "Turn aggregate input must contain every validated fragment summary in order",
    );
  }
  return anchorsById;
}

function validateTurnAggregateMapResult(result, chunk) {
  validateCoverageShape(
    result.fragmentCoverage,
    chunk.expectedFragmentIds,
    "fragmentId",
    "INCOMPLETE_FRAGMENT_COVERAGE",
    "fragmentCoverage",
  );
  validateCoverageShape(
    result.turnCoverage,
    chunk.expectedTurnIds,
    "turnId",
    "INCOMPLETE_TURN_COVERAGE",
    "turnCoverage",
  );
  const knownAnchors = collectAnchorIds(chunk);
  const claims = collectMapClaims(result, knownAnchors);
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const fragmentAnchors = aggregateFragmentAnchors(chunk);
  const fragmentReachable = validateCoverageClaims(result.fragmentCoverage, {
    idField: "fragmentId",
    label: "fragmentCoverage",
    itemName: "fragment",
    invalidCode: "INVALID_FRAGMENT_COVERAGE",
    incompleteSemanticCode: "INCOMPLETE_FRAGMENT_COVERAGE",
    claimsById,
    anchorsById: fragmentAnchors,
  });
  ensureAllClaimsReachable(claims, fragmentReachable, "fragmentCoverage");

  const turnAnchors = new Set([...fragmentAnchors.values()].flatMap((anchors) => [...anchors]));
  const turnReachable = validateCoverageClaims(result.turnCoverage, {
    idField: "turnId",
    label: "turnCoverage",
    itemName: "turn",
    invalidCode: "INVALID_TURN_COVERAGE",
    incompleteSemanticCode: "INCOMPLETE_SEMANTIC_COVERAGE",
    claimsById,
    anchorsById: new Map([[chunk.parentTurnId, turnAnchors]]),
  });
  ensureAllClaimsReachable(claims, turnReachable, "parent turnCoverage");
  requireStringArray(result.compressionNotes, "compressionNotes");
  return result;
}

export function validateMapResult(result, chunk, expectedFrame = undefined) {
  requireObject(result, "MAP result");
  validateFrameBinding(result, expectedFrame || {
    frameId: chunk.compressionFrame?.frameId,
    frameDigest: chunk.frameDigest,
  });
  if (result.segmentId !== chunk.segmentId) {
    throw new ExportHandoffError("SEGMENT_ID_MISMATCH", `MAP returned ${result.segmentId}`);
  }
  if (chunk.stage === "fragment_map") {
    return validateFragmentMapResult(result, chunk, expectedFrame);
  }
  if (chunk.stage === "turn_aggregate_map") {
    return validateTurnAggregateMapResult(result, chunk, expectedFrame);
  }
  if (!Array.isArray(result.turnCoverage)) {
    throw new ExportHandoffError("INVALID_TURN_COVERAGE", "turnCoverage must be an array");
  }

  const expected = new Set(chunk.expectedTurnIds);
  const actualIds = result.turnCoverage.map((item) => item?.turnId);
  const actual = new Set(actualIds);
  if (actual.size !== actualIds.length || !sameSet(actual, expected)) {
    throw new ExportHandoffError(
      "INCOMPLETE_TURN_COVERAGE",
      `Expected coverage for ${[...expected].join(", ")}; received ${actualIds.join(", ")}`,
    );
  }

  const knownAnchors = collectAnchorIds(chunk);
  const turnAnchors = new Map(
    (chunk.turns || []).map((turn) => [turn.turnId, collectAnchorIds(turn)]),
  );
  const claims = collectMapClaims(result, knownAnchors);
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const reachableClaims = new Set();

  for (const item of result.turnCoverage) {
    requireObject(item, `turnCoverage ${item?.turnId ?? "<missing>"}`);
    requireString(item.reason, `turnCoverage ${item.turnId}.reason`);
    requireStringArray(item.claimIds, `turnCoverage ${item.turnId}.claimIds`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    if (!["summarized", "ignored"].includes(item.status)) {
      throw new ExportHandoffError(
        "INVALID_TURN_COVERAGE",
        `Invalid coverage status for ${item.turnId}`,
      );
    }
    if (item.status === "ignored") {
      if (item.claimIds.length > 0) {
        throw new ExportHandoffError(
          "INVALID_TURN_COVERAGE",
          `Ignored turn ${item.turnId} cannot reference claims`,
        );
      }
      continue;
    }
    if (item.claimIds.length === 0) {
      throw new ExportHandoffError(
        "INCOMPLETE_SEMANTIC_COVERAGE",
        `Summarized turn ${item.turnId} reaches no claims`,
      );
    }
    for (const claimId of item.claimIds) {
      const claim = claimsById.get(claimId);
      if (!claim) {
        throw new ExportHandoffError(
          "UNSUPPORTED_CLAIM",
          `Coverage for ${item.turnId} references unknown claim ${claimId}`,
        );
      }
      const evidenceForTurn = turnAnchors.get(item.turnId) || new Set();
      if (!claim.anchors.some((anchorId) => evidenceForTurn.has(anchorId))) {
        throw new ExportHandoffError(
          "INCOMPLETE_SEMANTIC_COVERAGE",
          `${claimId} has no Evidence Anchor for ${item.turnId}`,
        );
      }
      reachableClaims.add(claimId);
    }
  }
  for (const claim of claims) {
    if (!reachableClaims.has(claim.claimId)) {
      throw new ExportHandoffError(
        "UNSUPPORTED_CLAIM",
        `${claim.claimId} is not reachable from turnCoverage`,
      );
    }
  }
  requireStringArray(result.compressionNotes, "compressionNotes");
  return result;
}

export function buildSemanticCoverageGraph(segmentSummaries, expectedTurnIds) {
  const turns = [];
  const claims = [];
  for (const summary of segmentSummaries) {
    turns.push(...summary.turnCoverage.map((entry) => ({
      turnId: entry.turnId,
      status: entry.status,
      claimIds: [...entry.claimIds],
      reason: entry.reason,
    })));
    claims.push(...collectMapClaims(summary).map((claim) => ({
      claimId: claim.claimId,
      kind: claim.kind,
      text: claim.text,
      anchors: [...claim.anchors],
    })));
  }
  validateUniqueClaims(claims);
  const expected = new Set(expectedTurnIds);
  const actualIds = turns.map((entry) => entry.turnId);
  if (
    actualIds.length !== expected.size ||
    new Set(actualIds).size !== actualIds.length ||
    !sameSet(new Set(actualIds), expected)
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_SEMANTIC_COVERAGE",
      "Combined MAP coverage must contain every Source Thread turn exactly once",
    );
  }
  return {
    turns,
    claims: claims.map(({ claimId, anchors }) => ({ claimId, anchors })),
  };
}

export function deriveFinalProvenance(result, expectedTurnIds, evidenceIndex, expectedFrame) {
  const anchorIds = collectAnchorIds(result);
  collectAnchorIds(expectedFrame?.frame?.currentGoal, anchorIds);
  collectAnchorIds(expectedFrame?.frame?.explicitExclusions, anchorIds);
  const byAnchor = anchorTurnLookup(evidenceIndex);
  const retainedTurns = new Set();
  for (const anchorId of anchorIds) {
    const turnId = byAnchor.get(anchorId);
    if (turnId) retainedTurns.add(turnId);
  }
  return expectedTurnIds.filter((turnId) => retainedTurns.has(turnId));
}

function validatePreservationCoverage(entries, preservationLedger, claimsById) {
  if (!Array.isArray(entries)) {
    throw new ExportHandoffError(
      "INCOMPLETE_PRESERVATION_COVERAGE",
      "preservationCoverage must be an array",
    );
  }
  const expected = new Set(preservationLedger?.criticalCategories || []);
  const categories = entries.map((entry) => entry?.category);
  if (
    categories.length !== expected.size ||
    new Set(categories).size !== categories.length ||
    !sameSet(new Set(categories), expected)
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_PRESERVATION_COVERAGE",
      "Every Preservation Ledger category must be represented or explicitly absent",
    );
  }
  for (const entry of entries) {
    requireObject(entry, `preservationCoverage ${entry?.category ?? "<missing>"}`);
    requireString(entry.reason, `preservationCoverage ${entry.category}.reason`);
    requireStringArray(entry.claimIds, `preservationCoverage ${entry.category}.claimIds`, {
      duplicateCode: "DUPLICATE_CLAIM",
    });
    if (!["represented", "absent"].includes(entry.status)) {
      throw new ExportHandoffError(
        "INCOMPLETE_PRESERVATION_COVERAGE",
        `Invalid Preservation Ledger status for ${entry.category}`,
      );
    }
    if (entry.status === "represented" && entry.claimIds.length === 0) {
      throw new ExportHandoffError(
        "INCOMPLETE_PRESERVATION_COVERAGE",
        `Represented category ${entry.category} must reference a claim`,
      );
    }
    if (entry.status === "absent" && entry.claimIds.length > 0) {
      throw new ExportHandoffError(
        "INCOMPLETE_PRESERVATION_COVERAGE",
        `Absent category ${entry.category} cannot reference claims`,
      );
    }
    for (const claimId of entry.claimIds) {
      if (!claimsById.has(claimId)) {
        throw new ExportHandoffError(
          "INCOMPLETE_PRESERVATION_COVERAGE",
          `${entry.category} references unknown claim ${claimId}`,
        );
      }
    }
  }
}

export function validateReduceResult(
  result,
  expectedTurnIds,
  expectedFrame,
  context = {},
) {
  requireObject(result, "REDUCE result");
  validateFrameBinding(result, expectedFrame);
  requireObject(result.objective, "objective");
  requireObject(result.workspaceState, "workspaceState");
  requireObject(result.provenance, "provenance");
  requireString(result.continuationDirective, "continuationDirective");
  requireString(result.objective.goal, "objective.goal");
  requireStringArray(result.objective.explicitExclusions, "objective.explicitExclusions");
  if (result.objective.goal !== expectedFrame.frame.currentGoal.text) {
    throw new ExportHandoffError(
      "UNSUPPORTED_FRAME_CLAIM",
      "REDUCE objective does not match the frozen Compression Frame currentGoal",
    );
  }
  const expectedExclusions = expectedFrame.frame.explicitExclusions.map((item) => item.text);
  if (
    result.objective.explicitExclusions.length !== expectedExclusions.length ||
    result.objective.explicitExclusions.some((item, index) => item !== expectedExclusions[index])
  ) {
    throw new ExportHandoffError(
      "UNSUPPORTED_FRAME_CLAIM",
      "REDUCE explicit exclusions do not match the frozen Compression Frame",
    );
  }
  if (!["full", "partial", "unavailable"].includes(result.workspaceState.evidenceStatus)) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", "workspaceState.evidenceStatus is invalid");
  }
  if (!Array.isArray(result.nextActions) || result.nextActions.length > 5) {
    throw new ExportHandoffError("INVALID_MODEL_OUTPUT", "nextActions must contain at most 5 items");
  }
  if ("decisions" in result || "verification" in result) {
    throw new ExportHandoffError(
      "INVALID_ARCHIVAL_LEDGER",
      "Decisions and verification must use archivalLedger",
    );
  }
  if (!context.evidenceIndex) {
    throw new ExportHandoffError(
      "EVIDENCE_INDEX_REQUIRED",
      "REDUCE claim validation requires the persisted Evidence Index",
    );
  }

  const knownAnchors = new Set(
    context.evidenceIndex.anchors.map((entry) => entry.anchor.anchorId),
  );
  const claims = collectReduceClaims(result, knownAnchors);
  if (context.deterministicProjections?.continuationAuthorities) {
    const authorities = context.deterministicProjections.continuationAuthorities;
    if (
      !Object.hasOwn(result, "acceptedProposal") ||
      !Object.hasOwn(result, "terminalState") ||
      canonicalStringify(result.acceptedProposal) !==
        canonicalStringify(authorities.acceptedProposal) ||
      canonicalStringify(result.terminalState) !==
        canonicalStringify(authorities.terminalState)
    ) {
      throw new ExportHandoffError(
        "DETERMINISTIC_PROJECTION_MISMATCH",
        "REDUCE Accepted Proposal and Terminal state must equal the frozen continuation authorities",
      );
    }
    if (result.acceptedProposal) {
      claims.push(validateClaim(
        result.acceptedProposal,
        "acceptedProposal",
        knownAnchors,
        "UNKNOWN_EVIDENCE_ANCHOR",
      ));
    }
    claims.push(validateClaim(
      result.terminalState,
      "terminalState",
      knownAnchors,
      "UNKNOWN_EVIDENCE_ANCHOR",
    ));
    validateUniqueClaims(claims);
  }
  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
  if (context.deterministicProjections) {
    if (
      canonicalStringify(result.importantLocations) !==
      canonicalStringify(context.deterministicProjections.importantLocations)
    ) {
      throw new ExportHandoffError(
        "DETERMINISTIC_PROJECTION_MISMATCH",
        "REDUCE importantLocations must equal the deterministic continuation projection",
      );
    }
    if (
      canonicalStringify(result.preservationCoverage) !==
      canonicalStringify(context.deterministicProjections.preservationCoverage)
    ) {
      throw new ExportHandoffError(
        "INCOMPLETE_PRESERVATION_COVERAGE",
        "REDUCE preservationCoverage must equal the deterministic continuation projection",
      );
    }
  }
  validatePreservationCoverage(
    result.preservationCoverage,
    context.preservationLedger || context.evidenceIndex.preservationLedger,
    claimsById,
  );
  requireStringArray(result.provenance.notes, "provenance.notes");
  requireStringArray(result.compressionNotes, "compressionNotes");

  const derived = deriveFinalProvenance(
    result,
    expectedTurnIds,
    context.evidenceIndex,
    expectedFrame,
  );
  if ("sourceTurnIds" in result.provenance) {
    requireStringArray(result.provenance.sourceTurnIds, "provenance.sourceTurnIds");
    if (
      result.provenance.sourceTurnIds.length !== derived.length ||
      result.provenance.sourceTurnIds.some((turnId, index) => turnId !== derived[index])
    ) {
      throw new ExportHandoffError(
        "PROVENANCE_NOT_DERIVED",
        "Final provenance must be derived from retained claim anchors",
      );
    }
  } else if (context.requireDerivedProvenance) {
    throw new ExportHandoffError(
      "PROVENANCE_NOT_DERIVED",
      "Continuation REDUCE must include deterministic sourceTurnIds",
    );
  }
  return result;
}
