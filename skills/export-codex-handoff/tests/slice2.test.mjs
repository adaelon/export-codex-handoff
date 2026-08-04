import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { sparseFromFullMapResult } from "./fixtures/sparse-map-fixtures.mjs";
import {
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  validateFrameStage,
  validateMapStage,
} from "../scripts/lib/task-workflow.mjs";

const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const WORKSPACE_REVISION = `sha256:${"b".repeat(64)}`;
const CRITICAL_CATEGORIES = [
  "constraint",
  "decision",
  "change",
  "verification",
  "open_work",
  "rollback",
];

function sourceEntry({ turnId, ordinal, text }) {
  return createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId,
    eventOrdinal: ordinal,
    rolloutLine: ordinal + 1,
    payloadPath: "/payload/content",
    value: [{ type: "input_text", text }],
    locator: { kind: "rollout_payload" },
  });
}

function workspaceEntry(text) {
  return createEvidenceEntry({
    sourceKind: "workspace",
    sourceRevision: WORKSPACE_REVISION,
    payloadPath: "/checkpoint/content",
    value: text,
    locator: {
      kind: "file",
      observationId: "checkpoint",
      path: "C:/workspace/SESSION_CHECKPOINT.md",
    },
  });
}

function evidencePack(extraGoal = "") {
  const oldGoal = "Build the legacy transcript exporter.";
  const latestGoal = [
    "Implement the evidence-preserving Compression Frame.",
    "Do not resume or modify the Source Thread.",
    "Keep C:/workspace/src/frame.mjs and symbol validateCompressionFrame byte-for-byte.",
    extraGoal,
  ].join("\n");
  const checkpoint = "# Checkpoint\nCurrent phase: implementing Slice 2.";
  const entries = [
    sourceEntry({ turnId: "turn-1", ordinal: 1, text: oldGoal }),
    sourceEntry({ turnId: "turn-2", ordinal: 2, text: latestGoal }),
    workspaceEntry(checkpoint),
  ];
  const preservationLedger = {
    ...buildPreservationLedger(SOURCE_REVISION, entries),
    criticalCategories: CRITICAL_CATEGORIES,
  };
  const source = {
    sessionId: SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/codex/rollout.jsonl",
    sourceChars: 10_000,
    sourceBytes: 10_000,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/workspace",
      startedAt: "2026-07-29T00:00:00Z",
    },
  };
  const workspace = {
    status: "available",
    cwd: "C:/workspace",
    sourceRevision: WORKSPACE_REVISION,
    checkpoint: {
      status: "found",
      path: "C:/workspace/SESSION_CHECKPOINT.md",
      content: checkpoint,
      truncatedChars: 0,
    },
    git: { status: "available", branchAndStatus: "## main", recentCommits: "abc frame" },
  };
  const turns = [
    {
      turnId: "turn-1",
      userMessages: [{ text: oldGoal, anchors: [entries[0].anchor.anchorId] }],
      assistantMessages: [],
      tools: [],
      toolReceipts: [],
      patches: [],
    },
    {
      turnId: "turn-2",
      userMessages: [{ text: latestGoal, anchors: [entries[1].anchor.anchorId] }],
      assistantMessages: [],
      tools: [],
      toolReceipts: [],
      patches: [],
    },
  ];
  const pack = {
    formatVersion: 1,
    source,
    turns,
    ignoredEvents: {},
    workspace,
    evidenceAnchors: entries.map((entry) => entry.anchor),
    preservationLedger,
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source,
    workspace,
    entries,
    preservationLedger,
  });
  return { ...pack, evidenceChars: JSON.stringify(pack).length, evidenceIndex };
}

async function prepare(root, options = {}) {
  const {
    buildPack = () => evidencePack(),
    ...prepareOptions
  } = options;
  return prepareCompressionTask(
    {
      sessionId: SESSION_ID,
      outputPath: path.join(root, "handoff.md"),
      workRoot: root,
      maxChunkChars: 4_000,
      ...prepareOptions,
    },
    { buildEvidencePack: async () => buildPack() },
  );
}

async function readJson(target) {
  return JSON.parse(await fs.promises.readFile(target, "utf8"));
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validFrame(frameInput) {
  return {
    frameId: frameInput.expectedFrameId,
    currentGoal: frameInput.latestUserGoal,
    taskType: "implementation",
    taskPhase: "implementing",
    explicitExclusions: frameInput.explicitExclusions,
    preservationPolicy: frameInput.preservationPolicy,
    anchors: frameInput.requiredFrameAnchors,
  };
}

function mapResult(segment, frameId, frameDigest) {
  const full = {
    frameId,
    frameDigest,
    segmentId: segment.segmentId,
    turnCoverage: segment.expectedTurnIds.map((turnId) => ({
      turnId,
      status: "ignored",
      claimIds: [],
      reason: "frame-binding fixture contains no semantic MAP facts",
    })),
    objectiveFacts: [],
    userConstraints: [],
    completedWork: [],
    openWork: [],
    nextActions: [],
    importantLocations: [],
    conflicts: [],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    compressionNotes: [],
  };
  return sparseFromFullMapResult(full);
}

async function prepareAndValidateFrame(root) {
  const prepared = await prepare(root);
  const frameStage = await prepareFrameStage(prepared.workDir);
  const frameInput = await readJson(frameStage.frameInputPath);
  await writeJson(frameStage.framePath, validFrame(frameInput));
  const validated = await validateFrameStage(prepared.workDir);
  return { prepared, frameStage, frameInput, validated };
}

test("late task pivot binds the earliest segment to the latest anchored goal", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-frame-pivot-"));
  try {
    const { prepared, frameInput, validated } = await prepareAndValidateFrame(root);
    assert.match(frameInput.latestUserGoal.text, /Compression Frame/);
    assert.match(frameInput.supersededUserGoals[0].text, /legacy transcript/);
    assert.equal(frameInput.workspaceCheckpoint.kind, "workspace_checkpoint");

    const earliestSegment = validated.segments[0];
    const earliestChunk = await readJson(earliestSegment.chunkPath);
    const earliestProjection = await readJson(earliestSegment.contextPath);
    assert.equal(Object.hasOwn(earliestChunk, "compressionFrame"), false);
    assert.equal(earliestProjection.currentGoal.text, frameInput.latestUserGoal.text);
    assert.equal(earliestProjection.frameDigest, validated.frameDigest);
    assert.ok(earliestSegment.mapInputChars <= 400_000);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("validation rejects restoring a superseded goal as current", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-frame-old-goal-"));
  try {
    const prepared = await prepare(root);
    const frameStage = await prepareFrameStage(prepared.workDir);
    const frameInput = await readJson(frameStage.frameInputPath);
    const frame = validFrame(frameInput);
    frame.currentGoal = frameInput.supersededUserGoals[0];
    await writeJson(frameStage.framePath, frame);
    await assert.rejects(validateFrameStage(prepared.workDir), {
      code: "UNSUPPORTED_FRAME_CLAIM",
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("equivalent frame retries keep one digest and preservation policy", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-frame-retry-"));
  try {
    const { prepared, frameInput, frameStage, validated } = await prepareAndValidateFrame(root);
    const frame = validFrame(frameInput);
    await writeJson(frameStage.framePath, {
      anchors: frame.anchors,
      preservationPolicy: frame.preservationPolicy,
      explicitExclusions: frame.explicitExclusions,
      taskPhase: frame.taskPhase,
      taskType: frame.taskType,
      currentGoal: frame.currentGoal,
      frameId: frame.frameId,
    });
    const retried = await validateFrameStage(prepared.workDir);
    assert.equal(retried.frameDigest, validated.frameDigest);

    const segment = retried.segments[0];
    const chunk = await readJson(segment.chunkPath);
    const projection = await readJson(segment.contextPath);
    assert.equal(Object.hasOwn(chunk, "compressionFrame"), false);
    assert.equal(projection.frameDigest, retried.frameDigest);
    assert.deepEqual(projection.globalObligationCounts, {
      requiredAnchors: frameInput.preservationPolicy.requiredAnchors.length,
      exactIdentifiers: frameInput.preservationPolicy.exactIdentifiers.length,
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("REDUCE preparation rejects a MAP result from another frame digest", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-frame-map-mismatch-"));
  try {
    const { prepared, validated } = await prepareAndValidateFrame(root);
    for (const [index, segment] of prepared.segments.entries()) {
      const digest = index === 0 ? `sha256:${"0".repeat(64)}` : validated.frameDigest;
      await writeJson(segment.summaryPath, mapResult(segment, validated.frameId, digest));
    }
    await assert.rejects(
      validateMapStage(prepared.workDir, prepared.segments[0].segmentId),
      { code: "FRAME_DIGEST_MISMATCH" },
    );
    await assert.rejects(prepareReduceStage(prepared.workDir), {
      code: "FRAME_DIGEST_MISMATCH",
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MAP validation rejects a mutated Frame Projection behind an unchanged digest field", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-frame-chunk-mutation-"));
  try {
    const { prepared, validated } = await prepareAndValidateFrame(root);
    const segment = validated.segments[0];
    const projection = await readJson(segment.contextPath);
    projection.taskPhase = "blocked";
    await writeJson(segment.contextPath, projection);
    await writeJson(
      segment.summaryPath,
      mapResult(segment, validated.frameId, validated.frameDigest),
    );
    await assert.rejects(validateMapStage(prepared.workDir, segment.segmentId), {
      code: "MAP_CONTEXT_CHANGED",
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("frame validation fails before dispatch when evidence plus projection exceeds its budget", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-frame-map-budget-"));
  try {
    const identifiers = Array.from({ length: 120 }, (_, index) => (
      `C:/workspace/generated/module-${String(index).padStart(3, "0")}/file.mjs`
    )).join(" ");
    const prepared = await prepare(root, {
      maxMapInputChars: 4_000,
      buildPack: () => evidencePack(identifiers),
    });
    const frameStage = await prepareFrameStage(prepared.workDir);
    const frameInput = await readJson(frameStage.frameInputPath);
    await writeJson(frameStage.framePath, validFrame(frameInput));
    await assert.rejects(validateFrameStage(prepared.workDir), {
      code: "MAP_INPUT_TOO_LARGE",
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("frame validation fails closed on preservation drift and unknown anchors", async (t) => {
  await t.test("changed exact identifier", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-frame-identifier-"));
    try {
      const prepared = await prepare(root);
      const frameStage = await prepareFrameStage(prepared.workDir);
      const frameInput = await readJson(frameStage.frameInputPath);
      const frame = validFrame(frameInput);
      frame.preservationPolicy.exactIdentifiers[0].value += "-changed";
      await writeJson(frameStage.framePath, frame);
      await assert.rejects(validateFrameStage(prepared.workDir), { code: "IDENTIFIER_MISMATCH" });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  await t.test("missing critical category", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-frame-category-"));
    try {
      const prepared = await prepare(root);
      const frameStage = await prepareFrameStage(prepared.workDir);
      const frameInput = await readJson(frameStage.frameInputPath);
      const frame = validFrame(frameInput);
      frame.preservationPolicy.criticalCategories.pop();
      await writeJson(frameStage.framePath, frame);
      await assert.rejects(validateFrameStage(prepared.workDir), {
        code: "MISSING_CRITICAL_CATEGORY",
      });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  await t.test("unknown anchor", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-frame-anchor-"));
    try {
      const prepared = await prepare(root);
      const frameStage = await prepareFrameStage(prepared.workDir);
      const frameInput = await readJson(frameStage.frameInputPath);
      const frame = validFrame(frameInput);
      frame.anchors.push("anchor-unknown");
      await writeJson(frameStage.framePath, frame);
      await assert.rejects(validateFrameStage(prepared.workDir), {
        code: "UNKNOWN_FRAME_ANCHOR",
      });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
