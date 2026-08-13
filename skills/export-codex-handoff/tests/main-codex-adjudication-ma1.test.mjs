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
import { prepareCompressionTask } from "../scripts/lib/task-workflow.mjs";

const CLI_PATH = fileURLToPath(new URL("../scripts/export-handoff.mjs", import.meta.url));
const SESSION_ID = "00000000-0000-7000-8000-0000000000f0";
const TURN_ID = "00000000-0000-7000-8000-0000000000f1";
const SOURCE_REVISION = `sha256:${"b".repeat(64)}`;
const FRAME_DIGEST = `sha256:${"c".repeat(64)}`;
const PRIVATE_SENTINEL = "PRIVATE-SOURCE-PAYLOAD-MUST-NOT-PERSIST";

function evidencePack() {
  const entry = createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId: TURN_ID,
    eventOrdinal: 1,
    rolloutLine: 1,
    payloadPath: "/payload/content/0/text",
    value: "Exercise the durable Main Codex adjudication contract.",
    locator: { kind: "rollout_payload" },
  });
  const turns = [{
    turnId: TURN_ID,
    userMessages: [{
      text: "Exercise the durable Main Codex adjudication contract.",
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
    rolloutPath: "C:/synthetic/main-codex-adjudication-ma1.jsonl",
    sourceChars: 64,
    sourceBytes: 64,
    sourceRevision: SOURCE_REVISION,
    session: {
      id: SESSION_ID,
      cwd: "C:/synthetic/main-codex-adjudication-ma1",
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

function boundedRequest(overrides = {}) {
  return {
    phase: "pre-dispatch",
    failureOwner: "coordinator",
    diagnostic: {
      code: "LIVE_BUDGET_UNREACHABLE",
      message: "The pre-dispatch live budget cannot be met.",
    },
    artifact: {
      kind: "compression_frame",
      coordinates: {
        frameId: "frame-ma1-contract",
      },
    },
    immutableDigests: {
      frameDigest: FRAME_DIGEST,
    },
    acceptedWork: {
      acceptedMaps: 0,
      acceptedReceipts: 0,
    },
    allowedActions: [
      "repair_stage",
      "regenerate_stage",
    ],
    ...overrides,
  };
}

function repairDecision(state, overrides = {}) {
  return {
    runId: state.runId,
    requestId: state.activeRequest.requestId,
    requestDigest: state.activeRequest.requestDigest,
    action: {
      type: "repair_stage",
      phase: state.activeRequest.request.phase,
    },
    rationale: "Main Codex corrected the bounded pre-dispatch input.",
    ...overrides,
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

async function loadAdjudicationApi() {
  return import("../scripts/lib/task-workflow.mjs");
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
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
  });
}

async function createAwaitingRequest(prepared) {
  const { createAdjudicationRequest } = await loadAdjudicationApi();
  return createAdjudicationRequest(prepared.workDir, boundedRequest());
}

async function createApplyingRequest(prepared) {
  const {
    createAdjudicationRequest,
    submitAdjudicationDecision,
  } = await loadAdjudicationApi();
  const awaiting = await createAdjudicationRequest(
    prepared.workDir,
    boundedRequest(),
  );
  return submitAdjudicationDecision(
    prepared.workDir,
    repairDecision(awaiting),
  );
}

test("MA1 initializes an immutable contract and replays an evidence-safe request byte-stably", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma1-request-"));
  try {
    const prepared = await prepareWorkflow(root);
    assert.equal(
      prepared.adjudicationContractPath,
      path.join(prepared.workDir, "adjudication-contract.json"),
    );
    const contractBefore = await fs.promises.readFile(
      prepared.adjudicationContractPath,
      "utf8",
    );
    const contract = JSON.parse(contractBefore);
    assert.equal(contract.outputPath, prepared.outputPath);
    assert.equal(contract.evidenceIndexPath, prepared.evidenceIndexPath);
    assert.equal(contract.sourceRevision, SOURCE_REVISION);
    const {
      createAdjudicationRequest,
      inspectAdjudication,
    } = await loadAdjudicationApi();

    await assert.rejects(
      createAdjudicationRequest(prepared.workDir, boundedRequest({
        privateEvidence: {
          rawSourcePayload: PRIVATE_SENTINEL,
        },
      })),
      { code: "INVALID_ADJUDICATION_REQUEST" },
    );
    await assert.rejects(
      fs.promises.access(path.join(prepared.workDir, "adjudication")),
      { code: "ENOENT" },
    );

    const created = await createAdjudicationRequest(
      prepared.workDir,
      boundedRequest(),
    );
    const replayed = await inspectAdjudication(prepared.workDir);
    const replayedAgain = await inspectAdjudication(prepared.workDir);
    assert.equal(created.lifecycleState, "AWAITING_ADJUDICATION");
    assert.deepEqual(replayedAgain, replayed);
    assert.equal(JSON.stringify(replayedAgain), JSON.stringify(replayed));
    assert.equal(replayed.eventChain.eventCount, 1);
    assert.equal(replayed.activeRequest.status, "AWAITING_ADJUDICATION");
    assert.deepEqual(replayed.requests.map((entry) => entry.requestId), [
      replayed.activeRequest.requestId,
    ]);

    const requestText = await fs.promises.readFile(
      replayed.activeRequest.documentPath,
      "utf8",
    );
    assert.equal(requestText.includes(PRIVATE_SENTINEL), false);
    assert.deepEqual(Object.keys(JSON.parse(requestText)).sort(), [
      "acceptedWork",
      "allowedActions",
      "artifact",
      "contractDigest",
      "createdAt",
      "diagnostic",
      "failureOwner",
      "formatVersion",
      "immutableDigests",
      "kind",
      "phase",
      "requestId",
      "runId",
    ]);
    assert.equal(
      await fs.promises.readFile(prepared.adjudicationContractPath, "utf8"),
      contractBefore,
    );
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA1 digest-chain replay detects event deletion, reordering, and mutation", async (t) => {
  for (const fault of ["deletion", "reordering", "mutation"]) {
    await t.test(fault, async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `codex-ma1-${fault}-`));
      try {
        const prepared = await prepareWorkflow(root);
        await createApplyingRequest(prepared);
        const { inspectAdjudication } = await loadAdjudicationApi();
        const eventsDir = path.join(prepared.workDir, "adjudication", "events");
        const eventNames = (await fs.promises.readdir(eventsDir)).sort();
        assert.equal(eventNames.length, 2);
        const firstPath = path.join(eventsDir, eventNames[0]);
        const secondPath = path.join(eventsDir, eventNames[1]);

        if (fault === "deletion") {
          await fs.promises.rm(firstPath);
        } else if (fault === "reordering") {
          const first = await fs.promises.readFile(firstPath, "utf8");
          const second = await fs.promises.readFile(secondPath, "utf8");
          await fs.promises.writeFile(firstPath, second, "utf8");
          await fs.promises.writeFile(secondPath, first, "utf8");
        } else {
          const event = JSON.parse(await fs.promises.readFile(secondPath, "utf8"));
          event.eventType = "mutated_event";
          await fs.promises.writeFile(
            secondPath,
            `${JSON.stringify(event, null, 2)}\n`,
            "utf8",
          );
        }

        await assert.rejects(
          inspectAdjudication(prepared.workDir),
          {
            code: fault === "mutation"
              ? "ADJUDICATION_EVENT_INTEGRITY_MISMATCH"
              : "ADJUDICATION_EVENT_CHAIN_INVALID",
          },
        );
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("MA1 decisions bind the exact active request and invalid submissions change no ledger bytes", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma1-decision-"));
  try {
    const prepared = await prepareWorkflow(root);
    const awaiting = await createAwaitingRequest(prepared);
    const {
      inspectAdjudication,
      submitAdjudicationDecision,
    } = await loadAdjudicationApi();
    const adjudicationDir = path.join(prepared.workDir, "adjudication");
    const requestBefore = await fs.promises.readFile(
      awaiting.activeRequest.documentPath,
      "utf8",
    );

    const invalidCases = [
      {
        input: repairDecision(awaiting, {
          runId: `adjudication-run-${"e".repeat(64)}`,
        }),
        code: "ADJUDICATION_DECISION_BINDING_MISMATCH",
      },
      {
        input: repairDecision(awaiting, { requestDigest: `sha256:${"d".repeat(64)}` }),
        code: "ADJUDICATION_DECISION_BINDING_MISMATCH",
      },
      {
        input: repairDecision(awaiting, { requestId: "adjudication-request-stale" }),
        code: "ADJUDICATION_DECISION_BINDING_MISMATCH",
      },
      {
        input: repairDecision(awaiting, {
          action: {
            type: "relocate_publication",
            outputPath: path.join(root, "relocated.md"),
            evidenceIndexPath: path.join(root, "relocated.evidence.json"),
          },
        }),
        code: "ADJUDICATION_ACTION_NOT_ALLOWED",
      },
      {
        input: repairDecision(awaiting, {
          action: {
            type: "repair_stage",
            phase: "pre-dispatch",
            also: "regenerate_stage",
          },
        }),
        code: "INVALID_ADJUDICATION_DECISION",
      },
    ];
    for (const invalid of invalidCases) {
      const before = await directorySnapshot(adjudicationDir);
      await assert.rejects(
        submitAdjudicationDecision(prepared.workDir, invalid.input),
        { code: invalid.code },
      );
      assert.deepEqual(await directorySnapshot(adjudicationDir), before);
      assert.equal(
        (await inspectAdjudication(prepared.workDir)).lifecycleState,
        "AWAITING_ADJUDICATION",
      );
    }

    const decisionPath = path.join(root, "decision.json");
    await fs.promises.writeFile(
      decisionPath,
      `${JSON.stringify(repairDecision(awaiting), null, 2)}\n`,
      "utf8",
    );
    const submitted = runCli([
      "adjudicate",
      prepared.workDir,
      "--submit",
      decisionPath,
    ]);
    assert.equal(submitted.status, 0, submitted.stderr);
    const applying = JSON.parse(submitted.stdout);
    assert.equal(applying.lifecycleState, "APPLYING_ADJUDICATION");
    assert.equal(applying.activeRequest.requestId, awaiting.activeRequest.requestId);
    assert.equal(applying.activeRequest.status, "APPLYING_ADJUDICATION");
    assert.equal(applying.activeRequest.decision.action.type, "repair_stage");
    assert.deepEqual(applying.requests.map((entry) => ({
      requestId: entry.requestId,
      status: entry.status,
    })), [{
      requestId: awaiting.activeRequest.requestId,
      status: "APPLYING_ADJUDICATION",
    }]);
    assert.equal(
      await fs.promises.readFile(awaiting.activeRequest.documentPath, "utf8"),
      requestBefore,
    );

    const afterValid = await directorySnapshot(adjudicationDir);
    await assert.rejects(
      submitAdjudicationDecision(prepared.workDir, repairDecision(awaiting)),
      { code: "ADJUDICATION_REQUEST_NOT_AWAITING" },
    );
    assert.deepEqual(await directorySnapshot(adjudicationDir), afterValid);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA1 adjudicate --inspect exposes stable replay without mutating the run", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma1-cli-"));
  try {
    const prepared = await prepareWorkflow(root);
    const first = runCli(["adjudicate", prepared.workDir, "--inspect"]);
    assert.equal(first.status, 0, first.stderr);
    const second = runCli(["adjudicate", prepared.workDir, "--inspect"]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    const state = JSON.parse(first.stdout);
    assert.equal(state.lifecycleState, "RUNNING");
    assert.equal(state.activeRequest, null);
    assert.equal(state.eventChain.eventCount, 0);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
