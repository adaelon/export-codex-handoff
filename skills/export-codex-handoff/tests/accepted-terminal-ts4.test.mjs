import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { CONTINUATION_MAP_RESULT_MODE } from "../scripts/lib/map-worker.mjs";
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
  ACCEPTED_ANALYZER_PROPOSAL,
  PROPOSAL_TURN_ID,
  TERMINAL_TURN_ID,
  acceptedTerminalEvidencePack,
  acceptedTerminalRolloutRecords,
} from "./fixtures/accepted-terminal-fixtures.mjs";

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function countExactString(value, target) {
  if (value === target) return 1;
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countExactString(item, target), 0);
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce(
      (total, item) => total + countExactString(item, target),
      0,
    );
  }
  return 0;
}

async function prepareAcceptedTerminalWorkflow(root) {
  const rolloutPath = path.join(root, "synthetic-rollout.jsonl");
  await fs.promises.writeFile(
    rolloutPath,
    `${acceptedTerminalRolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  const parsed = await parseSourceThread(rolloutPath);
  const pack = acceptedTerminalEvidencePack(parsed);
  const prepared = await prepareCompressionTask({
    sessionId: pack.source.sessionId,
    outputPath: path.join(root, "handoff.md"),
    evidenceIndexPath: path.join(root, "handoff.evidence.json"),
    workRoot: root,
    mapResultMode: CONTINUATION_MAP_RESULT_MODE,
  }, { buildEvidencePack: async () => pack });
  const frameStage = await prepareFrameStage(prepared.workDir);
  const frameInput = JSON.parse(await fs.promises.readFile(frameStage.frameInputPath, "utf8"));
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

  for (const dispatch of validated.mapDispatches) {
    const projection = JSON.parse(await fs.promises.readFile(dispatch.contextPath, "utf8"));
    assert.equal(projection.formatVersion, 3);
    assert.equal(projection.acceptedProposal.text, ACCEPTED_ANALYZER_PROPOSAL);
    assert.equal(projection.terminalStateClaim.kind, "terminal_state");
    await claimMapDispatch(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
      `worker-${dispatch.segmentId}`,
    );
    await writeJson(dispatch.summaryPath, {
      formatVersion: 1,
      kind: "codex-handoff-continuation-map",
      frameId: validated.frameId,
      frameDigest: validated.frameDigest,
      segmentId: dispatch.segmentId,
      claims: [],
      relations: { decisions: [], attempts: [], verification: [] },
      criticalExclusions: [],
    });
    await checkMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
    await completeMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
    await acceptMapReceipt(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
  }
  return { pack, prepared, frame, validated };
}

function reduceCandidate(workflow, reduceInput) {
  const acceptedProposal = reduceInput.claimTable.claims.find(
    (claim) => claim.kind === "accepted_proposal",
  );
  const terminalState = reduceInput.claimTable.claims.find(
    (claim) => claim.kind === "terminal_state",
  );
  const checkpointAnchor = workflow.pack.evidenceAnchors.find(
    (anchor) => anchor.payloadPath === "/checkpoint/content",
  ).anchorId;
  const gitAnchor = workflow.pack.evidenceAnchors.find(
    (anchor) => anchor.payloadPath === "/git/branchAndStatus",
  ).anchorId;
  return {
    frameId: workflow.validated.frameId,
    frameDigest: workflow.validated.frameDigest,
    continuationDirective: "Continue the accepted analyzer-policy fix from the terminal boundary.",
    objective: {
      goal: workflow.frame.currentGoal.text,
      explicitExclusions: workflow.frame.explicitExclusions.map((claim) => claim.text),
    },
    acceptedProposal,
    terminalState,
    constraints: [],
    workspaceState: {
      summary: {
        claimId: "workspace-ts4-current",
        kind: "workspace_state",
        text: "Compression-time Git is current file truth.",
        anchors: [gitAnchor],
      },
      evidenceStatus: "full",
      conflicts: [{
        claimId: "workspace-ts4-historical-conflict",
        kind: "conflict",
        text: "Historical checkpoint still names AA staging as open work.",
        anchors: [checkpointAnchor],
      }],
    },
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: [],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    preservationCoverage: [],
    provenance: { sourceTurnIds: [PROPOSAL_TURN_ID, TERMINAL_TURN_ID], notes: [] },
    compressionNotes: [],
  };
}

test("TS4 Frame v2 carries proposal and terminal authorities through publication", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ts4-workflow-"));
  try {
    const workflow = await prepareAcceptedTerminalWorkflow(root);
    assert.equal(workflow.prepared.frameContractVersion, 2);
    const binding = JSON.parse(await fs.promises.readFile(
      path.join(workflow.prepared.workDir, "workflow-version.json"),
      "utf8",
    ));
    assert.equal(binding.frameContractVersion, 2);

    const reducedStage = await prepareReduceStage(workflow.prepared.workDir);
    const reduceInputText = await fs.promises.readFile(reducedStage.reduceInputPath, "utf8");
    const reduceInput = JSON.parse(reduceInputText);
    const proposalClaims = reduceInput.claimTable.claims.filter(
      (claim) => claim.kind === "accepted_proposal",
    );
    const terminalClaims = reduceInput.claimTable.claims.filter(
      (claim) => claim.kind === "terminal_state",
    );
    assert.equal(proposalClaims.length, 1);
    assert.equal(terminalClaims.length, 1);
    assert.equal(proposalClaims[0].text, ACCEPTED_ANALYZER_PROPOSAL);
    assert.equal(countExactString(reduceInput, ACCEPTED_ANALYZER_PROPOSAL), 1);
    assert.equal(countExactString(reduceInput, terminalClaims[0].text), 1);
    assert.equal(
      reduceInput.deterministicProjectionPolicy.continuationAuthorities.terminalStateClaimId,
      terminalClaims[0].claimId,
    );
    const duplicatedTable = structuredClone(reduceInput.claimTable);
    duplicatedTable.claims.push({
      ...structuredClone(terminalClaims[0]),
      claimId: `${terminalClaims[0].claimId}-duplicate`,
    });
    assert.throws(
      () => buildContinuationReduceProjections(
        duplicatedTable,
        workflow.pack.preservationLedger,
        {
          claims: [proposalClaims[0], terminalClaims[0]],
          requireAcceptedProposal: true,
          requireTerminalState: true,
        },
      ),
      { code: "TERMINAL_STATE_CLAIM_INVALID" },
    );

    const valid = reduceCandidate(workflow, reduceInput);
    const missing = structuredClone(valid);
    delete missing.terminalState;
    await writeJson(reducedStage.reducedPath, missing);
    await assert.rejects(
      checkReduceStage(workflow.prepared.workDir),
      { code: "DETERMINISTIC_PROJECTION_MISMATCH" },
    );

    const mutated = structuredClone(valid);
    mutated.terminalState.anchors = [...mutated.acceptedProposal.anchors];
    await writeJson(reducedStage.reducedPath, mutated);
    await assert.rejects(
      checkReduceStage(workflow.prepared.workDir),
      { code: "DETERMINISTIC_PROJECTION_MISMATCH" },
    );

    await writeJson(reducedStage.reducedPath, valid);
    await checkReduceStage(workflow.prepared.workDir);
    const published = await publishHandoff(
      workflow.prepared.workDir,
      { keepWorkdir: true },
      { verifyEvidenceIndex: async () => ({ valid: true }) },
    );
    const handoff = await fs.promises.readFile(published.outputPath, "utf8");

    assert.match(handoff, /## Accepted proposal/);
    assert.ok(handoff.includes(ACCEPTED_ANALYZER_PROPOSAL));
    assert.match(handoff, /## Terminal state/);
    assert.ok(handoff.includes(valid.terminalState.text));
    assert.match(handoff, /Historical checkpoint still names AA staging as open work/);
    assert.ok(await fs.promises.stat(published.evidenceIndexPath));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
