import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildEvidenceReferenceDictionary,
  resolveEvidenceReferences,
} from "../scripts/lib/frame-projection.mjs";
import {
  buildContinuationPreservationLedger,
  createEvidenceEntry,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import {
  CONTINUATION_MAP_CANDIDATE_MAX_CHARS,
  CONTINUATION_MAP_RESULT_MODE,
} from "../scripts/lib/map-worker.mjs";
import {
  completeContinuationMapResult,
  validateContinuationMapResult,
} from "../scripts/lib/validation.mjs";
import {
  checkMapDispatch,
  claimMapDispatch,
  completeMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  scheduleNextMapWave,
  validateFrameStage,
} from "../scripts/lib/task-workflow.mjs";

const SESSION_ID = "00000000-0000-7000-8000-0000000000a3";
const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(
  "skills/export-codex-handoff/scripts/export-handoff.mjs",
);

function sourceEntry(index, text) {
  return createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId: `turn-r3-${index}`,
    eventOrdinal: index,
    rolloutLine: index,
    payloadPath: "/payload/content/0/text",
    value: text,
    locator: { kind: "rollout_payload" },
  });
}

function directFixture() {
  const first = sourceEntry(1, "Implement continuation-map-v1.");
  const second = sourceEntry(2, "Verify exact anchor derivation.");
  const preservationPolicy = buildContinuationPreservationLedger(
    SOURCE_REVISION,
    [first, second],
    {
      turns: [{
        turnId: first.anchor.turnId,
        userMessages: [{
          text: "Implement continuation-map-v1.",
          anchors: [first.anchor.anchorId],
        }],
        toolReceipts: [{ status: "error", outputAnchor: second.anchor.anchorId }],
      }],
    },
  );
  const frame = {
    frameId: "frame-r3",
    currentGoal: {
      claimId: "goal-r3",
      kind: "current_goal",
      text: "Implement continuation-map-v1.",
      anchors: [first.anchor.anchorId],
    },
    taskType: "implementation",
    taskPhase: "implementing",
    explicitExclusions: [],
    preservationPolicy,
    anchors: preservationPolicy.requiredAnchors,
  };
  const frozenFrame = {
    frame,
    frameId: frame.frameId,
    frameDigest: `sha256:${"f".repeat(64)}`,
  };
  const chunk = {
    segmentId: "segment-r3",
    stage: "segment_map",
    expectedTurnIds: [first.anchor.turnId, second.anchor.turnId],
    turns: [
      { turnId: first.anchor.turnId, userMessages: [{ anchors: [first.anchor.anchorId] }] },
      { turnId: second.anchor.turnId, toolReceipts: [{ outputAnchor: second.anchor.anchorId }] },
    ],
  };
  const dictionary = buildEvidenceReferenceDictionary(frozenFrame, chunk);
  return { first, second, frozenFrame, chunk, dictionary };
}

function continuationCandidate(fixture) {
  return {
    formatVersion: 1,
    kind: "codex-handoff-continuation-map",
    frameId: fixture.frozenFrame.frameId,
    frameDigest: fixture.frozenFrame.frameDigest,
    segmentId: fixture.chunk.segmentId,
    claims: [
      {
        localId: 1,
        kind: "objective",
        text: "Implement continuation-map-v1.",
        evidenceIndexes: [1],
      },
      {
        localId: 2,
        kind: "important_location",
        text: "skills/export-codex-handoff/scripts/lib/validation.mjs",
        evidenceIndexes: [2],
      },
      {
        localId: 3,
        kind: "verification",
        text: "node --test continuation-grade-r3.test.mjs => pass",
        evidenceIndexes: [2],
      },
    ],
    relations: {
      decisions: [],
      attempts: [],
      verification: [{
        claim: 3,
        command: "node --test continuation-grade-r3.test.mjs",
        result: "pass",
      }],
    },
    criticalExclusions: [],
  };
}

function workflowPack() {
  const text = "Implement R3 continuation-map-v1; do not implement R4.";
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
    rolloutPath: "C:/synthetic/r3-rollout.jsonl",
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
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source,
    workspace,
    entries: [entry],
    preservationLedger,
  });
  return { ...pack, evidenceChars: JSON.stringify(pack).length, evidenceIndex };
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function preparedContinuationWorkflow(root) {
  const pack = workflowPack();
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
  return { ...prepared, ...validated, dispatch, dictionary };
}

test("R3 diagnostic-equivalent candidate authors each Claim once without anchors or bindings", () => {
  const fixture = directFixture();
  const candidate = continuationCandidate(fixture);
  const serializedCandidate = JSON.stringify(candidate);

  assert.equal(serializedCandidate.includes("claimBindings"), false);
  assert.equal(serializedCandidate.includes("anchor-"), false);
  assert.equal(serializedCandidate.includes("claimId"), false);
  validateContinuationMapResult(candidate, fixture.dictionary, fixture.frozenFrame);

  const completed = completeContinuationMapResult(
    candidate,
    fixture.dictionary,
    fixture.frozenFrame,
  );
  for (const claim of candidate.claims) {
    assert.equal(JSON.stringify(completed).split(claim.text).length - 1, 1);
  }
  assert.deepEqual(
    completed.claims.map(({ kind }) => kind),
    ["objective", "important_location", "verification"],
  );
});

test("R3 invalid local evidence references fail deterministically", () => {
  const fixture = directFixture();
  const candidate = continuationCandidate(fixture);
  candidate.claims[0].evidenceIndexes = [999];

  assert.throws(
    () => validateContinuationMapResult(candidate, fixture.dictionary, fixture.frozenFrame),
    { code: "INVALID_EVIDENCE_REFERENCE" },
  );
});

test("R3 completion derives byte-exact anchors and global relation references", () => {
  const fixture = directFixture();
  const candidate = continuationCandidate(fixture);
  candidate.claims.push(
    { localId: 4, kind: "decision", text: "Keep completion deterministic.", evidenceIndexes: [1, 2] },
    { localId: 5, kind: "rationale", text: "Workers must not invent anchors.", evidenceIndexes: [2] },
  );
  candidate.relations.decisions.push({
    statement: 4,
    rationale: [5],
    status: "active",
    supersedes: [],
  });

  const completed = completeContinuationMapResult(
    candidate,
    fixture.dictionary,
    fixture.frozenFrame,
  );
  const decision = completed.claims.find(({ kind }) => kind === "decision");
  const rationale = completed.claims.find(({ kind }) => kind === "rationale");
  assert.deepEqual(
    decision.anchors,
    resolveEvidenceReferences(fixture.dictionary, [1, 2]),
  );
  assert.deepEqual(
    new Set(decision.anchors),
    new Set([fixture.first.anchor.anchorId, fixture.second.anchor.anchorId]),
  );
  assert.equal(completed.relations.decisions[0].statement, decision.claimId);
  assert.deepEqual(completed.relations.decisions[0].rationale, [rationale.claimId]);
  assert.match(decision.claimId, /^claim-[0-9a-f]{64}$/u);
});

test("R3 continuation workflow binds a 4k raw candidate and completes through non-consuming check", async () => {
  const root = await fs.promises.mkdtemp(path.join(process.cwd(), "codex-r3-workflow-"));
  try {
    const prepared = await preparedContinuationWorkflow(root);
    assert.equal(prepared.mapResultMode, CONTINUATION_MAP_RESULT_MODE);
    assert.equal(prepared.dispatch.mapResultMode, CONTINUATION_MAP_RESULT_MODE);
    assert.equal(
      prepared.dispatch.maxMapOutputChars,
      CONTINUATION_MAP_CANDIDATE_MAX_CHARS,
    );
    await claimMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
      "worker-r3",
    );

    const candidate = {
      formatVersion: 1,
      kind: "codex-handoff-continuation-map",
      frameId: prepared.frameId,
      frameDigest: prepared.frameDigest,
      segmentId: prepared.dispatch.segmentId,
      claims: [{
        localId: 1,
        kind: "objective",
        text: "x".repeat(CONTINUATION_MAP_CANDIDATE_MAX_CHARS),
        evidenceIndexes: [1],
      }],
      relations: { decisions: [], attempts: [], verification: [] },
      criticalExclusions: [],
    };
    await writeJson(prepared.dispatch.summaryPath, candidate);
    await assert.rejects(
      checkMapDispatch(
        prepared.workDir,
        prepared.dispatch.segmentId,
        prepared.dispatch.dispatchId,
      ),
      { code: "MAP_OUTPUT_TOO_LARGE" },
    );

    candidate.claims[0].text = "Implement continuation-map-v1.";
    await writeJson(prepared.dispatch.summaryPath, candidate);
    const checkedProcess = await execFileAsync(process.execPath, [
      CLI_PATH,
      "validate-map",
      prepared.workDir,
      prepared.dispatch.segmentId,
      "--check",
      prepared.dispatch.dispatchId,
    ]);
    const checked = JSON.parse(checkedProcess.stdout);
    assert.equal(checked.valid, true);
    const receipt = await completeMapDispatch(
      prepared.workDir,
      prepared.dispatch.segmentId,
      prepared.dispatch.dispatchId,
    );
    assert.match(receipt.summaryDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(receipt.completedSummaryDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(receipt.rawMapOutputChars <= CONTINUATION_MAP_CANDIDATE_MAX_CHARS);
    assert.ok(receipt.completedMapOutputChars > 0);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
