import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildEvidenceReferenceDictionary,
  buildReferenceFrameProjection,
  evidenceReferenceDictionaryDigest,
  resolveEvidenceReferences,
  resolveExactIdentifierReferences,
  validateEvidenceReferenceDictionary,
} from "../scripts/lib/frame-projection.mjs";
import {
  buildPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import {
  createMapDispatch,
  validateMapDispatch,
} from "../scripts/lib/map-worker.mjs";
import {
  prepareCompressionTask,
  prepareFrameStage,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";

const SESSION_ID = "00000000-0000-7000-8000-0000000000a2";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;

function sourceEntry(index, text) {
  return createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId: `turn-r2-${index}`,
    eventOrdinal: index,
    rolloutLine: index,
    payloadPath: "/payload/content/0/text",
    value: text,
    locator: { kind: "rollout_payload" },
  });
}

function directFixture(segmentId = "segment-r2-a") {
  const first = sourceEntry(1, "Implement R2 at C:\\repo\\src\\projection.mjs");
  const second = sourceEntry(2, "Keep symbol: resolveEvidenceReferences exact.");
  const preservationPolicy = buildPreservationLedger(
    SOURCE_REVISION,
    [first, second],
  );
  const frame = {
    frameId: "frame-r2",
    currentGoal: {
      claimId: "goal-r2",
      kind: "current_goal",
      text: "Implement the Evidence Reference Dictionary.",
      anchors: [first.anchor.anchorId],
    },
    taskType: "implementation",
    taskPhase: "implementing",
    explicitExclusions: [{
      claimId: "exclude-r3",
      kind: "explicit_exclusion",
      text: "Do not implement continuation-map-v1.",
      anchors: [second.anchor.anchorId],
    }],
    preservationPolicy,
    anchors: preservationPolicy.requiredAnchors,
  };
  const frozenFrame = {
    frame,
    frameId: frame.frameId,
    frameDigest: `sha256:${"f".repeat(64)}`,
  };
  const chunk = {
    segmentId,
    turns: [{
      turnId: "turn-r2",
      userMessages: [{ anchors: [first.anchor.anchorId, second.anchor.anchorId] }],
    }],
  };
  return { first, second, frozenFrame, chunk };
}

function workflowPack(goalSuffix = "") {
  const text = [
    "Implement R2 Evidence Reference Dictionary.",
    "Do not implement R3 or R4.",
    "Keep C:\\repo\\src\\frame-projection.mjs and symbol: resolveEvidenceReferences.",
    goalSuffix,
  ].join("\n");
  const entry = sourceEntry(1, text);
  const preservationLedger = buildPreservationLedger(SOURCE_REVISION, [entry]);
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/r2-rollout.jsonl",
    sourceChars: text.length,
    sourceBytes: text.length,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/workspace",
      startedAt: "2026-07-30T00:00:00Z",
    },
  };
  const turns = [{
    turnId: entry.anchor.turnId,
    userMessages: [{ text, anchors: [entry.anchor.anchorId] }],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
  }];
  const workspace = {
    status: "available",
    cwd: source.session.cwd,
    checkpoint: { status: "missing" },
    git: { status: "not_repository" },
  };
  const pack = {
    formatVersion: 1,
    source,
    turns,
    ignoredEvents: {},
    workspace,
    evidenceAnchors: [entry.anchor],
    preservationLedger,
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source,
    workspace,
    entries: [entry],
    preservationLedger,
  });
  return { ...pack, evidenceChars: JSON.stringify(pack).length, evidenceIndex };
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function preparedWorkflow(root, options = {}) {
  const pack = options.pack || workflowPack();
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    workRoot: root,
    maxChunkChars: 40_000,
    ...options.prepare,
  }, { buildEvidencePack: async () => pack });
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
  return { prepared, frameStage };
}

test("R2 dictionary mutation fails closed and every projected evidence reference resolves", () => {
  const fixture = directFixture();
  const dictionary = buildEvidenceReferenceDictionary(
    fixture.frozenFrame,
    fixture.chunk,
  );
  const projection = buildReferenceFrameProjection(
    fixture.frozenFrame,
    fixture.chunk,
    dictionary,
  );

  assert.deepEqual(
    resolveEvidenceReferences(dictionary, projection.currentGoal.evidenceIndexes),
    [fixture.first.anchor.anchorId],
  );
  assert.deepEqual(
    resolveEvidenceReferences(dictionary, projection.explicitExclusions[0].evidenceIndexes),
    [fixture.second.anchor.anchorId],
  );
  assert.deepEqual(
    resolveEvidenceReferences(
      dictionary,
      projection.preservationProjection.requiredEvidenceIndexes,
    ),
    fixture.frozenFrame.frame.preservationPolicy.requiredAnchors,
  );
  assert.deepEqual(
    resolveExactIdentifierReferences(
      dictionary,
      projection.preservationProjection.exactIdentifierIndexes,
    ).map(({ kind, value }) => ({ kind, value })),
    fixture.frozenFrame.frame.preservationPolicy.exactIdentifiers
      .map(({ kind, value }) => ({ kind, value })),
  );

  const mutated = structuredClone(dictionary);
  mutated.evidenceReferences[0].anchorId = `anchor-${"0".repeat(64)}`;
  assert.throws(
    () => validateEvidenceReferenceDictionary(
      mutated,
      fixture.frozenFrame,
      fixture.chunk,
    ),
    { code: "MAP_DICTIONARY_CHANGED" },
  );
});

test("R2 dictionary digest is dispatch-bound and cross-dispatch reuse fails closed", () => {
  const first = directFixture("segment-r2-a");
  const second = directFixture("segment-r2-b");
  const firstDictionary = buildEvidenceReferenceDictionary(first.frozenFrame, first.chunk);
  const secondDictionary = buildEvidenceReferenceDictionary(second.frozenFrame, second.chunk);
  const firstDigest = evidenceReferenceDictionaryDigest(firstDictionary);
  const secondDigest = evidenceReferenceDictionaryDigest(secondDictionary);
  assert.notEqual(firstDigest, secondDigest);

  const dispatch = createMapDispatch({
    segmentId: first.chunk.segmentId,
    chunkPath: "C:/work/segment-a.json",
    summaryPath: "C:/work/summary-a.json",
    contextPath: "C:/work/context-a.json",
    contextDigest: `sha256:${"c".repeat(64)}`,
    dictionaryPath: "C:/work/dictionary-a.json",
    dictionaryDigest: firstDigest,
    frameDigest: first.frozenFrame.frameDigest,
    attempt: 1,
  });
  assert.throws(
    () => validateMapDispatch(dispatch, { dictionaryDigest: secondDigest }),
    { code: "MAP_DICTIONARY_CHANGED" },
  );
  assert.throws(
    () => validateMapDispatch({ ...dispatch, dictionaryDigest: secondDigest }),
    { code: "MAP_DISPATCH_IDENTITY_MISMATCH" },
  );
  assert.throws(
    () => validateEvidenceReferenceDictionary(
      firstDictionary,
      second.frozenFrame,
      second.chunk,
    ),
    { code: "MAP_DICTIONARY_CHANGED" },
  );
});

test("R2 enforces the independent 20,000-character Frame Projection budget", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-r2-projection-budget-"));
  try {
    const { prepared } = await preparedWorkflow(root, {
      pack: workflowPack("x".repeat(6_000)),
      prepare: {
        maxFrameProjectionChars: 4_000,
        maxMapInputChars: 100_000,
      },
    });
    await assert.rejects(validateFrameStage(prepared.workDir), {
      code: "FRAME_PROJECTION_TOO_LARGE",
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("R2 retained-sample projection and total MAP input stay within 20k and 100k", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-r2-input-budget-"));
  try {
    const { prepared } = await preparedWorkflow(root);
    const validated = await validateFrameStage(prepared.workDir);
    assert.equal(validated.maxFrameProjectionChars, 20_000);
    assert.equal(validated.maxMapInputChars, 100_000);
    assert.ok(validated.maxObservedFrameProjectionChars <= 20_000);
    assert.ok(validated.maxObservedMapInputChars <= 100_000);
    for (const segment of validated.segments) {
      assert.ok(segment.contextChars <= 20_000);
      assert.ok(segment.mapInputChars <= 100_000);
      assert.match(segment.dictionaryDigest, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(segment.dispatch.dictionaryDigest, segment.dictionaryDigest);
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
