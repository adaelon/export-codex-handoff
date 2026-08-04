import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFrameInput,
  validateCompressionFrame,
} from "../scripts/lib/compression-frame.mjs";
import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import {
  validateActionReadyHandoffGates,
  validateReduceResult,
} from "../scripts/lib/validation.mjs";
import {
  actionReadyEvidencePack,
  actionReadyHandoffRolloutRecords,
  currentEvidenceValidReviewReduction,
} from "./fixtures/action-ready-handoff-fixtures.mjs";

const FRAME_ID = "frame-action-ready-ah3";
const FRAME_DIGEST = `sha256:${"a".repeat(64)}`;

function claim(claimId, kind, text, anchorId) {
  return { claimId, kind, text, anchors: [anchorId] };
}

function fixture() {
  const currentGoal = claim(
    "claim-ah3-goal",
    "objective",
    "Explain the review flow and complexity.",
    "anchor-ah3-goal",
  );
  const flow = claim(
    "claim-ah3-flow",
    "completed_work",
    "reviewTarget normalizes input before comparing node pairs.",
    "anchor-ah3-flow",
  );
  const complexity = claim(
    "claim-ah3-complexity",
    "completed_work",
    "The nested pair comparison is O(n^2) time.",
    "anchor-ah3-complexity",
  );
  const constraint = claim(
    "claim-ah3-constraint",
    "constraint",
    "Do not execute tests for this static review.",
    "anchor-ah3-constraint",
  );
  const decision = claim(
    "claim-ah3-decision",
    "decision",
    "Use the inspected source as the review authority.",
    "anchor-ah3-decision",
  );
  const nextAction = claim(
    "claim-ah3-next",
    "next_action",
    "Draft the flow explanation before any targeted verification.",
    "anchor-ah3-next",
  );
  const existenceProbe = claim(
    "claim-ah3-existence",
    "verification",
    "Test-Path src/review-target.mjs => pass",
    "anchor-ah3-existence",
  );
  const mechanical = claim(
    "claim-ah3-mechanical",
    "completed_work",
    "The read command completed successfully.",
    "anchor-ah3-mechanical",
  );
  const orphan = claim(
    "claim-ah3-orphan",
    "completed_work",
    "An unrelated observation was recorded.",
    "anchor-ah3-orphan",
  );
  const claims = [
    flow,
    complexity,
    constraint,
    decision,
    nextAction,
    existenceProbe,
    mechanical,
    orphan,
  ];
  const evidenceIndex = {
    anchors: [currentGoal, ...claims].map((item) => ({
      anchor: { anchorId: item.anchors[0] },
    })),
  };
  const claimTable = {
    formatVersion: 1,
    kind: "codex-handoff-continuation-claim-table",
    frameId: FRAME_ID,
    frameDigest: FRAME_DIGEST,
    claims,
    relations: {
      decisions: [{
        statement: decision.claimId,
        rationale: [],
        status: "active",
        supersedes: [],
      }],
      attempts: [],
      verification: [{
        claim: existenceProbe.claimId,
        command: "Test-Path src/review-target.mjs",
        result: "pass",
      }],
    },
  };
  const workingSynthesisInput = {
    formatVersion: 1,
    kind: "codex-handoff-working-synthesis-input",
    findings: [
      { findingId: "finding-ah3-flow", claimId: flow.claimId },
      { findingId: "finding-ah3-complexity", claimId: complexity.claimId },
    ],
    deliverables: [
      {
        deliverableId: "flow-explanation",
        request: "Explain the review flow.",
        status: "ready",
        findingIds: ["finding-ah3-flow"],
      },
      {
        deliverableId: "complexity-explanation",
        request: "Explain the time complexity.",
        status: "ready",
        findingIds: ["finding-ah3-complexity"],
      },
    ],
    inspections: [
      {
        location: "src/review-target.mjs",
        symbols: ["reviewTarget"],
        scope: "reviewTarget and pairwise comparison",
        findingIds: ["finding-ah3-flow", "finding-ah3-complexity"],
        rereadPolicy: "do_not_reread",
      },
    ],
  };
  const result = {
    constraints: [structuredClone(constraint)],
    nextActions: [structuredClone(nextAction)],
    workingSynthesis: {
      status: "draft_ready",
      sections: [{
        title: "Flow and complexity",
        body: `${flow.text} ${complexity.text}`,
        findingIds: ["finding-ah3-flow", "finding-ah3-complexity"],
      }],
      confirmedFindingIds: ["finding-ah3-flow", "finding-ah3-complexity"],
      uncertainties: [],
    },
    deliverableStatus: structuredClone(workingSynthesisInput.deliverables),
    inspectedEvidenceMap: structuredClone(workingSynthesisInput.inspections),
    resumePolicy: {
      mode: "synthesize_first",
      firstDeliverableIds: ["flow-explanation"],
      maxTargetedReads: 2,
      allowedReadReasons: ["claim_verification", "named_uncertainty"],
      forbidBroadSearch: true,
      forbidFullFileReread: true,
    },
  };
  return {
    result,
    context: {
      taskType: "review",
      currentGoal,
      claimTable,
      workingSynthesisInput,
      evidenceIndex,
    },
    claims: {
      flow,
      complexity,
      constraint,
      decision,
      nextAction,
      existenceProbe,
      mechanical,
      orphan,
    },
  };
}

test("AH3 projects only root-reachable evidence-backed Hot Context with stable keys", () => {
  const firstFixture = fixture();
  const first = validateActionReadyHandoffGates(
    firstFixture.result,
    firstFixture.context,
  );
  const secondFixture = fixture();
  const second = validateActionReadyHandoffGates(
    secondFixture.result,
    secondFixture.context,
  );

  assert.deepEqual(second, first);
  assert.equal(first.kind, "codex-handoff-action-ready-projection");
  assert.equal(first.hotContext.workingSynthesis.status, "draft_ready");
  assert.deepEqual(
    first.evidenceKeyMap.entries.map((entry) => entry.claimId).sort(),
    [
      "claim-ah3-complexity",
      "claim-ah3-constraint",
      "claim-ah3-decision",
      "claim-ah3-flow",
      "claim-ah3-goal",
      "claim-ah3-next",
    ],
  );
  assert.ok(first.evidenceKeyMap.entries.every((entry) => /^E[1-9][0-9]*$/u.test(entry.key)));
  assert.ok(!JSON.stringify(first.hotContext).includes("claim-ah3-"));
  assert.ok(!JSON.stringify(first.hotContext).includes("anchor-ah3-"));
  assert.ok(!first.evidenceKeyMap.entries.some((entry) => [
    firstFixture.claims.existenceProbe.claimId,
    firstFixture.claims.mechanical.claimId,
    firstFixture.claims.orphan.claimId,
  ].includes(entry.claimId)));
});

test("AH3 rejects an existence probe promoted through a deliverable Finding", () => {
  const value = fixture();
  const lowValueFinding = {
    findingId: "finding-ah3-existence",
    claimId: value.claims.existenceProbe.claimId,
  };
  value.context.workingSynthesisInput.findings.push(lowValueFinding);
  value.context.workingSynthesisInput.deliverables[0].findingIds.push(
    lowValueFinding.findingId,
  );
  value.result.deliverableStatus = structuredClone(
    value.context.workingSynthesisInput.deliverables,
  );
  value.result.workingSynthesis.sections[0].findingIds.push(lowValueFinding.findingId);
  value.result.workingSynthesis.confirmedFindingIds.push(lowValueFinding.findingId);

  assert.throws(
    () => validateActionReadyHandoffGates(value.result, value.context),
    { code: "HANDOFF_LOW_VALUE" },
  );
});

test("AH3 rejects the AH0 actionability shape and admits useful partial synthesis", () => {
  const missing = fixture();
  assert.throws(
    () => validateActionReadyHandoffGates(
      { constraints: [], nextActions: [] },
      missing.context,
    ),
    { code: "HANDOFF_NOT_ACTIONABLE" },
  );

  const partial = fixture();
  partial.context.workingSynthesisInput.deliverables[1] = {
    ...partial.context.workingSynthesisInput.deliverables[1],
    status: "partial",
    missingReason: "collectNodes behavior remains uncertain",
  };
  partial.result.deliverableStatus = structuredClone(
    partial.context.workingSynthesisInput.deliverables,
  );
  partial.result.workingSynthesis = {
    status: "partial",
    sections: [{
      title: "Confirmed flow",
      body: partial.claims.flow.text,
      findingIds: ["finding-ah3-flow"],
    }],
    confirmedFindingIds: ["finding-ah3-flow"],
    uncertainties: [{
      question: "Does collectNodes change the pair-count bound?",
      allowedScopes: ["src/review-target.mjs:collectNodes"],
      findingIds: ["finding-ah3-complexity"],
    }],
  };

  const projection = validateActionReadyHandoffGates(partial.result, partial.context);
  assert.equal(projection.hotContext.workingSynthesis.status, "partial");
  assert.deepEqual(
    projection.hotContext.workingSynthesis.uncertainties.map((item) => item.question),
    ["Does collectNodes change the pair-count bound?"],
  );
});

test("AH3 rejects the evidence-valid AH0 output through REDUCE preflight integration", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ah3-ah0-gate-"));
  const rolloutPath = path.join(root, "synthetic-rollout.jsonl");
  try {
    await fs.promises.writeFile(
      rolloutPath,
      `${actionReadyHandoffRolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const parsed = await parseSourceThread(rolloutPath);
    const pack = actionReadyEvidencePack(parsed);
    const frameInput = buildFrameInput(pack, pack.evidenceIndex);
    const frame = {
      formatVersion: 2,
      frameId: frameInput.expectedFrameId,
      currentGoal: frameInput.latestUserGoal,
      acceptedProposal: frameInput.acceptedProposal,
      terminalStateClaim: frameInput.terminalStateClaim,
      taskType: "review",
      taskPhase: "handoff",
      explicitExclusions: frameInput.explicitExclusions,
      preservationPolicy: frameInput.preservationPolicy,
      anchors: frameInput.requiredFrameAnchors,
    };
    const frameBinding = validateCompressionFrame(frame, frameInput);
    const current = currentEvidenceValidReviewReduction(parsed, pack, frameBinding);
    const gate = fixture();

    assert.throws(
      () => validateReduceResult(
        current.reduced,
        parsed.turns.map((turn) => turn.turnId),
        frameBinding,
        {
          evidenceIndex: pack.evidenceIndex,
          preservationLedger: pack.preservationLedger,
          requireDerivedProvenance: true,
          deterministicProjections: {
            continuationAuthorities: {
              acceptedProposal: null,
              terminalState: current.reduced.terminalState,
            },
            importantLocations: current.reduced.importantLocations,
            preservationCoverage: current.reduced.preservationCoverage,
          },
          actionReadyGateContext: gate.context,
        },
      ),
      { code: "HANDOFF_NOT_ACTIONABLE" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
