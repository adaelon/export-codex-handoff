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
import { captureAdjudicationFailure } from "../scripts/lib/adjudication.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { ExportHandoffError } from "../scripts/lib/source-thread.mjs";
import { prepareCompressionTask } from "../scripts/lib/task-workflow.mjs";
import { comparePackageTrees } from "./lib/action-ready-acceptance.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const REPO_ROOT = path.resolve(SKILL_DIR, "..", "..");
const CLI_PATH = path.join(SKILL_DIR, "scripts", "export-handoff.mjs");
const INSTALLED_SKILL_ENV = "EXPORT_CODEX_HANDOFF_INSTALLED_DIR";
const LIVE_ACCEPTANCE_ROOT_ENV = "EXPORT_CODEX_HANDOFF_MA5_ACCEPTANCE_DIR";
const SESSION_ID = "00000000-0000-7000-8000-000000000500";
const TURN_ID = "00000000-0000-7000-8000-000000000501";
const EXACT_GOAL = "Exercise the MA5 Main Codex operator loop without user adjudication.";
const REPAIR_ISSUES = [{
  code: "DETERMINISTIC_AUTHORITY_EXCLUSION",
  fieldPath: "criticalExclusions[0].evidenceIndex",
  message: "A frozen Frame authority already retains this Critical Anchor.",
  correctionHint: "Remove only this exclusion entry.",
}];

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function parseSuccess(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function parseCaptured(result, expectedCode) {
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, expectedCode);
  assert.equal(error.details.adjudication.lifecycleState, "AWAITING_ADJUDICATION");
  return error;
}

async function writeJson(target, value) {
  await fs.promises.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function buildFixtureEvidence(root) {
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
    claimId: "claim-ma5-terminal-state",
    kind: "terminal_state",
    text: "The synthetic MA5 Source Thread ended before compression completed.",
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
        abortReason: "synthetic MA5 fixture",
        terminationAnchors: [entry.anchor.anchorId],
        lastAssistant: null,
        orderedEvents: [],
      },
    },
    terminalState: {
      formatVersion: 1,
      sourceTerminal: { turnId: TURN_ID, status: "aborted" },
      workspaceObserved: {
        observedAt: workspace.observedAt,
        gitStatus: "not_repository",
      },
    },
    terminalStateClaim,
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
  const pack = await buildFixtureEvidence(root);
  return prepareCompressionTask({
    sessionId: SESSION_ID,
    outputPath: path.join(root, "published", "handoff.md"),
    evidenceIndexPath: path.join(root, "published", "handoff.evidence.json"),
    workRoot: path.join(root, "work"),
    maxChars: 12_000,
    maxChunkChars: 40_000,
  }, { buildEvidencePack: async () => pack });
}

async function submitDecision(prepared, state, action, rationale) {
  const decisionPath = path.join(
    prepared.workDir,
    `ma5-decision-${state.activeRequest.requestId}.json`,
  );
  await writeJson(decisionPath, {
    runId: state.runId,
    requestId: state.activeRequest.requestId,
    requestDigest: state.activeRequest.requestDigest,
    action,
    rationale,
  });
  return parseSuccess(runCli([
    "adjudicate",
    prepared.workDir,
    "--submit",
    decisionPath,
  ]));
}

test("MA5 operator contract owns every captured diagnostic until PUBLISHED", () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const workerContract = fs.readFileSync(
    path.join(SKILL_DIR, "references", "continuation-map-v2-worker-contract.md"),
    "utf8",
  );
  const architecture = fs.readFileSync(
    path.join(REPO_ROOT, "docs", "architecture.md"),
    "utf8",
  );

  assert.match(skill, /^## Main Codex adjudication loop$/mu);
  assert.match(skill, /while .*lifecycleState.*PUBLISHED/iu);
  assert.match(skill, /adjudicate <WORK_DIR> --inspect/u);
  assert.match(skill, /adjudicate <WORK_DIR> --capture <DIAGNOSTIC_CODE>/u);
  assert.match(skill, /adjudicate <WORK_DIR> --submit <DECISION_FILE>/u);
  assert.match(skill, /adjudicate <WORK_DIR> --apply/u);
  assert.match(skill, /resume\.command/u);
  assert.match(skill, /Main Codex owns every Adjudication Decision/u);
  assert.match(skill, /never ask the user to adjudicate an internal workflow diagnostic/iu);
  assert.match(skill, /choose `publish_degraded`/u);
  assert.match(skill, /same Compression Run/u);
  assert.doesNotMatch(skill, /On `MAP_WORKER_EXHAUSTED`, stop and\s+report/iu);
  assert.doesNotMatch(skill, /Stop without retry or publication on/iu);
  assert.doesNotMatch(skill, /On any other failure, stop and report/iu);

  assert.match(workerContract, /Captured Workflow Diagnostic/u);
  assert.match(workerContract, /Main Codex Adjudication/u);
  assert.match(workerContract, /same Compression Run/u);
  assert.match(workerContract, /must not ask the user to choose the repair action/iu);
  assert.match(architecture, /MA1-MA5 are implemented/u);
  assert.match(architecture, /operator loop/iu);
});

test("MA5 captures a pre-worker capacity diagnostic for Main Codex degradation", async () => {
  const configuredRoot = process.env[LIVE_ACCEPTANCE_ROOT_ENV]?.trim();
  const root = configuredRoot
    ? path.resolve(configuredRoot)
    : await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma5-capacity-"));
  try {
    if (configuredRoot) await fs.promises.mkdir(root, { recursive: true });
    const prepared = await prepareWorkflow(root);
    const captured = parseCaptured(runCli([
      "adjudicate",
      prepared.workDir,
      "--capture",
      "MAP_WORKER_UNAVAILABLE",
    ]), "MAP_WORKER_UNAVAILABLE");
    const inspected = parseSuccess(runCli([
      "adjudicate",
      prepared.workDir,
      "--inspect",
    ]));
    assert.equal(inspected.runId, captured.details.adjudication.runId);
    assert.equal(inspected.activeRequest.request.phase, "schedule-map");
    assert.equal(inspected.activeRequest.request.failureOwner, "coordinator");
    assert.deepEqual(inspected.activeRequest.request.allowedActions, [
      "retry_stage",
      "publish_degraded",
    ]);
    await submitDecision(
      prepared,
      inspected,
      { type: "publish_degraded" },
      "No isolated Worker slot exists; publish the verified pre-MAP evidence explicitly degraded.",
    );
    const published = parseSuccess(runCli([
      "adjudicate",
      prepared.workDir,
      "--apply",
    ]));
    assert.equal(published.lifecycleState, "PUBLISHED");
    assert.equal(published.result.effect, "degraded_handoff_published");
    const verified = parseSuccess(runCli([
      "verify-evidence",
      prepared.evidenceIndexPath,
    ]));
    assert.equal(verified.valid, true);
    if (configuredRoot) {
      const finalState = parseSuccess(runCli([
        "adjudicate",
        prepared.workDir,
        "--inspect",
      ]));
      await writeJson(path.join(root, "ma5-live-acceptance.json"), {
        formatVersion: 1,
        kind: "codex-handoff-ma5-live-acceptance",
        generatedAt: new Date().toISOString(),
        skillDir: SKILL_DIR,
        diagnosticCode: "MAP_WORKER_UNAVAILABLE",
        runId: finalState.runId,
        lifecycleState: finalState.lifecycleState,
        eventCount: finalState.eventChain.eventCount,
        requestIds: finalState.requests.map((entry) => entry.requestId),
        decisionIds: finalState.requests.map((entry) => entry.decisionId),
        applicationIds: finalState.applications.map(
          (entry) => entry.applicationId,
        ),
        publication: published.result,
        evidenceVerification: verified,
        workDir: prepared.workDir,
      });
    }
  } finally {
    if (!configuredRoot) {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  }
});

test("MA5 capture ingress rejects any non-allowlisted operator diagnostic", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma5-capture-"));
  try {
    const prepared = await prepareWorkflow(root);
    const rejected = runCli([
      "adjudicate",
      prepared.workDir,
      "--capture",
      "PRIVATE_OR_UNBOUNDED_DIAGNOSTIC",
    ]);
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stderr).code, "INVALID_ADJUDICATION_CAPTURE");
    const inspected = parseSuccess(runCli([
      "adjudicate",
      prepared.workDir,
      "--inspect",
    ]));
    assert.equal(inspected.lifecycleState, "RUNNING");
    assert.deepEqual(inspected.requests, []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA5 persists exact evidence-safe MAP repair issues in the active request", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma5-issues-"));
  try {
    const prepared = await prepareWorkflow(root);
    await assert.rejects(
      captureAdjudicationFailure(
        prepared.workDir,
        "validate-map-check",
        new ExportHandoffError(
          "MAP_REPAIR_REQUIRED",
          "The MAP candidate requires bounded correction.",
          { issues: REPAIR_ISSUES },
        ),
        {
          segmentId: "segment-ma5-001",
          dispatchId: "dispatch-ma5-001",
        },
      ),
      { code: "MAP_REPAIR_REQUIRED" },
    );
    const inspected = parseSuccess(runCli([
      "adjudicate",
      prepared.workDir,
      "--inspect",
    ]));
    assert.deepEqual(
      inspected.activeRequest.request.diagnostic.issues,
      REPAIR_ISSUES,
    );
    assert.deepEqual(inspected.activeRequest.request.artifact.coordinates, {
      command: "validate-map-check",
      segmentId: "segment-ma5-001",
      dispatchId: "dispatch-ma5-001",
    });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA5 fault injection retries, resumes, then degrades the same Compression Run", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ma5-loop-"));
  try {
    const prepared = await prepareWorkflow(root);
    const firstFailure = parseCaptured(
      runCli(["validate-frame", prepared.workDir]),
      "FRAME_INPUT_MISSING",
    );
    const firstInspection = parseSuccess(runCli([
      "adjudicate",
      prepared.workDir,
      "--inspect",
    ]));
    assert.equal(firstInspection.runId, firstFailure.details.adjudication.runId);
    assert.equal(firstInspection.requests.length, 1);

    const firstApplying = await submitDecision(
      prepared,
      firstInspection,
      { type: "retry_stage", phase: "validate-frame" },
      "Retry the exact responsible stage once before selecting degradation.",
    );
    assert.equal(firstApplying.lifecycleState, "APPLYING_ADJUDICATION");
    const resumed = parseSuccess(runCli([
      "adjudicate",
      prepared.workDir,
      "--apply",
    ]));
    assert.equal(resumed.lifecycleState, "RUNNING");
    assert.deepEqual(resumed.result.resume.command, [
      "validate-frame",
      prepared.workDir,
    ]);

    const repeatedFailure = parseCaptured(
      runCli(resumed.result.resume.command),
      "FRAME_INPUT_MISSING",
    );
    assert.equal(repeatedFailure.details.adjudication.runId, firstInspection.runId);
    const secondInspection = parseSuccess(runCli([
      "adjudicate",
      prepared.workDir,
      "--inspect",
    ]));
    assert.equal(secondInspection.requests.length, 2);
    assert.equal(secondInspection.requests[0].status, "APPLIED");
    assert.equal(secondInspection.activeRequest.status, "AWAITING_ADJUDICATION");

    const secondApplying = await submitDecision(
      prepared,
      secondInspection,
      { type: "publish_degraded" },
      "The same diagnostic repeated after one bounded retry; publish verified evidence explicitly degraded.",
    );
    assert.equal(secondApplying.lifecycleState, "APPLYING_ADJUDICATION");
    const published = parseSuccess(runCli([
      "adjudicate",
      prepared.workDir,
      "--apply",
    ]));
    assert.equal(published.runId, firstInspection.runId);
    assert.equal(published.lifecycleState, "PUBLISHED");
    assert.equal(published.result.effect, "degraded_handoff_published");

    const verified = parseSuccess(runCli([
      "verify-evidence",
      prepared.evidenceIndexPath,
    ]));
    assert.equal(verified.valid, true);
    const handoff = await fs.promises.readFile(prepared.outputPath, "utf8");
    assert.match(handoff, /^# Degraded Codex Handoff/mu);
    assert.equal(handoff.includes(EXACT_GOAL), true);
    const finalInspection = parseSuccess(runCli([
      "adjudicate",
      prepared.workDir,
      "--inspect",
    ]));
    assert.equal(finalInspection.lifecycleState, "PUBLISHED");
    assert.equal(finalInspection.requests.length, 2);
    assert.equal(finalInspection.applications.length, 2);
    assert.equal(finalInspection.eventChain.eventCount, 6);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("MA5 package comparison supports the installed Skill mirror", async () => {
  const configured = process.env[INSTALLED_SKILL_ENV]?.trim();
  const mirrorDir = configured ? path.resolve(configured) : SKILL_DIR;
  if (configured) {
    assert.notEqual(
      mirrorDir,
      SKILL_DIR,
      `${INSTALLED_SKILL_ENV} must name the installed package, not repository source`,
    );
  }
  const comparison = await comparePackageTrees(SKILL_DIR, mirrorDir);
  assert.equal(comparison.matches, true, JSON.stringify(comparison));
  assert.ok(comparison.fileCount >= 73);
  assert.match(comparison.packageDigest, /^sha256:[0-9a-f]{64}$/u);
});
