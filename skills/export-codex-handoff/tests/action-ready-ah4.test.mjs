import test from "node:test";
import assert from "node:assert/strict";

import { buildFrameInput } from "../scripts/lib/compression-frame.mjs";

const SOURCE_REVISION = `sha256:${"4".repeat(64)}`;
const GOAL_ANCHOR = `anchor-${"a".repeat(64)}`;
const TERMINAL_ANCHOR = `anchor-${"b".repeat(64)}`;

function frameInputForGoal(goal) {
  const currentGoal = { text: goal, anchors: [GOAL_ANCHOR] };
  const terminalStateClaim = {
    claimId: "claim-ah4-terminal-state",
    kind: "terminal_state",
    text: "The synthetic Source Thread stopped after recording the current goal.",
    anchors: [TERMINAL_ANCHOR],
  };
  const preservationLedger = {
    sourceRevision: SOURCE_REVISION,
    requiredAnchors: [GOAL_ANCHOR, TERMINAL_ANCHOR],
    exactIdentifiers: [],
    criticalCategories: [],
  };
  return buildFrameInput(
    {
      source: { sourceRevision: SOURCE_REVISION },
      turns: [{
        turnId: "turn-ah4",
        userMessages: [currentGoal],
      }],
      sourceContinuation: {
        currentGoal,
        acceptedProposal: null,
      },
      terminalStateClaim,
      workspace: { checkpoint: { status: "missing" } },
    },
    {
      anchors: [GOAL_ANCHOR, TERMINAL_ANCHOR].map((anchorId) => ({
        anchor: { anchorId },
      })),
      preservationLedger,
    },
  );
}

function exclusionTexts(goal) {
  const frameInput = frameInputForGoal(goal);
  assert.equal(frameInput.latestUserGoal.text, goal);
  for (const item of frameInput.explicitExclusions) {
    assert.equal(item.kind, "explicit_exclusion");
    assert.ok(goal.includes(item.text));
    assert.deepEqual(item.anchors, [GOAL_ANCHOR]);
  }
  return frameInput.explicitExclusions.map((item) => item.text);
}

test("AH4 preserves the complete mixed Chinese goal and extracts only its exclusion clause", () => {
  const goal = "看代码，说明流程和复杂度，不要跑测试";

  assert.deepEqual(exclusionTexts(goal), ["不要跑测试"]);
});

test("AH4 extracts English negation without splitting dotted path punctuation", () => {
  const goal = [
    "Review C:/workspace/src/frame.v2.mjs,",
    "but do not edit C:/workspace/tests/frame.v2.test.mjs.",
  ].join(" ");

  assert.deepEqual(exclusionTexts(goal), [
    "do not edit C:/workspace/tests/frame.v2.test.mjs.",
  ]);
});

test("AH4 retains negative comma lists and emits multiple exclusion clauses in source order", () => {
  const goal = [
    "Explain the flow;",
    "do not run tests, benchmarks, or linters;",
    "never modify fixtures, and do not browse unrelated files.",
  ].join(" ");

  assert.deepEqual(exclusionTexts(goal), [
    "do not run tests, benchmarks, or linters",
    "never modify fixtures",
    "do not browse unrelated files.",
  ]);
});

test("AH4 keeps standalone exclusions compatible and replay-stable", () => {
  const goal = "Do not modify the Source Thread.";
  const first = frameInputForGoal(goal);
  const second = frameInputForGoal(goal);

  assert.deepEqual(
    first.explicitExclusions.map((item) => item.text),
    [goal],
  );
  assert.deepEqual(second.explicitExclusions, first.explicitExclusions);
  assert.deepEqual(exclusionTexts("Explain the flow and complexity."), []);
});
