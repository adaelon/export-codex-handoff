import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEvidenceReferenceDictionary } from "../scripts/lib/frame-projection.mjs";
import {
  CONTINUATION_MAP_CANDIDATE_MAX_CHARS,
  CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS,
  CONTINUATION_MAP_V2_RESULT_MODE,
  createMapDispatch,
  validateMapReceipt,
} from "../scripts/lib/map-worker.mjs";
import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import {
  completeActionReadyContinuationMapResult,
  validateActionReadyContinuationMapResult,
  validateActionReadyReduceResult,
  validateContinuationMapResult,
} from "../scripts/lib/validation.mjs";
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
  ACTION_READY_SOURCE_PATH,
  ACTION_READY_TEST_PATH,
  COMPLEXITY_FINDING,
  FLOW_FINDING,
  actionReadyEvidencePack,
  actionReadyHandoffRolloutRecords,
} from "./fixtures/action-ready-handoff-fixtures.mjs";

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function parsedActionReadyPack(root) {
  const rolloutPath = path.join(root, "synthetic-action-ready-rollout.jsonl");
  await fs.promises.writeFile(
    rolloutPath,
    `${actionReadyHandoffRolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  return actionReadyEvidencePack(await parseSourceThread(rolloutPath));
}

function directFixture(pack) {
  const currentGoalAnchor = pack.sourceContinuation.currentGoal.anchors[0];
  const frame = {
    frameId: "frame-action-ready-ah2",
    currentGoal: {
      claimId: "goal-action-ready-ah2",
      kind: "current_goal",
      text: "看代码，说明流程和复杂度，不要跑测试",
      anchors: [currentGoalAnchor],
    },
    taskType: "review",
    taskPhase: "handoff",
    explicitExclusions: [],
    preservationPolicy: pack.preservationLedger,
    anchors: pack.preservationLedger.requiredAnchors,
  };
  const frozenFrame = {
    frame,
    frameId: frame.frameId,
    frameDigest: `sha256:${"d".repeat(64)}`,
  };
  const chunk = {
    segmentId: "progress-map-ah2",
    stage: "progress_map",
    sourceSessionId: pack.source.sessionId,
    progressEvidence: pack.progressEvidence,
  };
  const dictionary = buildEvidenceReferenceDictionary(frozenFrame, chunk);
  return { frozenFrame, chunk, dictionary };
}

function evidenceIndexesFor(reference, dictionary) {
  const byAnchor = new Map(
    dictionary.evidenceReferences.map((entry) => [entry.anchorId, entry.index]),
  );
  return reference.anchors.map((anchorId) => byAnchor.get(anchorId));
}

function actionReadyCandidate(fixture) {
  const { progressEvidence } = fixture.chunk;
  const sourceInspection = progressEvidence.inspections.find(
    (inspection) => inspection.location === ACTION_READY_SOURCE_PATH,
  );
  const testInspection = progressEvidence.inspections.find(
    (inspection) => inspection.location === ACTION_READY_TEST_PATH,
  );
  assert.ok(sourceInspection);
  assert.ok(testInspection);
  return {
    formatVersion: 2,
    kind: "codex-handoff-continuation-map",
    frameId: fixture.frozenFrame.frameId,
    frameDigest: fixture.frozenFrame.frameDigest,
    segmentId: fixture.chunk.segmentId,
    claims: [
      {
        localId: 1,
        kind: "completed_work",
        text: FLOW_FINDING,
        evidenceIndexes: [...new Set([
          ...evidenceIndexesFor(sourceInspection.outputEvidence, fixture.dictionary),
          ...evidenceIndexesFor(testInspection.outputEvidence, fixture.dictionary),
        ])],
      },
      {
        localId: 2,
        kind: "completed_work",
        text: COMPLEXITY_FINDING,
        evidenceIndexes: evidenceIndexesFor(
          sourceInspection.outputEvidence,
          fixture.dictionary,
        ),
      },
    ],
    relations: { decisions: [], attempts: [], verification: [] },
    criticalExclusions: [],
    findings: [
      { localId: 1, claim: 1 },
      { localId: 2, claim: 2 },
    ],
    deliverables: [
      {
        deliverableId: "flow-explanation",
        request: "说明 reviewTarget 的处理流程",
        status: "ready",
        findingIds: [1],
      },
      {
        deliverableId: "complexity-explanation",
        request: "说明 reviewTarget 的时间与空间复杂度",
        status: "ready",
        findingIds: [2],
      },
    ],
    inspectionDispositions: [
      {
        inspectionId: sourceInspection.outputEvidence.referenceId,
        findingIds: [1, 2],
        rereadPolicy: "do_not_reread",
      },
      {
        inspectionId: testInspection.outputEvidence.referenceId,
        findingIds: [1],
        rereadPolicy: "do_not_reread",
      },
    ],
  };
}

function v1Candidate(fixture) {
  return {
    formatVersion: 1,
    kind: "codex-handoff-continuation-map",
    frameId: fixture.frozenFrame.frameId,
    frameDigest: fixture.frozenFrame.frameDigest,
    segmentId: fixture.chunk.segmentId,
    claims: [],
    relations: { decisions: [], attempts: [], verification: [] },
    criticalExclusions: [],
  };
}

function actionReadyReduceCandidate(workingSynthesisInput) {
  const findingIds = workingSynthesisInput.findings.map((finding) => finding.findingId);
  return {
    workingSynthesis: {
      status: "draft_ready",
      sections: [{
        title: "流程与复杂度",
        body: `${FLOW_FINDING}${COMPLEXITY_FINDING}`,
        findingIds,
      }],
      confirmedFindingIds: findingIds,
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
}

async function prepareActionReadyWorkflow(root, pack) {
  const prepared = await prepareCompressionTask({
    sessionId: pack.source.sessionId,
    outputPath: path.join(root, "handoff.md"),
    evidenceIndexPath: path.join(root, "handoff.evidence.json"),
    workRoot: root,
    mapResultMode: CONTINUATION_MAP_V2_RESULT_MODE,
  }, { buildEvidencePack: async () => pack });
  const frameStage = await prepareFrameStage(prepared.workDir);
  const frameInput = JSON.parse(await fs.promises.readFile(frameStage.frameInputPath, "utf8"));
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
  return { prepared, validated };
}

function retentionCandidate(dispatch, dictionary, frame) {
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

test("AH2 completes exact finding, deliverable, and inspection relations for Working Synthesis", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ah2-direct-"));
  try {
    const fixture = directFixture(await parsedActionReadyPack(root));
    const candidate = actionReadyCandidate(fixture);
    assert.equal(
      validateActionReadyContinuationMapResult(
        candidate,
        fixture.dictionary,
        fixture.frozenFrame,
        fixture.chunk.progressEvidence,
      ),
      candidate,
    );
    const completed = completeActionReadyContinuationMapResult(
      candidate,
      fixture.dictionary,
      fixture.frozenFrame,
      fixture.chunk.progressEvidence,
    );
    assert.equal(completed.formatVersion, 2);
    assert.ok(completed.findings.every((finding) => (
      /^finding-[0-9a-f]{64}$/u.test(finding.findingId) &&
      /^claim-[0-9a-f]{64}$/u.test(finding.claimId)
    )));
    assert.deepEqual(
      completed.deliverables.map((deliverable) => deliverable.status),
      ["ready", "ready"],
    );
    assert.deepEqual(
      completed.inspectionDispositions.map((inspection) => inspection.rereadPolicy),
      ["do_not_reread", "do_not_reread"],
    );
    const workingSynthesisInput = {
      formatVersion: 1,
      kind: "codex-handoff-working-synthesis-input",
      findings: completed.findings,
      deliverables: completed.deliverables,
      inspections: completed.inspectionDispositions.map((inspection) => ({
        location: inspection.location,
        symbols: inspection.symbols,
        scope: inspection.scope,
        findingIds: inspection.findingIds,
        rereadPolicy: inspection.rereadPolicy,
      })),
    };
    assert.equal(
      validateActionReadyReduceResult(
        actionReadyReduceCandidate(workingSynthesisInput),
        workingSynthesisInput,
      ).workingSynthesis.status,
      "draft_ready",
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("AH2 fails closed on malformed finding links and incomplete inspection disposition", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ah2-invalid-"));
  try {
    const fixture = directFixture(await parsedActionReadyPack(root));
    const unknownFinding = actionReadyCandidate(fixture);
    unknownFinding.deliverables[0].findingIds = [999];
    assert.throws(
      () => validateActionReadyContinuationMapResult(
        unknownFinding,
        fixture.dictionary,
        fixture.frozenFrame,
        fixture.chunk.progressEvidence,
      ),
      { code: "INVALID_ACTION_READY_RELATION" },
    );

    const missingInspection = actionReadyCandidate(fixture);
    missingInspection.inspectionDispositions.pop();
    assert.throws(
      () => validateActionReadyContinuationMapResult(
        missingInspection,
        fixture.dictionary,
        fixture.frozenFrame,
        fixture.chunk.progressEvidence,
      ),
      { code: "INCOMPLETE_INSPECTION_DISPOSITION" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("AH2 binds bounded v2 workflow input while v1 candidates retain their exact route", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ah2-workflow-"));
  try {
    const pack = await parsedActionReadyPack(root);
    const direct = directFixture(pack);
    assert.equal(
      validateContinuationMapResult(
        v1Candidate(direct),
        direct.dictionary,
        direct.frozenFrame,
      ).formatVersion,
      1,
    );
    assert.throws(
      () => validateContinuationMapResult(
        actionReadyCandidate(direct),
        direct.dictionary,
        direct.frozenFrame,
      ),
      { code: "INVALID_MODEL_OUTPUT" },
    );
    const budgetDispatch = createMapDispatch({
      segmentId: "segment-ah2-budget",
      chunkPath: "C:/synthetic/segment.json",
      summaryPath: "C:/synthetic/summary.json",
      contextPath: "C:/synthetic/context.json",
      contextDigest: `sha256:${"1".repeat(64)}`,
      dictionaryPath: "C:/synthetic/dictionary.json",
      dictionaryDigest: `sha256:${"2".repeat(64)}`,
      frameDigest: direct.frozenFrame.frameDigest,
      attempt: 1,
      mapResultMode: CONTINUATION_MAP_V2_RESULT_MODE,
      maxMapOutputChars: CONTINUATION_MAP_CANDIDATE_MAX_CHARS,
    });
    assert.throws(
      () => validateMapReceipt({
        dispatchId: budgetDispatch.dispatchId,
        segmentId: budgetDispatch.segmentId,
        status: "validated",
        summaryDigest: `sha256:${"3".repeat(64)}`,
        completedSummaryDigest: `sha256:${"4".repeat(64)}`,
        rawMapOutputChars: 1,
        completedMapOutputChars: CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS + 1,
      }, budgetDispatch),
      { code: "MAP_OUTPUT_TOO_LARGE" },
    );

    const workflow = await prepareActionReadyWorkflow(root, pack);
    assert.equal(workflow.prepared.mapResultMode, CONTINUATION_MAP_V2_RESULT_MODE);
    const progressSegment = workflow.validated.segments.find(
      (segment) => segment.stage === "progress_map",
    );
    assert.ok(progressSegment);
    assert.ok(progressSegment.mapInputChars <= workflow.prepared.maxMapInputChars);
    assert.equal(
      progressSegment.dispatch.maxMapOutputChars,
      CONTINUATION_MAP_CANDIDATE_MAX_CHARS,
    );

    for (const dispatch of workflow.validated.mapDispatches) {
      const segment = workflow.validated.segments.find(
        (candidate) => candidate.segmentId === dispatch.segmentId,
      );
      const dictionary = JSON.parse(await fs.promises.readFile(dispatch.dictionaryPath, "utf8"));
      const chunk = JSON.parse(await fs.promises.readFile(dispatch.chunkPath, "utf8"));
      const candidate = segment.stage === "progress_map"
        ? actionReadyCandidate({
          frozenFrame: {
            frameId: workflow.validated.frameId,
            frameDigest: workflow.validated.frameDigest,
          },
          chunk,
          dictionary,
        })
        : retentionCandidate(dispatch, dictionary, workflow.validated);
      await claimMapDispatch(
        workflow.prepared.workDir,
        dispatch.segmentId,
        dispatch.dispatchId,
        `worker-${dispatch.segmentId}`,
      );
      if (segment.stage === "progress_map") {
        const oversized = structuredClone(candidate);
        oversized.claims[0].text = "x".repeat(CONTINUATION_MAP_CANDIDATE_MAX_CHARS);
        await writeJson(dispatch.summaryPath, oversized);
        await assert.rejects(
          checkMapDispatch(
            workflow.prepared.workDir,
            dispatch.segmentId,
            dispatch.dispatchId,
          ),
          { code: "MAP_OUTPUT_TOO_LARGE" },
        );
      }
      await writeJson(dispatch.summaryPath, candidate);
      await checkMapDispatch(
        workflow.prepared.workDir,
        dispatch.segmentId,
        dispatch.dispatchId,
      );
      const receipt = await completeMapDispatch(
        workflow.prepared.workDir,
        dispatch.segmentId,
        dispatch.dispatchId,
      );
      assert.ok(receipt.completedMapOutputChars <= CONTINUATION_MAP_V2_COMPLETED_MAX_CHARS);
      await acceptMapReceipt(
        workflow.prepared.workDir,
        dispatch.segmentId,
        dispatch.dispatchId,
      );
    }

    const reducedStage = await prepareReduceStage(workflow.prepared.workDir);
    const reduceInput = JSON.parse(await fs.promises.readFile(
      reducedStage.reduceInputPath,
      "utf8",
    ));
    assert.equal(reducedStage.mapResultMode, CONTINUATION_MAP_V2_RESULT_MODE);
    assert.equal(
      reduceInput.workingSynthesisInput.kind,
      "codex-handoff-working-synthesis-input",
    );
    assert.deepEqual(
      reduceInput.workingSynthesisInput.deliverables.map((item) => item.deliverableId),
      ["flow-explanation", "complexity-explanation"],
    );
    assert.deepEqual(
      reduceInput.workingSynthesisInput.inspections.map((item) => item.location),
      [ACTION_READY_SOURCE_PATH, ACTION_READY_TEST_PATH],
    );
    assert.deepEqual(reduceInput.actionReadyOutputContract.requiredFields, [
      "workingSynthesis",
      "deliverableStatus",
      "inspectedEvidenceMap",
      "resumePolicy",
    ]);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
