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
  scheduleNextMapWave,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  actionReadyEvidencePack,
  actionReadyHandoffRolloutRecords,
} from "./fixtures/action-ready-handoff-fixtures.mjs";

const EXPECTED_ISSUE = {
  code: "DETERMINISTIC_AUTHORITY_EXCLUSION",
  fieldPath: "criticalExclusions[0].evidenceIndex",
  message:
    "criticalExclusions cannot exclude an Anchor retained by a frozen Frame authority",
  correctionHint:
    "Remove this entry; the frozen Current Goal, explicit exclusion, Accepted Proposal, or Terminal-State Claim retains this Critical Anchor deterministically.",
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

function mapCandidate(dispatch, frame, dictionary, stage) {
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
    deliverables: stage === "progress_map" ? [{
      deliverableId: "continue-implementation",
      request: "Continue the interrupted implementation from the frozen goal.",
      status: "blocked",
      findingIds: [],
      missingReason: "The Source Thread ended before it recorded progress evidence.",
    }] : [],
    inspectionDispositions: [],
  };
}

async function prepareWorkflow(root) {
  const rolloutPath = path.join(root, "synthetic-authority-exclusion.jsonl");
  await fs.promises.writeFile(
    rolloutPath,
    `${emptyProgressRolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
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
  const frame = {
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
  };
  await writeJson(frameStage.framePath, frame);
  const validated = await validateFrameStage(prepared.workDir);
  const scheduled = await scheduleNextMapWave(
    prepared.workDir,
    validated.mapDispatches.length,
  );
  assert.deepEqual(scheduled.dispatches, validated.mapDispatches);
  return { prepared, validated, frame };
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

test("TR6 repairs deterministic authority exclusions before receipt acceptance", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-repair-tr6-"));
  try {
    const workflow = await prepareWorkflow(root);
    const { prepared, validated, frame } = workflow;
    const stagesById = new Map(
      validated.segments.map((segment) => [segment.segmentId, segment.stage]),
    );
    const terminalAnchors = new Set(frame.terminalStateClaim.anchors);

    let target = null;
    for (const dispatch of validated.mapDispatches) {
      if (stagesById.get(dispatch.segmentId) === "progress_map") continue;
      const dictionary = await readJson(dispatch.dictionaryPath);
      const reference = dictionary.evidenceReferences.find(
        (entry) => terminalAnchors.has(entry.anchorId),
      );
      if (reference) {
        target = { dispatch, dictionary, reference };
        break;
      }
    }
    assert.ok(target, "a non-progress dispatch must project a Terminal-State Claim anchor");

    const invalid = mapCandidate(
      target.dispatch,
      validated,
      target.dictionary,
      stagesById.get(target.dispatch.segmentId),
    );
    invalid.claims[0].evidenceIndexes = invalid.claims[0].evidenceIndexes.filter(
      (index) => index !== target.reference.index,
    );
    if (invalid.claims[0].evidenceIndexes.length === 0) invalid.claims = [];
    invalid.criticalExclusions = [{
      evidenceIndex: target.reference.index,
      reasonCode: "no_continuation_value",
    }];

    await claimMapDispatch(
      prepared.workDir,
      target.dispatch.segmentId,
      target.dispatch.dispatchId,
      "worker-targeted-map-repair-tr6-authority",
    );
    await writeJson(target.dispatch.summaryPath, invalid);
    const checkError = await captureError(() => checkMapDispatch(
      prepared.workDir,
      target.dispatch.segmentId,
      target.dispatch.dispatchId,
    ));
    assert.equal(checkError.code, "MAP_REPAIR_REQUIRED");
    assert.deepEqual(checkError.details, {
      repairScope: "map_candidate",
      segmentId: target.dispatch.segmentId,
      issues: [EXPECTED_ISSUE],
    });

    const repaired = structuredClone(invalid);
    repaired.criticalExclusions = [];
    const remainingIndexes = target.dictionary.evidenceReferences.map((entry) => entry.index);
    if (repaired.claims.length === 0) {
      repaired.claims = [{
        localId: 1,
        kind: "completed_work",
        text: `Retain evidence for ${target.dispatch.segmentId}.`,
        evidenceIndexes: remainingIndexes,
      }];
    } else {
      repaired.claims[0].evidenceIndexes = remainingIndexes;
    }
    await writeJson(target.dispatch.summaryPath, repaired);
    await checkMapDispatch(
      prepared.workDir,
      target.dispatch.segmentId,
      target.dispatch.dispatchId,
    );
    await completeMapDispatch(
      prepared.workDir,
      target.dispatch.segmentId,
      target.dispatch.dispatchId,
    );
    await acceptMapReceipt(
      prepared.workDir,
      target.dispatch.segmentId,
      target.dispatch.dispatchId,
    );

    for (const dispatch of validated.mapDispatches) {
      if (dispatch.dispatchId === target.dispatch.dispatchId) continue;
      const dictionary = await readJson(dispatch.dictionaryPath);
      await completeCandidate(
        workflow,
        dispatch,
        mapCandidate(
          dispatch,
          validated,
          dictionary,
          stagesById.get(dispatch.segmentId),
        ),
        `worker-targeted-map-repair-tr6-${dispatch.segmentId}`,
      );
    }

    const reduceStage = await prepareReduceStage(prepared.workDir);
    const reduceInput = await readJson(reduceStage.reduceInputPath);
    assert.ok(reduceInput.claimTable.claims.some(
      (claim) => claim.claimId === frame.terminalStateClaim.claimId,
    ));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
