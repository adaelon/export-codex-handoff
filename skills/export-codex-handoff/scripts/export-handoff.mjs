#!/usr/bin/env node

import fs from "node:fs";

import {
  captureAdjudicationFailure,
  inspectAdjudication,
  submitAdjudicationDecision,
  withAdjudicationCapture,
} from "./lib/adjudication.mjs";
import {
  retrieveEvidenceFromFile,
  verifyEvidenceIndexFile,
} from "./lib/evidence-index.mjs";
import { MAP_GENERATION_OBSERVATION_MAX_BYTES } from "./lib/performance-calibration.mjs";
import { ExportHandoffError } from "./lib/source-thread.mjs";
import {
  acceptMapReceipt,
  applyAdjudicationDecision,
  checkMapDispatch,
  checkReduceStage,
  claimMapDispatch,
  completeMapDispatch,
  prepareCompressionTask,
  prepareFrameStage,
  prepareReduceStage,
  publishHandoff,
  recordMapGenerationMetric,
  scheduleNextMapWave,
  validateFrameStage,
  validateMapStage,
} from "./lib/task-workflow.mjs";

function usage() {
  return `Usage:
  node export-handoff.mjs prepare <SESSION_UUID> [options]
  node export-handoff.mjs prepare-frame <WORK_DIR>
  node export-handoff.mjs validate-frame <WORK_DIR>
  node export-handoff.mjs validate-map <WORK_DIR> <SEGMENT_ID> [--claim <DISPATCH_ID> --worker <WORKER_ID> | --check <DISPATCH_ID> | --complete <DISPATCH_ID> | --accept <DISPATCH_ID>]
  node export-handoff.mjs record-map-metric <WORK_DIR> <SEGMENT_ID> <DISPATCH_ID> <OBSERVATION_FILE>
  node export-handoff.mjs schedule-map <WORK_DIR> <AVAILABLE_SLOTS>
  node export-handoff.mjs prepare-reduce <WORK_DIR>
  node export-handoff.mjs validate-reduce <WORK_DIR> --check
  node export-handoff.mjs publish <WORK_DIR> [--keep-workdir]
  node export-handoff.mjs adjudicate <WORK_DIR> --inspect
  node export-handoff.mjs adjudicate <WORK_DIR> --capture <DIAGNOSTIC_CODE>
  node export-handoff.mjs adjudicate <WORK_DIR> --submit <DECISION_FILE>
  node export-handoff.mjs adjudicate <WORK_DIR> --apply
  node export-handoff.mjs retrieve <EVIDENCE_INDEX> <ANCHOR_ID>
  node export-handoff.mjs verify-evidence <EVIDENCE_INDEX>

Prepare options:
  --output <path>          Handoff path (default: handoff-<UUID>.md)
  --evidence-index <path> Published Evidence Index path (default: Handoff basename.evidence.json)
  --max-chars <count>      Maximum rendered Handoff characters (default: 40000)
  --index-chars <count>    Maximum published Evidence Index characters (default: 1000000)
  --chunk-chars <count>    Requested evidence budget (default: 140000; continuation derives a lower total-input-safe cap)
  --frame-projection-chars <count> Maximum Frame Projection characters (default: 20000)
  --map-input-chars <count> Maximum evidence, dictionary, and projection characters (default: 100000)
  --map-output-chars <count> Maximum aggregate accepted MAP output characters (default: 3x REDUCE target for sparse; 1x for continuation)
  --map-result-mode <mode>  MAP contract: sparse-map-v1 (default), continuation-map-v1, or continuation-map-v2
  --codex-home <path>      Override CODEX_HOME for Source Thread discovery
  --help                   Show this help

MAP wave scheduling and optional provider timing:
  1. Before every wave, including wave 1, observe fresh dedicated slots and use schedule-map.
  2. schedule-map durably admits min(pending, slots) until it reports complete; zero slots or an
     expired workflow deadline enters adjudication without admitting another dispatch.
  3. Provider timing never controls admission. When the surface exposes a complete admitted-wave
     set, use record-map-metric with provider-reported latency only; otherwise record no metric.
  4. A complete provider-timing set adds a performance projection, but an over-target projection
     remains advisory and does not remove admitted dispatches.
  Never substitute coordinator or harness elapsed time for provider latency.`;
}

function requireValue(args, index, option) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function integerValue(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${option} must be an integer`);
  return parsed;
}

function parsePrepare(args) {
  const sessionId = args[0];
  if (!sessionId || sessionId.startsWith("--")) throw new Error("SESSION_UUID is required");
  const options = { sessionId };
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const value = requireValue(args, index, option);
    index += 1;
    if (option === "--output") options.outputPath = value;
    else if (option === "--evidence-index") options.evidenceIndexPath = value;
    else if (option === "--max-chars") options.maxChars = integerValue(value, option);
    else if (option === "--index-chars") {
      options.maxEvidenceIndexChars = integerValue(value, option);
    }
    else if (option === "--chunk-chars") options.maxChunkChars = integerValue(value, option);
    else if (option === "--frame-projection-chars") {
      options.maxFrameProjectionChars = integerValue(value, option);
    }
    else if (option === "--map-input-chars") {
      options.maxMapInputChars = integerValue(value, option);
    }
    else if (option === "--map-output-chars") {
      options.maxAggregateMapOutputChars = integerValue(value, option);
    }
    else if (option === "--map-result-mode") options.mapResultMode = value;
    else if (option === "--codex-home") options.codexHome = value;
    else throw new Error(`Unknown option: ${option}`);
  }
  return options;
}

function requirePositional(args, index, label) {
  if (!args[index] || args[index].startsWith("--")) throw new Error(`${label} is required`);
  return args[index];
}

function parseMapWorkerAction(args) {
  const workDir = requirePositional(args, 0, "WORK_DIR");
  const segmentId = requirePositional(args, 1, "SEGMENT_ID");
  if (args.length === 2) return { action: "direct", workDir, segmentId };
  if (args[2] === "--claim") {
    const dispatchId = requireValue(args, 2, "--claim");
    if (args[4] !== "--worker") throw new Error("--claim requires --worker <WORKER_ID>");
    const workerId = requireValue(args, 4, "--worker");
    if (args.length !== 6) throw new Error(`Unknown option: ${args[6]}`);
    return { action: "claim", workDir, segmentId, dispatchId, workerId };
  }
  if (args[2] === "--complete") {
    const dispatchId = requireValue(args, 2, "--complete");
    if (args.length !== 4) throw new Error(`Unknown option: ${args[4]}`);
    return { action: "complete", workDir, segmentId, dispatchId };
  }
  if (args[2] === "--check") {
    const dispatchId = requireValue(args, 2, "--check");
    if (args.length !== 4) throw new Error(`Unknown option: ${args[4]}`);
    return { action: "check", workDir, segmentId, dispatchId };
  }
  if (args[2] === "--accept") {
    const dispatchId = requireValue(args, 2, "--accept");
    if (args.length !== 4) throw new Error(`Unknown option: ${args[4]}`);
    return { action: "accept", workDir, segmentId, dispatchId };
  }
  throw new Error(`Unknown option: ${args[2]}`);
}

function parseMapMetricAction(args) {
  if (args.length !== 4) {
    throw new Error(
      "record-map-metric requires WORK_DIR SEGMENT_ID DISPATCH_ID OBSERVATION_FILE",
    );
  }
  return {
    workDir: requirePositional(args, 0, "WORK_DIR"),
    segmentId: requirePositional(args, 1, "SEGMENT_ID"),
    dispatchId: requirePositional(args, 2, "DISPATCH_ID"),
    observationPath: requirePositional(args, 3, "OBSERVATION_FILE"),
  };
}

function parseScheduleMapAction(args) {
  if (args.length !== 2) {
    throw new Error("schedule-map requires WORK_DIR AVAILABLE_SLOTS");
  }
  return {
    workDir: requirePositional(args, 0, "WORK_DIR"),
    availableSlots: integerValue(
      requirePositional(args, 1, "AVAILABLE_SLOTS"),
      "AVAILABLE_SLOTS",
    ),
  };
}

function parseAdjudicationAction(args) {
  const workDir = requirePositional(args, 0, "WORK_DIR");
  if (args.length === 2 && args[1] === "--inspect") {
    return { action: "inspect", workDir };
  }
  if (args.length === 2 && args[1] === "--apply") {
    return { action: "apply", workDir };
  }
  if (args.length === 3 && args[1] === "--submit") {
    return {
      action: "submit",
      workDir,
      decisionPath: requirePositional(args, 2, "DECISION_FILE"),
    };
  }
  if (args.length === 3 && args[1] === "--capture") {
    return {
      action: "capture",
      workDir,
      diagnosticCode: requirePositional(args, 2, "DIAGNOSTIC_CODE"),
    };
  }
  throw new Error(
    "adjudicate requires --inspect, --capture <DIAGNOSTIC_CODE>, --submit <DECISION_FILE>, or --apply",
  );
}

const OPERATOR_CAPTURE_DIAGNOSTICS = Object.freeze({
  MAP_WORKER_UNAVAILABLE: Object.freeze({
    phase: "schedule-map",
    message: "No fresh dedicated MAP Worker slot is available before dispatch",
    context: Object.freeze({ availableSlots: 0 }),
  }),
});

function operatorCaptureSpec(code) {
  const spec = OPERATOR_CAPTURE_DIAGNOSTICS[code];
  if (!spec) {
    throw new ExportHandoffError(
      "INVALID_ADJUDICATION_CAPTURE",
      "Only MAP_WORKER_UNAVAILABLE may enter through --capture",
    );
  }
  return spec;
}

async function readBoundedObservationDocument(target) {
  const handle = await fs.promises.open(target, "r");
  try {
    const buffer = Buffer.alloc(MAP_GENERATION_OBSERVATION_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      0,
    );
    if (bytesRead > MAP_GENERATION_OBSERVATION_MAX_BYTES) {
      throw new ExportHandoffError(
        "MAP_GENERATION_OBSERVATION_TOO_LARGE",
        `Provider observation document exceeds ${MAP_GENERATION_OBSERVATION_MAX_BYTES} bytes`,
      );
    }
    try {
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ExportHandoffError(
          "INVALID_MAP_GENERATION_OBSERVATION_DOCUMENT",
          "Provider observation document must contain exactly one JSON value",
        );
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function readBoundedDecisionDocument(target) {
  const maximumBytes = 32_768;
  const handle = await fs.promises.open(target, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes) {
      throw new ExportHandoffError(
        "ADJUDICATION_DECISION_TOO_LARGE",
        `Adjudication Decision document exceeds ${maximumBytes} bytes`,
      );
    }
    try {
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ExportHandoffError(
          "INVALID_ADJUDICATION_DECISION_DOCUMENT",
          "Adjudication Decision document must contain exactly one JSON value",
        );
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function dispatch(command, args) {
  if (command === "prepare") return prepareCompressionTask(parsePrepare(args));
  if (command === "prepare-frame") {
    const workDir = requirePositional(args, 0, "WORK_DIR");
    return withAdjudicationCapture(
      workDir,
      "prepare-frame",
      () => prepareFrameStage(workDir),
    );
  }
  if (command === "validate-frame") {
    const workDir = requirePositional(args, 0, "WORK_DIR");
    return withAdjudicationCapture(
      workDir,
      "validate-frame",
      () => validateFrameStage(workDir),
    );
  }
  if (command === "validate-map") {
    const action = parseMapWorkerAction(args);
    if (action.action === "claim") {
      return withAdjudicationCapture(
        action.workDir,
        "validate-map-claim",
        () => claimMapDispatch(
          action.workDir,
          action.segmentId,
          action.dispatchId,
          action.workerId,
        ),
        action,
      );
    }
    if (action.action === "complete") {
      return withAdjudicationCapture(
        action.workDir,
        "validate-map-complete",
        () => completeMapDispatch(
          action.workDir,
          action.segmentId,
          action.dispatchId,
        ),
        action,
      );
    }
    if (action.action === "check") {
      return withAdjudicationCapture(
        action.workDir,
        "validate-map-check",
        () => checkMapDispatch(
          action.workDir,
          action.segmentId,
          action.dispatchId,
        ),
        action,
      );
    }
    if (action.action === "accept") {
      return withAdjudicationCapture(
        action.workDir,
        "validate-map-accept",
        () => acceptMapReceipt(
          action.workDir,
          action.segmentId,
          action.dispatchId,
        ),
        action,
      );
    }
    return withAdjudicationCapture(
      action.workDir,
      "validate-map",
      () => validateMapStage(action.workDir, action.segmentId),
      action,
    );
  }
  if (command === "record-map-metric") {
    const action = parseMapMetricAction(args);
    return withAdjudicationCapture(
      action.workDir,
      "record-map-metric",
      async () => recordMapGenerationMetric(
        action.workDir,
        action.segmentId,
        action.dispatchId,
        await readBoundedObservationDocument(action.observationPath),
      ),
      action,
    );
  }
  if (command === "schedule-map") {
    const action = parseScheduleMapAction(args);
    return withAdjudicationCapture(
      action.workDir,
      "schedule-map",
      () => scheduleNextMapWave(action.workDir, action.availableSlots),
      action,
    );
  }
  if (command === "prepare-reduce") {
    const workDir = requirePositional(args, 0, "WORK_DIR");
    return withAdjudicationCapture(
      workDir,
      "prepare-reduce",
      () => prepareReduceStage(workDir),
    );
  }
  if (command === "validate-reduce") {
    const workDir = requirePositional(args, 0, "WORK_DIR");
    if (args.length !== 2 || args[1] !== "--check") {
      throw new Error("validate-reduce requires --check");
    }
    return withAdjudicationCapture(
      workDir,
      "validate-reduce",
      () => checkReduceStage(workDir),
    );
  }
  if (command === "publish") {
    const workDir = requirePositional(args, 0, "WORK_DIR");
    const unknown = args.slice(1).filter((item) => item !== "--keep-workdir");
    if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
    return withAdjudicationCapture(
      workDir,
      "publish",
      () => publishHandoff(workDir, {
        keepWorkdir: args.includes("--keep-workdir"),
      }),
    );
  }
  if (command === "adjudicate") {
    const action = parseAdjudicationAction(args);
    if (action.action === "inspect") return inspectAdjudication(action.workDir);
    if (action.action === "apply") return applyAdjudicationDecision(action.workDir);
    if (action.action === "capture") {
      const spec = operatorCaptureSpec(action.diagnosticCode);
      return captureAdjudicationFailure(
        action.workDir,
        spec.phase,
        new ExportHandoffError(action.diagnosticCode, spec.message),
        spec.context,
      );
    }
    return submitAdjudicationDecision(
      action.workDir,
      await readBoundedDecisionDocument(action.decisionPath),
    );
  }
  if (command === "retrieve") {
    return retrieveEvidenceFromFile(
      requirePositional(args, 0, "EVIDENCE_INDEX"),
      requirePositional(args, 1, "ANCHOR_ID"),
    );
  }
  if (command === "verify-evidence") {
    return verifyEvidenceIndexFile(requirePositional(args, 0, "EVIDENCE_INDEX"));
  }
  throw new Error(`Unknown command: ${command || "<missing>"}`);
}

const MANAGED_COMMAND_PHASES = Object.freeze({
  "prepare-frame": "prepare-frame",
  "validate-frame": "validate-frame",
  "validate-map": "validate-map",
  "record-map-metric": "record-map-metric",
  "schedule-map": "schedule-map",
  "prepare-reduce": "prepare-reduce",
  "validate-reduce": "validate-reduce",
  publish: "publish",
});

function managedParseContext(command, args) {
  const phase = MANAGED_COMMAND_PHASES[command];
  const workDir = args[0];
  if (!phase || typeof workDir !== "string" || workDir.startsWith("--")) {
    return null;
  }
  return { phase, workDir };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args[0] === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  try {
    const result = await dispatch(args[0], args.slice(1));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    let reported = error;
    const parseContext = managedParseContext(args[0], args.slice(1));
    if (
      parseContext &&
      !error?.details?.adjudication &&
      !error?.code
    ) {
      const parseError = new ExportHandoffError(
        "INVALID_CLI_ARGUMENTS",
        `Arguments for managed command ${parseContext.phase} are invalid`,
      );
      try {
        await captureAdjudicationFailure(
          parseContext.workDir,
          parseContext.phase,
          parseError,
          {
            artifactKind: "cli_arguments",
            allowedActions: ["retry_stage", "publish_degraded"],
          },
        );
      } catch (captureError) {
        reported = captureError === parseError ? error : captureError;
      }
    }
    process.stderr.write(`${JSON.stringify({
      code: reported.code || "ERROR",
      message: reported.message,
      details: reported.details,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

await main();
