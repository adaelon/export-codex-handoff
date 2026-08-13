import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildContinuationPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { CONTINUATION_MAP_RESULT_MODE } from "../scripts/lib/map-worker.mjs";
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
  scheduleNextMapWave,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";
import { REDUCE_DEFAULT_CATEGORIES } from "./fixtures/continuation-grade-fixtures.mjs";

const SESSION_ID = "00000000-0000-7000-8000-0000000000a5";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const CLI_PATH = path.resolve("skills/export-codex-handoff/scripts/export-handoff.mjs");
const execFileAsync = promisify(execFile);

function sourceEntry(index, text) {
  return createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId: `turn-r5-${index}`,
    eventOrdinal: index,
    rolloutLine: index,
    payloadPath: "/payload/content/0/text",
    value: text,
    locator: { kind: "rollout_payload" },
  });
}

function workflowPack(workspaceSuffix = "") {
  const text = "Implement R5 compact REDUCE; do not implement R6 or R7.";
  const entry = sourceEntry(1, text);
  const turns = [{
    turnId: entry.anchor.turnId,
    userMessages: [{ text, anchors: [entry.anchor.anchorId] }],
    assistantMessages: [],
    tools: [],
    toolReceipts: [],
    patches: [],
  }];
  const preservationLedger = buildContinuationPreservationLedger(
    SOURCE_REVISION,
    [entry],
    { turns },
  );
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/r5-rollout.jsonl",
    sourceChars: text.length,
    sourceBytes: text.length,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/workspace",
      startedAt: "2026-07-30T00:00:00Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: source.session.cwd,
    checkpoint: { status: "available", content: `R5 checkpoint${workspaceSuffix}` },
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

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function preparedAcceptedWorkflow(root, options = {}) {
  const pack = options.pack || workflowPack();
  const prepared = await prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "handoff.md"),
    workRoot: root,
    maxChunkChars: 40_000,
    mapResultMode: CONTINUATION_MAP_RESULT_MODE,
  }, { buildEvidencePack: async () => pack });
  const frameStage = await prepareFrameStage(prepared.workDir);
  const frameInput = JSON.parse(await fs.promises.readFile(frameStage.frameInputPath, "utf8"));
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
  const dictionary = JSON.parse(await fs.promises.readFile(dispatch.dictionaryPath, "utf8"));
  const evidenceIndex = dictionary.evidenceReferences.find(
    ({ anchorId }) => anchorId === pack.entry.anchor.anchorId,
  ).index;
  await claimMapDispatch(
    prepared.workDir,
    dispatch.segmentId,
    dispatch.dispatchId,
    "worker-r5",
  );
  await writeJson(dispatch.summaryPath, {
    formatVersion: 1,
    kind: "codex-handoff-continuation-map",
    frameId: validated.frameId,
    frameDigest: validated.frameDigest,
    segmentId: dispatch.segmentId,
    claims: [
      {
        localId: 1,
        kind: "open_work",
        text: "Complete R5 deterministic prepublication validation.",
        evidenceIndexes: [evidenceIndex],
      },
      {
        localId: 2,
        kind: "important_location",
        text: "skills/export-codex-handoff/scripts/lib/task-workflow-core.mjs",
        evidenceIndexes: [evidenceIndex],
      },
    ],
    relations: { decisions: [], attempts: [], verification: [] },
    criticalExclusions: [],
  });
  await checkMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
  await completeMapDispatch(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
  await acceptMapReceipt(prepared.workDir, dispatch.segmentId, dispatch.dispatchId);
  const reduce = await prepareReduceStage(prepared.workDir);
  const reduceInputText = await fs.promises.readFile(reduce.reduceInputPath, "utf8");
  const reduceInput = JSON.parse(reduceInputText);
  return { pack, prepared, validated, reduce, reduceInput, reduceInputText };
}

function correctedCandidate(workflow) {
  const openWorkClaim = workflow.reduceInput.claimTable.claims.find(
    ({ kind }) => kind === "open_work",
  );
  const deterministicProjections = buildContinuationReduceProjections(
    workflow.reduceInput.claimTable,
    workflow.pack.preservationLedger,
  );
  return {
    frameId: workflow.validated.frameId,
    frameDigest: workflow.validated.frameDigest,
    continuationDirective: "Begin with the validated R5 next action.",
    objective: {
      goal: workflow.reduceInput.compressionFrame.currentGoal.text,
      explicitExclusions: workflow.reduceInput.compressionFrame.explicitExclusions.map(
        ({ text }) => text,
      ),
    },
    constraints: [],
    workspaceState: {
      summary: {
        claimId: "workspace-r5",
        kind: "workspace_state",
        text: "Synthetic R5 workspace is available.",
        anchors: [workflow.pack.entry.anchor.anchorId],
      },
      evidenceStatus: "full",
      conflicts: [],
    },
    completedWork: [],
    openWork: [openWorkClaim],
    nextActions: [],
    importantLocations: deterministicProjections.importantLocations,
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    preservationCoverage: deterministicProjections.preservationCoverage,
    provenance: {
      notes: [],
      sourceTurnIds: [workflow.pack.entry.anchor.turnId],
    },
    compressionNotes: [],
  };
}

function semanticBody(candidate) {
  const clone = structuredClone(candidate);
  delete clone.importantLocations;
  delete clone.preservationCoverage;
  delete clone.provenance.sourceTurnIds;
  return clone;
}

test("R5 validate-reduce preflight rejects six default categories and records diagnostics", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-r5-preflight-failure-"));
  try {
    const workflow = await preparedAcceptedWorkflow(root);
    const invalid = correctedCandidate(workflow);
    invalid.preservationCoverage = REDUCE_DEFAULT_CATEGORIES.map((category) => ({
      category,
      status: "absent",
      claimIds: [],
      reason: "legacy REDUCE default",
    }));
    await writeJson(workflow.reduce.reducedPath, invalid);

    await assert.rejects(
      checkReduceStage(workflow.prepared.workDir),
      { code: "INCOMPLETE_PRESERVATION_COVERAGE" },
    );
    assert.equal(await fs.promises.stat(workflow.prepared.outputPath).catch(() => null), null);
    assert.equal(await fs.promises.stat(workflow.prepared.evidenceIndexPath).catch(() => null), null);

    const report = JSON.parse(await fs.promises.readFile(
      path.join(workflow.prepared.workDir, "failure-report.json"),
      "utf8",
    ));
    assert.equal(report.diagnostic.code, "INCOMPLETE_PRESERVATION_COVERAGE");
    assert.equal(report.workDir, workflow.prepared.workDir);
    assert.equal(report.workerMetrics.initialMaps, 1);
    assert.ok(Object.hasOwn(report, "phaseTimingsMs"));
    assert.deepEqual(Object.keys(report.performanceMetrics), [
      "mapGeneration",
      "checkAccept",
      "reduce",
      "publication",
    ]);
    assert.equal(report.performanceMetrics.reduce.complete, false);
    assert.ok(report.performanceMetrics.reduce.durationMs >= 0);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("R5 corrected candidate passes CLI preflight without changing semantic claims", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-r5-corrected-"));
  try {
    const workflow = await preparedAcceptedWorkflow(root);
    const corrected = correctedCandidate(workflow);
    const invalid = structuredClone(corrected);
    invalid.preservationCoverage = REDUCE_DEFAULT_CATEGORIES.map((category) => ({
      category,
      status: "absent",
      claimIds: [],
      reason: "legacy REDUCE default",
    }));
    assert.deepEqual(semanticBody(corrected), semanticBody(invalid));
    await writeJson(workflow.reduce.reducedPath, corrected);

    const checkedProcess = await execFileAsync(process.execPath, [
      CLI_PATH,
      "validate-reduce",
      workflow.prepared.workDir,
      "--check",
    ]);
    const checked = JSON.parse(checkedProcess.stdout);
    assert.equal(checked.valid, true);
    assert.match(checked.reducedDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(checked.finalProvenance, [workflow.pack.entry.anchor.turnId]);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("R5 continuation REDUCE input omits the complete ledger and stays within 300k", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-r5-reduce-budget-"));
  try {
    const workflow = await preparedAcceptedWorkflow(root);
    assert.ok(workflow.reduceInputText.length <= 300_000);
    assert.equal(workflow.reduce.maxReduceInputChars, 300_000);
    assert.equal("preservationLedger" in workflow.reduceInput, false);
    assert.equal("semanticCoverage" in workflow.reduceInput, false);
    assert.equal(workflow.reduceInput.segmentSummaries.length, 1);
    assert.deepEqual(
      workflow.reduceInput.deterministicProjectionPolicy.preservationCategories,
      [],
    );
    assert.equal(
      workflow.reduceInput.deterministicProjectionPolicy.finalProvenance,
      "derive from retained claim and frozen-frame anchors",
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("R5 publication consumes only the exact preflight-bound candidate digest", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-r5-digest-binding-"));
  try {
    const workflow = await preparedAcceptedWorkflow(root);
    const candidate = correctedCandidate(workflow);
    await writeJson(workflow.reduce.reducedPath, candidate);

    await assert.rejects(
      publishHandoff(workflow.prepared.workDir, { keepWorkdir: true }),
      { code: "REDUCE_NOT_CHECKED" },
    );
    const checked = await checkReduceStage(workflow.prepared.workDir);
    candidate.compressionNotes.push("mutation after preflight");
    await writeJson(workflow.reduce.reducedPath, candidate);
    await assert.rejects(
      publishHandoff(workflow.prepared.workDir, { keepWorkdir: true }),
      { code: "REDUCE_RESULT_CHANGED" },
    );
    assert.equal(await fs.promises.stat(workflow.prepared.outputPath).catch(() => null), null);

    candidate.compressionNotes = [];
    await writeJson(workflow.reduce.reducedPath, candidate);
    const published = await publishHandoff(
      workflow.prepared.workDir,
      { keepWorkdir: true },
      { verifyEvidenceIndex: async () => ({ valid: true }) },
    );
    assert.equal(published.reducePreflightDigest, checked.reducedDigest);
    assert.equal(await fs.promises.stat(workflow.prepared.outputPath).then(() => true), true);
    assert.equal(await fs.promises.stat(workflow.prepared.evidenceIndexPath).then(() => true), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
