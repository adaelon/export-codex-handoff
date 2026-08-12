import {
  canonicalStringify,
  sha256Text,
} from "./evidence-addressing.mjs";
import { resolveEvidenceReferences } from "./frame-projection.mjs";
import { classifyToolOperation } from "./progress-evidence.mjs";
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
const ACTION_READY_FINDING_CLAIM_KINDS = new Set([
  "completed_work",
  "conflict",
  "decision",
  "rationale",
  "lesson",
  "verification",
]);
const ACTION_READY_DELIVERABLE_STATUSES = new Set(["ready", "partial", "blocked"]);
const ACTION_READY_REREAD_POLICIES = new Set([
  "do_not_reread",
  "verify_only",
  "targeted_followup",
]);
const WORKING_SYNTHESIS_STATUSES = new Set(["draft_ready", "partial", "blocked"]);
const RESUME_POLICY_MODES = new Set([
  "synthesize_first",
  "execute_next",
  "resolve_blocker",
]);
const RESUME_READ_REASONS = new Set(["claim_verification", "named_uncertainty"]);
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

function continuationV1Projection(result) {
  return {
    formatVersion: 1,
    kind: CONTINUATION_MAP_KIND,
    frameId: result.frameId,
    frameDigest: result.frameDigest,
    segmentId: result.segmentId,
    claims: result.claims,
    relations: result.relations,
    criticalExclusions: result.criticalExclusions,
  };
}

function requireActionReadyFinding(
  findingsByLocalId,
  findingId,
  label,
) {
  if (!Number.isInteger(findingId) || findingId < 1) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      `${label} must be a positive local Finding ID`,
    );
  }
  const finding = findingsByLocalId.get(findingId);
  if (!finding) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      `${label} references unknown local Finding ${findingId}`,
    );
  }
  return finding;
}

function actionReadyProgressReferences(progressEvidence) {
  if (!progressEvidence) return null;
  requireObject(progressEvidence, "Progress Evidence");
  if (
    progressEvidence.formatVersion !== 1 ||
    progressEvidence.kind !== "codex-handoff-progress-evidence" ||
    !Array.isArray(progressEvidence.assistantProgress) ||
    !Array.isArray(progressEvidence.inspections)
  ) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "continuation-map-v2 requires validated Progress Evidence v1",
    );
  }
  const references = new Map();
  for (const reference of progressEvidence.assistantProgress) {
    if (
      typeof reference?.referenceId !== "string" ||
      !reference.referenceId ||
      references.has(reference.referenceId)
    ) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        "Progress Evidence contains an invalid or duplicate referenceId",
      );
    }
    references.set(reference.referenceId, reference);
  }
  const inspections = new Map();
  for (const inspection of progressEvidence.inspections) {
    const inspectionId = inspection?.outputEvidence?.referenceId;
    if (
      typeof inspectionId !== "string" ||
      !inspectionId ||
      references.has(inspectionId) ||
      inspections.has(inspectionId)
    ) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        "Progress Evidence contains an invalid or duplicate inspection referenceId",
      );
    }
    references.set(inspectionId, inspection.outputEvidence);
    inspections.set(inspectionId, inspection);
  }
  return { references, inspections };
}

function actionReadyCandidateRepairIssues(
  result,
  dictionary,
  expectedFrame,
  claimsByLocalId,
  progress = null,
) {
  const issues = [];
  const criticalAnchors = new Set(
    expectedFrame?.frame?.preservationPolicy?.requiredAnchors || [],
  );
  for (const [index, exclusion] of result.criticalExclusions.entries()) {
    const anchorId = resolveEvidenceReferences(dictionary, [exclusion.evidenceIndex])[0];
    if (!criticalAnchors.has(anchorId)) {
      issues.push({
        code: "NON_CRITICAL_EXCLUSION",
        fieldPath: `criticalExclusions[${index}].evidenceIndex`,
        message: "criticalExclusions may contain only Critical Anchor references",
        correctionHint:
          "Remove this entry; non-Critical evidence remains retrievable without an explicit exclusion.",
      });
    }
  }

  const claimIndexByLocalId = new Map(
    result.claims.map((claim, index) => [claim.localId, index]),
  );
  for (const [index, finding] of result.findings.entries()) {
    const claim = claimsByLocalId.get(finding.claim);
    if (claim.kind === "verification") {
      const operationClass = actionReadyVerificationClass(
        claim.localId,
        result.relations,
      );
      if (operationClass !== "verification") {
        const article = /^[aeiou]/u.test(operationClass) ? "an" : "a";
        issues.push({
          code: "LOW_VALUE_FINDING",
          fieldPath: `findings[${index}].claim`,
          message:
            `Finding references ${article} ${operationClass} result that must remain Cold Evidence`,
          correctionHint:
            "Remove this Finding or replace it with a deliverable-relevant semantic Claim.",
        });
      }
      continue;
    }

    const verification = /^(.+) => (pass|fail|not_run|unknown)$/u.exec(claim.text);
    if (
      verification &&
      classifyToolOperation({
        inputReceipt: {
          previewHead: JSON.stringify({ command: verification[1] }),
          previewTail: "",
        },
      }) === "verification"
    ) {
      issues.push({
        code: "MISCLASSIFIED_VERIFICATION_FINDING",
        fieldPath: `claims[${claimIndexByLocalId.get(claim.localId)}].kind`,
        message: `Finding references a verification result authored as ${claim.kind}`,
        correctionHint:
          "Change the Claim kind to verification and add its exact command/result relation.",
      });
    }
  }
  if (
    progress !== null &&
    result.findings.length === 0 &&
    result.deliverables.length === 0 &&
    result.inspectionDispositions.length === 0
  ) {
    issues.push({
      code: "MISSING_ACTION_READY_RELATIONS",
      fieldPath: "deliverables",
      message: "Progress Evidence MAP must author action-ready relations before REDUCE",
      correctionHint: [
        "Add at least one deliverable. When Progress Evidence cannot support a Finding,",
        "use status blocked, findingIds [], and a non-empty missingReason; do not invent evidence.",
      ].join(" "),
    });
  }
  return issues;
}

function requireNoActionReadyCandidateRepair(
  result,
  dictionary,
  expectedFrame,
  claimsByLocalId,
  progress = null,
) {
  const issues = actionReadyCandidateRepairIssues(
    result,
    dictionary,
    expectedFrame,
    claimsByLocalId,
    progress,
  );
  if (issues.length === 0) return;
  throw new ExportHandoffError(
    "MAP_REPAIR_REQUIRED",
    `${result.segmentId} MAP candidate requires ${issues.length} corrections`,
    {
      repairScope: "map_candidate",
      segmentId: result.segmentId,
      issues,
    },
  );
}

function validateActionReadyContinuationCandidate(
  result,
  dictionary,
  expectedFrame,
  progressEvidence,
) {
  requireObject(result, "Action-ready Continuation MAP result");
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
      "findings",
      "deliverables",
      "inspectionDispositions",
    ],
    "Action-ready Continuation MAP result",
  );
  if (result.formatVersion !== 2 || result.kind !== CONTINUATION_MAP_KIND) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `Action-ready Continuation MAP result must use formatVersion 2 and kind ${CONTINUATION_MAP_KIND}`,
    );
  }
  const projected = continuationV1Projection(result);
  const { claimsByLocalId } = validateContinuationCandidate(
    projected,
    dictionary,
    expectedFrame,
  );
  const progress = actionReadyProgressReferences(progressEvidence);
  for (const field of ["findings", "deliverables", "inspectionDispositions"]) {
    if (!Array.isArray(result[field])) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${field} must be an array`,
      );
    }
  }
  if (!progress) {
    if (
      result.findings.length > 0 ||
      result.deliverables.length > 0 ||
      result.inspectionDispositions.length > 0
    ) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        "Only a Progress Evidence dispatch may author action-ready relations",
      );
    }
    requireNoActionReadyCandidateRepair(
      result,
      dictionary,
      expectedFrame,
      claimsByLocalId,
    );
    return {
      result,
      claimsByLocalId,
      findingsByLocalId: new Map(),
      progress: null,
    };
  }

  const findingsByLocalId = new Map();
  const findingByClaim = new Set();
  for (const [index, finding] of result.findings.entries()) {
    const label = `findings[${index}]`;
    requireObject(finding, label);
    requireExactKeys(finding, ["localId", "claim"], label);
    if (!Number.isInteger(finding.localId) || finding.localId < 1) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label}.localId must be positive`,
      );
    }
    if (findingsByLocalId.has(finding.localId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `Duplicate local Finding ${finding.localId}`,
      );
    }
    const claim = continuationClaimByLocalId(
      claimsByLocalId,
      finding.claim,
      `${label}.claim`,
    );
    if (!ACTION_READY_FINDING_CLAIM_KINDS.has(claim.kind)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label}.claim must reference a finding-capable Claim`,
      );
    }
    if (findingByClaim.has(finding.claim)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label}.claim is already bound to another Finding`,
      );
    }
    findingByClaim.add(finding.claim);
    findingsByLocalId.set(finding.localId, { ...finding, claim });
  }

  const referencedFindings = new Set();
  const deliverableIds = new Set();
  for (const [index, deliverable] of result.deliverables.entries()) {
    const label = `deliverables[${index}]`;
    requireObject(deliverable, label);
    requireAllowedKeys(
      deliverable,
      ["deliverableId", "request", "status", "findingIds"],
      ["missingReason"],
      label,
    );
    requireString(deliverable.deliverableId, `${label}.deliverableId`);
    requireString(deliverable.request, `${label}.request`);
    if (deliverableIds.has(deliverable.deliverableId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `Duplicate deliverableId ${deliverable.deliverableId}`,
      );
    }
    deliverableIds.add(deliverable.deliverableId);
    if (!ACTION_READY_DELIVERABLE_STATUSES.has(deliverable.status)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label}.status must be ready, partial, or blocked`,
      );
    }
    requirePositiveIntegerArray(deliverable.findingIds, `${label}.findingIds`, {
      duplicateCode: "INVALID_ACTION_READY_RELATION",
    });
    if (
      ["ready", "partial"].includes(deliverable.status) &&
      deliverable.findingIds.length === 0
    ) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label}.${deliverable.status} must reference at least one Finding`,
      );
    }
    if (deliverable.status === "ready" && Object.hasOwn(deliverable, "missingReason")) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label}.ready cannot include missingReason`,
      );
    }
    if (deliverable.status !== "ready") {
      requireString(deliverable.missingReason, `${label}.missingReason`);
    }
    for (const localId of deliverable.findingIds) {
      requireActionReadyFinding(findingsByLocalId, localId, `${label}.findingIds`);
      referencedFindings.add(localId);
    }
  }
  if (
    ["review", "research", "diagnosis"].includes(expectedFrame?.frame?.taskType) &&
    result.deliverables.length === 0
  ) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "Review, research, and diagnosis Progress Evidence requires a deliverable status",
    );
  }
  for (const localId of findingsByLocalId.keys()) {
    if (!referencedFindings.has(localId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `Finding ${localId} is not reachable from a requested deliverable`,
      );
    }
  }

  const disposedInspectionIds = new Set();
  for (const [index, disposition] of result.inspectionDispositions.entries()) {
    const label = `inspectionDispositions[${index}]`;
    requireObject(disposition, label);
    requireExactKeys(
      disposition,
      ["inspectionId", "findingIds", "rereadPolicy"],
      label,
    );
    requireString(disposition.inspectionId, `${label}.inspectionId`);
    const inspection = progress.inspections.get(disposition.inspectionId);
    if (!inspection || disposedInspectionIds.has(disposition.inspectionId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label}.inspectionId is unknown or duplicated`,
      );
    }
    disposedInspectionIds.add(disposition.inspectionId);
    if (!ACTION_READY_REREAD_POLICIES.has(disposition.rereadPolicy)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label}.rereadPolicy is invalid`,
      );
    }
    requirePositiveIntegerArray(disposition.findingIds, `${label}.findingIds`, {
      duplicateCode: "INVALID_ACTION_READY_RELATION",
    });
    if (
      disposition.rereadPolicy !== "targeted_followup" &&
      disposition.findingIds.length === 0
    ) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label} must synthesize at least one Finding or use targeted_followup`,
      );
    }
    const inspectionAnchors = new Set(inspection.outputEvidence.anchors || []);
    for (const localId of disposition.findingIds) {
      const finding = requireActionReadyFinding(
        findingsByLocalId,
        localId,
        `${label}.findingIds`,
      );
      const claimAnchors = resolveEvidenceReferences(
        dictionary,
        finding.claim.evidenceIndexes,
      );
      if (!claimAnchors.some((anchorId) => inspectionAnchors.has(anchorId))) {
        throw new ExportHandoffError(
          "INVALID_ACTION_READY_RELATION",
          `${label} links Finding ${localId} without the inspected output evidence`,
        );
      }
    }
  }
  if (
    disposedInspectionIds.size !== progress.inspections.size ||
    [...progress.inspections.keys()].some((inspectionId) => !disposedInspectionIds.has(inspectionId))
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_INSPECTION_DISPOSITION",
      "Every Progress Evidence content inspection must be synthesized or targeted for follow-up",
    );
  }
  requireNoActionReadyCandidateRepair(
    result,
    dictionary,
    expectedFrame,
    claimsByLocalId,
    progress,
  );
  return { result, claimsByLocalId, findingsByLocalId, progress };
}

export function validateActionReadyContinuationMapResult(
  result,
  dictionary,
  expectedFrame,
  progressEvidence = null,
) {
  validateActionReadyContinuationCandidate(
    result,
    dictionary,
    expectedFrame,
    progressEvidence,
  );
  return result;
}

export function completeActionReadyContinuationMapResult(
  result,
  dictionary,
  expectedFrame,
  progressEvidence = null,
) {
  const validated = validateActionReadyContinuationCandidate(
    result,
    dictionary,
    expectedFrame,
    progressEvidence,
  );
  const completedBase = completeContinuationMapResult(
    continuationV1Projection(result),
    dictionary,
    expectedFrame,
  );
  const claimIdByLocalId = new Map(
    result.claims.map((claim, index) => [claim.localId, completedBase.claims[index].claimId]),
  );
  const findingIdByLocalId = new Map();
  const findings = result.findings.map((finding) => {
    const claimId = claimIdByLocalId.get(finding.claim);
    const completed = {
      findingId: `finding-${sha256Text(claimId)}`,
      claimId,
    };
    findingIdByLocalId.set(finding.localId, completed.findingId);
    return completed;
  });
  const globalFindingIds = (localIds) => localIds.map((localId) => (
    findingIdByLocalId.get(localId)
  ));
  return {
    ...completedBase,
    formatVersion: 2,
    findings,
    deliverables: result.deliverables.map((deliverable) => ({
      deliverableId: deliverable.deliverableId,
      request: deliverable.request,
      status: deliverable.status,
      findingIds: globalFindingIds(deliverable.findingIds),
      ...(Object.hasOwn(deliverable, "missingReason")
        ? { missingReason: deliverable.missingReason }
        : {}),
    })),
    inspectionDispositions: result.inspectionDispositions.map((disposition) => {
      const inspection = validated.progress.inspections.get(disposition.inspectionId);
      return {
        inspectionId: disposition.inspectionId,
        location: inspection.location,
        symbols: [...inspection.symbols],
        scope: inspection.scope,
        findingIds: globalFindingIds(disposition.findingIds),
        rereadPolicy: disposition.rereadPolicy,
      };
    }),
  };
}

function requireKnownFindingIds(value, label, knownFindingIds, options = {}) {
  requireStringArray(value, label, {
    nonEmpty: options.nonEmpty,
    duplicateCode: "INVALID_ACTION_READY_RELATION",
  });
  for (const findingId of value) {
    if (!knownFindingIds.has(findingId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label} references unknown Finding ${findingId}`,
      );
    }
  }
}

export function validateActionReadyReduceResult(result, workingSynthesisInput) {
  requireObject(result, "Action-ready REDUCE result");
  requireObject(workingSynthesisInput, "Working Synthesis input");
  if (
    workingSynthesisInput.formatVersion !== 1 ||
    workingSynthesisInput.kind !== "codex-handoff-working-synthesis-input" ||
    !Array.isArray(workingSynthesisInput.findings) ||
    !Array.isArray(workingSynthesisInput.deliverables) ||
    !Array.isArray(workingSynthesisInput.inspections)
  ) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "Action-ready REDUCE validation requires a Working Synthesis input v1",
    );
  }
  const knownFindingIds = new Set();
  for (const [index, finding] of workingSynthesisInput.findings.entries()) {
    const label = `workingSynthesisInput.findings[${index}]`;
    requireObject(finding, label);
    requireExactKeys(finding, ["findingId", "claimId"], label);
    requireString(finding.findingId, `${label}.findingId`);
    requireString(finding.claimId, `${label}.claimId`);
    if (knownFindingIds.has(finding.findingId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `Duplicate Finding ${finding.findingId}`,
      );
    }
    knownFindingIds.add(finding.findingId);
  }

  requireObject(result.workingSynthesis, "workingSynthesis");
  requireExactKeys(
    result.workingSynthesis,
    ["status", "sections", "confirmedFindingIds", "uncertainties"],
    "workingSynthesis",
  );
  if (!WORKING_SYNTHESIS_STATUSES.has(result.workingSynthesis.status)) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "workingSynthesis.status must be draft_ready, partial, or blocked",
    );
  }
  if (!Array.isArray(result.workingSynthesis.sections)) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "workingSynthesis.sections must be an array",
    );
  }
  const sectionFindingIds = new Set();
  for (const [index, section] of result.workingSynthesis.sections.entries()) {
    const label = `workingSynthesis.sections[${index}]`;
    requireObject(section, label);
    requireExactKeys(section, ["title", "body", "findingIds"], label);
    requireString(section.title, `${label}.title`);
    requireString(section.body, `${label}.body`);
    requireKnownFindingIds(section.findingIds, `${label}.findingIds`, knownFindingIds, {
      nonEmpty: true,
    });
    for (const findingId of section.findingIds) sectionFindingIds.add(findingId);
  }
  requireKnownFindingIds(
    result.workingSynthesis.confirmedFindingIds,
    "workingSynthesis.confirmedFindingIds",
    knownFindingIds,
  );
  for (const findingId of result.workingSynthesis.confirmedFindingIds) {
    if (!sectionFindingIds.has(findingId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `Confirmed Finding ${findingId} is absent from Working Synthesis sections`,
      );
    }
  }
  if (!Array.isArray(result.workingSynthesis.uncertainties)) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "workingSynthesis.uncertainties must be an array",
    );
  }
  const uncertaintyFindingIds = new Set();
  for (const [index, uncertainty] of result.workingSynthesis.uncertainties.entries()) {
    const label = `workingSynthesis.uncertainties[${index}]`;
    requireObject(uncertainty, label);
    requireExactKeys(uncertainty, ["question", "allowedScopes", "findingIds"], label);
    requireString(uncertainty.question, `${label}.question`);
    requireStringArray(uncertainty.allowedScopes, `${label}.allowedScopes`, {
      nonEmpty: true,
      duplicateCode: "INVALID_ACTION_READY_RELATION",
    });
    requireKnownFindingIds(uncertainty.findingIds, `${label}.findingIds`, knownFindingIds);
    for (const findingId of uncertainty.findingIds) uncertaintyFindingIds.add(findingId);
  }
  for (const findingId of knownFindingIds) {
    if (!sectionFindingIds.has(findingId) && !uncertaintyFindingIds.has(findingId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `Finding ${findingId} is absent from Working Synthesis and uncertainties`,
      );
    }
  }

  if (
    canonicalStringify(result.deliverableStatus) !==
    canonicalStringify(workingSynthesisInput.deliverables)
  ) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "deliverableStatus must preserve every requested deliverable relation exactly",
    );
  }
  if (
    canonicalStringify(result.inspectedEvidenceMap) !==
    canonicalStringify(workingSynthesisInput.inspections)
  ) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "inspectedEvidenceMap must preserve every completed inspection disposition exactly",
    );
  }

  requireObject(result.resumePolicy, "resumePolicy");
  requireExactKeys(
    result.resumePolicy,
    [
      "mode",
      "firstDeliverableIds",
      "maxTargetedReads",
      "allowedReadReasons",
      "forbidBroadSearch",
      "forbidFullFileReread",
    ],
    "resumePolicy",
  );
  if (!RESUME_POLICY_MODES.has(result.resumePolicy.mode)) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "resumePolicy.mode is invalid",
    );
  }
  requireStringArray(result.resumePolicy.firstDeliverableIds, "resumePolicy.firstDeliverableIds", {
    nonEmpty: true,
    duplicateCode: "INVALID_ACTION_READY_RELATION",
  });
  const deliverableIds = new Set(
    workingSynthesisInput.deliverables.map((deliverable) => deliverable.deliverableId),
  );
  for (const deliverableId of result.resumePolicy.firstDeliverableIds) {
    if (!deliverableIds.has(deliverableId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `resumePolicy references unknown deliverable ${deliverableId}`,
      );
    }
  }
  if (!Number.isInteger(result.resumePolicy.maxTargetedReads) || result.resumePolicy.maxTargetedReads < 0) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "resumePolicy.maxTargetedReads must be a non-negative integer",
    );
  }
  requireStringArray(result.resumePolicy.allowedReadReasons, "resumePolicy.allowedReadReasons", {
    duplicateCode: "INVALID_ACTION_READY_RELATION",
  });
  if (result.resumePolicy.allowedReadReasons.some((reason) => !RESUME_READ_REASONS.has(reason))) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "resumePolicy.allowedReadReasons contains an unsupported reason",
    );
  }
  for (const field of ["forbidBroadSearch", "forbidFullFileReread"]) {
    if (typeof result.resumePolicy[field] !== "boolean") {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `resumePolicy.${field} must be boolean`,
      );
    }
  }
  return result;
}

function actionReadyGateFailure(code, message) {
  throw new ExportHandoffError(code, message);
}

function validateActionReadyActionability(result, workingSynthesisInput, taskType) {
  const requiredFields = [
    "workingSynthesis",
    "deliverableStatus",
    "inspectedEvidenceMap",
    "resumePolicy",
  ];
  if (requiredFields.some((field) => !Object.hasOwn(result, field))) {
    actionReadyGateFailure(
      "HANDOFF_NOT_ACTIONABLE",
      "Action-ready continuation requires Working Synthesis, Deliverable Status, Inspected Evidence Map, and Resume Policy",
    );
  }
  if (!["review", "research", "diagnosis"].includes(taskType)) return;

  const synthesis = result.workingSynthesis;
  const policy = result.resumePolicy;
  if (
    !synthesis ||
    !["draft_ready", "partial"].includes(synthesis.status) ||
    !Array.isArray(synthesis.sections) ||
    synthesis.sections.length === 0
  ) {
    actionReadyGateFailure(
      "HANDOFF_NOT_ACTIONABLE",
      `${taskType} continuation requires a non-empty draft-ready or partial Working Synthesis`,
    );
  }
  if (
    synthesis.status === "partial" &&
    (!Array.isArray(synthesis.uncertainties) || synthesis.uncertainties.length === 0)
  ) {
    actionReadyGateFailure(
      "HANDOFF_NOT_ACTIONABLE",
      "Partial Working Synthesis requires at least one named uncertainty",
    );
  }
  if (
    !Array.isArray(result.deliverableStatus) ||
    result.deliverableStatus.length !== workingSynthesisInput.deliverables.length ||
    !result.deliverableStatus.some((deliverable) => (
      deliverable?.status === "ready" || deliverable?.status === "partial"
    ))
  ) {
    actionReadyGateFailure(
      "HANDOFF_NOT_ACTIONABLE",
      "Action-ready continuation must disposition every deliverable and leave at least one usable deliverable",
    );
  }
  const usableDeliverables = new Set(
    result.deliverableStatus
      .filter((deliverable) => ["ready", "partial"].includes(deliverable?.status))
      .map((deliverable) => deliverable.deliverableId),
  );
  if (
    !policy ||
    policy.mode !== "synthesize_first" ||
    !Array.isArray(policy.firstDeliverableIds) ||
    policy.firstDeliverableIds.length === 0 ||
    policy.firstDeliverableIds.some((deliverableId) => !usableDeliverables.has(deliverableId)) ||
    !Number.isInteger(policy.maxTargetedReads) ||
    policy.maxTargetedReads > 3 ||
    policy.forbidBroadSearch !== true ||
    policy.forbidFullFileReread !== true
  ) {
    actionReadyGateFailure(
      "HANDOFF_NOT_ACTIONABLE",
      `${taskType} continuation must synthesize first and allow at most three bounded targeted reads`,
    );
  }
}

function actionReadyGateContext(context) {
  requireObject(context, "Action-ready gate context");
  requireObject(context.currentGoal, "Action-ready currentGoal");
  requireObject(context.claimTable, "Action-ready Claim table");
  requireObject(context.workingSynthesisInput, "Action-ready Working Synthesis input");
  const explicitExclusions = context.explicitExclusions ?? [];
  if (!Array.isArray(explicitExclusions)) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "Action-ready explicit exclusions must be an array",
    );
  }
  if (
    context.claimTable.formatVersion !== 1 ||
    context.claimTable.kind !== CONTINUATION_CLAIM_TABLE_KIND ||
    !Array.isArray(context.claimTable.claims)
  ) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "Information Value validation requires a continuation Claim table v1",
    );
  }
  const knownAnchors = continuationEvidenceAnchorLookup(context.evidenceIndex);
  validateClaim(
    context.currentGoal,
    "Action-ready currentGoal",
    knownAnchors,
    "UNKNOWN_EVIDENCE_ANCHOR",
  );
  const claimsById = new Map();
  for (const [index, claim] of context.claimTable.claims.entries()) {
    validateClaim(
      claim,
      `Action-ready Claim table claims[${index}]`,
      knownAnchors,
      "UNKNOWN_EVIDENCE_ANCHOR",
    );
    if (claimsById.has(claim.claimId)) {
      throw new ExportHandoffError(
        "DUPLICATE_CLAIM",
        `Action-ready Claim table contains duplicate Claim ${claim.claimId}`,
      );
    }
    claimsById.set(claim.claimId, claim);
  }
  const existingGoal = claimsById.get(context.currentGoal.claimId);
  if (
    existingGoal &&
    canonicalStringify(existingGoal) !== canonicalStringify(context.currentGoal)
  ) {
    throw new ExportHandoffError(
      "DUPLICATE_CLAIM",
      "Action-ready currentGoal conflicts with the completed Claim table",
    );
  }
  const rootClaimIds = new Set([context.currentGoal.claimId, ...claimsById.keys()]);
  for (const [index, exclusion] of explicitExclusions.entries()) {
    validateClaim(
      exclusion,
      `Action-ready explicitExclusions[${index}]`,
      knownAnchors,
      "UNKNOWN_EVIDENCE_ANCHOR",
    );
    if (exclusion.kind !== "explicit_exclusion" || rootClaimIds.has(exclusion.claimId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `Action-ready explicitExclusions[${index}] is not a unique explicit_exclusion Claim`,
      );
    }
    rootClaimIds.add(exclusion.claimId);
  }
  validateContinuationGlobalRelations(
    context.claimTable.relations,
    claimsById,
    "Action-ready Claim table relations",
  );
  const findingsById = new Map();
  for (const [index, finding] of context.workingSynthesisInput.findings.entries()) {
    requireObject(finding, `workingSynthesisInput.findings[${index}]`);
    requireExactKeys(
      finding,
      ["findingId", "claimId"],
      `workingSynthesisInput.findings[${index}]`,
    );
    requireString(finding.findingId, `workingSynthesisInput.findings[${index}].findingId`);
    requireString(finding.claimId, `workingSynthesisInput.findings[${index}].claimId`);
    if (findingsById.has(finding.findingId) || !claimsById.has(finding.claimId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${finding.findingId} is duplicated or references a Claim outside the completed table`,
      );
    }
    findingsById.set(finding.findingId, finding);
  }
  return { knownAnchors, claimsById, findingsById, explicitExclusions };
}

function actionReadyResultClaim(claim, claimsById, expectedKind, label) {
  const source = claimsById.get(claim?.claimId);
  if (
    !source ||
    source.kind !== expectedKind ||
    canonicalStringify(source) !== canonicalStringify(claim)
  ) {
    actionReadyGateFailure(
      "HANDOFF_LOW_VALUE",
      `${label} is not an exact root-reachable ${expectedKind} Claim`,
    );
  }
  return source;
}

function actionReadyFindingClaim(findingId, findingsById, claimsById, label) {
  const finding = findingsById.get(findingId);
  const claim = finding && claimsById.get(finding.claimId);
  if (!claim) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      `${label} references unknown Finding ${findingId}`,
    );
  }
  return claim;
}

function actionReadyVerificationClass(claimId, relations) {
  const matches = relations.verification.filter((relation) => relation.claim === claimId);
  if (matches.length !== 1) return "mechanical_success";
  return classifyToolOperation({
    inputReceipt: {
      previewHead: JSON.stringify({ command: matches[0].command }),
      previewTail: "",
    },
  });
}

export function buildActionReadyHotContextProjection(result, context) {
  const {
    claimsById,
    findingsById,
    explicitExclusions,
  } = actionReadyGateContext(context);
  const hotClaimsById = new Map();
  const retain = (claim) => {
    hotClaimsById.set(claim.claimId, claim);
    return claim;
  };
  retain(context.currentGoal);
  const retainedExplicitExclusions = explicitExclusions.map(retain);

  const findingClaims = new Map();
  for (const finding of context.workingSynthesisInput.findings) {
    const claim = actionReadyFindingClaim(
      finding.findingId,
      findingsById,
      claimsById,
      "Working Synthesis input",
    );
    if (
      claim.kind === "verification" &&
      actionReadyVerificationClass(claim.claimId, context.claimTable.relations) !== "verification"
    ) {
      actionReadyGateFailure(
        "HANDOFF_LOW_VALUE",
        `Finding ${finding.findingId} promotes an existence probe or mechanical success into Hot Context`,
      );
    }
    findingClaims.set(finding.findingId, retain(claim));
  }

  const constraints = (result.constraints || []).map((claim, index) => retain(
    actionReadyResultClaim(
      claim,
      claimsById,
      "constraint",
      `constraints[${index}]`,
    ),
  ));
  const nextActions = (result.nextActions || []).map((claim, index) => retain(
    actionReadyResultClaim(
      claim,
      claimsById,
      "next_action",
      `nextActions[${index}]`,
    ),
  ));
  const decisions = context.claimTable.relations.decisions
    .filter((decision) => decision.status === "active")
    .map((decision) => ({
      statement: retain(claimsById.get(decision.statement)),
      rationale: decision.rationale.map((claimId) => retain(claimsById.get(claimId))),
    }));

  const sortedClaims = [...hotClaimsById.values()].sort((left, right) => (
    left.claimId < right.claimId ? -1 : left.claimId > right.claimId ? 1 : 0
  ));
  const keyByClaimId = new Map(
    sortedClaims.map((claim, index) => [claim.claimId, `E${index + 1}`]),
  );
  const evidenceKeys = (findingIds) => findingIds.map((findingId) => (
    keyByClaimId.get(findingClaims.get(findingId).claimId)
  ));
  const hotContext = {
    objective: {
      text: context.currentGoal.text,
      evidenceKey: keyByClaimId.get(context.currentGoal.claimId),
    },
    explicitExclusions: retainedExplicitExclusions.map((claim) => ({
      text: claim.text,
      evidenceKey: keyByClaimId.get(claim.claimId),
    })),
    workingSynthesis: {
      status: result.workingSynthesis.status,
      sections: result.workingSynthesis.sections.map((section) => ({
        title: section.title,
        body: section.body,
        evidenceKeys: evidenceKeys(section.findingIds),
      })),
      confirmedFindings: result.workingSynthesis.confirmedFindingIds.map((findingId) => {
        const finding = findingClaims.get(findingId);
        return {
          text: finding.text,
          evidenceKey: keyByClaimId.get(finding.claimId),
        };
      }),
      uncertainties: result.workingSynthesis.uncertainties.map((uncertainty) => ({
        question: uncertainty.question,
        allowedScopes: [...uncertainty.allowedScopes],
        evidenceKeys: evidenceKeys(uncertainty.findingIds),
      })),
    },
    deliverableStatus: result.deliverableStatus.map((deliverable) => ({
      deliverableId: deliverable.deliverableId,
      request: deliverable.request,
      status: deliverable.status,
      evidenceKeys: evidenceKeys(deliverable.findingIds),
      ...(Object.hasOwn(deliverable, "missingReason")
        ? { missingReason: deliverable.missingReason }
        : {}),
    })),
    constraints: constraints.map((claim) => ({
      text: claim.text,
      evidenceKey: keyByClaimId.get(claim.claimId),
    })),
    decisions: decisions.map((decision) => ({
      statement: {
        text: decision.statement.text,
        evidenceKey: keyByClaimId.get(decision.statement.claimId),
      },
      rationale: decision.rationale.map((claim) => ({
        text: claim.text,
        evidenceKey: keyByClaimId.get(claim.claimId),
      })),
    })),
    inspectedEvidenceMap: result.inspectedEvidenceMap.map((inspection) => ({
      location: inspection.location,
      symbols: [...inspection.symbols],
      scope: inspection.scope,
      evidenceKeys: evidenceKeys(inspection.findingIds),
      rereadPolicy: inspection.rereadPolicy,
    })),
    nextActions: nextActions.map((claim) => ({
      text: claim.text,
      evidenceKey: keyByClaimId.get(claim.claimId),
    })),
    relevantVerifications: context.claimTable.relations.verification
      .filter((verification) => {
        const claim = hotClaimsById.get(verification.claim);
        return claim?.kind === "verification" &&
          actionReadyVerificationClass(claim.claimId, context.claimTable.relations) === "verification";
      })
      .map((verification) => ({
        command: verification.command,
        result: verification.result,
        evidenceKey: keyByClaimId.get(verification.claim),
      })),
    resumePolicy: structuredClone(result.resumePolicy),
  };
  const serializedHotContext = canonicalStringify(hotContext);
  const rawIdentifiers = [
    context.currentGoal.claimId,
    ...context.currentGoal.anchors,
    ...explicitExclusions.flatMap((claim) => [claim.claimId, ...claim.anchors]),
    ...context.claimTable.claims.map((claim) => claim.claimId),
    ...context.evidenceIndex.anchors.map((entry) => entry.anchor.anchorId),
  ];
  if (rawIdentifiers.some((identifier) => serializedHotContext.includes(identifier))) {
    actionReadyGateFailure(
      "HANDOFF_LOW_VALUE",
      "Hot Context contains a raw Claim ID or Evidence Anchor instead of a Handoff Evidence Key",
    );
  }
  return {
    formatVersion: 1,
    kind: "codex-handoff-action-ready-projection",
    hotContext,
    evidenceKeyMap: {
      formatVersion: 1,
      kind: "codex-handoff-evidence-key-map",
      entries: sortedClaims.map((claim) => ({
        key: keyByClaimId.get(claim.claimId),
        claimId: claim.claimId,
        anchors: [...claim.anchors],
      })),
    },
  };
}

export function validateActionReadyHandoffGates(result, context) {
  requireObject(result, "Action-ready REDUCE result");
  validateActionReadyActionability(
    result,
    context.workingSynthesisInput,
    context.taskType,
  );
  validateActionReadyReduceResult(result, context.workingSynthesisInput);
  return buildActionReadyHotContextProjection(result, context);
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

function completedContinuationV1Projection(completed) {
  return {
    formatVersion: 1,
    kind: COMPLETED_CONTINUATION_MAP_KIND,
    frameId: completed.frameId,
    frameDigest: completed.frameDigest,
    segmentId: completed.segmentId,
    claims: completed.claims,
    relations: completed.relations,
    criticalExclusions: completed.criticalExclusions,
  };
}

function validateCompletedActionReadyMap(completed, label) {
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
      "findings",
      "deliverables",
      "inspectionDispositions",
    ],
    label,
  );
  if (
    completed.formatVersion !== 2 ||
    completed.kind !== COMPLETED_CONTINUATION_MAP_KIND
  ) {
    throw new ExportHandoffError(
      "INVALID_MODEL_OUTPUT",
      `${label} is not a completed continuation-map-v2 result`,
    );
  }
  for (const field of ["findings", "deliverables", "inspectionDispositions"]) {
    if (!Array.isArray(completed[field])) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${label}.${field} must be an array`,
      );
    }
  }
  const claimIds = new Set((completed.claims || []).map((claim) => claim?.claimId));
  const findingIds = new Set();
  for (const [index, finding] of completed.findings.entries()) {
    const findingLabel = `${label}.findings[${index}]`;
    requireObject(finding, findingLabel);
    requireExactKeys(finding, ["findingId", "claimId"], findingLabel);
    requireString(finding.findingId, `${findingLabel}.findingId`);
    requireString(finding.claimId, `${findingLabel}.claimId`);
    if (
      finding.findingId !== `finding-${sha256Text(finding.claimId)}` ||
      !claimIds.has(finding.claimId) ||
      findingIds.has(finding.findingId)
    ) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${findingLabel} is not bound to one local completed Claim`,
      );
    }
    findingIds.add(finding.findingId);
  }
  const deliverableIds = new Set();
  for (const [index, deliverable] of completed.deliverables.entries()) {
    const deliverableLabel = `${label}.deliverables[${index}]`;
    requireObject(deliverable, deliverableLabel);
    requireAllowedKeys(
      deliverable,
      ["deliverableId", "request", "status", "findingIds"],
      ["missingReason"],
      deliverableLabel,
    );
    requireString(deliverable.deliverableId, `${deliverableLabel}.deliverableId`);
    requireString(deliverable.request, `${deliverableLabel}.request`);
    requireKnownFindingIds(
      deliverable.findingIds,
      `${deliverableLabel}.findingIds`,
      findingIds,
    );
    if (
      !ACTION_READY_DELIVERABLE_STATUSES.has(deliverable.status) ||
      deliverableIds.has(deliverable.deliverableId)
    ) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${deliverableLabel} has an invalid or duplicate status relation`,
      );
    }
    deliverableIds.add(deliverable.deliverableId);
    if (deliverable.status !== "ready") {
      requireString(deliverable.missingReason, `${deliverableLabel}.missingReason`);
    }
  }
  const inspectionIds = new Set();
  for (const [index, inspection] of completed.inspectionDispositions.entries()) {
    const inspectionLabel = `${label}.inspectionDispositions[${index}]`;
    requireObject(inspection, inspectionLabel);
    requireExactKeys(
      inspection,
      [
        "inspectionId",
        "location",
        "symbols",
        "scope",
        "findingIds",
        "rereadPolicy",
      ],
      inspectionLabel,
    );
    requireString(inspection.inspectionId, `${inspectionLabel}.inspectionId`);
    if (inspection.location !== null) requireString(inspection.location, `${inspectionLabel}.location`);
    requireStringArray(inspection.symbols, `${inspectionLabel}.symbols`, {
      duplicateCode: "INVALID_ACTION_READY_RELATION",
    });
    if (inspection.scope !== null) requireString(inspection.scope, `${inspectionLabel}.scope`);
    requireKnownFindingIds(
      inspection.findingIds,
      `${inspectionLabel}.findingIds`,
      findingIds,
    );
    if (
      !ACTION_READY_REREAD_POLICIES.has(inspection.rereadPolicy) ||
      inspectionIds.has(inspection.inspectionId)
    ) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${inspectionLabel} has an invalid or duplicate disposition`,
      );
    }
    inspectionIds.add(inspection.inspectionId);
  }
  return completed;
}

function actionReadyMaps(completedMaps) {
  if (!Array.isArray(completedMaps) || completedMaps.length === 0) {
    throw new ExportHandoffError(
      "INCOMPLETE_CONTINUATION_COVERAGE",
      "Action-ready continuation requires completed continuation-map-v2 results",
    );
  }
  const actionAuthors = [];
  const projected = completedMaps.map((completed, index) => {
    validateCompletedActionReadyMap(completed, `completedMaps[${index}]`);
    if (
      completed.findings.length > 0 ||
      completed.deliverables.length > 0 ||
      completed.inspectionDispositions.length > 0
    ) {
      actionAuthors.push(completed);
    }
    return completedContinuationV1Projection(completed);
  });
  if (actionAuthors.length !== 1) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "Exactly one Progress Evidence MAP result must author action-ready relations",
    );
  }
  return { projected, actionAuthor: actionAuthors[0] };
}

export function buildActionReadyContinuationParentCoverage(
  completedMaps,
  parentTurnId,
  evidenceIndex,
  deterministicClaims = {},
) {
  return buildContinuationParentCoverage(
    completedMaps.map((completed, index) => completedContinuationV1Projection(
      validateCompletedActionReadyMap(completed, `completedMaps[${index}]`),
    )),
    parentTurnId,
    evidenceIndex,
    deterministicClaims,
  );
}

export function buildActionReadyContinuationDownstream(
  completedMaps,
  expectedTurnIds,
  evidenceIndex,
  preservationLedger,
  progressEvidence,
  deterministicClaims = {},
) {
  const { projected, actionAuthor } = actionReadyMaps(completedMaps);
  const downstream = buildContinuationDownstream(
    projected,
    expectedTurnIds,
    evidenceIndex,
    preservationLedger,
    deterministicClaims,
  );
  const progress = actionReadyProgressReferences(progressEvidence);
  if (!progress) {
    throw new ExportHandoffError(
      "INVALID_ACTION_READY_RELATION",
      "Action-ready downstream requires Progress Evidence",
    );
  }
  const claimsById = new Map(
    downstream.claimTable.claims.map((claim) => [claim.claimId, claim]),
  );
  const findings = actionAuthor.findings.map((finding) => {
    if (!claimsById.has(finding.claimId)) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${finding.findingId} references a Claim absent from the completed Claim table`,
      );
    }
    return structuredClone(finding);
  });
  const findingsById = new Map(findings.map((finding) => [finding.findingId, finding]));
  const inspections = actionAuthor.inspectionDispositions.map((disposition) => {
    const source = progress.inspections.get(disposition.inspectionId);
    if (
      !source ||
      canonicalStringify({
        location: disposition.location,
        symbols: disposition.symbols,
        scope: disposition.scope,
      }) !== canonicalStringify({
        location: source.location,
        symbols: source.symbols,
        scope: source.scope,
      })
    ) {
      throw new ExportHandoffError(
        "INVALID_ACTION_READY_RELATION",
        `${disposition.inspectionId} changed its Progress Evidence coordinates`,
      );
    }
    for (const findingId of disposition.findingIds) {
      const finding = findingsById.get(findingId);
      const claim = finding && claimsById.get(finding.claimId);
      const inspectionAnchors = new Set(source.outputEvidence.anchors || []);
      if (!claim || !claim.anchors.some((anchorId) => inspectionAnchors.has(anchorId))) {
        throw new ExportHandoffError(
          "INVALID_ACTION_READY_RELATION",
          `${disposition.inspectionId} has an unsupported Finding relation`,
        );
      }
    }
    return {
      location: disposition.location,
      symbols: [...disposition.symbols],
      scope: disposition.scope,
      findingIds: [...disposition.findingIds],
      rereadPolicy: disposition.rereadPolicy,
    };
  });
  if (
    inspections.length !== progress.inspections.size ||
    actionAuthor.inspectionDispositions.some(
      (disposition) => !progress.inspections.has(disposition.inspectionId),
    )
  ) {
    throw new ExportHandoffError(
      "INCOMPLETE_INSPECTION_DISPOSITION",
      "Completed continuation-map-v2 results must dispose every Progress Evidence inspection",
    );
  }
  return {
    ...downstream,
    workingSynthesisInput: {
      formatVersion: 1,
      kind: "codex-handoff-working-synthesis-input",
      findings,
      deliverables: structuredClone(actionAuthor.deliverables),
      inspections,
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
  if (context.actionReadyGateContext) {
    validateActionReadyHandoffGates(result, context.actionReadyGateContext);
  } else if (context.workingSynthesisInput) {
    validateActionReadyReduceResult(result, context.workingSynthesisInput);
  }
  return result;
}
