import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chunkEvidencePack,
  validateTurnFragments,
} from "../scripts/lib/chunking.mjs";
import {
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  publishHandoff,
  validateFrameStage,
  validateMapStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  buildPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { sparseFromFullMapResult } from "./fixtures/sparse-map-fixtures.mjs";

const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
const TURN_ID = "turn-oversized";
const ANCHOR_ID = `anchor-${"a".repeat(64)}`;

function message(text) {
  return {
    timestamp: "2026-07-29T00:00:00Z",
    text,
    anchors: [ANCHOR_ID],
    source: {
      anchorId: ANCHOR_ID,
      eventOrdinal: 2,
      rolloutLine: 3,
      payloadPath: "/payload/content/0/text",
      rangeUtf16: { start: 0, end: text.length },
      indivisible: false,
    },
  };
}

function evidencePack(text, overrides = {}) {
  return {
    formatVersion: 1,
    source: { sessionId: SESSION_ID },
    turns: [{
      turnId: TURN_ID,
      startedAt: "2026-07-29T00:00:00Z",
      completedAt: "2026-07-29T00:01:00Z",
      status: "completed",
      context: null,
      userMessages: [message(text)],
      assistantMessages: [],
      tools: [],
      toolReceipts: [],
      patches: [],
      ...overrides,
    }],
  };
}

function fragmentsFrom(plan) {
  return plan.segments
    .filter((segment) => segment.stage === "fragment_map")
    .flatMap((segment) => segment.fragments);
}

test("one oversized turn becomes ordered bounded fragments with exact reconstruction", () => {
  const source = [
    "BEGIN-BOUNDARY\n",
    "a".repeat(5_000),
    "\nMIDDLE-BOUNDARY\n",
    "b".repeat(5_000),
    "\nEND-BOUNDARY",
  ].join("");
  const plan = chunkEvidencePack(evidencePack(source), { maxChunkChars: 4_000 });
  const fragments = fragmentsFrom(plan);

  assert.ok(fragments.length > 1);
  assert.equal(plan.turnAggregates.length, 1);
  assert.equal(plan.segments.some((segment) => "oversize" in segment), false);
  assert.ok(plan.segments.every((segment) => segment.evidenceChars <= 4_000));
  assert.ok(fragments.every((fragment) => fragment.evidenceChars <= 4_000));
  assert.equal(fragments.map((fragment) => fragment.text).join(""), source);
  assert.match(fragments.map((fragment) => fragment.text).join(""), /BEGIN-BOUNDARY/);
  assert.match(fragments.map((fragment) => fragment.text).join(""), /MIDDLE-BOUNDARY/);
  assert.match(fragments.map((fragment) => fragment.text).join(""), /END-BOUNDARY/);
  assert.doesNotThrow(() => validateTurnFragments(fragments, {
    parentTurnId: TURN_ID,
    expectedFragmentIds: fragments.map((fragment) => fragment.fragmentId),
  }));
});

test("packs hundreds of adjacent small fragments into at most twelve bounded MAP segments", () => {
  const assistantMessages = Array.from({ length: 391 }, (_, index) => (
    message(`assistant-${String(index).padStart(3, "0")} ${"x".repeat(3_000)}`)
  ));
  const plan = chunkEvidencePack(evidencePack("current goal", { assistantMessages }), {
    maxChunkChars: 140_000,
  });
  const fragmentSegments = plan.segments.filter((segment) => segment.stage === "fragment_map");

  assert.ok(fragmentSegments.length <= 12);
  assert.ok(fragmentSegments.some((segment) => segment.fragments.length > 1));
  assert.ok(fragmentSegments.every((segment) => segment.evidenceChars <= 140_000));
  assert.equal(
    fragmentSegments.flatMap((segment) => segment.fragments).length,
    assistantMessages.length + 2,
  );
});

test("fragment completeness rejects missing, duplicate, overlapping, and reordered children", () => {
  const source = "x".repeat(12_000);
  const fragments = fragmentsFrom(
    chunkEvidencePack(evidencePack(source), { maxChunkChars: 4_000 }),
  );
  const expected = {
    parentTurnId: TURN_ID,
    expectedFragmentIds: fragments.map((fragment) => fragment.fragmentId),
  };

  assert.throws(
    () => validateTurnFragments(fragments.slice(0, -1), expected),
    { code: "INCOMPLETE_FRAGMENT_COVERAGE" },
  );
  assert.throws(
    () => validateTurnFragments([fragments[0], fragments[0], ...fragments.slice(1)], expected),
    { code: "DUPLICATE_FRAGMENT" },
  );

  const overlapping = structuredClone(fragments);
  const rangedIndex = overlapping.findIndex((fragment, index) => (
    index > 0 && fragment.unitId === overlapping[index - 1].unitId
  ));
  assert.ok(rangedIndex > 0);
  overlapping[rangedIndex].sourceRangeUtf16.start -= 1;
  assert.throws(
    () => validateTurnFragments(overlapping, expected),
    { code: "OVERLAPPING_FRAGMENT_RANGE" },
  );

  assert.throws(
    () => validateTurnFragments([...fragments].reverse(), expected),
    { code: "REORDERED_FRAGMENT" },
  );
});

test("candidate splits keep an exact identifier byte-for-byte in one fragment", () => {
  const exactUuid = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
  const source = `${"p".repeat(3_700)} ${exactUuid} ${"q".repeat(5_000)}`;
  const fragments = fragmentsFrom(
    chunkEvidencePack(evidencePack(source), { maxChunkChars: 4_000 }),
  );
  const textFragments = fragments.filter((fragment) => typeof fragment.text === "string");

  assert.equal(textFragments.map((fragment) => fragment.text).join(""), source);
  assert.equal(textFragments.filter((fragment) => fragment.text.includes(exactUuid)).length, 1);
  assert.equal(
    textFragments.some((fragment) => (
      fragment.text.includes(exactUuid.slice(0, 18)) && !fragment.text.includes(exactUuid)
    )),
    false,
  );
});

test("an indivisible over-budget receipt fails closed", () => {
  const receipt = {
    receiptId: `receipt-${"b".repeat(64)}`,
    toolName: "exec",
    callId: "call-1",
    status: "ok",
    previewHead: "h".repeat(4_500),
    previewTail: "",
    outputChars: 4_500,
    outputAnchor: ANCHOR_ID,
    exactIdentifiers: [],
    valueKind: "output",
  };

  assert.throws(
    () => chunkEvidencePack(evidencePack("small", { toolReceipts: [receipt] }), {
      maxChunkChars: 4_000,
    }),
    { code: "OVERSIZE_EVIDENCE_UNSPLITTABLE" },
  );
});

function workflowEvidencePack(input) {
  const messages = Array.isArray(input) ? input : [input];
  const text = messages.join("\n");
  const sourceRevision = `sha256:${"c".repeat(64)}`;
  const entries = messages.map((messageText, index) => createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision,
    turnId: TURN_ID,
    eventOrdinal: index + 2,
    rolloutLine: index + 3,
    payloadPath: "/payload/content/0/text",
    value: messageText,
    locator: { kind: "rollout_payload" },
  }));
  const preservationLedger = buildPreservationLedger(sourceRevision, entries);
  const pack = {
    formatVersion: 1,
    source: {
      sessionId: SESSION_ID,
      storageKind: "active",
      rolloutPath: "C:/codex/rollout.jsonl",
      sourceChars: text.length,
      sourceBytes: text.length,
      sourceRevision,
      session: { id: SESSION_ID, cwd: "C:/workspace", startedAt: null },
    },
    turns: [{
      turnId: TURN_ID,
      userMessages: messages.map((messageText, index) => ({
        ...message(messageText),
        anchors: [entries[index].anchor.anchorId],
        source: {
          anchorId: entries[index].anchor.anchorId,
          eventOrdinal: index + 2,
          rolloutLine: index + 3,
          payloadPath: "/payload/content/0/text",
          rangeUtf16: { start: 0, end: messageText.length },
          indivisible: false,
        },
      })),
      assistantMessages: [],
      tools: [],
      toolReceipts: [],
      patches: [],
    }],
    ignoredEvents: {},
    workspace: {
      status: "available",
      cwd: "C:/workspace",
      checkpoint: { status: "missing" },
      git: { status: "not_repository" },
    },
    evidenceAnchors: entries.map((entry) => entry.anchor),
    preservationLedger,
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source: pack.source,
    workspace: pack.workspace,
    entries,
    preservationLedger,
  });
  return { ...pack, evidenceChars: JSON.stringify(pack).length, evidenceIndex };
}

function emptyMapShape(binding, segmentId) {
  return {
    frameId: binding.frameId,
    frameDigest: binding.frameDigest,
    segmentId,
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

function fragmentMapResult(segment, binding) {
  const result = emptyMapShape(binding, segment.segmentId);
  result.fragmentCoverage = segment.fragments.map((fragment) => {
    if (fragment.anchors.length === 0) {
      return {
        fragmentId: fragment.fragmentId,
        status: "ignored",
        claimIds: [],
        reason: "turn metadata has no semantic claim anchor",
      };
    }
    const claimId = `claim-${fragment.fragmentId}`;
    result.objectiveFacts.push({
      claimId,
      kind: "objective",
      text: `Fragment ${fragment.ordinal}`,
      anchors: [fragment.anchors[0]],
    });
    return {
      fragmentId: fragment.fragmentId,
      status: "summarized",
      claimIds: [claimId],
      reason: "captured fragment",
    };
  });
  return sparseFromFullMapResult(result);
}

function sharedClaimFragmentMapResult(segment, binding) {
  const result = emptyMapShape(binding, segment.segmentId);
  const anchoredFragments = segment.fragments.filter((fragment) => fragment.anchors.length > 0);
  const claimId = `shared-${segment.segmentId}`;
  if (anchoredFragments.length > 0) {
    result.objectiveFacts.push({
      claimId,
      kind: "objective",
      text: `Shared claim for ${segment.segmentId}`,
      anchors: [...new Set(anchoredFragments.flatMap((fragment) => fragment.anchors))],
    });
  }
  result.fragmentCoverage = segment.fragments.map((fragment) => (
    fragment.anchors.length > 0
      ? {
        fragmentId: fragment.fragmentId,
        status: "summarized",
        claimIds: [claimId],
        reason: "captured by one claim spanning multiple fragments",
      }
      : {
        fragmentId: fragment.fragmentId,
        status: "ignored",
        claimIds: [],
        reason: "turn metadata has no semantic claim anchor",
      }
  ));
  return sparseFromFullMapResult(result);
}

function reduceResult(binding, anchorId) {
  return {
    frameId: binding.frameId,
    frameDigest: binding.frameDigest,
    continuationDirective: "Read the Handoff and continue safely.",
    objective: {
      goal: binding.frame.currentGoal.text,
      explicitExclusions: binding.frame.explicitExclusions.map((item) => item.text),
    },
    constraints: [],
    workspaceState: {
      summary: {
        claimId: "reduce-workspace",
        kind: "workspace_state",
        text: "Synthetic fragmented workflow is ready for continuation",
        anchors: [anchorId],
      },
      evidenceStatus: "full",
      conflicts: [],
    },
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: [],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    preservationCoverage: binding.frame.preservationPolicy.criticalCategories.map(
      (category) => ({
        category,
        status: "absent",
        claimIds: [],
        reason: `No retained ${category} evidence`,
      }),
    ),
    provenance: { notes: [] },
    compressionNotes: [],
  };
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("workflow requires every fragment MAP before validating parent-turn coverage", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-fragments-"));
  try {
    const pack = workflowEvidencePack(`goal ${"z".repeat(10_000)}`);
    const prepared = await prepareCompressionTask({
      sessionId: SESSION_ID,
      outputPath: path.join(root, "handoff.md"),
      workRoot: root,
      maxChunkChars: 4_000,
    }, { buildEvidencePack: async () => pack });
    assert.ok(prepared.segments.every((segment) => segment.stage === "fragment_map"));
    assert.equal(prepared.turnAggregates.length, 1);

    const frameStage = await prepareFrameStage(prepared.workDir);
    const frameInput = JSON.parse(await fs.promises.readFile(frameStage.frameInputPath, "utf8"));
    await writeJson(frameStage.framePath, {
      frameId: frameInput.expectedFrameId,
      currentGoal: frameInput.latestUserGoal,
      taskType: "implementation",
      taskPhase: "implementing",
      explicitExclusions: frameInput.explicitExclusions,
      preservationPolicy: frameInput.preservationPolicy,
      anchors: frameInput.requiredFrameAnchors,
    });
    const binding = await validateFrameStage(prepared.workDir);

    for (const segment of prepared.segments.slice(0, -1)) {
      const chunk = JSON.parse(await fs.promises.readFile(segment.chunkPath, "utf8"));
      await writeJson(segment.summaryPath, fragmentMapResult(chunk, binding));
      const checked = await validateMapStage(prepared.workDir, segment.segmentId);
      assert.equal(checked.nextStage, null);
    }
    await assert.rejects(
      prepareReduceStage(prepared.workDir),
      { code: "MAP_RECEIPT_NOT_ACCEPTED" },
    );

    const lastSegment = prepared.segments.at(-1);
    const lastChunk = JSON.parse(await fs.promises.readFile(lastSegment.chunkPath, "utf8"));
    await writeJson(lastSegment.summaryPath, fragmentMapResult(lastChunk, binding));
    const lastChecked = await validateMapStage(prepared.workDir, lastSegment.segmentId);
    assert.equal(lastChecked.nextStage, null);
    assert.equal(binding.turnAggregates[0].dispatch, null);

    await Promise.all(prepared.segments.map((segment) => fs.promises.rm(segment.chunkPath)));
    const reduced = await prepareReduceStage(prepared.workDir);
    assert.deepEqual(reduced.expectedTurnIds, [TURN_ID]);
    const reduceInput = JSON.parse(await fs.promises.readFile(reduced.reduceInputPath, "utf8"));
    assert.equal(reduceInput.segmentSummaries.length, 1);
    assert.equal(reduceInput.segmentSummaries[0].turnCoverage[0].turnId, TURN_ID);
    assert.equal(
      reduceInput.segmentSummaries[0].fragmentCoverage.length,
      binding.turnAggregates[0].expectedFragmentIds.length,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("one sparse Claim spanning fragments survives parent coverage, REDUCE, and publication", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-shared-claim-"));
  try {
    const messages = Array.from(
      { length: 8 },
      (_, index) => `goal-${index} ${String.fromCharCode(97 + index).repeat(700)}`,
    );
    const pack = workflowEvidencePack(messages);
    const prepared = await prepareCompressionTask({
      sessionId: SESSION_ID,
      outputPath: path.join(root, "handoff.md"),
      workRoot: root,
      maxChunkChars: 4_000,
    }, { buildEvidencePack: async () => pack });
    assert.ok(prepared.segments.every((segment) => segment.stage === "fragment_map"));

    const frameStage = await prepareFrameStage(prepared.workDir);
    const frameInput = JSON.parse(await fs.promises.readFile(frameStage.frameInputPath, "utf8"));
    const frame = {
      frameId: frameInput.expectedFrameId,
      currentGoal: frameInput.latestUserGoal,
      taskType: "implementation",
      taskPhase: "implementing",
      explicitExclusions: frameInput.explicitExclusions,
      preservationPolicy: frameInput.preservationPolicy,
      anchors: frameInput.requiredFrameAnchors,
    };
    await writeJson(frameStage.framePath, frame);
    const validated = await validateFrameStage(prepared.workDir);
    const binding = { ...validated, frame };

    let hasMultiFragmentClaim = false;
    for (const segment of prepared.segments) {
      const chunk = JSON.parse(await fs.promises.readFile(segment.chunkPath, "utf8"));
      const candidate = sharedClaimFragmentMapResult(chunk, binding);
      hasMultiFragmentClaim ||= candidate.claimBindings.some(
        (claimBinding) => claimBinding.evidenceIndexes.length > 1,
      );
      await writeJson(segment.summaryPath, candidate);
      await validateMapStage(prepared.workDir, segment.segmentId);
    }
    assert.equal(hasMultiFragmentClaim, true);

    await Promise.all(prepared.segments.map((segment) => fs.promises.rm(segment.chunkPath)));
    const reduce = await prepareReduceStage(prepared.workDir);
    const reduceInput = JSON.parse(await fs.promises.readFile(reduce.reduceInputPath, "utf8"));
    const parentClaimIds = reduceInput.segmentSummaries[0].turnCoverage[0].claimIds;
    assert.equal(parentClaimIds.length, new Set(parentClaimIds).size);

    await writeJson(
      reduce.reducedPath,
      reduceResult(binding, pack.evidenceAnchors[0].anchorId),
    );
    const published = await publishHandoff(
      prepared.workDir,
      { keepWorkdir: true },
      { verifyEvidenceIndex: async () => ({ valid: true }) },
    );
    const publishedIndex = JSON.parse(
      await fs.promises.readFile(published.evidenceIndexPath, "utf8"),
    );
    assert.deepEqual(
      publishedIndex.semanticCoverage.turns.map((entry) => entry.turnId),
      [TURN_ID],
    );
    assert.equal(published.cleanupStatus, "kept");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
