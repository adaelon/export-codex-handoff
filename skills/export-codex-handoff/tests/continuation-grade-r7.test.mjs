import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { chunkEvidencePack } from "../scripts/lib/chunking.mjs";
import { createEvidenceEntry } from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { buildEvidenceReferenceDictionary } from "../scripts/lib/frame-projection.mjs";
import { CONTINUATION_MAP_RESULT_MODE } from "../scripts/lib/map-worker.mjs";
import {
  prepareCompressionTask,
  prepareFrameStage,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");

function readSkillFile(relativePath) {
  return fs.readFileSync(path.join(SKILL_DIR, relativePath), "utf8");
}

test("R7 continuation-map-v1 remains a frozen compatibility route after v2 promotion", () => {
  const skill = readSkillFile("SKILL.md");

  assert.match(
    skill,
    /`continuation-map-v1`[\s\S]{0,80}compatibility routes only/,
  );
  assert.match(skill, /references\/continuation-map-worker-contract\.md/);
  assert.match(skill, /dictionaryPath/);
  assert.match(skill, /validate-reduce <workDir> --check/);
  assert.match(skill, /completedMapOutputChars/);
  assert.match(skill, /complete Evidence Index[\s\S]{0,180}Critical Anchors/);
  assert.match(skill, /60,000 characters/);
  assert.doesNotMatch(
    skill,
    /New runs[\s\S]{0,120}default remains `sparse-map-v1`/,
  );
});

test("R7 Skill requires deterministic R6 calibration and deadline-governed waves", () => {
  const skill = readSkillFile("SKILL.md");

  assert.match(skill, /projectFirstWaveBudget/);
  assert.match(skill, /provider[^\n]*latency/i);
  assert.match(skill, /fresh[^\n]*slot/i);
  assert.match(skill, /workflow deadline/);
  assert.match(skill, /over[ -]target[\s\S]{0,100}advisory/i);
  assert.match(skill, /performanceMetrics/);
  assert.match(skill, /phaseTimingsMs\.total <= 600000/);
});

test("R7 contracts describe current continuation input and output metrics", () => {
  const contracts = readSkillFile("references/contracts.md");
  const cli = readSkillFile("scripts/export-handoff.mjs");

  assert.match(
    contracts,
    /evidence,\s+dictionary, and projection files together must not exceed `maxMapInputChars`, which defaults to\s+100,000/,
  );
  assert.match(contracts, /completedMapOutputChars/);
  assert.match(contracts, /continuation-map-v1/);
  assert.match(contracts, /complete Source Thread turn-ID inventory/);
  assert.match(contracts, /default continuation evidence[\s\S]{0,80}60,000/);
  assert.match(
    cli,
    /3x REDUCE target for sparse; 1x for continuation/,
  );
});

test("R7 continuation planning sends only Critical Anchor evidence to MAP", () => {
  const anchors = {
    old: "anchor-old-history",
    goal: "anchor-latest-goal",
    failure: "anchor-failed-tool",
    checkpoint: "anchor-workspace-checkpoint",
    git: "anchor-workspace-git",
  };
  const evidencePack = {
    source: { sessionId: "00000000-0000-7000-8000-0000000000a7" },
    turns: [
      {
        turnId: "turn-old",
        userMessages: [{
          text: `non-critical-history-${"x".repeat(150_000)}`,
          anchors: [anchors.old],
        }],
      },
      {
        turnId: "turn-current",
        userMessages: [{
          text: "Implement the accepted continuation slice.",
          anchors: [anchors.goal],
        }],
        toolReceipts: [{
          status: "error",
          outputAnchor: anchors.failure,
          previewHead: "failing verification",
          previewTail: "",
        }],
      },
    ],
    workspace: {
      checkpoint: { status: "found", content: "Next: finish the continuation slice." },
      git: { status: "available", branchAndStatus: "## main\n M runtime.mjs" },
    },
    evidenceAnchors: [
      { anchorId: anchors.old, sourceKind: "source_thread", payloadPath: "/old" },
      { anchorId: anchors.goal, sourceKind: "source_thread", payloadPath: "/goal" },
      { anchorId: anchors.failure, sourceKind: "source_thread", payloadPath: "/failure" },
      { anchorId: anchors.checkpoint, sourceKind: "workspace", payloadPath: "/checkpoint/content" },
      { anchorId: anchors.git, sourceKind: "workspace", payloadPath: "/git/branchAndStatus" },
    ],
    preservationLedger: {
      requiredAnchors: [
        anchors.goal,
        anchors.failure,
        anchors.checkpoint,
        anchors.git,
      ],
    },
  };

  const plan = chunkEvidencePack(evidencePack, {
    maxChunkChars: 60_000,
    criticalOnly: true,
  });
  const serialized = JSON.stringify(plan);
  const frameId = "frame-r7-critical-packaging";
  const frozenFrame = {
    frameId,
    frameDigest: `sha256:${"7".repeat(64)}`,
    frame: {
      frameId,
      preservationPolicy: {
        exactIdentifiers: [],
      },
    },
  };
  const dictionaryAnchors = new Set(plan.segments.flatMap((segment) => (
    buildEvidenceReferenceDictionary(frozenFrame, segment)
      .evidenceReferences
      .map((reference) => reference.anchorId)
  )));

  assert.doesNotMatch(serialized, /non-critical-history/);
  for (const anchorId of evidencePack.preservationLedger.requiredAnchors) {
    assert.ok(dictionaryAnchors.has(anchorId));
  }
  assert.deepEqual(evidencePack.turns.map((turn) => turn.turnId), [
    "turn-old",
    "turn-current",
  ]);
  assert.equal(evidencePack.evidenceAnchors.length, 5);
  assert.ok(plan.segments.every((segment) => segment.evidenceChars <= 60_000));
  assert.ok(plan.segments.some((segment) => segment.stage === "workspace_map"));
  assert.ok(plan.segments.length <= 3);
});

test("R7 continuation prepare and frame validation preserve full inventories under the 100k gate", async () => {
  const sessionId = "00000000-0000-7000-8000-0000000007a7";
  const sourceRevision = `sha256:${"a".repeat(64)}`;
  const workspaceRevision = `sha256:${"b".repeat(64)}`;
  const sourceEntry = (index, text) => createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision,
    turnId: `turn-r7-${index}`,
    eventOrdinal: index,
    rolloutLine: index,
    payloadPath: "/payload/content/0/text",
    value: text,
    locator: { kind: "rollout_payload" },
  });
  const workspaceEntry = (payloadPath, value, observationId) => createEvidenceEntry({
    sourceKind: "workspace",
    sourceRevision: workspaceRevision,
    payloadPath,
    value,
    locator: {
      kind: "command",
      observationId,
      executable: "git",
      cwd: "C:/synthetic/r7-workspace",
      args: ["status"],
      expectedOk: true,
      stream: "stdout",
    },
  });
  const oldText = `non-critical-runtime-history-${"x".repeat(150_000)}`;
  const goalText = "Finish R7 continuation packaging.";
  const checkpointText = "Next: run the R7 live acceptance.";
  const gitText = "## main\n M runtime.mjs";
  const oldEntry = sourceEntry(1, oldText);
  const goalEntry = sourceEntry(2, goalText);
  const checkpointEntry = workspaceEntry(
    "/checkpoint/content",
    checkpointText,
    "checkpoint",
  );
  const gitEntry = workspaceEntry(
    "/git/branchAndStatus",
    gitText,
    "git.status",
  );
  const entries = [oldEntry, goalEntry, checkpointEntry, gitEntry];
  const preservationLedger = {
    sourceRevision,
    requiredAnchors: [
      goalEntry.anchor.anchorId,
      checkpointEntry.anchor.anchorId,
      gitEntry.anchor.anchorId,
    ],
    exactIdentifiers: [],
    criticalCategories: [],
  };
  const turns = [
    { turnId: oldEntry.anchor.turnId, text: oldText, anchorId: oldEntry.anchor.anchorId },
    { turnId: goalEntry.anchor.turnId, text: goalText, anchorId: goalEntry.anchor.anchorId },
  ].map(({ turnId, text, anchorId }) => ({
    turnId,
    userMessages: [{ text, anchors: [anchorId] }],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
  }));
  const source = {
    sessionId,
    storageKind: "active",
    rolloutPath: "C:/synthetic/r7-rollout.jsonl",
    sourceChars: oldText.length + goalText.length,
    sourceBytes: oldText.length + goalText.length,
    sourceRevision,
    session: {
      id: sessionId,
      cwd: "C:/synthetic/r7-workspace",
      startedAt: "2026-07-30T00:00:00Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: source.session.cwd,
    sourceRevision: workspaceRevision,
    checkpoint: { status: "found", content: checkpointText },
    git: { status: "available", branchAndStatus: gitText },
  };
  const pack = {
    formatVersion: 1,
    source,
    turns,
    ignoredEvents: {},
    workspace,
    evidenceAnchors: entries.map(({ anchor }) => anchor),
    preservationLedger,
  };
  pack.evidenceChars = JSON.stringify(pack).length;
  pack.evidenceIndex = buildEvidenceIndex({
    sessionId,
    source,
    workspace,
    entries,
    preservationLedger,
  });

  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-r7-runtime-"));
  try {
    const prepared = await prepareCompressionTask({
      sessionId,
      outputPath: path.join(root, "handoff.md"),
      workRoot: root,
      mapResultMode: CONTINUATION_MAP_RESULT_MODE,
    }, { buildEvidencePack: async () => pack });
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const persistedIndex = JSON.parse(await fs.promises.readFile(
      path.join(prepared.workDir, "evidence-index.json"),
      "utf8",
    ));
    const chunkTexts = await Promise.all(prepared.segments.map(
      ({ chunkPath }) => fs.promises.readFile(chunkPath, "utf8"),
    ));

    assert.equal(manifest.maxChunkChars, 60_000);
    assert.deepEqual(manifest.expectedTurnIds, turns.map(({ turnId }) => turnId));
    assert.equal(persistedIndex.anchors.length, entries.length);
    assert.ok(chunkTexts.every((text) => !text.includes("non-critical-runtime-history")));

    const frameStage = await prepareFrameStage(prepared.workDir);
    const frameInput = JSON.parse(await fs.promises.readFile(frameStage.frameInputPath, "utf8"));
    await fs.promises.writeFile(frameStage.framePath, `${JSON.stringify({
      frameId: frameInput.expectedFrameId,
      currentGoal: frameInput.latestUserGoal,
      taskType: "implementation",
      taskPhase: "verifying",
      explicitExclusions: frameInput.explicitExclusions,
      preservationPolicy: frameInput.preservationPolicy,
      anchors: frameInput.requiredFrameAnchors,
    }, null, 2)}\n`, "utf8");
    const validated = await validateFrameStage(prepared.workDir);
    const visibleAnchors = new Set();
    for (const dispatch of validated.mapDispatches) {
      const dictionary = JSON.parse(await fs.promises.readFile(
        dispatch.dictionaryPath,
        "utf8",
      ));
      for (const reference of dictionary.evidenceReferences) {
        visibleAnchors.add(reference.anchorId);
      }
    }
    for (const anchorId of preservationLedger.requiredAnchors) {
      assert.ok(visibleAnchors.has(anchorId));
    }
    assert.ok(validated.maxObservedMapInputChars <= 100_000);
    assert.ok(validated.mapDispatches.length <= 3);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
