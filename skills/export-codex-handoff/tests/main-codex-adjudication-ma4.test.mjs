import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPreservationLedger,
  createEvidenceEntry,
  hashFileRevision,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import {
  inspectAdjudication,
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  submitAdjudicationDecision,
  validateFrameStage,
  validateMapStage,
} from "../scripts/lib/task-workflow.mjs";
import { sparseFromFullMapResult } from "./fixtures/sparse-map-fixtures.mjs";

const CLI_PATH = fileURLToPath(new URL("../scripts/export-handoff.mjs", import.meta.url));
const SESSION_ID = "00000000-0000-7000-8000-000000000400";
const TURN_ID = "00000000-0000-7000-8000-000000000401";
const EXACT_GOAL = "Implement MA4 exactly.\nPreserve this byte-exact goal: <MA4> & [evidence].";
const ACCEPTED_WORK = "Retain this accepted MAP fact in a degraded publication.";
const UNVERIFIED_REDUCE_SENTINEL = "MA4-UNVERIFIED-REDUCE-MUST-NOT-PUBLISH";
const UNVERIFIED_NORMAL_SENTINEL = "MA4-OVERSIZED-NORMAL-RESULT-MUST-NOT-PUBLISH";

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(target) {
  return JSON.parse(await fs.promises.readFile(target, "utf8"));
}

async function evidencePack(root) {
  const rolloutPath = path.join(root, "source-thread.jsonl");
  const record = {
    turnId: TURN_ID,
    payload: { content: [{ type: "input_text", text: EXACT_GOAL }] },
  };
  await fs.promises.writeFile(rolloutPath, `${JSON.stringify(record)}\n`, "utf8");
  const revision = await hashFileRevision(rolloutPath);
  const entry = createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: revision.sourceRevision,
    turnId: TURN_ID,
    eventOrdinal: 1,
    rolloutLine: 1,
    payloadPath: "/payload/content/0/text",
    value: EXACT_GOAL,
    locator: { kind: "rollout_payload" },
  });
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath,
    sourceChars: revision.sourceChars,
    sourceBytes: revision.sourceBytes,
    sourceRevision: revision.sourceRevision,
    session: {
      id: SESSION_ID,
      cwd: root,
      startedAt: "2026-08-12T00:00:00.000Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: root,
    observedAt: "2026-08-12T00:01:00.000Z",
    sourceRevision: null,
    observationAnchors: [],
    checkpoint: { status: "missing" },
    git: { status: "not_repository" },
  };
  const turns = [{
    turnId: TURN_ID,
    userMessages: [{ text: EXACT_GOAL, anchors: [entry.anchor.anchorId] }],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
  }];
  const preservationLedger = buildPreservationLedger(
    revision.sourceRevision,
    [entry],
  );
  const terminalStateClaim = {
    claimId: "claim-ma4-terminal-state",
    kind: "terminal_state",
    text: "Synthetic Source Thread stopped before completing MA4; workspace observation was available.",
    anchors: [entry.anchor.anchorId],
  };
  const pack = {
    formatVersion: 1,
    source,
    turns,
    ignoredEvents: {},
    workspace,
    evidenceAnchors: [entry.anchor],
    preservationLedger,
    sourceContinuation: {
      currentGoal: {
        timestamp: "2026-08-12T00:00:01.000Z",
        text: EXACT_GOAL,
        anchors: [entry.anchor.anchorId],
        source: null,
      },
      acceptedProposal: null,
      terminalEvidence: {
        turnId: TURN_ID,
        startedAt: "2026-08-12T00:00:00.000Z",
        terminatedAt: "2026-08-12T00:00:02.000Z",
        status: "aborted",
        abortReason: "synthetic MA4 fixture",
        terminationAnchors: [entry.anchor.anchorId],
        lastAssistant: null,
        orderedEvents: [],
      },
    },
    terminalState: {
      formatVersion: 1,
      sourceTerminal: {
        turnId: TURN_ID,
        status: "aborted",
      },
      workspaceObserved: {
        observedAt: workspace.observedAt,
        gitStatus: "not_repository",
      },
    },
    terminalStateClaim,
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source,
    workspace,
    entries: [entry],
    preservationLedger,
  });
  return {
    ...pack,
    evidenceChars: JSON.stringify(pack).length,
    evidenceIndex,
    entry,
  };
}

async function prepareWorkflow(root, options = {}) {
  const pack = await evidencePack(root);
  const outputPath = options.outputPath || path.join(root, "published", "handoff.md");
  const evidenceIndexPath = options.evidenceIndexPath ||
    path.join(root, "published", "handoff.evidence.json");
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath,
    evidenceIndexPath,
    workRoot: path.join(root, "work"),
    maxChars: options.maxChars || 12_000,
    maxChunkChars: 40_000,
  }, { buildEvidencePack: async () => pack });
  return { pack, prepared };
}

function sparseMapCandidate(segment, binding, pack) {
  const anchorId = pack.entry.anchor.anchorId;
  return sparseFromFullMapResult({
    frameId: binding.frameId,
    frameDigest: binding.frameDigest,
    segmentId: segment.segmentId,
    turnCoverage: [{
      turnId: TURN_ID,
      status: "summarized",
      claimIds: ["claim-ma4-accepted-work"],
      reason: "Retained by the accepted MA4 MAP fixture.",
    }],
    objectiveFacts: [{
      claimId: "claim-ma4-accepted-work",
      kind: "objective",
      text: ACCEPTED_WORK,
      anchors: [anchorId],
    }],
    userConstraints: [],
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: [],
    conflicts: [],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    compressionNotes: [],
  });
}

async function prepareAcceptedMap(workflow) {
  const frameStage = await prepareFrameStage(workflow.prepared.workDir);
  const frameInput = await readJson(frameStage.frameInputPath);
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
  const binding = await validateFrameStage(workflow.prepared.workDir);
  const segment = binding.segments[0];
  await writeJson(
    segment.summaryPath,
    sparseMapCandidate(segment, binding, workflow.pack),
  );
  await validateMapStage(workflow.prepared.workDir, segment.segmentId);
  return { binding: { ...binding, frame }, segment };
}

function reduceCandidate(workflow, binding, directive) {
  const anchorId = workflow.pack.entry.anchor.anchorId;
  return {
    frameId: binding.frameId,
    frameDigest: binding.frameDigest,
    continuationDirective: directive,
    objective: {
      goal: binding.frame.currentGoal.text,
      explicitExclusions: binding.frame.explicitExclusions.map(({ text }) => text),
    },
    constraints: [],
    workspaceState: {
      summary: {
        claimId: "claim-ma4-workspace",
        kind: "workspace_state",
        text: "The synthetic MA4 workspace was available at capture time.",
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
        reason: `No retained ${category} evidence in the MA4 fixture.`,
      }),
    ),
    provenance: { notes: [] },
    compressionNotes: [],
  };
}

function assertCaptured(processResult, expectedCode) {
  assert.equal(processResult.status, 1);
  const error = JSON.parse(processResult.stderr);
  assert.equal(error.code, expectedCode);
  assert.equal(error.details.adjudication.lifecycleState, "AWAITING_ADJUDICATION");
}

async function submitDegradedDecision(workflow) {
  const awaiting = await inspectAdjudication(workflow.prepared.workDir);
  assert.equal(awaiting.lifecycleState, "AWAITING_ADJUDICATION");
  return submitAdjudicationDecision(workflow.prepared.workDir, {
    runId: awaiting.runId,
    requestId: awaiting.activeRequest.requestId,
    requestDigest: awaiting.activeRequest.requestDigest,
    action: { type: "publish_degraded" },
    rationale: "Publish only the verified MA4 subset and preserve the unresolved diagnostic.",
  });
}

async function assertDegradedPublication(workflow, applied, expectedDiagnostic) {
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.lifecycleState, "PUBLISHED");
  assert.equal(result.applied, true);
  assert.equal(result.result.effect, "degraded_handoff_published");
  assert.equal(result.result.publicationState, "PUBLISHED");
  assert.equal(result.result.outputPath, workflow.prepared.outputPath);
  assert.equal(result.result.evidenceIndexPath, workflow.prepared.evidenceIndexPath);

  const handoff = await fs.promises.readFile(workflow.prepared.outputPath, "utf8");
  assert.match(handoff, /^# Degraded Codex Handoff/mu);
  assert.equal(handoff.includes(EXACT_GOAL), true);
  assert.equal(handoff.includes(expectedDiagnostic), true);
  assert.equal(
    handoff.includes(result.activeRequest.request.diagnostic.message),
    true,
  );
  assert.equal(handoff.includes("Synthetic Source Thread stopped before completing MA4"), true);
  assert.equal(handoff.includes("does not claim normal completion"), true);

  const evidenceIndex = await readJson(workflow.prepared.evidenceIndexPath);
  assert.equal(evidenceIndex.kind, "codex-handoff-evidence-index");
  assert.match(evidenceIndex.integrity.indexDigest, /^[0-9a-f]{64}$/u);
  const verified = runCli(["verify-evidence", workflow.prepared.evidenceIndexPath]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).valid, true);
  return { result, handoff, evidenceIndex };
}

test("MA4 publishes a verifiable Degraded Handoff before MAP", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma4-before-map-"));
  try {
    const workflow = await prepareWorkflow(root);
    const legacyContract = await readJson(workflow.prepared.adjudicationContractPath);
    legacyContract.lifecycleStates = [
      "RUNNING",
      "AWAITING_ADJUDICATION",
      "APPLYING_ADJUDICATION",
    ];
    await writeJson(workflow.prepared.adjudicationContractPath, legacyContract);
    const captured = runCli(["validate-frame", workflow.prepared.workDir]);
    assertCaptured(captured, "FRAME_INPUT_MISSING");
    await submitDegradedDecision(workflow);

    const publication = await assertDegradedPublication(
      workflow,
      runCli(["adjudicate", workflow.prepared.workDir, "--apply"]),
      "FRAME_INPUT_MISSING",
    );
    assert.equal(publication.result.result.acceptedMaps, 0);
    assert.match(publication.handoff, /Accepted MAP work[\s\S]*unavailable/iu);

    const publishedState = await inspectAdjudication(workflow.prepared.workDir);
    const eventCount = publishedState.eventChain.eventCount;
    const handoffBytes = await fs.promises.readFile(workflow.prepared.outputPath);
    const indexBytes = await fs.promises.readFile(workflow.prepared.evidenceIndexPath);
    const replay = runCli(["adjudicate", workflow.prepared.workDir, "--apply"]);
    assert.equal(replay.status, 0, replay.stderr);
    const replayed = JSON.parse(replay.stdout);
    assert.equal(replayed.applied, false);
    assert.equal(replayed.lifecycleState, "PUBLISHED");
    assert.deepEqual(replayed.result, publication.result.result);
    assert.equal(replayed.eventChain.eventCount, eventCount);
    assert.deepEqual(await fs.promises.readFile(workflow.prepared.outputPath), handoffBytes);
    assert.deepEqual(
      await fs.promises.readFile(workflow.prepared.evidenceIndexPath),
      indexBytes,
    );

    const gated = runCli(["prepare-frame", workflow.prepared.workDir]);
    assert.equal(gated.status, 1);
    assert.equal(JSON.parse(gated.stderr).code, "COMPRESSION_RUN_PUBLISHED");
    assert.equal(
      (await inspectAdjudication(workflow.prepared.workDir)).eventChain.eventCount,
      eventCount,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA4 retains verified accepted MAP work after receipt acceptance", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma4-after-map-"));
  try {
    const workflow = await prepareWorkflow(root);
    const { segment } = await prepareAcceptedMap(workflow);
    const manifest = await readJson(workflow.prepared.manifestPath);
    const accepted = manifest.segments.find(({ segmentId }) => (
      segmentId === segment.segmentId
    ));
    const captured = runCli([
      "validate-map",
      workflow.prepared.workDir,
      segment.segmentId,
      "--accept",
      accepted.dispatch.dispatchId,
    ]);
    assertCaptured(captured, "DUPLICATE_MAP_RECEIPT");
    await submitDegradedDecision(workflow);

    const publication = await assertDegradedPublication(
      workflow,
      runCli(["adjudicate", workflow.prepared.workDir, "--apply"]),
      "DUPLICATE_MAP_RECEIPT",
    );
    assert.equal(publication.result.result.acceptedMaps, 1);
    assert.equal(publication.handoff.includes(ACCEPTED_WORK), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA4 omits an invalid REDUCE candidate and publishes its exact diagnostic", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma4-reduce-"));
  try {
    const workflow = await prepareWorkflow(root);
    await prepareAcceptedMap(workflow);
    const reduce = await prepareReduceStage(workflow.prepared.workDir);
    await writeJson(reduce.reducedPath, { marker: UNVERIFIED_REDUCE_SENTINEL });
    const captured = runCli([
      "validate-reduce",
      workflow.prepared.workDir,
      "--check",
    ]);
    assertCaptured(captured, "FRAME_ID_MISMATCH");
    await submitDegradedDecision(workflow);

    const publication = await assertDegradedPublication(
      workflow,
      runCli(["adjudicate", workflow.prepared.workDir, "--apply"]),
      "FRAME_ID_MISMATCH",
    );
    assert.equal(publication.handoff.includes(UNVERIFIED_REDUCE_SENTINEL), false);
    assert.match(publication.handoff, /normal REDUCE result[\s\S]*omitted/iu);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA4 replaces an oversized normal publication with a bounded degraded pair", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma4-publication-"));
  try {
    const workflow = await prepareWorkflow(root, { maxChars: 4_000 });
    const { binding } = await prepareAcceptedMap(workflow);
    const reduce = await prepareReduceStage(workflow.prepared.workDir);
    await writeJson(
      reduce.reducedPath,
      reduceCandidate(
        workflow,
        binding,
        `${UNVERIFIED_NORMAL_SENTINEL}:${"z".repeat(5_000)}`,
      ),
    );
    const captured = runCli(["publish", workflow.prepared.workDir, "--keep-workdir"]);
    assertCaptured(captured, "OUTPUT_TOO_LARGE");
    await submitDegradedDecision(workflow);

    const publication = await assertDegradedPublication(
      workflow,
      runCli(["adjudicate", workflow.prepared.workDir, "--apply"]),
      "OUTPUT_TOO_LARGE",
    );
    assert.equal(publication.handoff.includes(UNVERIFIED_NORMAL_SENTINEL), false);
    assert.ok(publication.handoff.length <= 4_000);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA4 rebuilds an explicit adjudication-only index when Source evidence changed", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma4-subset-"));
  try {
    const workflow = await prepareWorkflow(root);
    await fs.promises.appendFile(
      workflow.pack.source.rolloutPath,
      `${JSON.stringify({ type: "source_changed_after_prepare" })}\n`,
      "utf8",
    );
    const captured = runCli(["validate-frame", workflow.prepared.workDir]);
    assertCaptured(captured, "FRAME_INPUT_MISSING");
    await submitDegradedDecision(workflow);

    const applied = runCli(["adjudicate", workflow.prepared.workDir, "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.lifecycleState, "PUBLISHED");
    assert.equal(result.result.evidenceScope, "verified subset: adjudication only");
    assert.equal(result.result.retainedAnchors, 0);
    assert.equal(result.result.omittedAnchors, 1);

    const handoff = await fs.promises.readFile(workflow.prepared.outputPath, "utf8");
    assert.match(handoff, /Current goal[\s\S]*Status: unavailable/iu);
    assert.equal(handoff.includes(EXACT_GOAL), false);
    assert.match(handoff, /Evidence Index anchors: 1 anchor\(s\) omitted after SOURCE_CHANGED/iu);
    const index = await readJson(workflow.prepared.evidenceIndexPath);
    assert.deepEqual(index.anchors, []);
    const verified = runCli(["verify-evidence", workflow.prepared.evidenceIndexPath]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).anchors, 0);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA4 never publishes a mutated Evidence Pack goal as verified", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma4-mutated-pack-"));
  try {
    const workflow = await prepareWorkflow(root);
    const packPath = path.join(workflow.prepared.workDir, "evidence-pack.json");
    const mutated = await readJson(packPath);
    mutated.sourceContinuation.currentGoal.text = "MA4-FABRICATED-GOAL-MUST-NOT-PUBLISH";
    await writeJson(packPath, mutated);
    const captured = runCli(["validate-frame", workflow.prepared.workDir]);
    assertCaptured(captured, "FRAME_INPUT_MISSING");
    await submitDegradedDecision(workflow);

    const applied = runCli(["adjudicate", workflow.prepared.workDir, "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.lifecycleState, "PUBLISHED");
    assert.equal(result.result.evidenceScope, "complete");
    const handoff = await fs.promises.readFile(workflow.prepared.outputPath, "utf8");
    assert.match(handoff, /Current goal[\s\S]*Status: unavailable/iu);
    assert.equal(handoff.includes("MA4-FABRICATED-GOAL-MUST-NOT-PUBLISH"), false);
    assert.equal(handoff.includes(EXACT_GOAL), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA4 degraded pair failure rolls back and activates one linked successor", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma4-rollback-"));
  try {
    const blockedParent = path.join(root, "blocked-parent");
    const workflow = await prepareWorkflow(root, {
      evidenceIndexPath: path.join(blockedParent, "handoff.evidence.json"),
    });
    const captured = runCli(["validate-frame", workflow.prepared.workDir]);
    assertCaptured(captured, "FRAME_INPUT_MISSING");
    const applying = await submitDegradedDecision(workflow);
    const predecessor = applying.activeRequest;
    await fs.promises.writeFile(blockedParent, "not a directory", "utf8");

    const failedApply = runCli(["adjudicate", workflow.prepared.workDir, "--apply"]);
    assert.equal(failedApply.status, 1);
    assert.equal(JSON.parse(failedApply.stderr).code, "PUBLICATION_FAILED");
    await assert.rejects(fs.promises.access(workflow.prepared.outputPath), { code: "ENOENT" });
    assert.equal(await fs.promises.readFile(blockedParent, "utf8"), "not a directory");

    const failed = await inspectAdjudication(workflow.prepared.workDir);
    assert.equal(failed.lifecycleState, "AWAITING_ADJUDICATION");
    assert.equal(failed.requests.length, 2);
    assert.equal(failed.requests[0].requestId, predecessor.requestId);
    assert.equal(failed.requests[0].status, "APPLICATION_FAILED");
    assert.deepEqual(failed.activeRequest.request.predecessor, {
      requestId: predecessor.requestId,
      decisionId: predecessor.decisionId,
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
