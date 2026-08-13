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

function assertRetainedFailureIssues(issues) {
  assert.deepEqual(issues, EXPECTED_ISSUES);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    [
      "NON_CRITICAL_EXCLUSION",
      "LOW_VALUE_FINDING",
      "LOW_VALUE_FINDING",
      "MISCLASSIFIED_VERIFICATION_FINDING",
    ],
  );
  assert.match(issues[1].message, /existence_probe/u);
  assert.match(issues[2].message, /mechanical_success/u);
  assert.match(issues[3].message, /verification result authored as completed_work/u);
}

function repairCandidateFromIssues(invalid, issues) {
  assertRetainedFailureIssues(issues);
  const corrected = structuredClone(invalid);
  const exclusionIndexes = new Set();
  const removedFindingIds = new Set();

  for (const issue of issues) {
    if (issue.code === "NON_CRITICAL_EXCLUSION") {
      const match = /^criticalExclusions\[(\d+)\]\.evidenceIndex$/u.exec(issue.fieldPath);
      assert.ok(match);
      exclusionIndexes.add(Number(match[1]));
      continue;
    }
    if (issue.code === "LOW_VALUE_FINDING") {
      const match = /^findings\[(\d+)\]\.claim$/u.exec(issue.fieldPath);
      assert.ok(match);
      removedFindingIds.add(invalid.findings[Number(match[1])].localId);
      continue;
    }
    if (issue.code === "MISCLASSIFIED_VERIFICATION_FINDING") {
      const match = /^claims\[(\d+)\]\.kind$/u.exec(issue.fieldPath);
      assert.ok(match);
      const claim = corrected.claims[Number(match[1])];
      const verification = /^(.+) => (pass|fail|not_run|unknown)$/u.exec(claim.text);
      assert.ok(verification);
      claim.kind = "verification";
      corrected.relations.verification.push({
        claim: claim.localId,
        command: verification[1],
        result: verification[2],
      });
      continue;
    }
    assert.fail(`Unexpected MAP repair issue: ${issue.code}`);
  }

  corrected.criticalExclusions = corrected.criticalExclusions.filter(
    (_entry, index) => !exclusionIndexes.has(index),
  );
  corrected.findings = corrected.findings.filter(
    (finding) => !removedFindingIds.has(finding.localId),
  );
  corrected.deliverables = corrected.deliverables.map((deliverable) => ({
    ...deliverable,
    findingIds: deliverable.findingIds.filter(
      (findingId) => !removedFindingIds.has(findingId),
    ),
  }));
  corrected.inspectionDispositions = corrected.inspectionDispositions.map(
    (disposition) => ({
      ...disposition,
      findingIds: disposition.findingIds.filter(
        (findingId) => !removedFindingIds.has(findingId),
      ),
    }),
  );
  return corrected;
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
  const targetSegment = validated.segments.find(
    (candidate) => candidate.stage === "progress_map",
  );
  assert.ok(targetSegment);
  const targetDispatch = validated.mapDispatches.find(
    (candidate) => candidate.segmentId === targetSegment.segmentId,
  );
  assert.ok(targetDispatch);
  const unrelatedDispatch = validated.mapDispatches.find(
    (candidate) => candidate.segmentId !== targetSegment.segmentId,
  );
  assert.ok(unrelatedDispatch, "fixture must expose unrelated MAP work");

  const chunk = await readJson(targetDispatch.chunkPath);
  const dictionary = await readJson(targetDispatch.dictionaryPath);
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
    targetDispatch,
    unrelatedDispatch,
    invalidCandidate: invalidProgressCandidate({
      chunk,
      dictionary,
      frame: validated,
      nonCriticalIndex: nonCriticalReference.index,
    }),
  };
}

async function retainUnrelatedMap(workflow) {
  const { prepared, validated, targetDispatch, unrelatedDispatch } = workflow;
  const dictionary = await readJson(unrelatedDispatch.dictionaryPath);
  await claimMapDispatch(
    prepared.workDir,
    unrelatedDispatch.segmentId,
    unrelatedDispatch.dispatchId,
    `worker-${unrelatedDispatch.segmentId}`,
  );
  await writeJson(
    unrelatedDispatch.summaryPath,
    retentionCandidate(unrelatedDispatch, dictionary, validated),
  );
  await checkMapDispatch(
    prepared.workDir,
    unrelatedDispatch.segmentId,
    unrelatedDispatch.dispatchId,
  );
  await completeMapDispatch(
    prepared.workDir,
    unrelatedDispatch.segmentId,
    unrelatedDispatch.dispatchId,
  );
  await acceptMapReceipt(
    prepared.workDir,
    unrelatedDispatch.segmentId,
    unrelatedDispatch.dispatchId,
  );

  const manifest = await readJson(prepared.manifestPath);
  const stage = manifest.segments.find(
    (candidate) => candidate.segmentId === unrelatedDispatch.segmentId,
  );
  assert.equal(stage.workerStatus, "validated");
  return {
    segments: structuredClone(
      manifest.segments.filter((segment) => segment.segmentId !== targetDispatch.segmentId),
    ),
    receiptPath: stage.receiptPath,
    receiptBytes: await fs.promises.readFile(stage.receiptPath),
  };
}

async function assertUnrelatedMapRetained(workflow, retained) {
  const manifest = await readJson(workflow.prepared.manifestPath);
  assert.deepEqual(
    manifest.segments.filter(
      (segment) => segment.segmentId !== workflow.targetDispatch.segmentId,
    ),
    retained.segments,
  );
  assert.deepEqual(
    await fs.promises.readFile(retained.receiptPath),
    retained.receiptBytes,
  );
}

test("TR4 accepts aggregated retained failures through same-attempt repair", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-repair-tr4-check-"));
  try {
    const workflow = await prepareWorkflow(root);
    const retained = await retainUnrelatedMap(workflow);
    const { prepared, targetDispatch, invalidCandidate } = workflow;
    await claimMapDispatch(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
      "worker-targeted-map-repair-tr4-check",
    );
    await writeJson(targetDispatch.summaryPath, invalidCandidate);

    const checkError = await captureError(() => checkMapDispatch(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
    ));
    assert.equal(checkError.code, "MAP_REPAIR_REQUIRED");
    assert.equal(checkError.details.repairScope, "map_candidate");
    assert.equal(checkError.details.segmentId, targetDispatch.segmentId);
    assertRetainedFailureIssues(checkError.details.issues);

    await writeJson(
      targetDispatch.summaryPath,
      repairCandidateFromIssues(invalidCandidate, checkError.details.issues),
    );
    const checked = await checkMapDispatch(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
    );
    assert.equal(checked.valid, true);
    assert.equal(checked.dispatchId, targetDispatch.dispatchId);
    const receipt = await completeMapDispatch(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
    );
    assert.equal(receipt.status, "validated");
    assert.equal(receipt.dispatchId, targetDispatch.dispatchId);
    await acceptMapReceipt(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
    );

    const manifest = await readJson(prepared.manifestPath);
    const repaired = manifest.segments.find(
      (segment) => segment.segmentId === targetDispatch.segmentId,
    );
    assert.equal(repaired.dispatch.attempt, 1);
    assert.equal(repaired.dispatch.dispatchId, targetDispatch.dispatchId);
    assert.equal(repaired.workerStatus, "validated");
    await assertUnrelatedMapRetained(workflow, retained);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("TR4 preserves exact feedback through Main Codex-directed same-dispatch repair", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-map-repair-tr4-retry-"));
  try {
    const workflow = await prepareWorkflow(root);
    const retained = await retainUnrelatedMap(workflow);
    const { prepared, targetDispatch, invalidCandidate } = workflow;
    await claimMapDispatch(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
      "worker-targeted-map-repair-tr4-attempt-1",
    );
    await writeJson(targetDispatch.summaryPath, invalidCandidate);

    const checkError = await captureError(() => checkMapDispatch(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
    ));
    assert.equal(checkError.code, "MAP_REPAIR_REQUIRED");
    assertRetainedFailureIssues(checkError.details.issues);

    const completeError = await captureError(() => completeMapDispatch(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
    ));
    assert.equal(completeError.code, "MAP_REPAIR_REQUIRED");
    assert.deepEqual(completeError.details.issues, checkError.details.issues);
    assert.equal(completeError.details.repairScope, "map_candidate");
    assert.equal(completeError.details.segmentId, targetDispatch.segmentId);
    assert.equal(completeError.details.receipt.diagnosticCode, "MAP_REPAIR_REQUIRED");
    assert.equal(Object.hasOwn(completeError.details, "nextDispatch"), false);
    let manifest = await readJson(prepared.manifestPath);
    let repaired = manifest.segments.find(
      (segment) => segment.segmentId === targetDispatch.segmentId,
    );
    assert.equal(repaired.dispatch.dispatchId, targetDispatch.dispatchId);
    assert.equal(repaired.dispatch.attempt, 1);
    assert.equal(repaired.workerStatus, "failed");

    await writeJson(
      targetDispatch.summaryPath,
      repairCandidateFromIssues(invalidCandidate, completeError.details.issues),
    );
    const checked = await checkMapDispatch(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
    );
    assert.equal(checked.valid, true);
    assert.equal(checked.dispatchId, targetDispatch.dispatchId);
    const receipt = await completeMapDispatch(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
    );
    assert.equal(receipt.status, "validated");
    assert.equal(receipt.dispatchId, targetDispatch.dispatchId);
    await acceptMapReceipt(
      prepared.workDir,
      targetDispatch.segmentId,
      targetDispatch.dispatchId,
    );

    manifest = await readJson(prepared.manifestPath);
    repaired = manifest.segments.find(
      (segment) => segment.segmentId === targetDispatch.segmentId,
    );
    assert.equal(repaired.dispatch.attempt, 1);
    assert.equal(repaired.dispatch.dispatchId, targetDispatch.dispatchId);
    assert.equal(repaired.workerStatus, "validated");
    assert.equal(repaired.lastDiagnosticCode, undefined);
    await assertUnrelatedMapRetained(workflow, retained);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
