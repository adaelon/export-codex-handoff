#!/usr/bin/env node

import {
  retrieveEvidenceFromFile,
  verifyEvidenceIndexFile,
} from "./lib/evidence-index.mjs";
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
  validateFrameStage,
  validateMapStage,
} from "./lib/task-workflow.mjs";

function usage() {
  return `Usage:
  node export-handoff.mjs prepare <SESSION_UUID> [options]
  node export-handoff.mjs prepare-frame <WORK_DIR>
  node export-handoff.mjs validate-frame <WORK_DIR>
  node export-handoff.mjs validate-map <WORK_DIR> <SEGMENT_ID> [--claim <DISPATCH_ID> --worker <WORKER_ID> | --check <DISPATCH_ID> | --complete <DISPATCH_ID> | --accept <DISPATCH_ID>]
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
  --help                   Show this help`;
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
