import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPreservationLedger,
  createEvidenceEntry,
  extractExactIdentifiers,
  hashFileRevision,
} from "../scripts/lib/evidence-addressing.mjs";
import {
  buildEvidenceIndex,
  retrieveEvidence,
  validateEvidenceIndex,
} from "../scripts/lib/evidence-index.mjs";
import { buildEvidencePack } from "../scripts/lib/evidence-pack.mjs";
import { captureWorkspaceSnapshot } from "../scripts/lib/workspace-snapshot.mjs";
import {
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  publishHandoff,
  validateFrameStage,
  validateMapStage,
} from "../scripts/lib/task-workflow.mjs";
import {
  EXACT_IDENTIFIERS,
  MIDDLE_ONLY_MARKER,
  SLICE1_EXPECTATIONS,
  largeToolOutput,
} from "./fixtures/slice1-semantic-fixture.mjs";
import { compareFixtureItems } from "./lib/fixture-comparator.mjs";
import { sparseFromFullMapResult } from "./fixtures/sparse-map-fixtures.mjs";

const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";
const TURN_ID = "019fa2c4-3e76-79a2-b530-8b7652767423";

async function createSourceFixture(root) {
  const codexHome = path.join(root, ".codex");
  const workspace = path.join(root, "workspace");
  const sessionDir = path.join(codexHome, "sessions", "2026", "07", "28");
  const rolloutPath = path.join(sessionDir, `rollout-${SESSION_ID}.jsonl`);
  await fs.promises.mkdir(sessionDir, { recursive: true });
  await fs.promises.mkdir(workspace, { recursive: true });
  const records = [
    { type: "session_meta", payload: { id: SESSION_ID, cwd: workspace, cli_version: "test" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: TURN_ID } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Preserve the failure" }] } },
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec", input: "run diagnostics" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1", output: largeToolOutput() } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Captured" }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: TURN_ID } },
  ];
  await fs.promises.writeFile(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return { codexHome, workspace, rolloutPath };
}

test("semantic fixture comparator reports four deterministic difference classes", () => {
  const [expected] = SLICE1_EXPECTATIONS.claims;
  const actual = [
    { ...expected, text: "mutated" },
    { ...expected, text: "duplicate" },
    { claimId: "unsupported", text: "invented", anchors: [] },
  ];
  assert.deepEqual(
    compareFixtureItems(actual, [expected, { claimId: "missing", text: "absent", anchors: [] }]),
    {
      missing: ["missing"],
      mutated: [expected.claimId],
      unsupported: ["unsupported"],
      duplicates: [expected.claimId],
    },
  );
});

test("exact identifier extraction keeps every annotated value byte-for-byte", () => {
  const actual = extractExactIdentifiers(largeToolOutput());
  for (const expected of EXACT_IDENTIFIERS) {
    assert.ok(
      actual.some((item) => item.kind === expected.kind && item.value === expected.value),
      `missing ${expected.kind}:${expected.value}`,
    );
  }
});

test("Evidence Index retrieves anchored JSONL payloads and rejects source mutation", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-anchor-unit-"));
  try {
    const rolloutPath = path.join(root, "rollout.jsonl");
    const record = { payload: { output: largeToolOutput() } };
    await fs.promises.writeFile(rolloutPath, `${JSON.stringify(record)}\n`);
    const revision = await hashFileRevision(rolloutPath);
    const entry = createEvidenceEntry({
      sourceKind: "source_thread",
      sourceRevision: revision.sourceRevision,
      eventOrdinal: 1,
      rolloutLine: 1,
      payloadPath: "/payload/output",
      callId: "call-1",
      value: record.payload.output,
      locator: { kind: "rollout_payload" },
    });
    const ledger = buildPreservationLedger(revision.sourceRevision, [entry]);
    const index = buildEvidenceIndex({
      sessionId: SESSION_ID,
      source: { rolloutPath, ...revision },
      workspace: { cwd: root, sourceRevision: null },
      entries: [entry],
      preservationLedger: ledger,
    });
    const retrieved = await retrieveEvidence(index, entry.anchor.anchorId);
    assert.match(retrieved.content, new RegExp(MIDDLE_ONLY_MARKER));

    const raw = await fs.promises.readFile(rolloutPath, "utf8");
    await fs.promises.writeFile(rolloutPath, raw.replace("payload", "payloae"));
    await assert.rejects(retrieveEvidence(index, entry.anchor.anchorId), { code: "SOURCE_CHANGED" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("Evidence Index integrity rejects mutated anchor metadata", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-index-integrity-"));
  try {
    const rolloutPath = path.join(root, "rollout.jsonl");
    await fs.promises.writeFile(rolloutPath, "{}\n");
    const revision = await hashFileRevision(rolloutPath);
    const index = buildEvidenceIndex({
      sessionId: SESSION_ID,
      source: { rolloutPath, ...revision },
      workspace: { cwd: root, sourceRevision: null },
      entries: [],
      preservationLedger: buildPreservationLedger(revision.sourceRevision, []),
    });
    index.source.rolloutPath = path.join(root, "other.jsonl");
    assert.throws(() => validateEvidenceIndex(index), { code: "EVIDENCE_INDEX_INTEGRITY_MISMATCH" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("Evidence Pack replaces truncation with bounded retrievable Tool Receipts", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-receipt-integration-"));
  try {
    const fixture = await createSourceFixture(root);
    const pack = await buildEvidencePack(SESSION_ID, {
      codexHome: fixture.codexHome,
      maxToolChars: 220,
    });
    const receipt = pack.turns[0].toolReceipts.find(
      (item) => item.callId === "call-1" && item.valueKind === "output",
    );
    assert.ok(receipt);
    assert.ok(receipt.previewHead.length + receipt.previewTail.length <= 220);
    assert.equal(receipt.outputChars, largeToolOutput().length);
    assert.doesNotMatch(`${receipt.previewHead}${receipt.previewTail}`, new RegExp(MIDDLE_ONLY_MARKER));
    const retrieved = await retrieveEvidence(pack.evidenceIndex, receipt.outputAnchor);
    assert.match(retrieved.content, new RegExp(MIDDLE_ONLY_MARKER));
    for (const expected of EXACT_IDENTIFIERS) {
      assert.ok(retrieved.content.includes(expected.value));
    }
    assert.equal(pack.preservationLedger.requiredAnchors.includes(receipt.outputAnchor), true);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("workspace command results expose equivalent anchors", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-workspace-anchor-"));
  try {
    const commandRunner = async (_cwd, args) => {
      if (args[0] === "rev-parse") return { ok: true, stdout: "true", stderr: "" };
      return { ok: true, stdout: `result:${args.join(" ")}`, stderr: "" };
    };
    const snapshot = await captureWorkspaceSnapshot(root, { commandRunner });
    assert.match(snapshot.sourceRevision, /^sha256:[0-9a-f]{64}$/);
    assert.ok(snapshot.evidenceEntries.length >= 7);
    assert.ok(snapshot.evidenceEntries.every((entry) => entry.anchor.sourceKind === "workspace"));
    assert.ok(snapshot.evidenceEntries.every((entry) => entry.locator.kind === "command"));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

function mapResult(segment, frameBinding, anchorId) {
  const full = {
    frameId: frameBinding.frameId,
    frameDigest: frameBinding.frameDigest,
    segmentId: segment.segmentId,
    turnCoverage: segment.expectedTurnIds.map((turnId) => ({
      turnId,
      status: "summarized",
      claimIds: [`map-${turnId}`],
      reason: "captured",
    })),
    objectiveFacts: segment.expectedTurnIds.map((turnId) => ({
      claimId: `map-${turnId}`,
      kind: "objective",
      text: "Preserve the failure",
      anchors: [anchorId],
    })),
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

function reduceResult(anchorId, frameBinding) {
  return {
    frameId: frameBinding.frameId,
    frameDigest: frameBinding.frameDigest,
    continuationDirective: "Continue safely.",
    objective: {
      goal: frameBinding.frame.currentGoal.text,
      explicitExclusions: frameBinding.frame.explicitExclusions.map((item) => item.text),
    },
    constraints: [{
      claimId: "constraint-proof",
      kind: "constraint",
      text: "Keep proof",
      anchors: [anchorId],
    }],
    workspaceState: {
      summary: {
        claimId: "workspace-known",
        kind: "workspace_state",
        text: "Known",
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

async function bindFrame(prepared) {
  const stage = await prepareFrameStage(prepared.workDir);
  const input = JSON.parse(await fs.promises.readFile(stage.frameInputPath, "utf8"));
  const frame = {
    ...(input.formatVersion === 2 ? {
      formatVersion: 2,
      acceptedProposal: input.acceptedProposal,
      terminalStateClaim: input.terminalStateClaim,
    } : {}),
    frameId: input.expectedFrameId,
    currentGoal: input.latestUserGoal,
    taskType: "implementation",
    taskPhase: "implementing",
    explicitExclusions: input.explicitExclusions,
    preservationPolicy: input.preservationPolicy,
    anchors: input.requiredFrameAnchors,
  };
  await writeJson(stage.framePath, frame);
  return { ...await validateFrameStage(prepared.workDir), frame };
}

test("publication keeps the compact Evidence Index after managed cleanup", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-index-publish-"));
  try {
    const fixture = await createSourceFixture(root);
    const pack = await buildEvidencePack(SESSION_ID, { codexHome: fixture.codexHome, maxToolChars: 220 });
    const prepared = await prepareCompressionTask(
      {
        sessionId: SESSION_ID,
        outputPath: path.join(root, "handoff.md"),
        workRoot: root,
        maxChunkChars: 4_000,
      },
      { buildEvidencePack: async () => pack },
    );
    const frameBinding = await bindFrame(prepared);
    const mapAnchor = pack.turns[0].userMessages[0].anchors[0];
    for (const segment of prepared.segments) {
      await writeJson(segment.summaryPath, mapResult(segment, frameBinding, mapAnchor));
      await validateMapStage(prepared.workDir, segment.segmentId);
    }
    const reduce = await prepareReduceStage(prepared.workDir);
    const knownAnchor = pack.preservationLedger.requiredAnchors[0];
    await writeJson(reduce.reducedPath, reduceResult(knownAnchor, frameBinding));
    const published = await publishHandoff(prepared.workDir, {}, {
      verifyEvidenceIndex: async () => ({ valid: true }),
    });
    assert.equal(published.cleanupStatus, "removed");
    assert.equal(await fs.promises.stat(published.evidenceIndexPath).then(() => true), true);
    assert.equal(await fs.promises.access(prepared.workDir).then(() => true, () => false), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("publication fails when a Handoff fact references an unknown anchor", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-unknown-anchor-"));
  try {
    const fixture = await createSourceFixture(root);
    const pack = await buildEvidencePack(SESSION_ID, { codexHome: fixture.codexHome, maxToolChars: 220 });
    const prepared = await prepareCompressionTask(
      {
        sessionId: SESSION_ID,
        outputPath: path.join(root, "handoff.md"),
        workRoot: root,
        maxChunkChars: 4_000,
      },
      { buildEvidencePack: async () => pack },
    );
    const frameBinding = await bindFrame(prepared);
    const mapAnchor = pack.turns[0].userMessages[0].anchors[0];
    for (const segment of prepared.segments) {
      await writeJson(segment.summaryPath, mapResult(segment, frameBinding, mapAnchor));
      await validateMapStage(prepared.workDir, segment.segmentId);
    }
    const reduce = await prepareReduceStage(prepared.workDir);
    await writeJson(
      reduce.reducedPath,
      reduceResult("anchor-does-not-exist", frameBinding),
    );
    await assert.rejects(publishHandoff(prepared.workDir), { code: "UNKNOWN_EVIDENCE_ANCHOR" });
    await assert.rejects(fs.promises.access(prepared.outputPath));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
