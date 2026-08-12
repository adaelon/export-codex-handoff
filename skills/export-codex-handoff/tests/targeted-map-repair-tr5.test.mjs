import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import { CONTINUATION_MAP_V2_RESULT_MODE } from "../scripts/lib/map-worker.mjs";
import {
  acceptMapReceipt,
  checkMapDispatch,
  claimMapDispatch,
  completeMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  actionReadyEvidencePack,
  actionReadyHandoffRolloutRecords,
} from "./fixtures/action-ready-handoff-fixtures.mjs";

const EXPECTED_ISSUE = {
  code: "MISSING_ACTION_READY_RELATIONS",
  fieldPath: "deliverables",
  message: "Progress Evidence MAP must author action-ready relations before REDUCE",
  correctionHint: [
    "Add at least one deliverable. When Progress Evidence cannot support a Finding,",
    "use status blocked, findingIds [], and a non-empty missingReason; do not invent evidence.",
  ].join(" "),
};

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

function emptyProgressRolloutRecords() {
  return actionReadyHandoffRolloutRecords().filter((record) => {
    const payload = record.payload;
    return !(
      record.type === "response_item" &&
      (
        payload?.role === "assistant" ||
        payload?.type === "function_call" ||
        payload?.type === "function_call_output"
      )
    );
  });
}

function mapCandidate(dispatch, frame, dictionary) {
  return {
    formatVersion: 2,
    kind: "codex-handoff-continuation-map",
    frameId: frame.frameId,
    frameDigest: frame.frameDigest,
    segmentId: dispatch.segmentId,
    claims: dictionary.evidenceReferences.length > 0 ? [{
      localId: 1,
      kind: "completed_work",
      text: `Retain evidence for ${dispatch.segmentId}.`,
      evidenceIndexes: dictionary.evidenceReferences.map((entry) => entry.index),
    }] : [],
    relations: { decisions: [], attempts: [], verification: [] },
    criticalExclusions: [],
    findings: [],
    deliverables: [],
    inspectionDispositions: [],
  };
}

async function prepareWorkflow(root) {
  const rolloutPath = path.join(root, "synthetic-empty-progress.jsonl");
  await fs.promises.writeFile(
    rolloutPath,
    `${emptyProgressRolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  const pack = actionReadyEvidencePack(await parseSourceThread(rolloutPath));
  assert.equal(pack.progressEvidence.inspections.length, 0);
  assert.equal(pack.progressEvidence.assistantProgress.length, 0);

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
    taskType: "implementation",
    taskPhase: "implementing",
    explicitExclusions: frameInput.explicitExclusions,
    preservationPolicy: frameInput.preservationPolicy,
    anchors: frameInput.requiredFrameAnchors,
  });
  const validated = await validateFrameStage(prepared.workDir);
  const progressSegment = validated.segments.find(
    (segment) => segment.stage === "progress_map",
  );
  assert.ok(progressSegment);
  const progressDispatch = validated.mapDispatches.find(
    (dispatch) => dispatch.segmentId === progressSegment.segmentId,
  );
  assert.ok(progressDispatch);
  return { prepared, validated, progressDispatch };
}

async function completeCandidate(workflow, dispatch, candidate, workerId) {
  await claimMapDispatch(
    workflow.prepared.workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
    workerId,
  );
  await writeJson(dispatch.summaryPath, candidate);
  await checkMapDispatch(
    workflow.prepared.workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
  );
  await completeMapDispatch(
    workflow.prepared.workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
  );
  await acceptMapReceipt(
    workflow.prepared.workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
  );
}

test("TR5 repairs an empty Progress MAP before REDUCE without inventing a Finding", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-repair-tr5-"));
  try {
    const workflow = await prepareWorkflow(root);
    const { prepared, validated, progressDispatch } = workflow;
    const dictionary = await readJson(progressDispatch.dictionaryPath);
    const emptyCandidate = mapCandidate(progressDispatch, validated, dictionary);
    emptyCandidate.claims = [];

    await claimMapDispatch(
      prepared.workDir,
      progressDispatch.segmentId,
      progressDispatch.dispatchId,
      "worker-targeted-map-repair-tr5-progress",
    );
    await writeJson(progressDispatch.summaryPath, emptyCandidate);
    const checkError = await captureError(() => checkMapDispatch(
      prepared.workDir,
      progressDispatch.segmentId,
      progressDispatch.dispatchId,
    ));
    assert.equal(checkError.code, "MAP_REPAIR_REQUIRED");
    assert.deepEqual(checkError.details, {
      repairScope: "map_candidate",
      segmentId: progressDispatch.segmentId,
      issues: [EXPECTED_ISSUE],
    });

    const repaired = structuredClone(emptyCandidate);
    repaired.deliverables = [{
      deliverableId: "continue-implementation",
      request: "Continue the interrupted implementation from the frozen goal.",
      status: "blocked",
      findingIds: [],
      missingReason: "The Source Thread ended before it recorded progress evidence.",
    }];
    await writeJson(progressDispatch.summaryPath, repaired);
    await checkMapDispatch(
      prepared.workDir,
      progressDispatch.segmentId,
      progressDispatch.dispatchId,
    );
    await completeMapDispatch(
      prepared.workDir,
      progressDispatch.segmentId,
      progressDispatch.dispatchId,
    );
    await acceptMapReceipt(
      prepared.workDir,
      progressDispatch.segmentId,
      progressDispatch.dispatchId,
    );

    for (const dispatch of validated.mapDispatches) {
      if (dispatch.dispatchId === progressDispatch.dispatchId) continue;
      const otherDictionary = await readJson(dispatch.dictionaryPath);
      await completeCandidate(
        workflow,
        dispatch,
        mapCandidate(dispatch, validated, otherDictionary),
        `worker-targeted-map-repair-tr5-${dispatch.segmentId}`,
      );
    }

    const reduceStage = await prepareReduceStage(prepared.workDir);
    const reduceInput = await readJson(reduceStage.reduceInputPath);
    assert.deepEqual(reduceInput.workingSynthesisInput.findings, []);
    assert.deepEqual(
      reduceInput.workingSynthesisInput.deliverables,
      repaired.deliverables,
    );
    assert.deepEqual(reduceInput.workingSynthesisInput.inspections, []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
