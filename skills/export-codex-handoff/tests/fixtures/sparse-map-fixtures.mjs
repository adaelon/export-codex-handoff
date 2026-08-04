export const FRAME_ID = "frame-sparse-map-fixture";
export const FRAME_DIGEST = `sha256:${"f".repeat(64)}`;
export const ANCHORS = [
  `anchor-${"a".repeat(64)}`,
  `anchor-${"b".repeat(64)}`,
  `anchor-${"c".repeat(64)}`,
];

export function claim(claimId, kind, text, anchorIndex) {
  return { claimId, kind, text, anchors: [ANCHORS[anchorIndex]] };
}

function turn(turnId, anchorId) {
  return {
    turnId,
    userMessages: [{ text: `synthetic evidence for ${turnId}`, anchors: [anchorId] }],
    assistantMessages: [],
    toolReceipts: [],
  };
}

export function segmentChunk() {
  return {
    segmentId: "segment-001",
    stage: "segment_map",
    sourceSessionId: "00000000-0000-7000-8000-000000000001",
    expectedTurnIds: ["turn-1", "turn-2", "turn-3"],
    turns: [
      turn("turn-1", ANCHORS[0]),
      turn("turn-2", ANCHORS[1]),
      turn("turn-3", ANCHORS[2]),
    ],
    compressionFrame: { frameId: FRAME_ID },
    frameDigest: FRAME_DIGEST,
  };
}

export function sparseFixture() {
  return {
    formatVersion: 1,
    kind: "codex-handoff-sparse-map",
    frameId: FRAME_ID,
    frameDigest: FRAME_DIGEST,
    segmentId: "segment-001",
    claims: [
      claim("claim-objective", "objective", "Retain the active objective", 0),
      claim("claim-decision", "decision", "Use sparse bookkeeping", 0),
      claim("claim-rationale", "rationale", "Avoid repeated coverage prose", 0),
      claim("claim-goal", "attempt_goal", "Validate the candidate", 2),
      claim("claim-action", "attempt_action", "Run deterministic expansion", 2),
      claim("claim-outcome", "attempt_outcome", "Expansion succeeded", 2),
      claim("claim-verification", "verification", "node --test sparse-map.test.mjs => pass", 2),
    ],
    claimGroups: {
      objectiveFacts: ["claim-objective"],
      userConstraints: [],
      completedWork: [],
      openWork: [],
      nextActions: [],
      importantLocations: [],
      conflicts: [],
    },
    claimBindings: [
      { claimId: "claim-objective", evidenceIndexes: [0] },
      { claimId: "claim-decision", evidenceIndexes: [0] },
      { claimId: "claim-rationale", evidenceIndexes: [0] },
      { claimId: "claim-goal", evidenceIndexes: [2] },
      { claimId: "claim-action", evidenceIndexes: [2] },
      { claimId: "claim-outcome", evidenceIndexes: [2] },
      { claimId: "claim-verification", evidenceIndexes: [2] },
    ],
    exclusionRanges: [{
      startIndex: 1,
      endIndexExclusive: 2,
      reasonCode: "non_semantic",
    }],
    archivalLedger: {
      decisions: [{
        statementClaimId: "claim-decision",
        rationaleClaimIds: ["claim-rationale"],
        status: "active",
        supersedes: [],
      }],
      attempts: [{
        goalClaimId: "claim-goal",
        actionClaimId: "claim-action",
        outcomeClaimId: "claim-outcome",
      }],
      verification: [{
        claimId: "claim-verification",
        command: "node --test sparse-map.test.mjs",
        result: "pass",
      }],
    },
    compressionNotes: ["synthetic fixture"],
  };
}

export function fullFixture() {
  const sparse = sparseFixture();
  const byId = new Map(sparse.claims.map((item) => [item.claimId, item]));
  const copy = (claimId) => structuredClone(byId.get(claimId));
  return {
    frameId: FRAME_ID,
    frameDigest: FRAME_DIGEST,
    segmentId: "segment-001",
    turnCoverage: [
      {
        turnId: "turn-1",
        status: "summarized",
        claimIds: ["claim-objective", "claim-decision", "claim-rationale"],
        reason: "captured by sparse MAP claim bindings",
      },
      {
        turnId: "turn-2",
        status: "ignored",
        claimIds: [],
        reason: "excluded by sparse MAP: non-semantic evidence",
      },
      {
        turnId: "turn-3",
        status: "summarized",
        claimIds: ["claim-goal", "claim-action", "claim-outcome", "claim-verification"],
        reason: "captured by sparse MAP claim bindings",
      },
    ],
    objectiveFacts: [copy("claim-objective")],
    userConstraints: [],
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: [],
    conflicts: [],
    archivalLedger: {
      decisions: [{
        statement: copy("claim-decision"),
        rationale: [copy("claim-rationale")],
        status: "active",
        supersedes: [],
      }],
      attempts: [{
        goal: copy("claim-goal"),
        action: copy("claim-action"),
        outcome: copy("claim-outcome"),
      }],
      verification: [{
        claimId: "claim-verification",
        command: "node --test sparse-map.test.mjs",
        result: "pass",
        anchors: [ANCHORS[2]],
      }],
    },
    compressionNotes: ["synthetic fixture"],
  };
}

export function importantLocationsFullDiagnosticFixture() {
  const candidate = fullFixture();
  candidate.importantLocations = [{
    claimId: "map009-important-location",
    kind: "important_location",
    location: "C:/synthetic/workspace/reduce-input.json",
    purpose: "synthetic REDUCE-shaped location in a MAP result",
    anchors: [ANCHORS[0]],
  }];
  candidate.turnCoverage[0].claimIds.push("map009-important-location");
  return candidate;
}

export function importantLocationsSparseFixture() {
  const candidate = sparseFixture();
  candidate.claims.push(claim(
    "map009-important-location",
    "important_location",
    "C:/synthetic/workspace/reduce-input.json — synthetic MAP Claim location",
    0,
  ));
  candidate.claimGroups.importantLocations.push("map009-important-location");
  candidate.claimBindings.push({
    claimId: "map009-important-location",
    evidenceIndexes: [0],
  });
  return candidate;
}

export function reusedVerificationFullDiagnosticFixture() {
  const candidate = fullFixture();
  const reused = claim(
    "map009-red-outcome",
    "verification",
    "node --test retained-map-009 => fail",
    2,
  );
  candidate.archivalLedger.attempts[0].outcome = structuredClone(reused);
  candidate.archivalLedger.verification[0] = {
    claimId: reused.claimId,
    command: "node --test retained-map-009",
    result: "fail",
    anchors: [...reused.anchors],
  };
  candidate.turnCoverage[2].claimIds = [
    "claim-goal",
    "claim-action",
    reused.claimId,
  ];
  return candidate;
}

export function reusedVerificationSparseDiagnosticFixture() {
  const candidate = sparseFixture();
  candidate.claims = candidate.claims.filter((item) => item.claimId !== "claim-outcome");
  candidate.claimBindings = candidate.claimBindings.filter(
    (binding) => binding.claimId !== "claim-outcome",
  );
  candidate.archivalLedger.attempts[0].outcomeClaimId = "claim-verification";
  return candidate;
}

export function sparseFromFullMapResult(fullResult) {
  const claims = [];
  const claimIds = new Set();
  const addClaim = (candidate) => {
    if (claimIds.has(candidate.claimId)) {
      throw new Error(`Cannot sparsify duplicate Claim ${candidate.claimId}`);
    }
    claimIds.add(candidate.claimId);
    claims.push(structuredClone(candidate));
  };
  const claimGroups = {};
  for (const field of [
    "objectiveFacts",
    "userConstraints",
    "completedWork",
    "openWork",
    "nextActions",
    "importantLocations",
    "conflicts",
  ]) {
    claimGroups[field] = fullResult[field].map((candidate) => {
      addClaim(candidate);
      return candidate.claimId;
    });
  }

  const archivalLedger = {
    decisions: fullResult.archivalLedger.decisions.map((decision) => {
      addClaim(decision.statement);
      for (const rationale of decision.rationale) addClaim(rationale);
      return {
        statementClaimId: decision.statement.claimId,
        rationaleClaimIds: decision.rationale.map((claim) => claim.claimId),
        status: decision.status,
        supersedes: [...decision.supersedes],
      };
    }),
    attempts: fullResult.archivalLedger.attempts.map((attempt) => {
      for (const field of ["goal", "action", "outcome"]) addClaim(attempt[field]);
      if (attempt.lesson) addClaim(attempt.lesson);
      return {
        goalClaimId: attempt.goal.claimId,
        actionClaimId: attempt.action.claimId,
        outcomeClaimId: attempt.outcome.claimId,
        ...(attempt.failureClass ? { failureClass: attempt.failureClass } : {}),
        ...(attempt.lesson ? { lessonClaimId: attempt.lesson.claimId } : {}),
      };
    }),
    verification: fullResult.archivalLedger.verification.map((verification) => {
      addClaim({
        claimId: verification.claimId,
        kind: "verification",
        text: `${verification.command} => ${verification.result}`,
        anchors: [...verification.anchors],
      });
      return {
        claimId: verification.claimId,
        command: verification.command,
        result: verification.result,
      };
    }),
  };

  const coverage = fullResult.turnCoverage || fullResult.fragmentCoverage;
  const bindingIndexes = new Map(claims.map((candidate) => [candidate.claimId, []]));
  for (const [index, entry] of coverage.entries()) {
    for (const claimId of entry.claimIds) bindingIndexes.get(claimId).push(index);
  }
  const exclusionRanges = [];
  for (let index = 0; index < coverage.length;) {
    if (coverage[index].status !== "ignored") {
      index += 1;
      continue;
    }
    const startIndex = index;
    while (index < coverage.length && coverage[index].status === "ignored") index += 1;
    exclusionRanges.push({
      startIndex,
      endIndexExclusive: index,
      reasonCode: "non_semantic",
    });
  }

  return {
    formatVersion: 1,
    kind: "codex-handoff-sparse-map",
    frameId: fullResult.frameId,
    frameDigest: fullResult.frameDigest,
    segmentId: fullResult.segmentId,
    claims,
    claimGroups,
    claimBindings: claims.map((candidate) => ({
      claimId: candidate.claimId,
      evidenceIndexes: bindingIndexes.get(candidate.claimId),
    })),
    exclusionRanges,
    archivalLedger,
    compressionNotes: [...fullResult.compressionNotes],
  };
}
