import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildContinuationPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { CONTINUATION_MAP_RESULT_MODE } from "../scripts/lib/map-worker.mjs";
import {
  acceptMapReceipt,
  checkMapDispatch,
  claimMapDispatch,
  completeMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  scheduleNextMapWave,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";
import * as validation from "../scripts/lib/validation.mjs";

const SESSION_ID = "00000000-0000-7000-8000-0000000000a4";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const WORKSPACE_REVISION = `sha256:${"b".repeat(64)}`;
const FRAME_DIGEST = `sha256:${"f".repeat(64)}`;
const CLAIM_ID = `claim-${"c".repeat(64)}`;
const UNIQUE_CLAIM_BODY = "R4 unique continuation Claim body";
const POLICY_IGNORE_REASON = "not selected by continuation policy";

function sourceEntry(index, text) {
  return createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId: `turn-r4-${index}`,
    eventOrdinal: index,
    rolloutLine: index,
    payloadPath: "/payload/content/0/text",
    value: text,
    locator: { kind: "rollout_payload" },
  });
}

function directFixture() {
  const nonCritical = sourceEntry(1, "Routine historical detail.");
  const critical = sourceEntry(2, "Implement R4 continuation coverage.");
  const entries = [nonCritical, critical];
  const preservationLedger = {
    sourceRevision: SOURCE_REVISION,
    requiredAnchors: [critical.anchor.anchorId],
    exactIdentifiers: [],
    criticalCategories: [],
  };
  const source = {
    sessionId: SESSION_ID,
    rolloutPath: "C:/synthetic/r4-rollout.jsonl",
    sourceRevision: SOURCE_REVISION,
    sourceBytes: 2,
  };
  const workspace = {
    cwd: "C:/synthetic/workspace",
    sourceRevision: WORKSPACE_REVISION,
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source,
    workspace,
    entries,
    preservationLedger,
  });
  const completedMap = {
    formatVersion: 1,
    kind: "codex-handoff-completed-continuation-map",
    frameId: "frame-r4",
    frameDigest: FRAME_DIGEST,
    segmentId: "segment-r4",
    claims: [{
      claimId: CLAIM_ID,
      kind: "open_work",
      text: UNIQUE_CLAIM_BODY,
      evidenceIndexes: [1],
      anchors: [critical.anchor.anchorId],
    }],
    relations: { decisions: [], attempts: [], verification: [] },
    criticalExclusions: [],
  };
  return {
    nonCritical,
    critical,
    preservationLedger,
    evidenceIndex,
    completedMap,
  };
}

function buildContinuationDownstream(...args) {
  assert.equal(
    typeof validation.buildContinuationDownstream,
    "function",
    "R4 must expose deterministic continuation downstream construction",
  );
  return validation.buildContinuationDownstream(...args);
}

function buildContinuationParentCoverage(...args) {
  assert.equal(
    typeof validation.buildContinuationParentCoverage,
    "function",
    "R4 must expose edge-only deterministic parent coverage",
  );
  return validation.buildContinuationParentCoverage(...args);
}

function completedWithoutClaims(fixture) {
  return {
    ...fixture.completedMap,
    claims: [],
  };
}

function workflowPack() {
  const nonCriticalText = "Routine historical detail.";
  const criticalText = "Implement R4 continuation coverage.";
  const nonCritical = sourceEntry(1, nonCriticalText);
  const critical = sourceEntry(2, criticalText);
  const turns = [
    { entry: nonCritical, text: nonCriticalText },
    { entry: critical, text: criticalText },
  ].map(({ entry, text }) => ({
    turnId: entry.anchor.turnId,
    userMessages: [{ text, anchors: [entry.anchor.anchorId] }],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
  }));
  const entries = [nonCritical, critical];
  const preservationLedger = buildContinuationPreservationLedger(
    SOURCE_REVISION,
    entries,
    { turns },
  );
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/r4-rollout.jsonl",
    sourceChars: 2,
    sourceBytes: 2,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/workspace",
      startedAt: "2026-07-30T00:00:00Z",
    },
  };
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
    evidenceAnchors: entries.map(({ anchor }) => anchor),
    preservationLedger,
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source,
    workspace,
    entries,
    preservationLedger,
  });
  return {
    ...pack,
    evidenceChars: JSON.stringify(pack).length,
    evidenceIndex,
    nonCritical,
    critical,
  };
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function preparedAcceptedWorkflow(root) {
  const pack = workflowPack();
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    workRoot: root,
    maxChunkChars: 40_000,
    mapResultMode: CONTINUATION_MAP_RESULT_MODE,
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
  const validated = await validateFrameStage(prepared.workDir);
  await scheduleNextMapWave(prepared.workDir, validated.mapDispatches.length);
  const dispatch = validated.mapDispatches[0];
  const dictionary = JSON.parse(await fs.promises.readFile(dispatch.dictionaryPath, "utf8"));
  const criticalIndex = dictionary.evidenceReferences.find(
    ({ anchorId }) => anchorId === pack.critical.anchor.anchorId,
  ).index;
  await claimMapDispatch(
    prepared.workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
    "worker-r4",
  );
  await writeJson(dispatch.summaryPath, {
    formatVersion: 1,
    kind: "codex-handoff-continuation-map",
    frameId: validated.frameId,
    frameDigest: validated.frameDigest,
    segmentId: dispatch.segmentId,
    claims: [{
      localId: 1,
      kind: "open_work",
      text: UNIQUE_CLAIM_BODY,
      evidenceIndexes: [criticalIndex],
    }],
    relations: { decisions: [], attempts: [], verification: [] },
    criticalExclusions: [],
  });
  await checkMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
  await completeMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
  await acceptMapReceipt(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
  return { pack, prepared, validated };
}

test("R4 fails when a Critical Anchor is neither retained nor explicitly excluded", () => {
  const fixture = directFixture();
  assert.throws(
    () => buildContinuationDownstream(
      [completedWithoutClaims(fixture)],
      [fixture.nonCritical.anchor.turnId, fixture.critical.anchor.turnId],
      fixture.evidenceIndex,
      fixture.preservationLedger,
    ),
    { code: "INCOMPLETE_CONTINUATION_COVERAGE" },
  );
});

test("R4 derives canonical ignored coverage for an unbound non-critical turn", () => {
  const fixture = directFixture();
  const downstream = buildContinuationDownstream(
    [fixture.completedMap],
    [fixture.nonCritical.anchor.turnId, fixture.critical.anchor.turnId],
    fixture.evidenceIndex,
    fixture.preservationLedger,
  );

  assert.deepEqual(downstream.semanticCoverage.turns[0], {
    turnId: fixture.nonCritical.anchor.turnId,
    status: "ignored",
    claimIds: [],
    reason: POLICY_IGNORE_REASON,
  });
  assert.equal(downstream.continuationCoverage.criticalAnchors.length, 1);
  assert.equal(downstream.continuationCoverage.criticalAnchors[0].status, "retained");
});

test("R4 folds a shared fragment Claim into one parent edge and one global body", () => {
  const fixture = directFixture();
  const first = { ...fixture.completedMap, segmentId: "fragment-map-001" };
  const second = structuredClone(first);
  second.segmentId = "fragment-map-002";
  const parent = buildContinuationParentCoverage(
    [first, second],
    fixture.critical.anchor.turnId,
    fixture.evidenceIndex,
  );
  const downstream = buildContinuationDownstream(
    [first, second],
    [fixture.nonCritical.anchor.turnId, fixture.critical.anchor.turnId],
    fixture.evidenceIndex,
    fixture.preservationLedger,
  );

  assert.deepEqual(parent.claimIds, [CLAIM_ID]);
  assert.equal(downstream.claimTable.claims.length, 1);
  assert.equal(downstream.claimTable.claims[0].text, UNIQUE_CLAIM_BODY);
});

test("R4 prepares continuation REDUCE after completed raw chunks are removed", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-r4-raw-removal-"));
  try {
    const workflow = await preparedAcceptedWorkflow(root);
    await Promise.all(
      workflow.prepared.segments.map((segment) => fs.promises.rm(segment.chunkPath)),
    );
    const reduced = await prepareReduceStage(workflow.prepared.workDir);
    assert.equal(reduced.mapResultMode, CONTINUATION_MAP_RESULT_MODE);
    assert.equal(reduced.expectedTurnIds.length, 2);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("R4 continuation REDUCE input serializes each Claim body exactly once", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-r4-claim-once-"));
  try {
    const workflow = await preparedAcceptedWorkflow(root);
    const reduced = await prepareReduceStage(workflow.prepared.workDir);
    const reduceInputText = await fs.promises.readFile(reduced.reduceInputPath, "utf8");
    const reduceInput = JSON.parse(reduceInputText);

    assert.equal(reduceInputText.split(UNIQUE_CLAIM_BODY).length - 1, 1);
    assert.equal(reduceInput.claimTable.claims.length, 1);
    assert.equal("claims" in reduceInput.segmentSummaries[0], false);
    assert.equal("objectiveFacts" in reduceInput.segmentSummaries[0], false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
