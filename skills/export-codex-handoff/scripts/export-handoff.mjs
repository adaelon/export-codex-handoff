#!/usr/bin/env node

import fs from "node:fs";

import {
  retrieveEvidenceFromFile,
  verifyEvidenceIndexFile,
} from "./lib/evidence-index.mjs";
import { MAP_GENERATION_OBSERVATION_MAX_BYTES } from "./lib/performance-calibration.mjs";
import { ExportHandoffError } from "./lib/source-thread.mjs";
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

Provider timing for multi-wave MAP:
  1. Observe fresh dedicated slots and ProviderTimingCapability before any Worker claim.
  2. If timing is unavailable for a structurally multi-wave run, stop with
     PROVIDER_TIMING_UNAVAILABLE and zero admitted dispatches.
  3. After accepting each admitted Worker receipt, use record-map-metric with
     provider-reported latency only.
  4. Before a later wave, observe fresh slots again and use schedule-map.
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

async function dispatch(command, args) {
  if (command === "prepare") return prepareCompressionTask(parsePrepare(args));
  if (command === "prepare-frame") {
    return prepareFrameStage(requirePositional(args, 0, "WORK_DIR"));
  }
  if (command === "validate-frame") {
    return validateFrameStage(requirePositional(args, 0, "WORK_DIR"));
  }
  if (command === "validate-map") {
    const action = parseMapWorkerAction(args);
    if (action.action === "claim") {
      return claimMapDispatch(
        action.workDir,
        action.segmentId,
        action.dispatchId,
        action.workerId,
      );
    }
    if (action.action === "complete") {
      return completeMapDispatch(action.workDir, action.segmentId, action.dispatchId);
    }
    if (action.action === "check") {
      return checkMapDispatch(action.workDir, action.segmentId, action.dispatchId);
    }
    if (action.action === "accept") {
      return acceptMapReceipt(action.workDir, action.segmentId, action.dispatchId);
    }
    return validateMapStage(action.workDir, action.segmentId);
  }
  if (command === "record-map-metric") {
    const action = parseMapMetricAction(args);
    const observation = await readBoundedObservationDocument(action.observationPath);
    return recordMapGenerationMetric(
      action.workDir,
      action.segmentId,
      action.dispatchId,
      observation,
    );
  }
  if (command === "schedule-map") {
    const action = parseScheduleMapAction(args);
    return scheduleNextMapWave(action.workDir, action.availableSlots);
  }
  if (command === "prepare-reduce") {
    return prepareReduceStage(requirePositional(args, 0, "WORK_DIR"));
  }
  if (command === "validate-reduce") {
    const workDir = requirePositional(args, 0, "WORK_DIR");
    if (args.length !== 2 || args[1] !== "--check") {
      throw new Error("validate-reduce requires --check");
    }
    return checkReduceStage(workDir);
  }
  if (command === "publish") {
    const workDir = requirePositional(args, 0, "WORK_DIR");
    const unknown = args.slice(1).filter((item) => item !== "--keep-workdir");
    if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
    return publishHandoff(workDir, { keepWorkdir: args.includes("--keep-workdir") });
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
    process.stderr.write(`${JSON.stringify({
      code: error.code || "ERROR",
      message: error.message,
      details: error.details,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

await main();
