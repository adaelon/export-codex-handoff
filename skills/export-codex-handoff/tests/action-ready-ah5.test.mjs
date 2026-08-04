import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  attachEvidenceKeyMap,
  validateEvidenceIndex,
} from "../scripts/lib/evidence-index.mjs";
import { CONTINUATION_MAP_V2_RESULT_MODE } from "../scripts/lib/map-worker.mjs";
import {
  buildActionReadyConsumerContract,
  renderActionReadyHandoff,
} from "../scripts/lib/render-action-ready-handoff.mjs";
import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import { buildContinuationReduceProjections } from "../scripts/lib/validation.mjs";
import {
  acceptMapReceipt,
  checkMapDispatch,
  checkReduceStage,
  claimMapDispatch,
  completeMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  publishHandoff,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  ACTION_READY_SOURCE_PATH,
  ACTION_READY_TEST_PATH,
  ACTION_READY_TURN_ID,
  COMPLEXITY_FINDING,
  EXPECTED_EXCLUSION_CLAUSE,
  FLOW_FINDING,
  actionReadyEvidencePack,
  actionReadyHandoffRolloutRecords,
} from "./fixtures/action-ready-handoff-fixtures.mjs";

const FRAME_DIGEST = `sha256:${"f".repeat(64)}`;
const INDEX_DIGEST = "9".repeat(64);

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function evidenceIndexesFor(reference, dictionary) {
  const byAnchor = new Map(
    dictionary.evidenceReferences.map((entry) => [entry.anchorId, entry.index]),
  );
  const indexes = reference.anchors.map((anchorId) => byAnchor.get(anchorId));
  assert.ok(indexes.every(Number.isInteger));
  return indexes;
}

function actionReadyCandidate({ frozenFrame, chunk, dictionary }) {
  const sourceInspection = chunk.progressEvidence.inspections.find(
    (inspection) => inspection.location === ACTION_READY_SOURCE_PATH,
  );
  const testInspection = chunk.progressEvidence.inspections.find(
    (inspection) => inspection.location === ACTION_READY_TEST_PATH,
  );
  assert.ok(sourceInspection);
  assert.ok(testInspection);
  return {
    formatVersion: 2,
    kind: "codex-handoff-continuation-map",
    frameId: frozenFrame.frameId,
    frameDigest: frozenFrame.frameDigest,
    segmentId: chunk.segmentId,
    claims: [
      {
        localId: 1,
        kind: "completed_work",
        text: FLOW_FINDING,
        evidenceIndexes: [...new Set([
          ...evidenceIndexesFor(sourceInspection.outputEvidence, dictionary),
          ...evidenceIndexesFor(testInspection.outputEvidence, dictionary),
        ])],
      },
      {
        localId: 2,
        kind: "completed_work",
        text: COMPLEXITY_FINDING,
        evidenceIndexes: evidenceIndexesFor(sourceInspection.outputEvidence, dictionary),
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
      text: `Retain critical evidence for ${dispatch.segmentId}.`,
      evidenceIndexes: dictionary.evidenceReferences.map((entry) => entry.index),
    }] : [],
    relations: { decisions: [], attempts: [], verification: [] },
    criticalExclusions: [],
    findings: [],
    deliverables: [],
    inspectionDispositions: [],
  };
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

async function prepareActionReadyPublication(root) {
  const pack = await parsedActionReadyPack(root);
  const prepared = await prepareCompressionTask({
    sessionId: pack.source.sessionId,
    outputPath: path.join(root, "handoff-v2.md"),
    evidenceIndexPath: path.join(root, "handoff-v2.evidence.json"),
    workRoot: root,
    mapResultMode: CONTINUATION_MAP_V2_RESULT_MODE,
  }, { buildEvidencePack: async () => pack });
  const frameStage = await prepareFrameStage(prepared.workDir);
  const frameInput = JSON.parse(await fs.promises.readFile(frameStage.frameInputPath, "utf8"));
  const frame = {
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
  };
  await writeJson(frameStage.framePath, frame);
  const validated = await validateFrameStage(prepared.workDir);

  for (const dispatch of validated.mapDispatches) {
    const segment = validated.segments.find((item) => item.segmentId === dispatch.segmentId);
    const dictionary = JSON.parse(await fs.promises.readFile(dispatch.dictionaryPath, "utf8"));
    const chunk = JSON.parse(await fs.promises.readFile(dispatch.chunkPath, "utf8"));
    const candidate = segment.stage === "progress_map"
      ? actionReadyCandidate({
        frozenFrame: validated,
        chunk,
        dictionary,
      })
      : retentionCandidate(dispatch, dictionary, validated);
    await claimMapDispatch(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
      `worker-ah5-${dispatch.segmentId}`,
    );
    await writeJson(dispatch.summaryPath, candidate);
    await checkMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
    await completeMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
    await acceptMapReceipt(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
  }

  const reduce = await prepareReduceStage(prepared.workDir);
  const reduceInput = JSON.parse(await fs.promises.readFile(reduce.reduceInputPath, "utf8"));
  return { pack, prepared, frame, validated, reduce, reduceInput };
}

function actionReadyReducedCandidate(workflow) {
  const findingIds = workflow.reduceInput.workingSynthesisInput.findings.map(
    (finding) => finding.findingId,
  );
  const deterministicClaims = {
    claims: [workflow.frame.acceptedProposal, workflow.frame.terminalStateClaim].filter(Boolean),
    requireAcceptedProposal: workflow.frame.acceptedProposal !== null,
    requireTerminalState: true,
  };
  const deterministicProjections = buildContinuationReduceProjections(
    workflow.reduceInput.claimTable,
    workflow.pack.preservationLedger,
    deterministicClaims,
  );
  return {
    frameId: workflow.validated.frameId,
    frameDigest: workflow.validated.frameDigest,
    continuationDirective: "Produce the requested draft before retrieving any evidence.",
    objective: {
      goal: workflow.frame.currentGoal.text,
      explicitExclusions: workflow.frame.explicitExclusions.map((claim) => claim.text),
    },
    acceptedProposal: workflow.frame.acceptedProposal,
    terminalState: structuredClone(workflow.frame.terminalStateClaim),
    constraints: [],
    workspaceState: {
      summary: {
        claimId: "claim-ah5-workspace",
        kind: "workspace_state",
        text: "The synthetic review workspace remains available.",
        anchors: [...workflow.frame.currentGoal.anchors],
      },
      evidenceStatus: "full",
      conflicts: [],
    },
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: deterministicProjections.importantLocations,
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    preservationCoverage: deterministicProjections.preservationCoverage,
    provenance: { notes: [], sourceTurnIds: [ACTION_READY_TURN_ID] },
    compressionNotes: [],
    workingSynthesis: {
      status: "draft_ready",
      sections: [{
        title: "流程与复杂度",
        body: `${FLOW_FINDING}\n\n${COMPLEXITY_FINDING}`,
        findingIds,
      }],
      confirmedFindingIds: findingIds,
      uncertainties: [],
    },
    deliverableStatus: structuredClone(
      workflow.reduceInput.workingSynthesisInput.deliverables,
    ),
    inspectedEvidenceMap: structuredClone(
      workflow.reduceInput.workingSynthesisInput.inspections,
    ),
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

function directProjectionFixture() {
  const anchors = [1, 2, 3, 4].map((index) => `anchor-${String(index).repeat(64)}`);
  const entries = anchors.map((anchorId, index) => ({
    key: `E${index + 1}`,
    claimId: `claim-ah5-${index + 1}`,
    anchors: [anchorId],
  }));
  const resumePolicy = {
    mode: "synthesize_first",
    firstDeliverableIds: ["flow-explanation"],
    maxTargetedReads: 2,
    allowedReadReasons: ["claim_verification", "named_uncertainty"],
    forbidBroadSearch: true,
    forbidFullFileReread: true,
  };
  const projection = {
    formatVersion: 1,
    kind: "codex-handoff-action-ready-projection",
    hotContext: {
      objective: { text: "说明流程和复杂度，不要跑测试", evidenceKey: "E1" },
      explicitExclusions: [{ text: EXPECTED_EXCLUSION_CLAUSE, evidenceKey: "E2" }],
      workingSynthesis: {
        status: "draft_ready",
        sections: [{
          title: "流程与复杂度",
          body: "流程第一行\n\n复杂度第二行",
          evidenceKeys: ["E3", "E4"],
        }],
        confirmedFindings: [
          { text: FLOW_FINDING, evidenceKey: "E3" },
          { text: COMPLEXITY_FINDING, evidenceKey: "E4" },
        ],
        uncertainties: [],
      },
      deliverableStatus: [
        {
          deliverableId: "flow-explanation",
          request: "说明处理流程",
          status: "ready",
          evidenceKeys: ["E3"],
        },
        {
          deliverableId: "complexity-explanation",
          request: "说明复杂度",
          status: "ready",
          evidenceKeys: ["E4"],
        },
      ],
      constraints: [],
      decisions: [],
      inspectedEvidenceMap: [{
        location: ACTION_READY_SOURCE_PATH,
        symbols: ["reviewTarget"],
        scope: "reviewTarget and pairwiseConflicts",
        evidenceKeys: ["E3", "E4"],
        rereadPolicy: "do_not_reread",
      }],
      nextActions: [],
      relevantVerifications: [],
      resumePolicy,
    },
    evidenceKeyMap: {
      formatVersion: 1,
      kind: "codex-handoff-evidence-key-map",
      entries,
    },
  };
  const evidenceIndex = {
    source: { sourceRevision: `sha256:${"8".repeat(64)}` },
    workspace: { cwd: "C:/synthetic/action-ready-workspace" },
    anchors: anchors.map((anchorId) => ({ anchor: { anchorId } })),
    semanticCoverage: {
      turns: [{
        turnId: ACTION_READY_TURN_ID,
        status: "summarized",
        claimIds: entries.map((entry) => entry.claimId),
        reason: "Test-Path src/review-target.mjs and raw Git probe stay cold.",
      }],
    },
    evidenceKeyMap: projection.evidenceKeyMap,
    integrity: { indexDigest: INDEX_DIGEST },
  };
  return { projection, evidenceIndex, resumePolicy, entries };
}

function assertExecutionOrder(handoff) {
  const headings = [
    "## Objective and first deliverable",
    "## Working Synthesis",
    "## Deliverable status",
    "## Confirmed findings and uncertainties",
    "## Inspected Evidence Map",
    "## Resume Policy",
    "## Next actions and constraints",
    "## Audit footer",
  ];
  const positions = headings.map((heading) => handoff.indexOf(heading));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
}

test("AH5 renderer orders actionable synthesis before compact audit and omits Cold Evidence", () => {
  const fixture = directProjectionFixture();
  const consumerContract = buildActionReadyConsumerContract(fixture.resumePolicy);
  assert.deepEqual(consumerContract, {
    formatVersion: 1,
    kind: "codex-handoff-synthesize-first-consumer-contract",
    mode: "synthesize_first",
    firstDeliverableIds: ["flow-explanation"],
    preDraftEvidenceReads: 0,
    maxTargetedReads: 2,
    allowedReadReasons: ["claim_verification", "named_uncertainty"],
    forbidBroadSearch: true,
    forbidFullFileReread: true,
  });
  assert.throws(
    () => buildActionReadyConsumerContract({
      ...fixture.resumePolicy,
      maxTargetedReads: 4,
    }),
    { code: "HANDOFF_LOW_VALUE" },
  );

  const handoff = renderActionReadyHandoff({
    projection: fixture.projection,
    evidencePack: {
      source: { sourceRevision: fixture.evidenceIndex.source.sourceRevision },
      workspace: { cwd: fixture.evidenceIndex.workspace.cwd },
    },
    evidenceIndex: fixture.evidenceIndex,
    evidenceIndexPath: "C:/synthetic/handoff-v2.evidence.json",
    frameDigest: FRAME_DIGEST,
  });

  assertExecutionOrder(handoff);
  assert.match(handoff, /流程第一行[\s\S]*复杂度第二行/u);
  assert.doesNotMatch(handoff, /流程第一行 +复杂度第二行/u);
  assert.match(handoff, /Pre-draft evidence reads: `0`/u);
  assert.match(handoff, /Maximum targeted reads after the first draft: `2`/u);
  assert.match(handoff, /Broad search: `forbidden`/u);
  assert.match(handoff, /Full-file reread: `forbidden`/u);
  for (const entry of fixture.entries) assert.ok(handoff.includes(entry.key));
  assert.ok(!fixture.entries.some((entry) => handoff.includes(entry.claimId)));
  assert.ok(!fixture.entries.some((entry) => entry.anchors.some((anchor) => handoff.includes(anchor))));
  assert.doesNotMatch(handoff, /Test-Path|raw Git probe|Terminal-State JSON/u);
  assert.doesNotMatch(handoff, /## Semantic coverage|## Terminal state|Session UUID/u);
  assert.match(handoff, new RegExp(INDEX_DIGEST, "u"));
});

test("AH5 v2 publication binds preflight, resolves every key, and delivers synthesize-first consumption", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ah5-publish-"));
  try {
    const workflow = await prepareActionReadyPublication(root);
    const candidate = actionReadyReducedCandidate(workflow);
    assert.throws(
      () => attachEvidenceKeyMap(workflow.pack.evidenceIndex, {
        formatVersion: 1,
        kind: "codex-handoff-evidence-key-map",
        entries: [{
          key: "E1",
          claimId: "claim-ah5-invalid",
          anchors: ["anchor-missing"],
        }],
      }),
      { code: "INVALID_EVIDENCE_INDEX" },
    );
    await writeJson(workflow.reduce.reducedPath, candidate);

    await assert.rejects(
      publishHandoff(workflow.prepared.workDir, { keepWorkdir: true }),
      { code: "REDUCE_NOT_CHECKED" },
    );
    const checked = await checkReduceStage(workflow.prepared.workDir);
    candidate.compressionNotes.push("mutation after action-ready preflight");
    await writeJson(workflow.reduce.reducedPath, candidate);
    await assert.rejects(
      publishHandoff(workflow.prepared.workDir, { keepWorkdir: true }),
      { code: "REDUCE_RESULT_CHANGED" },
    );
    candidate.compressionNotes = [];
    await writeJson(workflow.reduce.reducedPath, candidate);

    const published = await publishHandoff(
      workflow.prepared.workDir,
      { keepWorkdir: true },
      { verifyEvidenceIndex: async () => ({ valid: true }) },
    );
    const handoff = await fs.promises.readFile(workflow.prepared.outputPath, "utf8");
    const evidenceIndex = validateEvidenceIndex(JSON.parse(await fs.promises.readFile(
      workflow.prepared.evidenceIndexPath,
      "utf8",
    )));

    assert.equal(published.reducePreflightDigest, checked.reducedDigest);
    assertExecutionOrder(handoff);
    assert.ok(handoff.includes(FLOW_FINDING));
    assert.ok(handoff.includes(COMPLEXITY_FINDING));
    assert.ok(handoff.includes(EXPECTED_EXCLUSION_CLAUSE));
    assert.doesNotMatch(
      handoff,
      /Test-Path|read_file|Terminal-State JSON|## Semantic coverage|## Preservation coverage/u,
    );
    assert.ok(evidenceIndex.evidenceKeyMap.entries.length > 0);
    const keys = new Set(evidenceIndex.evidenceKeyMap.entries.map((entry) => entry.key));
    const renderedKeys = new Set(handoff.match(/\bE[1-9][0-9]*\b/gu) || []);
    assert.ok(renderedKeys.size > 0);
    assert.ok([...renderedKeys].every((key) => keys.has(key)));
    const knownAnchors = new Set(
      evidenceIndex.anchors.map((entry) => entry.anchor.anchorId),
    );
    assert.ok(evidenceIndex.evidenceKeyMap.entries.every((entry) => (
      entry.claimId && entry.anchors.length > 0 &&
      entry.anchors.every((anchorId) => knownAnchors.has(anchorId))
    )));
    assert.deepEqual(published.consumerContract, {
      formatVersion: 1,
      kind: "codex-handoff-synthesize-first-consumer-contract",
      mode: "synthesize_first",
      firstDeliverableIds: ["flow-explanation"],
      preDraftEvidenceReads: 0,
      maxTargetedReads: 2,
      allowedReadReasons: ["claim_verification", "named_uncertainty"],
      forbidBroadSearch: true,
      forbidFullFileReread: true,
    });
    assert.match(published.suggestedContinuation, /before any Evidence Index read/u);
    assert.match(published.suggestedContinuation, /at most 2 targeted reads/u);
    assert.match(published.suggestedContinuation, /no broad search or full-file reread/u);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
