import {
  canonicalStringify,
  sha256Text,
} from "./evidence-addressing.mjs";
import { ExportHandoffError } from "./source-thread.mjs";

const TASK_TYPES = new Set([
  "implementation",
  "diagnosis",
  "review",
  "research",
  "documentation",
  "other",
]);
const TASK_PHASES = new Set([
  "discovering",
  "implementing",
  "verifying",
  "blocked",
  "handoff",
]);
const EXCLUSION_MARKER_PATTERN = /\b(?:do not|don't|must not|never|exclude|excluded|non-goal|out of scope|without)\b|(?:不要|不得|禁止|不做|排除|范围外|无需|无须|不能|不可)/giu;
const EXCLUSION_CONNECTOR_PATTERN = /(?:\b(?:and|or|but|nor|also)\b|(?:并且|而且|以及|同时|并|且|也|但|而))\s*$/iu;
const POSITIVE_TAIL_PATTERN = /[,，]\s*(?:(?:and|but)\s+)?(?:then|next|finally)\b|[,，]\s*(?:然后|随后|接着|最后|再)(?=\s|$)/giu;

function fail(code, message, details = undefined) {
  throw new ExportHandoffError(code, message, details);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_COMPRESSION_FRAME", `${label} must be an object`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_COMPRESSION_FRAME", `${label} must be a non-empty string`);
  }
}

function requireStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim()) ||
    new Set(value).size !== value.length
  ) {
    fail("INVALID_COMPRESSION_FRAME", `${label} must contain unique non-empty strings`);
  }
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalStringify(actual) !== canonicalStringify(wanted)) {
    fail(
      "INVALID_COMPRESSION_FRAME",
      `${label} keys must be exactly: ${wanted.join(", ")}`,
    );
  }
}

function sameContract(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function stableUnique(values) {
  return [...new Set(values)];
}

function claim(kind, text, anchors, identity) {
  const normalizedAnchors = stableUnique(anchors);
  return {
    claimId: `claim-${sha256Text(canonicalStringify({ kind, text, anchors: normalizedAnchors, identity }))}`,
    kind,
    text,
    anchors: normalizedAnchors,
  };
}

function anchoredMessageClaim(kind, message, identity) {
  const text = message?.text;
  const anchors = message?.anchors || [];
  if (typeof text !== "string" || !text.trim()) {
    fail("FRAME_GOAL_MISSING", `${kind} message is empty`);
  }
  if (anchors.length === 0) {
    fail("FRAME_GOAL_ANCHOR_MISSING", `${kind} message has no Evidence Anchor`);
  }
  return claim(kind, text, anchors, identity);
}

function messageClaims(evidencePack) {
  const claims = [];
  for (const [turnIndex, turn] of evidencePack.turns.entries()) {
    for (const [messageIndex, message] of (turn.userMessages || []).entries()) {
      const text = String(message?.text || "").trim();
      if (!text) continue;
      const anchors = message.anchors || [];
      if (anchors.length === 0) {
        fail(
          "FRAME_GOAL_ANCHOR_MISSING",
          `User goal ${turn.turnId}/${messageIndex} has no Evidence Anchor`,
        );
      }
      claims.push(claim("user_goal", text, anchors, {
        turnId: turn.turnId,
        turnIndex,
        messageIndex,
      }));
    }
  }
  if (claims.length === 0) {
    fail("FRAME_GOAL_MISSING", "Evidence Pack contains no anchored user goal");
  }
  return claims;
}

function hardExclusionEnd(text, start) {
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\r" || character === "\n" || character === ";" || character === "；") {
      return index;
    }
    if (
      ".!?。！？".includes(character) &&
      (index + 1 === text.length || /\s/u.test(text[index + 1]))
    ) {
      return index + 1;
    }
  }
  return text.length;
}

function splitBeforeMarker(text, current, next, hardEnd) {
  if (!next || next.index >= hardEnd) return hardEnd;
  const between = text.slice(current.index + current[0].length, next.index);
  const lastComma = Math.max(between.lastIndexOf(","), between.lastIndexOf("，"));
  if (lastComma >= 0) return current.index + current[0].length + lastComma;
  const connector = EXCLUSION_CONNECTOR_PATTERN.exec(between);
  if (connector) return current.index + current[0].length + connector.index;
  return hardEnd;
}

function trimPositiveTail(text, start, end) {
  const span = text.slice(start, end);
  const transition = [...span.matchAll(POSITIVE_TAIL_PATTERN)].at(0);
  return transition ? start + transition.index : end;
}

function exclusionSpans(text) {
  const markers = [...text.matchAll(EXCLUSION_MARKER_PATTERN)];
  const spans = [];
  let coveredUntil = -1;
  for (const [index, marker] of markers.entries()) {
    if (marker.index < coveredUntil) continue;
    const hardEnd = hardExclusionEnd(text, marker.index + marker[0].length);
    const markerEnd = splitBeforeMarker(text, marker, markers[index + 1], hardEnd);
    const end = trimPositiveTail(text, marker.index, markerEnd);
    const span = text.slice(marker.index, end).trimEnd();
    if (span) spans.push(span);
    coveredUntil = markerEnd;
  }
  return stableUnique(spans);
}

function exclusionClaims(goal) {
  return exclusionSpans(goal.text).map((text, index) => claim(
    "explicit_exclusion",
    text,
    goal.anchors,
    { goalClaimId: goal.claimId, index },
  ));
}

function workspaceCheckpointClaim(evidencePack, knownAnchors) {
  const checkpoint = evidencePack.workspace?.checkpoint;
  if (checkpoint?.status !== "found" || typeof checkpoint.content !== "string") return null;
  if (
    checkpoint.freshness !== undefined &&
    checkpoint.freshness !== "fresh"
  ) return null;
  const anchors = (evidencePack.evidenceAnchors || [])
    .filter((anchor) => (
      anchor.sourceKind === "workspace" &&
      anchor.payloadPath === "/checkpoint/content" &&
      knownAnchors.has(anchor.anchorId)
    ))
    .map((anchor) => anchor.anchorId);
  if (anchors.length === 0) {
    fail("FRAME_CHECKPOINT_ANCHOR_MISSING", "Workspace checkpoint has no Evidence Anchor");
  }
  return claim("workspace_checkpoint", checkpoint.content, anchors, {
    path: checkpoint.path || null,
  });
}

function validateClaim(value, label, knownAnchors) {
  requireObject(value, label);
  requireExactKeys(value, ["claimId", "kind", "text", "anchors"], label);
  requireString(value.claimId, `${label}.claimId`);
  requireString(value.kind, `${label}.kind`);
  requireString(value.text, `${label}.text`);
  requireStringArray(value.anchors, `${label}.anchors`);
  for (const anchorId of value.anchors) {
    if (!knownAnchors.has(anchorId)) {
      fail("UNKNOWN_FRAME_ANCHOR", `${label} references unknown Evidence Anchor ${anchorId}`);
    }
  }
}

function validatePreservationPolicy(policy, expected, knownAnchors) {
  requireObject(policy, "preservationPolicy");
  requireExactKeys(
    policy,
    ["sourceRevision", "requiredAnchors", "exactIdentifiers", "criticalCategories"],
    "preservationPolicy",
  );
  requireString(policy.sourceRevision, "preservationPolicy.sourceRevision");
  requireStringArray(policy.requiredAnchors, "preservationPolicy.requiredAnchors");
  requireStringArray(policy.criticalCategories, "preservationPolicy.criticalCategories");
  if (!Array.isArray(policy.exactIdentifiers)) {
    fail("INVALID_COMPRESSION_FRAME", "preservationPolicy.exactIdentifiers must be an array");
  }
  for (const [index, identifier] of policy.exactIdentifiers.entries()) {
    requireObject(identifier, `preservationPolicy.exactIdentifiers[${index}]`);
    requireExactKeys(
      identifier,
      ["kind", "value", "anchors"],
      `preservationPolicy.exactIdentifiers[${index}]`,
    );
    requireString(identifier.kind, `preservationPolicy.exactIdentifiers[${index}].kind`);
    requireString(identifier.value, `preservationPolicy.exactIdentifiers[${index}].value`);
    requireStringArray(
      identifier.anchors,
      `preservationPolicy.exactIdentifiers[${index}].anchors`,
    );
  }

  for (const anchorId of [
    ...policy.requiredAnchors,
    ...policy.exactIdentifiers.flatMap((identifier) => identifier.anchors),
  ]) {
    if (!knownAnchors.has(anchorId)) {
      fail("UNKNOWN_FRAME_ANCHOR", `Preservation policy references unknown Evidence Anchor ${anchorId}`);
    }
  }
  if (!sameContract(policy.exactIdentifiers, expected.exactIdentifiers)) {
    fail("IDENTIFIER_MISMATCH", "Compression Frame changed an exact identifier obligation");
  }
  const missingCategories = expected.criticalCategories.filter(
    (category) => !policy.criticalCategories.includes(category),
  );
  if (missingCategories.length > 0) {
    fail(
      "MISSING_CRITICAL_CATEGORY",
      `Compression Frame omitted critical categories: ${missingCategories.join(", ")}`,
    );
  }
  if (
    policy.sourceRevision !== expected.sourceRevision ||
    !sameContract(policy.requiredAnchors, expected.requiredAnchors) ||
    !sameContract(policy.criticalCategories, expected.criticalCategories)
  ) {
    fail("PRESERVATION_POLICY_MISMATCH", "Compression Frame changed the Preservation Ledger");
  }
}

export function compressionFrameDigest(frame) {
  return `sha256:${sha256Text(canonicalStringify(frame))}`;
}

export function frameInputDigest(frameInput) {
  return `sha256:${sha256Text(canonicalStringify(frameInput))}`;
}

export function buildFrameInput(evidencePack, evidenceIndex, options = {}) {
  const knownAnchors = new Set(
    (evidenceIndex.anchors || []).map((entry) => entry?.anchor?.anchorId).filter(Boolean),
  );
  const goals = messageClaims(evidencePack);
  const terminalArtifactsAvailable = Boolean(
    evidencePack.sourceContinuation?.currentGoal && evidencePack.terminalStateClaim
  );
  const hasTerminalContract = options.terminalAuthority === undefined
    ? terminalArtifactsAvailable
    : options.terminalAuthority === true && terminalArtifactsAvailable;
  const latestUserGoal = hasTerminalContract
    ? anchoredMessageClaim(
      "user_goal",
      evidencePack.sourceContinuation.currentGoal,
      { role: "current_goal", formatVersion: 2 },
    )
    : goals.at(-1);
  const acceptedProposal = hasTerminalContract && evidencePack.sourceContinuation.acceptedProposal
    ? anchoredMessageClaim(
      "accepted_proposal",
      evidencePack.sourceContinuation.acceptedProposal,
      { role: "accepted_proposal", formatVersion: 2 },
    )
    : null;
  const terminalStateClaim = hasTerminalContract
    ? structuredClone(evidencePack.terminalStateClaim)
    : null;
  if (terminalStateClaim && terminalStateClaim.kind !== "terminal_state") {
    fail("INVALID_COMPRESSION_FRAME", "terminalStateClaim must use kind terminal_state");
  }
  const explicitExclusions = exclusionClaims(latestUserGoal);
  const workspaceCheckpoint = workspaceCheckpointClaim(evidencePack, knownAnchors);
  const preservationPolicy = evidenceIndex.preservationLedger;
  const requiredFrameAnchors = stableUnique([
    ...latestUserGoal.anchors,
    ...(acceptedProposal?.anchors || []),
    ...(terminalStateClaim?.anchors || []),
    ...explicitExclusions.flatMap((item) => item.anchors),
    ...(workspaceCheckpoint?.anchors || []),
    ...preservationPolicy.requiredAnchors,
  ]);
  const expectedFrameId = `frame-${sha256Text(canonicalStringify({
    formatVersion: hasTerminalContract ? 2 : 1,
    sourceRevision: evidencePack.source.sourceRevision,
    currentGoal: latestUserGoal,
    ...(hasTerminalContract ? { acceptedProposal, terminalStateClaim } : {}),
    explicitExclusions,
    workspaceCheckpoint,
    preservationPolicy,
  }))}`;
  return {
    formatVersion: hasTerminalContract ? 2 : 1,
    kind: "codex-handoff-frame-input",
    sourceRevision: evidencePack.source.sourceRevision,
    expectedFrameId,
    latestUserGoal,
    ...(hasTerminalContract ? { acceptedProposal, terminalStateClaim } : {}),
    supersededUserGoals: goals.slice(0, -1),
    explicitExclusions,
    workspaceCheckpoint,
    preservationPolicy,
    knownAnchors: [...knownAnchors],
    requiredFrameAnchors,
    taskTypes: [...TASK_TYPES],
    taskPhases: [...TASK_PHASES],
  };
}

export function validateCompressionFrame(frame, frameInput) {
  requireObject(frameInput, "Compression Frame input");
  requireObject(frame, "Compression Frame");
  const terminalContract = frameInput.formatVersion === 2;
  requireExactKeys(
    frame,
    terminalContract
      ? [
        "formatVersion",
        "frameId",
        "currentGoal",
        "acceptedProposal",
        "terminalStateClaim",
        "taskType",
        "taskPhase",
        "explicitExclusions",
        "preservationPolicy",
        "anchors",
      ]
      : [
        "frameId",
        "currentGoal",
        "taskType",
        "taskPhase",
        "explicitExclusions",
        "preservationPolicy",
        "anchors",
      ],
    "Compression Frame",
  );
  if (terminalContract && frame.formatVersion !== 2) {
    fail("INVALID_COMPRESSION_FRAME", "Terminal-authority Compression Frame must use formatVersion 2");
  }
  const knownAnchors = new Set(frameInput.knownAnchors || []);
  requireString(frame.frameId, "frameId");
  if (frame.frameId !== frameInput.expectedFrameId) {
    fail("FRAME_ID_MISMATCH", `Expected frameId ${frameInput.expectedFrameId}`);
  }
  validateClaim(frame.currentGoal, "currentGoal", knownAnchors);
  if (!sameContract(frame.currentGoal, frameInput.latestUserGoal)) {
    fail("UNSUPPORTED_FRAME_CLAIM", "Compression Frame currentGoal is not the latest user goal");
  }
  if (terminalContract) {
    if (frame.acceptedProposal !== null) {
      validateClaim(frame.acceptedProposal, "acceptedProposal", knownAnchors);
      if (frame.acceptedProposal.kind !== "accepted_proposal") {
        fail("INVALID_COMPRESSION_FRAME", "acceptedProposal must use kind accepted_proposal");
      }
    }
    if (!sameContract(frame.acceptedProposal, frameInput.acceptedProposal)) {
      fail("UNSUPPORTED_FRAME_CLAIM", "Compression Frame changed the Accepted Proposal");
    }
    validateClaim(frame.terminalStateClaim, "terminalStateClaim", knownAnchors);
    if (frame.terminalStateClaim.kind !== "terminal_state") {
      fail("INVALID_COMPRESSION_FRAME", "terminalStateClaim must use kind terminal_state");
    }
    if (!sameContract(frame.terminalStateClaim, frameInput.terminalStateClaim)) {
      fail("UNSUPPORTED_FRAME_CLAIM", "Compression Frame changed the Terminal-State Claim");
    }
  }
  if (!TASK_TYPES.has(frame.taskType)) {
    fail("INVALID_COMPRESSION_FRAME", `Unknown taskType ${frame.taskType}`);
  }
  if (!TASK_PHASES.has(frame.taskPhase)) {
    fail("INVALID_COMPRESSION_FRAME", `Unknown taskPhase ${frame.taskPhase}`);
  }
  if (!Array.isArray(frame.explicitExclusions)) {
    fail("INVALID_COMPRESSION_FRAME", "explicitExclusions must be an array");
  }
  frame.explicitExclusions.forEach((item, index) => (
    validateClaim(item, `explicitExclusions[${index}]`, knownAnchors)
  ));
  if (!sameContract(frame.explicitExclusions, frameInput.explicitExclusions)) {
    fail("UNSUPPORTED_FRAME_CLAIM", "Compression Frame changed explicit exclusions");
  }
  validatePreservationPolicy(
    frame.preservationPolicy,
    frameInput.preservationPolicy,
    knownAnchors,
  );
  requireStringArray(frame.anchors, "anchors");
  for (const anchorId of frame.anchors) {
    if (!knownAnchors.has(anchorId)) {
      fail("UNKNOWN_FRAME_ANCHOR", `Compression Frame references unknown Evidence Anchor ${anchorId}`);
    }
  }
  if (!sameContract(frame.anchors, frameInput.requiredFrameAnchors)) {
    fail("FRAME_ANCHOR_SET_MISMATCH", "Compression Frame changed its required anchor set");
  }
  return {
    frame,
    frameId: frame.frameId,
    frameDigest: compressionFrameDigest(frame),
  };
}
