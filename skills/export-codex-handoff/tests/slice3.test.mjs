import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { renderHandoff } from "../scripts/lib/render-handoff.mjs";
import {
  deriveFinalProvenance,
  validateMapResult,
  validateReduceResult,
} from "../scripts/lib/validation.mjs";

const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const FRAME_DIGEST = `sha256:${"f".repeat(64)}`;
const TURN_IDS = ["turn-1", "turn-2"];
const CRITICAL_CATEGORIES = [
  "constraint",
  "decision",
  "change",
  "verification",
  "open_work",
  "rollback",
];

function sourceEntry(turnId, eventOrdinal, text) {
  return createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId,
    eventOrdinal,
    rolloutLine: eventOrdinal,
    payloadPath: "/payload/content",
    value: [{ type: "input_text", text }],
    locator: { kind: "rollout_payload" },
  });
}

function fixture() {
  const entries = [
    sourceEntry("turn-1", 1, "Choose the append-only ledger because order matters."),
    sourceEntry("turn-2", 2, "The first approach failed; tests were not run."),
  ];
  const preservationLedger = {
    ...buildPreservationLedger(SOURCE_REVISION, entries),
    criticalCategories: CRITICAL_CATEGORIES,
  };
  const source = {
    sessionId: SESSION_ID,
    rolloutPath: "C:/codex/rollout.jsonl",
    sourceRevision: SOURCE_REVISION,
    sourceBytes: 2_000,
    sourceChars: 2_000,
    session: {
      id: SESSION_ID,
      cwd: "C:/workspace",
      startedAt: "2026-07-29T00:00:00Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: "C:/workspace",
    sourceRevision: null,
    checkpoint: { status: "missing" },
    git: { status: "unavailable" },
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source,
    workspace,
    entries,
    preservationLedger,
  });
  const anchorIds = entries.map((entry) => entry.anchor.anchorId);
  const frame = {
    frameId: "frame-slice-3",
    frameDigest: FRAME_DIGEST,
    frame: {
      frameId: "frame-slice-3",
      currentGoal: {
        claimId: "goal-current",
        kind: "current_goal",
        text: "Implement Semantic Coverage and the Archival Ledger.",
        anchors: [anchorIds[1]],
      },
      explicitExclusions: [],
    },
  };
  return { entries, preservationLedger, source, workspace, evidenceIndex, anchorIds, frame };
}

function claim(claimId, kind, text, anchors) {
  return { claimId, kind, text, anchors };
}

function emptyMap(chunk) {
  return {
    frameId: chunk.compressionFrame.frameId,
    frameDigest: chunk.frameDigest,
    segmentId: chunk.segmentId,
    turnCoverage: [],
    objectiveFacts: [],
    userConstraints: [],
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: [],
    conflicts: [],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    compressionNotes: [],
  };
}

function mapChunk(fx, turnIds = TURN_IDS) {
  return {
    segmentId: "segment-001",
    expectedTurnIds: turnIds,
    turns: turnIds.map((turnId, index) => ({
      turnId,
      userMessages: [{
        text: `Evidence ${turnId}`,
        anchors: [fx.anchorIds[index]],
      }],
      assistantMessages: [],
      tools: [],
      toolReceipts: [],
      patches: [],
    })),
    compressionFrame: fx.frame.frame,
    frameDigest: fx.frame.frameDigest,
  };
}

function archivalReduce(fx, options = {}) {
  const [firstAnchor, secondAnchor] = fx.anchorIds;
  const decisions = [
    {
      statement: claim(
        "decision-old",
        "decision",
        "Use an unordered category summary.",
        [firstAnchor],
      ),
      rationale: [
        claim("rationale-old", "decision_rationale", "It looked compact.", [firstAnchor]),
      ],
      status: "superseded",
      supersedes: [],
    },
    {
      statement: claim(
        "decision-active",
        "decision",
        "Use a chronological Archival Ledger.",
        [secondAnchor],
      ),
      rationale: [
        claim(
          "rationale-active",
          "decision_rationale",
          "Order and supersession must remain recoverable.",
          [firstAnchor, secondAnchor],
        ),
      ],
      status: "active",
      supersedes: ["decision-old"],
    },
  ];
  const attempts = [{
    goal: claim("attempt-goal", "attempt_goal", "Validate turn enumeration.", [firstAnchor]),
    action: claim("attempt-action", "attempt_action", "Accepted a complete turn ID list.", [firstAnchor]),
    outcome: claim("attempt-outcome", "attempt_outcome", "Empty facts still passed.", [secondAnchor]),
    failureClass: "semantic-coverage-gap",
    lesson: claim(
      "attempt-lesson",
      "failure_lesson",
      "Coverage must link turns to supported claims.",
      [firstAnchor, secondAnchor],
    ),
  }];
  const verification = [
    {
      claimId: "verification-pass",
      command: "node --test pass.test.mjs",
      result: "pass",
      anchors: [firstAnchor],
    },
    {
      claimId: "verification-fail",
      command: "node --test fail.test.mjs",
      result: "fail",
      anchors: [secondAnchor],
    },
    {
      claimId: "verification-not-run",
      command: "node --test pending.test.mjs",
      result: "not_run",
      anchors: [secondAnchor],
    },
    {
      claimId: "verification-unknown",
      command: "external verification",
      result: "unknown",
      anchors: [secondAnchor],
    },
  ];
  return {
    frameId: fx.frame.frameId,
    frameDigest: fx.frame.frameDigest,
    continuationDirective: "Continue from the validated claim graph.",
    objective: {
      goal: fx.frame.frame.currentGoal.text,
      explicitExclusions: [],
    },
    constraints: [
      claim("constraint-1", "constraint", "Preserve exact evidence anchors.", [firstAnchor]),
    ],
    workspaceState: {
      summary: claim("workspace-state", "workspace_state", "Workspace state is known.", [secondAnchor]),
      evidenceStatus: "full",
      conflicts: [],
    },
    completedWork: [
      claim("change-1", "change", "The first contract was superseded.", [secondAnchor]),
    ],
    openWork: [
      claim("open-work-1", "open_work", "Publish the claim coverage graph.", [secondAnchor]),
    ],
    nextActions: [
      claim("next-action-1", "next_action", "Run the Slice 3 suite.", [secondAnchor]),
    ],
    importantLocations: [{
      claimId: "location-1",
      kind: "important_location",
      location: "scripts/lib/validation.mjs",
      purpose: "claim graph validation",
      anchors: [secondAnchor],
    }],
    archivalLedger: { decisions, attempts, verification },
    preservationCoverage: CRITICAL_CATEGORIES.map((category) => {
      const represented = {
        constraint: ["constraint-1"],
        decision: ["decision-active"],
        change: ["change-1"],
        verification: ["verification-pass", "verification-fail"],
        open_work: ["open-work-1"],
      }[category];
      return represented
        ? { category, status: "represented", claimIds: represented, reason: "retained claims" }
        : { category, status: "absent", claimIds: [], reason: "no rollback evidence retained" };
    }),
    provenance: {
      ...(options.provenanceIds ? { sourceTurnIds: options.provenanceIds } : {}),
      notes: [],
    },
    compressionNotes: [],
  };
}

test("rejects complete turn enumeration when summarized turns reach no claims", () => {
  const fx = fixture();
  const chunk = mapChunk(fx, ["turn-1"]);
  const result = emptyMap(chunk);
  result.turnCoverage = [{
    turnId: "turn-1",
    status: "summarized",
    claimIds: [],
    reason: "turn ID enumerated",
  }];
  assert.throws(
    () => validateMapResult(result, chunk, fx.frame),
    { code: "INCOMPLETE_SEMANTIC_COVERAGE" },
  );
});

test("MAP coverage rejects duplicate, unsupported, and unreachable claims", async (t) => {
  const fx = fixture();
  const chunk = mapChunk(fx, ["turn-1"]);

  await t.test("duplicate claim IDs", () => {
    const result = emptyMap(chunk);
    result.objectiveFacts = [
      claim("claim-1", "objective", "First", [fx.anchorIds[0]]),
      claim("claim-1", "objective", "Second", [fx.anchorIds[0]]),
    ];
    result.turnCoverage = [{
      turnId: "turn-1",
      status: "summarized",
      claimIds: ["claim-1"],
      reason: "captured objective",
    }];
    assert.throws(
      () => validateMapResult(result, chunk, fx.frame),
      { code: "DUPLICATE_CLAIM" },
    );
  });

  await t.test("unknown anchor", () => {
    const result = emptyMap(chunk);
    result.objectiveFacts = [
      claim("claim-1", "objective", "Unsupported", ["anchor-does-not-exist"]),
    ];
    result.turnCoverage = [{
      turnId: "turn-1",
      status: "summarized",
      claimIds: ["claim-1"],
      reason: "captured objective",
    }];
    assert.throws(
      () => validateMapResult(result, chunk, fx.frame),
      { code: "UNSUPPORTED_CLAIM" },
    );
  });

  await t.test("claim not reachable from its turn", () => {
    const result = emptyMap(chunk);
    result.objectiveFacts = [
      claim("claim-1", "objective", "Wrong turn", [fx.anchorIds[1]]),
    ];
    result.turnCoverage = [{
      turnId: "turn-1",
      status: "summarized",
      claimIds: ["claim-1"],
      reason: "captured objective",
    }];
    assert.throws(
      () => validateMapResult(result, chunk, fx.frame),
      { code: "INCOMPLETE_SEMANTIC_COVERAGE" },
    );
  });

  await t.test("ignored turn linked to a claim", () => {
    const result = emptyMap(chunk);
    result.objectiveFacts = [
      claim("claim-1", "objective", "Must not be hidden", [fx.anchorIds[0]]),
    ];
    result.turnCoverage = [{
      turnId: "turn-1",
      status: "ignored",
      claimIds: ["claim-1"],
      reason: "incorrect exclusion",
    }];
    assert.throws(
      () => validateMapResult(result, chunk, fx.frame),
      { code: "INVALID_TURN_COVERAGE" },
    );
  });
});

test("REDUCE provenance is derived from retained claims and rejects a forged list", () => {
  const fx = fixture();
  const reduced = archivalReduce(fx, { provenanceIds: ["turn-2"] });
  assert.throws(
    () => validateReduceResult(
      reduced,
      TURN_IDS,
      fx.frame,
      {
        evidenceIndex: fx.evidenceIndex,
        preservationLedger: fx.preservationLedger,
      },
    ),
    { code: "PROVENANCE_NOT_DERIVED" },
  );

  delete reduced.provenance.sourceTurnIds;
  validateReduceResult(
    reduced,
    TURN_IDS,
    fx.frame,
    {
      evidenceIndex: fx.evidenceIndex,
      preservationLedger: fx.preservationLedger,
    },
  );
  assert.deepEqual(
    deriveFinalProvenance(reduced, TURN_IDS, fx.evidenceIndex, fx.frame),
    TURN_IDS,
  );
});

test("critical Preservation Ledger categories must be represented or explicitly absent", () => {
  const fx = fixture();
  const reduced = archivalReduce(fx);
  reduced.preservationCoverage.pop();
  assert.throws(
    () => validateReduceResult(
      reduced,
      TURN_IDS,
      fx.frame,
      {
        evidenceIndex: fx.evidenceIndex,
        preservationLedger: fx.preservationLedger,
      },
    ),
    { code: "INCOMPLETE_PRESERVATION_COVERAGE" },
  );
});

test("renders ordered active and superseded decisions, failed attempts, and exact verification states", () => {
  const fx = fixture();
  const reduced = archivalReduce(fx);
  const handoff = renderHandoff({
    evidencePack: { source: fx.source, workspace: fx.workspace },
    reduced,
    coverage: [
      {
        turnId: "turn-1",
        status: "summarized",
        claimIds: ["decision-old", "rationale-old"],
        reason: "captured early decision",
      },
      {
        turnId: "turn-2",
        status: "summarized",
        claimIds: ["decision-active", "attempt-outcome"],
        reason: "captured supersession and failure",
      },
    ],
    provenance: TURN_IDS,
    generatedAt: "2026-07-29T12:00:00.000Z",
  });

  assert.match(handoff, /## Active decisions[\s\S]*Use a chronological Archival Ledger/);
  assert.match(handoff, /## Superseded decisions[\s\S]*Use an unordered category summary/);
  assert.match(handoff, /## Failed attempts[\s\S]*Coverage must link turns to supported claims/);
  assert.match(handoff, /## Verification outcomes[\s\S]*pass[\s\S]*fail[\s\S]*not_run[\s\S]*unknown/);
  assert.ok(
    handoff.indexOf("Use an unordered category summary") <
      handoff.indexOf("Use a chronological Archival Ledger"),
  );
});
