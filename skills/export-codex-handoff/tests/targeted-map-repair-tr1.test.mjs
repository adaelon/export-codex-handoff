import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import { CONTINUATION_MAP_V2_RESULT_MODE } from "../scripts/lib/map-worker.mjs";
import {
  checkMapDispatch,
  claimMapDispatch,
  completeMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  scheduleNextMapWave,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  ACTION_READY_SOURCE_PATH,
  ACTION_READY_TEST_PATH,
  COMPLEXITY_FINDING,
  FLOW_FINDING,
  actionReadyEvidencePack,
  actionReadyHandoffRolloutRecords,
} from "./fixtures/action-ready-handoff-fixtures.mjs";

const EXISTENCE_COMMAND = `Test-Path ${ACTION_READY_SOURCE_PATH}`;
const MECHANICAL_COMMAND = "Write-Output worker-ready";
const TEST_COMMAND = `node --test ${ACTION_READY_TEST_PATH}`;

const EXPECTED_ISSUES = [
  {
    code: "NON_CRITICAL_EXCLUSION",
    fieldPath: "criticalExclusions[0].evidenceIndex",
    message: "criticalExclusions may contain only Critical Anchor references",
    correctionHint:
      "Remove this entry; non-Critical evidence remains retrievable without an explicit exclusion.",
  },
  {
    code: "LOW_VALUE_FINDING",
    fieldPath: "findings[2].claim",
    message: "Finding references an existence_probe result that must remain Cold Evidence",
    correctionHint:
      "Remove this Finding or replace it with a deliverable-relevant semantic Claim.",
  },
  {
    code: "LOW_VALUE_FINDING",
    fieldPath: "findings[3].claim",
    message: "Finding references a mechanical_success result that must remain Cold Evidence",
    correctionHint:
      "Remove this Finding or replace it with a deliverable-relevant semantic Claim.",
  },
  {
    code: "MISCLASSIFIED_VERIFICATION_FINDING",
    fieldPath: "claims[4].kind",
    message: "Finding references a verification result authored as completed_work",
    correctionHint:
      "Change the Claim kind to verification and add its exact command/result relation.",
  },
];

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(target) {
  return JSON.parse(await fs.promises.readFile(target, "utf8"));
}

async function captureError(operation) {
  let captured = null;
  try {
    await operation();
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, "operation must reject");
  return captured;
}

function evidenceIndexesFor(reference, dictionary) {
  const byAnchor = new Map(
    dictionary.evidenceReferences.map((entry) => [entry.anchorId, entry.index]),
  );
  return reference.anchors.map((anchorId) => byAnchor.get(anchorId));
}

function invalidProgressCandidate({ chunk, dictionary, frame, nonCriticalIndex }) {
  const sourceInspection = chunk.progressEvidence.inspections.find(
    (inspection) => inspection.location === ACTION_READY_SOURCE_PATH,
  );
  const testInspection = chunk.progressEvidence.inspections.find(
    (inspection) => inspection.location === ACTION_READY_TEST_PATH,
  );
  assert.ok(sourceInspection);
  assert.ok(testInspection);
  const sourceIndexes = evidenceIndexesFor(sourceInspection.outputEvidence, dictionary);
  const testIndexes = evidenceIndexesFor(testInspection.outputEvidence, dictionary);

  return {
    formatVersion: 2,
    kind: "codex-handoff-continuation-map",
    frameId: frame.frameId,
    frameDigest: frame.frameDigest,
    segmentId: chunk.segmentId,
    claims: [
      {
        localId: 1,
        kind: "completed_work",
        text: FLOW_FINDING,
        evidenceIndexes: [...new Set([...sourceIndexes, ...testIndexes])],
      },
      {
        localId: 2,
        kind: "completed_work",
        text: COMPLEXITY_FINDING,
        evidenceIndexes: sourceIndexes,
      },
      {
        localId: 3,
        kind: "verification",
        text: `${EXISTENCE_COMMAND} => pass`,
        evidenceIndexes: sourceIndexes,
      },
      {
        localId: 4,
        kind: "verification",
        text: `${MECHANICAL_COMMAND} => pass`,
        evidenceIndexes: sourceIndexes,
      },
      {
        localId: 5,
        kind: "completed_work",
        text: `${TEST_COMMAND} => pass`,
        evidenceIndexes: testIndexes,
      },
    ],
    relations: {
      decisions: [],
      attempts: [],
      verification: [
        { claim: 3, command: EXISTENCE_COMMAND, result: "pass" },
        { claim: 4, command: MECHANICAL_COMMAND, result: "pass" },
      ],
    },
    criticalExclusions: [{
      evidenceIndex: nonCriticalIndex,
      reasonCode: "no_continuation_value",
    }],
    findings: [
      { localId: 1, claim: 1 },
      { localId: 2, claim: 2 },
      { localId: 3, claim: 3 },
      { localId: 4, claim: 4 },
      { localId: 5, claim: 5 },
    ],
    deliverables: [{
      deliverableId: "review-explanation",
      request: "Explain the review flow and complexity.",
      status: "ready",
      findingIds: [1, 2, 3, 4, 5],
    }],
    inspectionDispositions: [
      {
        inspectionId: sourceInspection.outputEvidence.referenceId,
        findingIds: [1, 2, 3, 4],
        rereadPolicy: "do_not_reread",
      },
      {
        inspectionId: testInspection.outputEvidence.referenceId,
        findingIds: [1, 5],
        rereadPolicy: "do_not_reread",
      },
    ],
  };
}

async function prepareWorkflow(root) {
  const rolloutPath = path.join(root, "synthetic-targeted-map-repair.jsonl");
  await fs.promises.writeFile(
    rolloutPath,
    `${actionReadyHandoffRolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  const pack = actionReadyEvidencePack(await parseSourceThread(rolloutPath));
  const prepared = await prepareCompressionTask({
    sessionId: pack.source.sessionId,
    outputPath: path.join(root, "handoff.md"),
    evidenceIndexPath: path.join(root, "handoff.evidence.json"),
    workRoot: root,
    mapResultMode: CONTINUATION_MAP_V2_RESULT_MODE,
  }, { buildEvidencePack: async () => pack });
  const frameStage = await prepareFrameStage(prepared.workDir);
  const frameInput = await readJson(frameStage.frameInputPath);
  await writeJson(frameStage.framePath, {
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
  });
  const validated = await validateFrameStage(prepared.workDir);
  await scheduleNextMapWave(prepared.workDir, validated.mapDispatches.length);
  const segment = validated.segments.find((candidate) => candidate.stage === "progress_map");
  assert.ok(segment);
  const dispatch = validated.mapDispatches.find(
    (candidate) => candidate.segmentId === segment.segmentId,
  );
  assert.ok(dispatch);
  const chunk = await readJson(dispatch.chunkPath);
  const dictionary = await readJson(dispatch.dictionaryPath);
  const criticalAnchors = new Set(frameInput.preservationPolicy.requiredAnchors);
  const usedInspectionAnchors = new Set(
    chunk.progressEvidence.inspections.flatMap(
      (inspection) => inspection.outputEvidence.anchors,
    ),
  );
  const nonCriticalReference = dictionary.evidenceReferences.find((reference) => (
    !criticalAnchors.has(reference.anchorId) && !usedInspectionAnchors.has(reference.anchorId)
  ));
  assert.ok(nonCriticalReference, "fixture must expose an unused non-Critical local reference");
  return {
    prepared,
    validated,
    dispatch,
    candidate: invalidProgressCandidate({
      chunk,
      dictionary,
      frame: validated,
      nonCriticalIndex: nonCriticalReference.index,
    }),
  };
}

test("TR1 returns one bounded diagnostic for every MAP-owned candidate issue", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-repair-tr1-"));
  try {
    const fixture = await prepareWorkflow(root);
    const { prepared, validated, dispatch, candidate } = fixture;
    await claimMapDispatch(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
      "worker-targeted-map-repair-tr1",
    );
    await writeJson(dispatch.summaryPath, candidate);

    const manifestBeforeCheck = await fs.promises.readFile(prepared.manifestPath, "utf8");
    const checkError = await captureError(() => checkMapDispatch(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
    ));
    assert.equal(checkError.code, "MAP_REPAIR_REQUIRED");
    assert.deepEqual(checkError.details, {
      repairScope: "map_candidate",
      segmentId: dispatch.segmentId,
      issues: EXPECTED_ISSUES,
    });
    assert.equal(
      await fs.promises.readFile(prepared.manifestPath, "utf8"),
      manifestBeforeCheck,
      "--check must not consume or mutate the current attempt",
    );

    const unrelatedDispatchIds = validated.mapDispatches
      .filter((item) => item.segmentId !== dispatch.segmentId)
      .map((item) => item.dispatchId);
    const completeError = await captureError(() => completeMapDispatch(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
    ));
    assert.equal(completeError.code, "MAP_REPAIR_REQUIRED");
    assert.deepEqual(completeError.details.issues, EXPECTED_ISSUES);
    assert.equal(completeError.details.repairScope, "map_candidate");
    assert.equal(completeError.details.segmentId, dispatch.segmentId);
    assert.equal(completeError.details.receipt.diagnosticCode, "MAP_REPAIR_REQUIRED");
    assert.equal(Object.hasOwn(completeError.details, "nextDispatch"), false);

    const manifestAfterComplete = await readJson(prepared.manifestPath);
    const repairedSegment = manifestAfterComplete.segments.find(
      (item) => item.segmentId === dispatch.segmentId,
    );
    assert.equal(repairedSegment.dispatch.attempt, 1);
    assert.equal(repairedSegment.dispatch.dispatchId, dispatch.dispatchId);
    assert.equal(repairedSegment.workerStatus, "failed");
    assert.deepEqual(
      manifestAfterComplete.segments
        .filter((item) => item.segmentId !== dispatch.segmentId)
        .map((item) => item.dispatch.dispatchId),
      unrelatedDispatchIds,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
