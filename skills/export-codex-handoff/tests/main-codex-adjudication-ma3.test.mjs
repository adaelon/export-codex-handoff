import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPreservationLedger,
  canonicalStringify,
  createEvidenceEntry,
  sha256Text,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import {
  createAdjudicationRequest,
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
const SESSION_ID = "00000000-0000-7000-8000-000000000300";
const TURN_ID = "00000000-0000-7000-8000-000000000301";
const SOURCE_REVISION = `sha256:${"3".repeat(64)}`;
const MULTI_TURN_IDS = ["turn-ma3-1", "turn-ma3-2", "turn-ma3-3"];

function evidencePack() {
  const text = "Exercise Main Codex decision application.";
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
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/main-codex-adjudication-ma3.jsonl",
    sourceChars: text.length,
    sourceBytes: text.length,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/main-codex-adjudication-ma3",
      startedAt: "2026-08-12T00:00:00.000Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: source.session.cwd,
    checkpoint: { status: "missing" },
    git: { status: "not_repository" },
  };
  const turns = [{
    turnId: TURN_ID,
    userMessages: [{ text, anchors: [entry.anchor.anchorId] }],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
  }];
  const preservationLedger = buildPreservationLedger(SOURCE_REVISION, [entry]);
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

async function prepareWorkflow(root) {
  return prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    evidenceIndexPath: path.join(root, "handoff.evidence.json"),
    workRoot: root,
  }, { buildEvidencePack: async () => evidencePack() });
}

function multiSegmentEvidencePack() {
  const entries = MULTI_TURN_IDS.map((turnId, index) => createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId,
    eventOrdinal: index + 1,
    rolloutLine: index + 1,
    payloadPath: "/payload/content",
    value: [{
      type: "input_text",
      text: `Exercise MA3 generation ${index} ${"x".repeat(2_500)}`,
    }],
    locator: { kind: "rollout_payload" },
  }));
  const preservationLedger = buildPreservationLedger(SOURCE_REVISION, entries);
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/main-codex-adjudication-ma3-multi.jsonl",
    sourceChars: 120_000,
    sourceBytes: 120_000,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/main-codex-adjudication-ma3-multi",
      startedAt: "2026-08-12T00:00:00.000Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: source.session.cwd,
    checkpoint: { status: "missing" },
    git: { status: "not_repository" },
  };
  const turns = MULTI_TURN_IDS.map((turnId, index) => ({
    turnId,
    userMessages: [{
      text: `Exercise MA3 generation ${index} ${"x".repeat(2_500)}`,
      anchors: [entries[index].anchor.anchorId],
    }],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
  }));
  const pack = {
    formatVersion: 1,
    source,
    turns,
    ignoredEvents: {},
    workspace,
    evidenceAnchors: entries.map((entry) => entry.anchor),
    preservationLedger,
  };
  return {
    ...pack,
    evidenceChars: JSON.stringify(pack).length,
    evidenceIndex: buildEvidenceIndex({
      sessionId: SESSION_ID,
      source,
      workspace,
      entries,
      preservationLedger,
    }),
  };
}

function anchorForTurn(pack, turnId) {
  return pack.turns.find((turn) => turn.turnId === turnId).userMessages[0].anchors[0];
}

function sparseMapCandidate(segment, binding, pack, marker) {
  const claims = segment.expectedTurnIds.map((turnId) => ({
    claimId: `ma3-${segment.segmentId}-${turnId}`,
    kind: "objective",
    text: marker,
    anchors: [anchorForTurn(pack, turnId)],
  }));
  return sparseFromFullMapResult({
    frameId: binding.frameId,
    frameDigest: binding.frameDigest,
    segmentId: segment.segmentId,
    turnCoverage: segment.expectedTurnIds.map((turnId) => ({
      turnId,
      status: "summarized",
      claimIds: [`ma3-${segment.segmentId}-${turnId}`],
      reason: "captured by the MA3 generation fixture",
    })),
    objectiveFacts: claims,
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

async function prepareMultiMapWorkflow(root) {
  const pack = multiSegmentEvidencePack();
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    evidenceIndexPath: path.join(root, "handoff.evidence.json"),
    workRoot: root,
    maxChunkChars: 4_000,
  }, { buildEvidencePack: async () => pack });
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
  const binding = await validateFrameStage(prepared.workDir);
  assert.ok(binding.segments.length >= 2, "fixture must expose unrelated MAP work");
  for (const [index, segment] of binding.segments.entries()) {
    await writeJson(
      segment.summaryPath,
      sparseMapCandidate(
        segment,
        binding,
        pack,
        index === 0 ? "MA3 superseded generation" : `MA3 unrelated generation ${index}`,
      ),
    );
    await validateMapStage(prepared.workDir, segment.segmentId);
  }
  return { pack, prepared, binding };
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(target) {
  return JSON.parse(await fs.promises.readFile(target, "utf8"));
}

async function snapshotStageFiles(stage) {
  const snapshot = {};
  for (const [field, target] of Object.entries(stage)) {
    if (typeof target !== "string" || !field.endsWith("Path")) continue;
    snapshot[field] = await fs.promises.readFile(target);
  }
  return snapshot;
}

async function assertStageFiles(stage, expected) {
  for (const [field, bytes] of Object.entries(expected)) {
    assert.deepEqual(await fs.promises.readFile(stage[field]), bytes);
  }
}

async function filesContaining(root, sentinel) {
  const matches = [];
  async function visit(current) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if ((await fs.promises.readFile(target, "utf8")).includes(sentinel)) {
        matches.push(target);
      }
    }
  }
  await visit(root);
  return matches.sort();
}

async function directorySnapshot(root) {
  const output = {};
  async function visit(current, relative) {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(target, name);
      else output[name] = await fs.promises.readFile(target, "utf8");
    }
  }
  await visit(root, "");
  return output;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
}

async function submitDecision(prepared, request, action) {
  const running = await inspectAdjudication(prepared.workDir);
  const awaiting = await createAdjudicationRequest(prepared.workDir, {
    phase: request.phase,
    failureOwner: request.failureOwner,
    diagnostic: request.diagnostic,
    artifact: request.artifact,
    immutableDigests: {
      contractDigest: running.contract.contractDigest,
      ...(request.immutableDigests || {}),
    },
    acceptedWork: request.acceptedWork || { acceptedMaps: 0, acceptedReceipts: 0 },
    allowedActions: request.allowedActions,
  });
  return submitAdjudicationDecision(prepared.workDir, {
    runId: awaiting.runId,
    requestId: awaiting.activeRequest.requestId,
    requestDigest: awaiting.activeRequest.requestDigest,
    action,
    rationale: "Apply the bounded MA3 recovery decision.",
  });
}

test("MA3 repair_stage apply resumes only validate-reduce and replays with zero writes", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-retry-"));
  try {
    const prepared = await prepareWorkflow(root);
    const applying = await submitDecision(prepared, {
      phase: "validate-reduce",
      failureOwner: "reduce-author",
      diagnostic: {
        code: "REDUCE_RESULT_INVALID",
        message: "The mutable REDUCE candidate must be corrected and checked again.",
      },
      artifact: {
        kind: "reduce_candidate",
        coordinates: { command: "validate-reduce", candidate: "reduced.json" },
      },
      allowedActions: ["repair_stage", "regenerate_stage"],
    }, { type: "repair_stage", phase: "validate-reduce" });
    assert.equal(applying.lifecycleState, "APPLYING_ADJUDICATION");
    await fs.promises.rm(
      path.join(prepared.workDir, "adjudication", "applications"),
      { recursive: true, force: true },
    );
    assert.equal(
      (await inspectAdjudication(prepared.workDir)).lifecycleState,
      "APPLYING_ADJUDICATION",
    );

    const first = runCli(["adjudicate", prepared.workDir, "--apply"]);
    assert.equal(first.status, 0, first.stderr);
    const applied = JSON.parse(first.stdout);
    assert.equal(applied.applied, true);
    assert.equal(applied.lifecycleState, "RUNNING");
    assert.deepEqual(applied.result.resume, {
      phase: "validate-reduce",
      command: ["validate-reduce", prepared.workDir, "--check"],
    });
    assert.equal(applied.activeRequest.status, "APPLIED");
    assert.equal(applied.application.result.effect, "directed_repair_applied");
    assert.equal(applied.applications.length, 1);
    assert.equal(applied.application.status, "APPLIED");
    assert.equal(
      typeof (await import("../scripts/lib/task-workflow.mjs")).applyAdjudicationDecision,
      "function",
    );

    const afterFirst = await directorySnapshot(prepared.workDir);
    const eventCount = applied.eventChain.eventCount;
    const replay = runCli(["adjudicate", prepared.workDir, "--apply"]);
    assert.equal(replay.status, 0, replay.stderr);
    const replayed = JSON.parse(replay.stdout);
    assert.equal(replayed.applied, false);
    assert.equal(replayed.lifecycleState, "RUNNING");
    assert.deepEqual(replayed.result, applied.result);
    assert.equal(replayed.eventChain.eventCount, eventCount);
    assert.deepEqual(await directorySnapshot(prepared.workDir), afterFirst);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA3 repair_stage restores the command contract for every repairable named phase", async (t) => {
  const cases = [
    { phase: "prepare-frame", coordinates: {}, suffix: ["prepare-frame"] },
    { phase: "validate-frame", coordinates: {}, suffix: ["validate-frame"] },
    { phase: "pre-dispatch", coordinates: {}, suffix: ["validate-frame"] },
    {
      phase: "validate-map",
      coordinates: { segmentId: "segment-ma3" },
      suffix: ["validate-map", "WORK_DIR", "segment-ma3"],
    },
    {
      phase: "validate-map-claim",
      coordinates: { segmentId: "segment-ma3", dispatchId: "dispatch-ma3" },
      suffix: [
        "validate-map",
        "WORK_DIR",
        "segment-ma3",
        "--claim",
        "dispatch-ma3",
        "--worker",
        "<WORKER_ID>",
      ],
    },
    {
      phase: "validate-map-check",
      coordinates: { segmentId: "segment-ma3", dispatchId: "dispatch-ma3" },
      suffix: [
        "validate-map",
        "WORK_DIR",
        "segment-ma3",
        "--check",
        "dispatch-ma3",
      ],
    },
    {
      phase: "validate-map-complete",
      coordinates: { segmentId: "segment-ma3", dispatchId: "dispatch-ma3" },
      suffix: [
        "validate-map",
        "WORK_DIR",
        "segment-ma3",
        "--complete",
        "dispatch-ma3",
      ],
    },
    {
      phase: "record-map-metric",
      coordinates: { segmentId: "segment-ma3", dispatchId: "dispatch-ma3" },
      suffix: [
        "record-map-metric",
        "WORK_DIR",
        "segment-ma3",
        "dispatch-ma3",
        "<OBSERVATION_FILE>",
      ],
    },
    {
      phase: "schedule-map",
      coordinates: { availableSlots: 3 },
      suffix: ["schedule-map", "WORK_DIR", "<AVAILABLE_SLOTS>"],
    },
    { phase: "prepare-reduce", coordinates: {}, suffix: ["prepare-reduce"] },
    {
      phase: "validate-reduce",
      coordinates: {},
      suffix: ["validate-reduce", "WORK_DIR", "--check"],
    },
    { phase: "publish", coordinates: {}, suffix: ["publish"] },
  ];

  for (const phaseCase of cases) {
    await t.test(phaseCase.phase, async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-phase-"));
      try {
        const prepared = await prepareWorkflow(root);
        await submitDecision(prepared, {
          phase: phaseCase.phase,
          failureOwner: "ma3-phase-owner",
          diagnostic: {
            code: "MA3_PHASE_RETRY",
            message: `Resume only ${phaseCase.phase}.`,
          },
          artifact: {
            kind: "phase-input",
            coordinates: phaseCase.coordinates,
          },
          allowedActions: ["repair_stage", "regenerate_stage"],
        }, { type: "repair_stage", phase: phaseCase.phase });

        const applied = runCli(["adjudicate", prepared.workDir, "--apply"]);
        assert.equal(applied.status, 0, applied.stderr);
        const result = JSON.parse(applied.stdout);
        const expected = phaseCase.suffix.map((entry) => (
          entry === "WORK_DIR" ? prepared.workDir : entry
        ));
        if (!phaseCase.suffix.includes("WORK_DIR")) expected.splice(1, 0, prepared.workDir);
        assert.deepEqual(result.result.resume, {
          phase: phaseCase.phase,
          command: expected,
        });
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("MA3 regenerate_stage archives the REDUCE generation before resuming its author", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-reduce-"));
  try {
    const prepared = await prepareWorkflow(root);
    const marker = "MA3-REDUCE-GENERATION-MUST-REMAIN-AUDITABLE";
    await writeJson(prepared.reducedPath, { marker, mutable: true });
    const candidateBytes = await fs.promises.readFile(prepared.reducedPath);
    await submitDecision(prepared, {
      phase: "validate-reduce",
      failureOwner: "reduce-author",
      diagnostic: {
        code: "REDUCE_RESULT_INVALID",
        message: "Regenerate the responsible REDUCE candidate.",
      },
      artifact: {
        kind: "reduce-result",
        coordinates: { candidatePath: prepared.reducedPath },
      },
      allowedActions: ["repair_stage", "regenerate_stage"],
    }, { type: "regenerate_stage", phase: "validate-reduce" });

    const applied = runCli(["adjudicate", prepared.workDir, "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.applied, true);
    assert.equal(result.lifecycleState, "RUNNING");
    assert.equal(result.activeRequest.status, "APPLIED");
    assert.equal(result.application.result.effect, "stage_regenerated");
    assert.deepEqual(result.result.resume, {
      phase: "validate-reduce",
      command: ["validate-reduce", prepared.workDir, "--check"],
    });
    await assert.rejects(fs.promises.access(prepared.reducedPath), { code: "ENOENT" });
    const archives = await filesContaining(prepared.workDir, marker);
    assert.equal(archives.length, 1);
    assert.notEqual(path.resolve(archives[0]), path.resolve(prepared.reducedPath));
    assert.deepEqual(await fs.promises.readFile(archives[0]), candidateBytes);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA3 prepare-frame regeneration clears the stale input binding before exact restoration", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-frame-input-"));
  try {
    const prepared = await prepareWorkflow(root);
    await prepareFrameStage(prepared.workDir);
    const original = await fs.promises.readFile(prepared.frameInputPath);
    const before = await readJson(prepared.manifestPath);
    assert.match(before.frameInputDigest, /^sha256:[0-9a-f]{64}$/);
    await submitDecision(prepared, {
      phase: "prepare-frame",
      failureOwner: "workflow-control-files",
      diagnostic: {
        code: "FRAME_INPUT_CHANGED",
        message: "Archive and deterministically restore the Frame input.",
      },
      artifact: {
        kind: "compression-frame-input",
        coordinates: { candidatePath: prepared.frameInputPath },
      },
      allowedActions: ["repair_stage", "regenerate_stage"],
    }, { type: "regenerate_stage", phase: "prepare-frame" });

    const applied = runCli(["adjudicate", prepared.workDir, "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.application.result.effect, "stage_regenerated");
    assert.match(
      result.application.result.archivedArtifact.archiveDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal((await readJson(prepared.manifestPath)).frameInputDigest, null);
    await assert.rejects(fs.promises.access(prepared.frameInputPath), { code: "ENOENT" });

    const restored = await prepareFrameStage(prepared.workDir);
    assert.equal(restored.frameInputDigest, before.frameInputDigest);
    assert.deepEqual(await fs.promises.readFile(prepared.frameInputPath), original);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA3 provider-observation regeneration preserves the accepted MAP generation", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-observation-"));
  try {
    const workflow = await prepareMultiMapWorkflow(root);
    const before = await fs.promises.readFile(workflow.prepared.manifestPath);
    const manifest = JSON.parse(before);
    const target = manifest.segments[0];
    await submitDecision(workflow.prepared, {
      phase: "record-map-metric",
      failureOwner: "host-ingress",
      diagnostic: {
        code: "MAP_GENERATION_OBSERVATION_MISMATCH",
        message: "Regenerate only the provider observation for this accepted dispatch.",
      },
      artifact: {
        kind: "provider-observation",
        coordinates: {
          segmentId: target.segmentId,
          dispatchId: target.dispatch.dispatchId,
        },
      },
      acceptedWork: {
        acceptedMaps: manifest.segments.length,
        acceptedReceipts: manifest.segments.length,
      },
      allowedActions: ["repair_stage", "regenerate_stage"],
    }, { type: "regenerate_stage", phase: "record-map-metric" });

    const applied = runCli(["adjudicate", workflow.prepared.workDir, "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.application.result.effect, "stage_regenerated");
    assert.equal(
      result.application.result.regeneratedArtifact,
      "provider-observation",
    );
    assert.deepEqual(result.result.resume, {
      phase: "record-map-metric",
      command: [
        "record-map-metric",
        workflow.prepared.workDir,
        target.segmentId,
        target.dispatch.dispatchId,
        "<OBSERVATION_FILE>",
      ],
    });
    assert.deepEqual(await fs.promises.readFile(workflow.prepared.manifestPath), before);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA3 accepted MAP regeneration supersedes only its generation and REDUCE reads the latest", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-map-"));
  try {
    const workflow = await prepareMultiMapWorkflow(root);
    const before = await readJson(workflow.prepared.manifestPath);
    const targetBefore = structuredClone(before.segments[0]);
    const unrelatedBefore = structuredClone(before.segments[1]);
    const targetFiles = await snapshotStageFiles(targetBefore);
    const unrelatedFiles = await snapshotStageFiles(unrelatedBefore);
    const receiptBytes = await fs.promises.readFile(targetBefore.receiptPath);
    await submitDecision(workflow.prepared, {
      phase: "validate-map-accept",
      failureOwner: "coordinator",
      diagnostic: {
        code: "CONFLICTING_ACCEPTED_MAP_RECEIPT",
        message: "Supersede only the responsible accepted MAP generation.",
      },
      artifact: {
        kind: "map-receipt",
        coordinates: {
          segmentId: targetBefore.segmentId,
          dispatchId: targetBefore.dispatch.dispatchId,
        },
      },
      immutableDigests: {
        receiptDigest: `sha256:${sha256Text(receiptBytes)}`,
      },
      acceptedWork: {
        acceptedMaps: before.segments.length,
        acceptedReceipts: before.segments.length,
      },
      allowedActions: ["repair_stage", "regenerate_stage"],
    }, { type: "regenerate_stage", phase: "validate-map-accept" });

    const applied = runCli(["adjudicate", workflow.prepared.workDir, "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.applied, true);
    assert.equal(result.lifecycleState, "RUNNING");
    assert.equal(result.application.result.effect, "map_generation_superseded");
    const after = await readJson(workflow.prepared.manifestPath);
    const targetAfter = after.segments.find(
      (segment) => segment.segmentId === targetBefore.segmentId,
    );
    const unrelatedAfter = after.segments.find(
      (segment) => segment.segmentId === unrelatedBefore.segmentId,
    );
    assert.equal(targetAfter.workerStatus, "pending");
    assert.notEqual(targetAfter.dispatch.dispatchId, targetBefore.dispatch.dispatchId);
    assert.notEqual(targetAfter.summaryPath, targetBefore.summaryPath);
    assert.notEqual(targetAfter.receiptPath, targetBefore.receiptPath);
    assert.notEqual(targetAfter.normalizedSummaryPath, targetBefore.normalizedSummaryPath);
    assert.deepEqual(unrelatedAfter, unrelatedBefore);
    assert.equal(after.supersededMapGenerations.length, 1);
    assert.equal(
      after.supersededMapGenerations[0].decisionId,
      result.activeRequest.decisionId,
    );
    assert.equal(
      after.supersededMapGenerations[0].supersedingDispatchId,
      targetAfter.dispatch.dispatchId,
    );
    assert.deepEqual(after.supersededMapGenerations[0].generation, targetBefore);
    assert.equal(
      result.application.result.supersededGenerationDigest,
      `sha256:${sha256Text(canonicalStringify(after.supersededMapGenerations[0]))}`,
    );
    await assertStageFiles(targetBefore, targetFiles);
    await assertStageFiles(unrelatedAfter, unrelatedFiles);

    await writeJson(
      targetAfter.summaryPath,
      sparseMapCandidate(
        targetAfter,
        workflow.binding,
        workflow.pack,
        "MA3 latest generation",
      ),
    );
    await validateMapStage(
      workflow.prepared.workDir,
      targetAfter.segmentId,
    );
    const reduce = await prepareReduceStage(workflow.prepared.workDir);
    const reduceInput = await fs.promises.readFile(reduce.reduceInputPath, "utf8");
    assert.equal(reduceInput.includes("MA3 latest generation"), true);
    assert.equal(reduceInput.includes("MA3 superseded generation"), false);
    await assertStageFiles(targetBefore, targetFiles);
    await assertStageFiles(unrelatedAfter, unrelatedFiles);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA3 MAP regeneration fails closed when the bound accepted receipt changed", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-map-digest-"));
  try {
    const workflow = await prepareMultiMapWorkflow(root);
    const before = await readJson(workflow.prepared.manifestPath);
    const target = before.segments[0];
    const receiptBytes = await fs.promises.readFile(target.receiptPath);
    await submitDecision(workflow.prepared, {
      phase: "validate-map-accept",
      failureOwner: "coordinator",
      diagnostic: {
        code: "CONFLICTING_ACCEPTED_MAP_RECEIPT",
        message: "Bind regeneration to the exact accepted MAP receipt.",
      },
      artifact: {
        kind: "map-receipt",
        coordinates: {
          segmentId: target.segmentId,
          dispatchId: target.dispatch.dispatchId,
        },
      },
      immutableDigests: {
        receiptDigest: `sha256:${sha256Text(receiptBytes)}`,
      },
      acceptedWork: {
        acceptedMaps: before.segments.length,
        acceptedReceipts: before.segments.length,
      },
      allowedActions: ["repair_stage", "regenerate_stage"],
    }, { type: "regenerate_stage", phase: "validate-map-accept" });
    await fs.promises.writeFile(
      target.receiptPath,
      `${receiptBytes.toString("utf8").trimEnd()} \n`,
      "utf8",
    );

    const applied = runCli(["adjudicate", workflow.prepared.workDir, "--apply"]);
    assert.equal(applied.status, 1);
    assert.equal(
      JSON.parse(applied.stderr).code,
      "ADJUDICATION_ARTIFACT_INTEGRITY_MISMATCH",
    );
    const failed = await inspectAdjudication(workflow.prepared.workDir);
    assert.equal(failed.lifecycleState, "AWAITING_ADJUDICATION");
    assert.equal(failed.requests[0].status, "APPLICATION_FAILED");
    assert.equal(failed.activeRequest.request.predecessor.requestId, failed.requests[0].requestId);
    assert.equal(
      (await readJson(workflow.prepared.manifestPath)).segments[0].dispatch.dispatchId,
      target.dispatch.dispatchId,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA3 relocate_publication rebinds a fresh pair without mutating its immutable contract", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-relocate-"));
  try {
    const prepared = await prepareWorkflow(root);
    const contractBefore = await fs.promises.readFile(
      prepared.adjudicationContractPath,
      "utf8",
    );
    const outputPath = path.join(root, "relocated", "handoff.md");
    const evidenceIndexPath = path.join(root, "relocated", "handoff.evidence.json");
    await submitDecision(prepared, {
      phase: "publish",
      failureOwner: "publisher",
      diagnostic: {
        code: "OUTPUT_EXISTS",
        message: "Relocate the publication pair without overwriting either target.",
      },
      artifact: {
        kind: "publication-pair",
        coordinates: {
          outputPath: prepared.outputPath,
          evidenceIndexPath: prepared.evidenceIndexPath,
        },
      },
      allowedActions: ["repair_stage", "regenerate_stage", "relocate_publication"],
    }, {
      type: "relocate_publication",
      outputPath,
      evidenceIndexPath,
    });

    const applied = runCli(["adjudicate", prepared.workDir, "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    assert.equal(result.applied, true);
    assert.equal(result.lifecycleState, "RUNNING");
    assert.equal(result.application.result.effect, "publication_relocated");
    assert.deepEqual(result.result.resume, {
      phase: "publish",
      command: ["publish", prepared.workDir],
    });
    const manifest = await readJson(prepared.manifestPath);
    assert.equal(manifest.outputPath, path.resolve(outputPath));
    assert.equal(manifest.evidenceIndexPath, path.resolve(evidenceIndexPath));
    assert.equal(
      await fs.promises.readFile(prepared.adjudicationContractPath, "utf8"),
      contractBefore,
    );
    await assert.rejects(fs.promises.access(outputPath), { code: "ENOENT" });
    await assert.rejects(fs.promises.access(evidenceIndexPath), { code: "ENOENT" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA3 relocation rejects targets inside the disposable work directory", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-relocate-inside-"));
  try {
    const prepared = await prepareWorkflow(root);
    const manifestBefore = await fs.promises.readFile(prepared.manifestPath);
    const outputPath = path.join(prepared.workDir, "published", "handoff.md");
    const evidenceIndexPath = path.join(
      prepared.workDir,
      "published",
      "handoff.evidence.json",
    );
    await submitDecision(prepared, {
      phase: "publish",
      failureOwner: "publisher",
      diagnostic: {
        code: "OUTPUT_EXISTS",
        message: "Choose a publication pair outside the disposable work directory.",
      },
      artifact: {
        kind: "publication-pair",
        coordinates: {
          outputPath: prepared.outputPath,
          evidenceIndexPath: prepared.evidenceIndexPath,
        },
      },
      allowedActions: ["repair_stage", "regenerate_stage", "relocate_publication"],
    }, {
      type: "relocate_publication",
      outputPath,
      evidenceIndexPath,
    });

    const applied = runCli(["adjudicate", prepared.workDir, "--apply"]);
    assert.equal(applied.status, 1);
    assert.equal(JSON.parse(applied.stderr).code, "INVALID_PUBLICATION_TARGET");
    assert.deepEqual(await fs.promises.readFile(prepared.manifestPath), manifestBefore);
    const failed = await inspectAdjudication(prepared.workDir);
    assert.equal(failed.lifecycleState, "AWAITING_ADJUDICATION");
    assert.equal(failed.requests[0].status, "APPLICATION_FAILED");
    await assert.rejects(fs.promises.access(outputPath), { code: "ENOENT" });
    await assert.rejects(fs.promises.access(evidenceIndexPath), { code: "ENOENT" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA3 relocation TOCTOU failure closes the predecessor and opens one linked successor", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-toctou-"));
  try {
    const prepared = await prepareWorkflow(root);
    const outputPath = path.join(root, "race", "handoff.md");
    const evidenceIndexPath = path.join(root, "race", "handoff.evidence.json");
    const applying = await submitDecision(prepared, {
      phase: "publish",
      failureOwner: "publisher",
      diagnostic: {
        code: "OUTPUT_EXISTS",
        message: "Select an initially free publication pair.",
      },
      artifact: {
        kind: "publication-pair",
        coordinates: {
          outputPath: prepared.outputPath,
          evidenceIndexPath: prepared.evidenceIndexPath,
        },
      },
      allowedActions: ["repair_stage", "regenerate_stage", "relocate_publication"],
    }, {
      type: "relocate_publication",
      outputPath,
      evidenceIndexPath,
    });
    const predecessor = applying.activeRequest;
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, "TOCTOU-WINNER-MUST-NOT-BE-OVERWRITTEN", "utf8");

    runCli(["adjudicate", prepared.workDir, "--apply"]);
    const failed = await inspectAdjudication(prepared.workDir);
    assert.equal(failed.lifecycleState, "AWAITING_ADJUDICATION");
    assert.equal(failed.eventChain.eventCount, 3);
    assert.equal(failed.applications.length, 1);
    assert.equal(failed.applications[0].application.status, "APPLICATION_FAILED");
    assert.equal(failed.requests.length, 2);
    assert.equal(failed.requests[0].requestId, predecessor.requestId);
    assert.equal(failed.requests[0].status, "APPLICATION_FAILED");
    assert.equal(failed.activeRequest.status, "AWAITING_ADJUDICATION");
    assert.deepEqual(failed.activeRequest.request.predecessor, {
      requestId: predecessor.requestId,
      decisionId: predecessor.decisionId,
    });
    assert.equal(failed.activeRequest.request.phase, "publish");
    assert.deepEqual(
      failed.activeRequest.request.allowedActions,
      ["repair_stage", "regenerate_stage", "relocate_publication"],
    );
    assert.equal(
      await fs.promises.readFile(outputPath, "utf8"),
      "TOCTOU-WINNER-MUST-NOT-BE-OVERWRITTEN",
    );
    await assert.rejects(fs.promises.access(evidenceIndexPath), { code: "ENOENT" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA3 repeat apply never replays an older success after a newer application failure", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma3-latest-failure-"));
  try {
    const prepared = await prepareWorkflow(root);
    await submitDecision(prepared, {
      phase: "validate-reduce",
      failureOwner: "reduce-author",
      diagnostic: {
        code: "REDUCE_RESULT_INVALID",
        message: "Create an earlier successful application.",
      },
      artifact: {
        kind: "reduce-result",
        coordinates: { command: "validate-reduce" },
      },
      allowedActions: ["repair_stage", "regenerate_stage"],
    }, { type: "repair_stage", phase: "validate-reduce" });
    assert.equal(
      runCli(["adjudicate", prepared.workDir, "--apply"]).status,
      0,
    );

    const outputPath = path.join(root, "newer-failure", "handoff.md");
    const evidenceIndexPath = path.join(root, "newer-failure", "handoff.evidence.json");
    await submitDecision(prepared, {
      phase: "publish",
      failureOwner: "publisher",
      diagnostic: {
        code: "OUTPUT_EXISTS",
        message: "Create a newer failed application.",
      },
      artifact: {
        kind: "publication-pair",
        coordinates: {
          outputPath: prepared.outputPath,
          evidenceIndexPath: prepared.evidenceIndexPath,
        },
      },
      allowedActions: ["repair_stage", "regenerate_stage", "relocate_publication"],
    }, {
      type: "relocate_publication",
      outputPath,
      evidenceIndexPath,
    });
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, "newer failure", "utf8");
    assert.equal(
      runCli(["adjudicate", prepared.workDir, "--apply"]).status,
      1,
    );
    const afterFailure = await inspectAdjudication(prepared.workDir);
    assert.equal(afterFailure.lifecycleState, "AWAITING_ADJUDICATION");
    const eventCount = afterFailure.eventChain.eventCount;

    const replay = runCli(["adjudicate", prepared.workDir, "--apply"]);
    assert.equal(replay.status, 1);
    assert.equal(
      JSON.parse(replay.stderr).code,
      "ADJUDICATION_DECISION_NOT_APPLYING",
    );
    const afterReplay = await inspectAdjudication(prepared.workDir);
    assert.equal(afterReplay.eventChain.eventCount, eventCount);
    assert.equal(afterReplay.activeRequest.requestId, afterFailure.activeRequest.requestId);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
