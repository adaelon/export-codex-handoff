import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  publishHandoff,
  validateFrameStage,
  validateMapStage,
} from "../scripts/lib/task-workflow.mjs";
import { validateReduceResult } from "../scripts/lib/validation.mjs";
import {
  buildPreservationLedger,
  createEvidenceEntry,
  hashFileRevision,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { sparseFromFullMapResult } from "./fixtures/sparse-map-fixtures.mjs";

const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
const TURN_IDS = ["turn-1", "turn-2", "turn-3"];

function evidencePack(options = {}) {
  const sourceRevision = options.sourceRevision || `sha256:${"a".repeat(64)}`;
  const entries = TURN_IDS.map((turnId, index) => createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision,
    turnId,
    eventOrdinal: index + 1,
    rolloutLine: index + 2,
    payloadPath: "/payload/content",
    value: [{ type: "input_text", text: `Build exporter ${index} ${"x".repeat(2_500)}` }],
    locator: { kind: "rollout_payload" },
  }));
  const preservationLedger = buildPreservationLedger(sourceRevision, entries);
  const pack = {
    formatVersion: 1,
    source: {
      sessionId: SESSION_ID,
      storageKind: "active",
      rolloutPath: options.rolloutPath || "C:/codex/rollout.jsonl",
      sourceChars: options.sourceChars ?? 120_000,
      sourceBytes: options.sourceBytes ?? 120_000,
      sourceRevision,
      session: { id: SESSION_ID, cwd: "C:/workspace", startedAt: "2026-07-28T00:00:00Z" },
    },
    turns: TURN_IDS.map((turnId, index) => ({
      turnId,
      userMessages: [{
        text: `Build exporter ${index} ${"x".repeat(2_500)}`,
        anchors: [entries[index].anchor.anchorId],
      }],
      assistantMessages: [{ text: `result ${index}` }],
      tools: [],
      toolReceipts: [],
      patches: [],
    })),
    ignoredEvents: {},
    workspace: {
      status: "available",
      cwd: "C:/workspace",
      checkpoint: { status: "missing" },
      git: { status: "available", branchAndStatus: "## main", recentCommits: "abc initial" },
    },
    evidenceAnchors: entries.map((entry) => entry.anchor),
    preservationLedger,
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source: pack.source,
    workspace: pack.workspace,
    entries,
    preservationLedger,
  });
  return { ...pack, evidenceChars: JSON.stringify(pack).length, evidenceIndex };
}

function claim(claimId, kind, text, anchors) {
  return { claimId, kind, text, anchors };
}

function anchorForTurn(turnId, pack = evidencePack()) {
  const turn = pack.turns.find((item) => item.turnId === turnId);
  return turn.userMessages[0].anchors[0];
}

function mapResult(segment, frameId, frameDigest, pack = evidencePack()) {
  const claims = segment.expectedTurnIds.map((turnId) => claim(
    `map-${segment.segmentId}-${turnId}`,
    "objective",
    `Build exporter from ${turnId}`,
    [anchorForTurn(turnId, pack)],
  ));
  return {
    frameId,
    frameDigest,
    segmentId: segment.segmentId,
    turnCoverage: segment.expectedTurnIds.map((turnId) => ({
      turnId,
      status: "summarized",
      claimIds: [`map-${segment.segmentId}-${turnId}`],
      reason: "captured",
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
  };
}

function routedMapResult(segment, frameId, frameDigest, pack, mapResultMode) {
  const full = mapResult(segment, frameId, frameDigest, pack);
  return mapResultMode === "sparse-map-v1"
    ? sparseFromFullMapResult(full)
    : full;
}

function reduceResult(
  turnIds,
  frameBinding,
  directive = "Read the Handoff and continue safely.",
  pack = evidencePack(),
) {
  const firstAnchor = anchorForTurn(turnIds[0], pack);
  const lastAnchor = anchorForTurn(turnIds.at(-1), pack);
  return {
    frameId: frameBinding.frameId,
    frameDigest: frameBinding.frameDigest,
    continuationDirective: directive,
    objective: {
      goal: frameBinding.frame.currentGoal.text,
      explicitExclusions: frameBinding.frame.explicitExclusions.map((item) => item.text),
    },
    constraints: [
      claim("reduce-constraint", "constraint", "Preserve source", [firstAnchor]),
    ],
    workspaceState: {
      summary: claim("reduce-workspace", "workspace_state", "Workspace clean", [lastAnchor]),
      evidenceStatus: "full",
      conflicts: [],
    },
    completedWork: [],
    openWork: [
      claim("reduce-open-work", "open_work", "Implement next slice", [lastAnchor]),
    ],
    nextActions: [
      claim("reduce-next-action", "next_action", "Run tests", [lastAnchor]),
    ],
    importantLocations: [{
      claimId: "reduce-location",
      kind: "important_location",
      location: "scripts/export.mjs",
      purpose: "entry",
      anchors: [firstAnchor],
    }],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    preservationCoverage: frameBinding.frame.preservationPolicy.criticalCategories.map(
      (category) => ({
        category,
        status: "absent",
        claimIds: [],
        reason: `No retained ${category} evidence`,
      }),
    ),
    provenance: { notes: [] },
    compressionNotes: [],
  };
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function prepare(root, options = {}) {
  const {
    legacyV1 = false,
    buildPack = async () => evidencePack(),
    ...prepareOptions
  } = options;
  const builtPack = await buildPack();
  const prepared = await prepareCompressionTask(
    {
      sessionId: SESSION_ID,
      outputPath: path.join(root, "handoff.md"),
      workRoot: root,
      maxChunkChars: 4_000,
      ...prepareOptions,
    },
    { buildEvidencePack: async () => builtPack },
  );
  if (legacyV1) {
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    manifest.formatVersion = 1;
    delete manifest.mapResultMode;
    delete manifest.maxAggregateMapOutputChars;
    for (const segment of manifest.segments) delete segment.maxMapOutputChars;
    await writeJson(prepared.manifestPath, manifest);
    await fs.promises.rm(path.join(prepared.workDir, "workflow-version.json"), {
      force: true,
    });
  }
  const frameStage = await prepareFrameStage(prepared.workDir);
  const frameInput = JSON.parse(await fs.promises.readFile(frameStage.frameInputPath, "utf8"));
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
  const validated = await validateFrameStage(prepared.workDir);
  return { ...prepared, ...validated, frame, testPack: builtPack };
}

async function liveEvidencePack(rolloutPath) {
  const records = [
    { type: "session_meta" },
    ...TURN_IDS.map((turnId, index) => ({
      turnId,
      payload: {
        content: [{ type: "input_text", text: `Build exporter ${index} ${"x".repeat(2_500)}` }],
      },
    })),
  ];
  const text = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  await fs.promises.writeFile(rolloutPath, text, "utf8");
  const revision = await hashFileRevision(rolloutPath);
  return evidencePack({
    rolloutPath,
    sourceChars: text.length,
    ...revision,
  });
}

async function writeAllMaps(prepared) {
  for (const segment of prepared.segments) {
    await writeJson(
      segment.summaryPath,
      routedMapResult(
        segment,
        prepared.frameId,
        prepared.frameDigest,
        prepared.testPack,
        prepared.mapResultMode,
      ),
    );
  }
}

async function prepareReadyPublication(root, options = {}) {
  const prepared = await prepare(root, options);
  await writeAllMaps(prepared);
  for (const segment of prepared.segments) {
    await validateMapStage(prepared.workDir, segment.segmentId);
  }
  const reduce = await prepareReduceStage(prepared.workDir);
  await writeJson(
    reduce.reducedPath,
    reduceResult(TURN_IDS, prepared, undefined, prepared.testPack),
  );
  return prepared;
}

test("prepares a managed Compression Task workspace", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-prepare-"));
  try {
    const prepared = await prepare(root);
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    assert.equal(manifest.kind, "codex-handoff-compression-task");
    assert.equal(prepared.segments.length, 3);
    assert.deepEqual(prepared.segments.flatMap((item) => item.expectedTurnIds), TURN_IDS);
    assert.equal(
      prepared.segments.reduce((total, segment) => total + segment.maxMapOutputChars, 0),
      prepared.maxAggregateMapOutputChars,
    );
    assert.equal(await fs.promises.stat(prepared.segments[0].chunkPath).then(() => true), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("rejects incomplete MAP coverage before REDUCE", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-map-"));
  try {
    const prepared = await prepare(root);
    const invalid = routedMapResult(
      prepared.segments[0],
      prepared.frameId,
      prepared.frameDigest,
      undefined,
      prepared.mapResultMode,
    );
    invalid.claimBindings = [];
    await writeJson(prepared.segments[0].summaryPath, invalid);
    await assert.rejects(
      validateMapStage(prepared.workDir, prepared.segments[0].segmentId),
      { code: "UNSUPPORTED_CLAIM" },
    );
    await assert.rejects(
      prepareReduceStage(prepared.workDir),
      { code: "UNSUPPORTED_CLAIM" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("validates staged summaries and atomically publishes a Handoff", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-publish-"));
  try {
    const prepared = await prepare(root);
    await writeAllMaps(prepared);
    for (const segment of prepared.segments) {
      const checked = await validateMapStage(prepared.workDir, segment.segmentId);
      assert.equal(checked.valid, true);
    }
    const reduce = await prepareReduceStage(prepared.workDir);
    assert.deepEqual(reduce.expectedTurnIds, TURN_IDS);
    await writeJson(reduce.reducedPath, reduceResult(TURN_IDS, prepared));
    const result = await publishHandoff(prepared.workDir, {}, {
      verifyEvidenceIndex: async () => ({ valid: true }),
    });
    const handoff = await fs.promises.readFile(result.outputPath, "utf8");
    const publishedIndex = JSON.parse(
      await fs.promises.readFile(result.evidenceIndexPath, "utf8"),
    );
    assert.match(handoff, /# Codex Handoff/);
    assert.match(handoff, /Build exporter/);
    assert.match(handoff, /turn-1/);
    assert.deepEqual(
      publishedIndex.semanticCoverage.turns.map((item) => item.turnId),
      TURN_IDS,
    );
    assert.equal(publishedIndex.semanticCoverage.claims.length, TURN_IDS.length);
    assert.equal(result.coveredTurns, 3);
    assert.equal(result.initialMaps, prepared.segments.length);
    assert.ok(result.maxObservedMapInputChars > 0);
    assert.ok(result.rawMapOutputChars > 0);
    assert.ok(result.normalizedMapOutputChars > 0);
    assert.ok(result.rawMapOutputChars <= result.maxAggregateMapOutputChars);
    assert.equal(
      result.maxAggregateMapOutputChars,
      Math.floor(40_000 * 0.85) * 3,
    );
    assert.ok(result.phaseTimingsMs.total >= 0);
    assert.ok(result.phaseTimingsMs.map >= 0);
    assert.equal(result.cleanupStatus, "removed");
    await assert.rejects(fs.promises.access(prepared.workDir));
    await assert.rejects(prepare(root), { code: "OUTPUT_EXISTS" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("fails closed on budget overflow and keeps the work directory", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-budget-"));
  try {
    const prepared = await prepare(root, { maxChars: 4_000 });
    await writeAllMaps(prepared);
    for (const segment of prepared.segments) {
      await validateMapStage(prepared.workDir, segment.segmentId);
    }
    const reduce = await prepareReduceStage(prepared.workDir);
    await writeJson(
      reduce.reducedPath,
      reduceResult(TURN_IDS, prepared, "z".repeat(5_000)),
    );
    await assert.rejects(publishHandoff(prepared.workDir), { code: "OUTPUT_TOO_LARGE" });
    await assert.rejects(fs.promises.access(prepared.outputPath));
    assert.equal(await fs.promises.stat(prepared.workDir).then(() => true), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("rejects a final provenance list that was not derived from claims", () => {
  const pack = evidencePack();
  const frame = {
    frameId: "frame-test",
    frameDigest: `sha256:${"f".repeat(64)}`,
    frame: {
      currentGoal: { text: "Build exporter" },
      explicitExclusions: [{ text: "Do not modify the Source Thread" }],
      preservationPolicy: pack.preservationLedger,
    },
  };
  const reduced = reduceResult(TURN_IDS, frame);
  reduced.provenance.sourceTurnIds = ["turn-2"];
  assert.throws(
    () => validateReduceResult(reduced, TURN_IDS, frame, {
      evidenceIndex: pack.evidenceIndex,
      preservationLedger: pack.preservationLedger,
    }),
    { code: "PROVENANCE_NOT_DERIVED" },
  );
});

test("new prepare creates a version-bound v2 work directory", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-v2-"));
  try {
    const prepared = await prepareCompressionTask(
      {
        sessionId: SESSION_ID,
        outputPath: path.join(root, "handoff.md"),
        workRoot: root,
        maxChunkChars: 4_000,
      },
      { buildEvidencePack: async () => evidencePack() },
    );
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    const versionBinding = JSON.parse(await fs.promises.readFile(
      path.join(prepared.workDir, "workflow-version.json"),
      "utf8",
    ));
    assert.equal(manifest.formatVersion, 2);
    assert.deepEqual(versionBinding, {
      kind: "codex-handoff-workflow-version",
      formatVersion: 2,
      sessionId: SESSION_ID,
      workDir: prepared.workDir,
      mapResultMode: "sparse-map-v1",
      maxAggregateMapOutputChars: Math.floor(40_000 * 0.85) * 3,
      mapContextMode: "reference-frame-projection-v1",
      maxFrameProjectionChars: 20_000,
      maxMapInputChars: 100_000,
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("legacy v1 validation and publication never upgrade the manifest", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-v1-"));
  try {
    const prepared = await prepareReadyPublication(root, { legacyV1: true });
    const result = await publishHandoff(prepared.workDir, { keepWorkdir: true });
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    assert.equal(manifest.formatVersion, 1);
    assert.equal(result.formatVersion, 1);
    assert.equal(result.cleanupStatus, "kept");
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("mixed v1 and v2 workflow state fails closed", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-mixed-"));
  try {
    const prepared = await prepareCompressionTask(
      {
        sessionId: SESSION_ID,
        outputPath: path.join(root, "handoff.md"),
        workRoot: root,
        maxChunkChars: 4_000,
      },
      { buildEvidencePack: async () => evidencePack() },
    );
    const manifest = JSON.parse(await fs.promises.readFile(prepared.manifestPath, "utf8"));
    manifest.formatVersion = 1;
    await writeJson(prepared.manifestPath, manifest);
    await assert.rejects(
      prepareFrameStage(prepared.workDir),
      { code: "WORKFLOW_VERSION_MISMATCH" },
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("v2 publication rolls back its first file when the second file fails", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-rollback-"));
  try {
    const prepared = await prepareReadyPublication(root);
    await assert.rejects(
      publishHandoff(prepared.workDir, {}, {
        verifyEvidenceIndex: async () => ({ valid: true }),
        beforePublish: ({ index }) => {
          if (index === 1) throw new Error("injected second-file failure");
        },
      }),
      { code: "PUBLICATION_FAILED" },
    );
    await assert.rejects(fs.promises.access(prepared.outputPath));
    await assert.rejects(fs.promises.access(prepared.evidenceIndexPath));
    assert.equal(await fs.promises.stat(prepared.workDir).then(() => true), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("cleanup failure reports diagnostics without retracting a valid v2 publication", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-cleanup-"));
  try {
    const prepared = await prepareReadyPublication(root);
    const result = await publishHandoff(prepared.workDir, {}, {
      verifyEvidenceIndex: async () => ({ valid: true }),
      beforeCleanup: () => {
        throw new Error("injected cleanup failure");
      },
    });
    assert.match(result.cleanupStatus, /^failed: injected cleanup failure$/);
    assert.equal(await fs.promises.stat(prepared.outputPath).then(() => true), true);
    assert.equal(await fs.promises.stat(prepared.evidenceIndexPath).then(() => true), true);
    assert.equal(await fs.promises.stat(prepared.workDir).then(() => true), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("v2 publication validates the live Source Thread revision before either output", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-source-change-"));
  try {
    const rolloutPath = path.join(root, "rollout.jsonl");
    const pack = await liveEvidencePack(rolloutPath);
    const prepared = await prepareReadyPublication(root, {
      buildPack: async () => pack,
    });
    await fs.promises.appendFile(rolloutPath, `${JSON.stringify({ type: "appended" })}\n`, "utf8");
    await assert.rejects(
      publishHandoff(prepared.workDir),
      { code: "SOURCE_CHANGED" },
    );
    await assert.rejects(fs.promises.access(prepared.outputPath));
    await assert.rejects(fs.promises.access(prepared.evidenceIndexPath));
    assert.equal(await fs.promises.stat(prepared.workDir).then(() => true), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("v2 publication enforces the configured Evidence Index budget before publishing", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-index-budget-"));
  try {
    const prepared = await prepareReadyPublication(root, {
      maxEvidenceIndexChars: 4_000,
    });
    await assert.rejects(
      publishHandoff(prepared.workDir, {}, {
        verifyEvidenceIndex: async () => ({ valid: true }),
      }),
      { code: "EVIDENCE_INDEX_TOO_LARGE" },
    );
    await assert.rejects(fs.promises.access(prepared.outputPath));
    await assert.rejects(fs.promises.access(prepared.evidenceIndexPath));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("deterministic v2 replay returns the same structural digest", async () => {
  const firstRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-replay-a-"));
  const secondRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-handoff-replay-b-"));
  try {
    const first = await prepareReadyPublication(firstRoot);
    const second = await prepareReadyPublication(secondRoot);
    const dependencies = { verifyEvidenceIndex: async () => ({ valid: true }) };
    const firstResult = await publishHandoff(first.workDir, { keepWorkdir: true }, dependencies);
    const secondResult = await publishHandoff(second.workDir, { keepWorkdir: true }, dependencies);
    assert.match(firstResult.structuralDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(firstResult.structuralDigest, secondResult.structuralDigest);
  } finally {
    await fs.promises.rm(firstRoot, { recursive: true, force: true });
    await fs.promises.rm(secondRoot, { recursive: true, force: true });
  }
});
