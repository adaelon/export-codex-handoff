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
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import {
  acceptMapReceipt,
  checkMapDispatch,
  claimMapDispatch,
  completeMapDispatch,
  createAdjudicationRequest,
  inspectAdjudication,
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  submitAdjudicationDecision,
  scheduleNextMapWave,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";

const CLI_PATH = fileURLToPath(new URL("../scripts/export-handoff.mjs", import.meta.url));
const SESSION_ID = "00000000-0000-7000-8000-000000000100";
const TURN_ID = "00000000-0000-7000-8000-000000000101";
const SOURCE_REVISION = `sha256:${"d".repeat(64)}`;
const CLI_SENTINEL = "PRIVATE-CLI-PARSE-SENTINEL";

const REPAIR_ACTIONS = [
  "repair_stage",
  "regenerate_stage",
];
const ACCEPT_ACTIONS = ["repair_stage", "regenerate_stage"];
const SCHEDULE_ACTIONS = ["repair_stage", "regenerate_stage"];
const PUBLISH_ACTIONS = [
  "repair_stage",
  "regenerate_stage",
  "relocate_publication",
];

function evidencePack() {
  const text = "Exercise all-stage Main Codex adjudication capture.";
  const entry = createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId: TURN_ID,
    eventOrdinal: 1,
    rolloutLine: 1,
    payloadPath: "/payload/content/0/text",
    value: text,
    locator: { kind: "rollout_payload" },
  });
  const turns = [{
    turnId: TURN_ID,
    userMessages: [{
      text,
      anchors: [entry.anchor.anchorId],
    }],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
  }];
  const preservationLedger = buildPreservationLedger(SOURCE_REVISION, [entry]);
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/main-codex-adjudication-ma2.jsonl",
    sourceChars: text.length,
    sourceBytes: text.length,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/main-codex-adjudication-ma2",
      startedAt: "2026-08-12T00:00:00.000Z",
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
    evidenceAnchors: [entry.anchor],
    preservationLedger,
  };
  return {
    ...pack,
    evidenceChars: JSON.stringify(pack).length,
    evidenceIndex: buildEvidenceIndex({
      sessionId: SESSION_ID,
      source,
      workspace,
      entries: [entry],
      preservationLedger,
    }),
  };
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function prepareWorkflow(root) {
  return prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    evidenceIndexPath: path.join(root, "handoff.evidence.json"),
    workRoot: root,
  }, { buildEvidencePack: async () => evidencePack() });
}

function assertAdjudicationDetails(error, state, expectedCode) {
  assert.equal(error.code, expectedCode);
  assert.deepEqual(error.details?.adjudication, {
    lifecycleState: state.lifecycleState,
    runId: state.runId,
    requestId: state.activeRequest.requestId,
    requestDigest: state.activeRequest.requestDigest,
    inspectionPath: state.activeRequest.documentPath,
    inspectCommand: [
      "adjudicate",
      path.dirname(state.contract.documentPath),
      "--inspect",
    ],
  });
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
}

async function noPublishedOutput(prepared) {
  await assert.rejects(fs.promises.access(prepared.outputPath), { code: "ENOENT" });
  await assert.rejects(fs.promises.access(prepared.evidenceIndexPath), { code: "ENOENT" });
}

const PHASE_CASES = [
  {
    name: "prepare-frame",
    phase: "prepare-frame",
    code: "WORKFLOW_FILE_MISSING",
    actions: REPAIR_ACTIONS,
    async setup(prepared) {
      await fs.promises.rm(path.join(prepared.workDir, "evidence-pack.json"), {
        force: true,
      });
    },
    args: (prepared) => ["prepare-frame", prepared.workDir],
  },
  {
    name: "validate-frame",
    phase: "validate-frame",
    code: "FRAME_INPUT_MISSING",
    actions: REPAIR_ACTIONS,
    args: (prepared) => ["validate-frame", prepared.workDir],
  },
  {
    name: "pre-dispatch budget",
    phase: "pre-dispatch",
    code: "LIVE_BUDGET_UNREACHABLE",
    actions: REPAIR_ACTIONS,
    manifestChanges: true,
    async setup(prepared) {
      const frameStage = await prepareFrameStage(prepared.workDir);
      const frameInput = JSON.parse(await fs.promises.readFile(
        frameStage.frameInputPath,
        "utf8",
      ));
      await writeJson(frameStage.framePath, {
        frameId: frameInput.expectedFrameId,
        currentGoal: frameInput.latestUserGoal,
        taskType: "implementation",
        taskPhase: "implementing",
        explicitExclusions: frameInput.explicitExclusions,
        preservationPolicy: frameInput.preservationPolicy,
        anchors: frameInput.requiredFrameAnchors,
      });
      const manifest = JSON.parse(await fs.promises.readFile(
        prepared.manifestPath,
        "utf8",
      ));
      manifest.createdAt = "2026-08-12T00:00:00.000Z";
      manifest.workflowDeadlineAt = "2026-08-12T00:10:00.000Z";
      manifest.frameValidatedAt = "2026-08-12T00:10:01.000Z";
      await writeJson(prepared.manifestPath, manifest);
      const bindingPath = path.join(prepared.workDir, "workflow-version.json");
      const binding = JSON.parse(await fs.promises.readFile(bindingPath, "utf8"));
      binding.createdAt = manifest.createdAt;
      binding.workflowDeadlineAt = manifest.workflowDeadlineAt;
      await writeJson(bindingPath, binding);
    },
    args: (prepared) => ["validate-frame", prepared.workDir],
  },
  {
    name: "validate-map --claim",
    phase: "validate-map-claim",
    code: "FRAME_NOT_VALIDATED",
    actions: REPAIR_ACTIONS,
    args: (prepared) => [
      "validate-map",
      prepared.workDir,
      prepared.segments[0].segmentId,
      "--claim",
      "dispatch-missing",
      "--worker",
      "ma2-worker",
    ],
  },
  {
    name: "validate-map --check",
    phase: "validate-map-check",
    code: "FRAME_NOT_VALIDATED",
    actions: REPAIR_ACTIONS,
    args: (prepared) => [
      "validate-map",
      prepared.workDir,
      prepared.segments[0].segmentId,
      "--check",
      "dispatch-missing",
    ],
  },
  {
    name: "validate-map --complete",
    phase: "validate-map-complete",
    code: "FRAME_NOT_VALIDATED",
    actions: REPAIR_ACTIONS,
    args: (prepared) => [
      "validate-map",
      prepared.workDir,
      prepared.segments[0].segmentId,
      "--complete",
      "dispatch-missing",
    ],
  },
  {
    name: "validate-map --accept",
    phase: "validate-map-accept",
    code: "FRAME_NOT_VALIDATED",
    actions: ACCEPT_ACTIONS,
    args: (prepared) => [
      "validate-map",
      prepared.workDir,
      prepared.segments[0].segmentId,
      "--accept",
      "dispatch-missing",
    ],
  },
  {
    name: "direct validate-map",
    phase: "validate-map",
    code: "MAP_DISPATCH_MISSING",
    actions: REPAIR_ACTIONS,
    args: (prepared) => [
      "validate-map",
      prepared.workDir,
      prepared.segments[0].segmentId,
    ],
  },
  {
    name: "record-map-metric",
    phase: "record-map-metric",
    code: "MAP_DISPATCH_MISSING",
    actions: REPAIR_ACTIONS,
    async setup(prepared, root) {
      prepared.observationPath = path.join(root, "observation.json");
      await writeJson(prepared.observationPath, {});
    },
    args: (prepared) => [
      "record-map-metric",
      prepared.workDir,
      prepared.segments[0].segmentId,
      "dispatch-missing",
      prepared.observationPath,
    ],
  },
  {
    name: "schedule-map",
    phase: "schedule-map",
    code: "MAP_DISPATCH_MISSING",
    actions: SCHEDULE_ACTIONS,
    args: (prepared) => ["schedule-map", prepared.workDir, "0"],
  },
  {
    name: "prepare-reduce",
    phase: "prepare-reduce",
    code: "FRAME_NOT_VALIDATED",
    actions: REPAIR_ACTIONS,
    args: (prepared) => ["prepare-reduce", prepared.workDir],
  },
  {
    name: "validate-reduce --check",
    phase: "validate-reduce",
    code: "REDUCE_NOT_PREPARED",
    actions: REPAIR_ACTIONS,
    args: (prepared) => ["validate-reduce", prepared.workDir, "--check"],
  },
  {
    name: "publish",
    phase: "publish",
    code: "FRAME_NOT_VALIDATED",
    actions: PUBLISH_ACTIONS,
    args: (prepared) => ["publish", prepared.workDir, "--keep-workdir"],
  },
];

test("MA2 captures every post-prepare phase once and gates its replay", async (t) => {
  for (const phaseCase of PHASE_CASES) {
    await t.test(phaseCase.name, async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma2-phase-"));
      try {
        const prepared = await prepareWorkflow(root);
        await phaseCase.setup?.(prepared, root);
        const contractBefore = await fs.promises.readFile(
          prepared.adjudicationContractPath,
          "utf8",
        );
        const manifestBefore = await fs.promises.readFile(prepared.manifestPath, "utf8");

        const first = runCli(phaseCase.args(prepared));
        assert.equal(first.status, 1, first.stderr);
        const firstError = JSON.parse(first.stderr);
        const firstState = await inspectAdjudication(prepared.workDir);
        assert.equal(firstState.lifecycleState, "AWAITING_ADJUDICATION");
        assert.equal(firstState.eventChain.eventCount, 1);
        assert.equal(firstState.requests.length, 1);
        assert.equal(firstState.activeRequest.request.phase, phaseCase.phase);
        assert.deepEqual(
          firstState.activeRequest.request.allowedActions,
          phaseCase.actions,
        );
        assert.equal(
          firstState.activeRequest.request.diagnostic.code,
          phaseCase.code,
        );
        assert.equal(
          firstState.activeRequest.request.artifact.coordinates.command,
          phaseCase.phase,
        );
        assert.equal(
          firstState.activeRequest.request.immutableDigests.contractDigest,
          firstState.contract.contractDigest,
        );
        assert.deepEqual(firstState.activeRequest.request.acceptedWork, {
          acceptedMaps: 0,
          acceptedReceipts: 0,
        });
        assertAdjudicationDetails(firstError, firstState, phaseCase.code);

        assert.equal(
          await fs.promises.readFile(prepared.adjudicationContractPath, "utf8"),
          contractBefore,
        );
        if (!phaseCase.manifestChanges) {
          assert.equal(
            await fs.promises.readFile(prepared.manifestPath, "utf8"),
            manifestBefore,
          );
        }
        await noPublishedOutput(prepared);

        const failureReportPath = path.join(prepared.workDir, "failure-report.json");
        const failureReport = await fs.promises.readFile(
          failureReportPath,
          "utf8",
        ).then(JSON.parse).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        assert.equal(
          failureReport?.kind,
          "codex-handoff-captured-workflow-diagnostic",
        );
        assert.equal(
          failureReport.adjudication.requestId,
          firstState.activeRequest.requestId,
        );

        const replay = runCli(phaseCase.args(prepared));
        assert.equal(replay.status, 1, replay.stderr);
        const replayError = JSON.parse(replay.stderr);
        const replayed = await inspectAdjudication(prepared.workDir);
        assert.equal(replayed.eventChain.eventCount, 1);
        assert.equal(
          replayed.activeRequest.requestId,
          firstState.activeRequest.requestId,
        );
        assertAdjudicationDetails(replayError, replayed, phaseCase.code);
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("MA2 retains accepted MAP artifacts when a later phase enters adjudication", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma2-retain-"));
  try {
    const prepared = await prepareWorkflow(root);
    const frameStage = await prepareFrameStage(prepared.workDir);
    const frameInput = JSON.parse(await fs.promises.readFile(
      frameStage.frameInputPath,
      "utf8",
    ));
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
    const anchorId = evidencePack().turns[0].userMessages[0].anchors[0];
    const claimId = "ma2-retained-map-claim";
    await claimMapDispatch(
      prepared.workDir,
      dispatch.segmentId,
      dispatch.dispatchId,
      "ma2-retention-worker",
    );
    await writeJson(dispatch.summaryPath, {
      formatVersion: 1,
      kind: "codex-handoff-sparse-map",
      frameId: validated.frameId,
      frameDigest: validated.frameDigest,
      segmentId: dispatch.segmentId,
      claims: [{
        claimId,
        kind: "objective",
        text: "Exercise all-stage Main Codex adjudication capture.",
        anchors: [anchorId],
      }],
      claimGroups: {
        objectiveFacts: [claimId],
        userConstraints: [],
        completedWork: [],
        openWork: [],
        nextActions: [],
        importantLocations: [],
        conflicts: [],
      },
      claimBindings: [{ claimId, evidenceIndexes: [0] }],
      exclusionRanges: [],
      archivalLedger: { decisions: [], attempts: [], verification: [] },
      compressionNotes: [],
    });
    await checkMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
    await completeMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
    await acceptMapReceipt(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
    await prepareReduceStage(prepared.workDir);

    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const stage = manifest.segments[0];
    const receiptBefore = await fs.promises.readFile(stage.receiptPath, "utf8");
    const summaryBefore = await fs.promises.readFile(stage.summaryPath, "utf8");
    const normalizedBefore = await fs.promises.readFile(
      stage.normalizedSummaryPath,
      "utf8",
    );

    const failed = runCli(["validate-reduce", prepared.workDir, "--check"]);
    assert.equal(failed.status, 1, failed.stderr);
    const error = JSON.parse(failed.stderr);
    const state = await inspectAdjudication(prepared.workDir);
    assert.equal(state.activeRequest.request.diagnostic.code, "WORKFLOW_FILE_MISSING");
    assert.deepEqual(state.activeRequest.request.acceptedWork, {
      acceptedMaps: 1,
      acceptedReceipts: 1,
    });
    assertAdjudicationDetails(error, state, "WORKFLOW_FILE_MISSING");
    assert.equal(await fs.promises.readFile(stage.receiptPath, "utf8"), receiptBefore);
    assert.equal(await fs.promises.readFile(stage.summaryPath, "utf8"), summaryBefore);
    assert.equal(
      await fs.promises.readFile(stage.normalizedSummaryPath, "utf8"),
      normalizedBefore,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA2 captures managed CLI parse errors without persisting the raw argument", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma2-cli-"));
  try {
    const prepared = await prepareWorkflow(root);
    const first = runCli([
      "validate-reduce",
      prepared.workDir,
      `--${CLI_SENTINEL}`,
    ]);
    assert.equal(first.status, 1);
    const firstError = JSON.parse(first.stderr);
    assert.equal(firstError.code, "INVALID_CLI_ARGUMENTS");
    const state = await inspectAdjudication(prepared.workDir);
    assert.equal(state.lifecycleState, "AWAITING_ADJUDICATION");
    assert.equal(state.eventChain.eventCount, 1);
    assert.equal(state.activeRequest.request.phase, "validate-reduce");
    assert.deepEqual(state.activeRequest.request.allowedActions, SCHEDULE_ACTIONS);
    assert.equal(
      state.activeRequest.request.artifact.kind,
      "cli_arguments",
    );
    assert.equal(
      (await fs.promises.readFile(state.activeRequest.documentPath, "utf8"))
        .includes(CLI_SENTINEL),
      false,
    );
    assert.equal(
      (await fs.promises.readFile(
        path.join(prepared.workDir, "failure-report.json"),
        "utf8",
      )).includes(CLI_SENTINEL),
      false,
    );

    const replay = runCli([
      "validate-reduce",
      prepared.workDir,
      `--${CLI_SENTINEL}`,
    ]);
    assert.equal(replay.status, 1);
    assert.equal(JSON.parse(replay.stderr).code, "INVALID_CLI_ARGUMENTS");
    const replayed = await inspectAdjudication(prepared.workDir);
    assert.equal(replayed.eventChain.eventCount, 1);
    assert.equal(replayed.activeRequest.requestId, state.activeRequest.requestId);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA2 replays the immutable contract when mutable manifest integrity fails", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma2-integrity-"));
  try {
    const prepared = await prepareWorkflow(root);
    await fs.promises.writeFile(prepared.manifestPath, "{broken-manifest", "utf8");

    const failed = runCli(["prepare-frame", prepared.workDir]);
    assert.equal(failed.status, 1, failed.stderr);
    const error = JSON.parse(failed.stderr);
    const state = await inspectAdjudication(prepared.workDir);
    assert.equal(state.lifecycleState, "AWAITING_ADJUDICATION");
    assert.equal(state.eventChain.eventCount, 1);
    assert.equal(state.activeRequest.request.phase, "prepare-frame");
    assert.equal(
      state.activeRequest.request.diagnostic.code,
      "INVALID_WORKFLOW_JSON",
    );
    assertAdjudicationDetails(error, state, "INVALID_WORKFLOW_JSON");

    const replay = runCli(["validate-frame", prepared.workDir]);
    assert.equal(replay.status, 1, replay.stderr);
    const replayed = await inspectAdjudication(prepared.workDir);
    assert.equal(replayed.eventChain.eventCount, 1);
    assert.equal(replayed.activeRequest.requestId, state.activeRequest.requestId);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA2 immutable contract prevents a mutable manifest v1 downgrade bypass", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma2-downgrade-"));
  try {
    const prepared = await prepareWorkflow(root);
    const manifest = JSON.parse(await fs.promises.readFile(
      prepared.manifestPath,
      "utf8",
    ));
    manifest.formatVersion = 1;
    await writeJson(prepared.manifestPath, manifest);

    const failed = runCli(["prepare-frame", prepared.workDir]);
    assert.equal(failed.status, 1, failed.stderr);
    const error = JSON.parse(failed.stderr);
    const state = await inspectAdjudication(prepared.workDir);
    assert.equal(state.lifecycleState, "AWAITING_ADJUDICATION");
    assert.equal(state.activeRequest.request.phase, "prepare-frame");
    assert.equal(
      state.activeRequest.request.diagnostic.code,
      "WORKFLOW_VERSION_MISMATCH",
    );
    assertAdjudicationDetails(error, state, "WORKFLOW_VERSION_MISMATCH");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA2 gates ordinary commands while a submitted decision awaits MA3 application", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma2-applying-"));
  try {
    const prepared = await prepareWorkflow(root);
    const running = await inspectAdjudication(prepared.workDir);
    const awaiting = await createAdjudicationRequest(prepared.workDir, {
      phase: "prepare-frame",
      failureOwner: "workflow-control-files",
      diagnostic: {
        code: "MA2_MANUAL_GATE",
        message: "Exercise the unapplied-decision gate.",
      },
      artifact: {
        kind: "compression_frame_input",
        coordinates: { command: "prepare-frame" },
      },
      immutableDigests: {
        contractDigest: running.contract.contractDigest,
      },
      acceptedWork: { acceptedMaps: 0, acceptedReceipts: 0 },
      allowedActions: SCHEDULE_ACTIONS,
    });
    const applying = await submitAdjudicationDecision(prepared.workDir, {
      runId: awaiting.runId,
      requestId: awaiting.activeRequest.requestId,
      requestDigest: awaiting.activeRequest.requestDigest,
      action: { type: "repair_stage", phase: "prepare-frame" },
      rationale: "Leave the valid decision unapplied until MA3.",
    });
    assert.equal(applying.lifecycleState, "APPLYING_ADJUDICATION");
    const manifestBefore = await fs.promises.readFile(prepared.manifestPath, "utf8");

    const failed = runCli(["prepare-frame", prepared.workDir]);
    assert.equal(failed.status, 1, failed.stderr);
    const error = JSON.parse(failed.stderr);
    const replayed = await inspectAdjudication(prepared.workDir);
    assert.equal(replayed.lifecycleState, "APPLYING_ADJUDICATION");
    assert.equal(replayed.eventChain.eventCount, 2);
    assert.equal(replayed.activeRequest.requestId, applying.activeRequest.requestId);
    assertAdjudicationDetails(error, replayed, "MA2_MANUAL_GATE");
    assert.equal(await fs.promises.readFile(prepared.manifestPath, "utf8"), manifestBefore);
    await assert.rejects(fs.promises.access(prepared.frameInputPath), { code: "ENOENT" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
