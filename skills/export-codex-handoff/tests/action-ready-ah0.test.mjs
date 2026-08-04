import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFrameInput,
  validateCompressionFrame,
} from "../scripts/lib/compression-frame.mjs";
import { validateEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { renderHandoff } from "../scripts/lib/render-handoff.mjs";
import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import { validateReduceResult } from "../scripts/lib/validation.mjs";
import {
  ACTION_READY_AH4_INTERIM_METRICS,
  ACTION_READY_SOURCE_PATH,
  ACTION_READY_TEST_PATH,
  ACTION_READY_TURN_ID,
  COMPLEXITY_FINDING,
  EXISTENCE_PROBE_CALL_ID,
  EXPECTED_EXCLUSION_CLAUSE,
  FINAL_PROGRESS,
  FLOW_FINDING,
  MIXED_REVIEW_GOAL,
  SOURCE_READ_CALL_ID,
  TEST_READ_CALL_ID,
  actionReadyEvidencePack,
  actionReadyHandoffRolloutRecords,
  compareActionReadyHandoff,
  currentEvidenceValidReviewReduction,
} from "./fixtures/action-ready-handoff-fixtures.mjs";

async function withRenderedFixture(run) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ah0-action-ready-"));
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
    validateEvidenceIndex(pack.evidenceIndex);
    validateReduceResult(
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
      },
    );
    const handoff = renderHandoff({
      evidencePack: pack,
      reduced: current.reduced,
      coverage: current.coverage,
      provenance: current.provenance,
      generatedAt: "2026-08-01T08:06:00.000Z",
    });
    return await run({ parsed, pack, frameInput, frameBinding, current, handoff });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

function occurrences(text, value) {
  return text.split(value).length - 1;
}

test("AH0 fixture is private-data-free and contains progress, reads, probe, and interruption", async () => {
  const serialized = JSON.stringify(actionReadyHandoffRolloutRecords());
  assert.ok(!serialized.includes("C:\\Users\\"));
  assert.ok(!serialized.includes("E:\\allwork"));
  assert.ok(serialized.includes("C:/synthetic/action-ready-workspace"));

  await withRenderedFixture(({ parsed }) => {
    const turn = parsed.turns.at(-1);
    assert.equal(turn.turnId, ACTION_READY_TURN_ID);
    assert.equal(turn.status, "aborted");
    assert.equal(turn.termination.abortReason, "interrupted");
    assert.equal(turn.userMessages.at(-1).text, MIXED_REVIEW_GOAL);
    assert.equal(turn.assistantMessages.at(-1).text, FINAL_PROGRESS);
    assert.ok(turn.assistantMessages.at(-1).text.includes(FLOW_FINDING));
    assert.ok(turn.assistantMessages.at(-1).text.includes(COMPLEXITY_FINDING));
    assert.deepEqual(
      turn.tools.map((tool) => [tool.callId, tool.name, Boolean(tool.outputReceiptId)]),
      [
        [SOURCE_READ_CALL_ID, "read_file", true],
        [TEST_READ_CALL_ID, "read_file", true],
        [EXISTENCE_PROBE_CALL_ID, "path_exists", true],
      ],
    );
  });
});

test("AH0 fixture remains evidence-valid after AH4 narrows the exclusion clause", async () => {
  await withRenderedFixture(({ pack, frameInput, current, handoff }) => {
    assert.equal(pack.evidenceIndex.anchors.length, pack.evidenceAnchors.length);
    assert.equal(frameInput.latestUserGoal.text, MIXED_REVIEW_GOAL);
    assert.deepEqual(
      frameInput.explicitExclusions.map((claim) => claim.text),
      [EXPECTED_EXCLUSION_CLAUSE],
    );
    assert.deepEqual(current.reduced.objective.explicitExclusions, [EXPECTED_EXCLUSION_CLAUSE]);
    assert.equal(occurrences(handoff, MIXED_REVIEW_GOAL), 1);
    assert.ok(handoff.includes(`- ${EXPECTED_EXCLUSION_CLAUSE}\n`));
    assert.match(handoff, /## Terminal state/);
    assert.match(handoff, /## Semantic coverage/);
    assert.ok(handoff.includes(ACTION_READY_SOURCE_PATH));
    assert.ok(handoff.includes(ACTION_READY_TEST_PATH));
    assert.ok(!handoff.includes("## Working Synthesis"));
  });
});

test("AH0 comparator freezes the low-value and non-actionable baseline", async () => {
  await withRenderedFixture(({ current, handoff }) => {
    const compared = compareActionReadyHandoff(handoff, current.reduced);

    assert.deepEqual(compared.baselineMetrics, ACTION_READY_AH4_INTERIM_METRICS);
    assert.equal(compared.actionability.usableDraft, false);
    assert.deepEqual(compared.actionability.missingSections, [
      "Working Synthesis",
      "Deliverable status",
      "Inspected Evidence Map",
      "Resume Policy",
    ]);
    assert.equal(compared.auditExpansion.auditDominates, true);
    assert.ok(compared.inlineEvidenceNoise.suffixCount > 0);
    assert.ok(compared.inlineEvidenceNoise.rawAnchorReferences > 0);
    assert.equal(compared.firstDeliverableReadiness.firstDeliverableReady, false);
    assert.equal(compared.firstDeliverableReadiness.requiresPreDraftRead, true);
    assert.deepEqual(compared.classification.missing, []);
    assert.deepEqual(compared.classification.unsupported, []);
    assert.deepEqual(compared.classification.duplicates, []);
    assert.deepEqual(compared.classification.mutated, [
      "ah0-flow-finding",
      "ah0-complexity-finding",
      "ah0-existence-probe",
      "ah0-read-success",
      "ah0-terminal-audit",
      "ah0-semantic-coverage",
    ]);
    assert.deepEqual(compared.actionability.diagnosticCodes, [
      "HANDOFF_NOT_ACTIONABLE",
      "HANDOFF_LOW_VALUE",
    ]);
  });
});
