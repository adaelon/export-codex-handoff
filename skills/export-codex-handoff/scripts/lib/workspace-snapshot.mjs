import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { promisify } from "node:util";

import {
  boundedPreview,
  computeWorkspaceRevision,
  createEvidenceEntry,
} from "./evidence-addressing.mjs";

const execFile = promisify(childProcess.execFile);
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;
const CHECKPOINT_REVISION_PATTERNS = [
  /(?:写入时最新\s*commit|commit\s+at\s+write\s+time)\s*:\s*([0-9a-f]{40}(?:[0-9a-f]{24})?)/iu,
  /(?:checkpoint|write)\s+revision\s*:\s*([0-9a-f]{40}(?:[0-9a-f]{24})?)/iu,
];

function normalizedGitRevision(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return GIT_REVISION_PATTERN.test(normalized) ? normalized : null;
}

export function parseCheckpointRevision(content) {
  if (typeof content !== "string") return null;
  for (const pattern of CHECKPOINT_REVISION_PATTERNS) {
    const match = pattern.exec(content);
    if (match) return normalizedGitRevision(match[1]);
  }
  return null;
}

export function classifyCheckpointFreshness(checkpointRevision, gitHead) {
  const checkpoint = normalizedGitRevision(checkpointRevision);
  const head = normalizedGitRevision(gitHead);
  if (!checkpoint || !head) return "unknown";
  return checkpoint === head ? "fresh" : "stale";
}

async function runGit(cwd, args) {
  try {
    const result = await execFile("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trimEnd(),
      stderr: String(error.stderr || error.message || "").trimEnd(),
      code: error.code ?? null,
    };
  }
}

function previewText(value, maxChars) {
  const preview = boundedPreview(value, maxChars);
  if (!preview.previewTail) return preview.previewHead;
  const omitted = preview.outputChars - preview.previewHead.length - preview.previewTail.length;
  return `${preview.previewHead}\n[... ${omitted} UTF-16 code units omitted from workspace preview ...]\n${preview.previewTail}`;
}

async function readCheckpoint(cwd, maxChars) {
  const checkpointPath = path.join(cwd, "SESSION_CHECKPOINT.md");
  try {
    const content = await fs.promises.readFile(checkpointPath, "utf8");
    return {
      snapshot: {
        status: "found",
        path: checkpointPath,
        content: previewText(content, maxChars),
        truncatedChars: Math.max(0, content.length - maxChars),
        recordedRevision: parseCheckpointRevision(content),
      },
      observation: {
        observationId: "checkpoint",
        payloadPath: "/checkpoint/content",
        value: content,
        locator: {
          kind: "file",
          observationId: "checkpoint",
          path: checkpointPath,
        },
      },
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { snapshot: { status: "missing", path: checkpointPath }, observation: null };
    }
    return {
      snapshot: { status: "unreadable", path: checkpointPath, reason: error.message },
      observation: null,
    };
  }
}

function commandObservation(cwd, observationId, args, result, payloadPath) {
  const stream = result.ok || result.stdout ? "stdout" : "stderr";
  const value = stream === "stdout" ? result.stdout : result.stderr;
  return {
    observationId,
    payloadPath,
    value,
    locator: {
      kind: "command",
      observationId,
      executable: "git",
      cwd,
      args,
      expectedOk: result.ok,
      stream,
    },
  };
}

function materializeEntries(sourceRevision, observations) {
  return observations.map((observation) => createEvidenceEntry({
    sourceKind: "workspace",
    sourceRevision,
    payloadPath: observation.payloadPath,
    value: observation.value,
    locator: observation.locator,
  }));
}

export async function captureWorkspaceSnapshot(cwd, options = {}) {
  const maxCheckpointChars = options.maxCheckpointChars ?? 20_000;
  const maxObservationChars = options.maxObservationChars ?? 20_000;
  const commandRunner = options.commandRunner || runGit;
  const observedAt = new Date().toISOString();
  if (!cwd) {
    return {
      status: "unavailable",
      cwd: null,
      observedAt,
      reason: "Source Thread has no recorded cwd",
      sourceRevision: null,
      evidenceEntries: [],
    };
  }

  const resolvedCwd = path.resolve(cwd);
  try {
    const stat = await fs.promises.stat(resolvedCwd);
    if (!stat.isDirectory()) {
      return {
        status: "unavailable",
        cwd: resolvedCwd,
        observedAt,
        reason: "Recorded cwd is not a directory",
        sourceRevision: null,
        evidenceEntries: [],
      };
    }
  } catch (error) {
    return {
      status: "unavailable",
      cwd: resolvedCwd,
      observedAt,
      reason: error.message,
      sourceRevision: null,
      evidenceEntries: [],
    };
  }

  const checkpointResult = await readCheckpoint(resolvedCwd, maxCheckpointChars);
  const observations = [];
  if (checkpointResult.observation) observations.push(checkpointResult.observation);

  const probeArgs = ["rev-parse", "--is-inside-work-tree"];
  const probe = await commandRunner(resolvedCwd, probeArgs);
  observations.push(commandObservation(
    resolvedCwd,
    "git.probe",
    probeArgs,
    probe,
    "/git/probe",
  ));

  if (!probe.ok || probe.stdout !== "true") {
    const sourceRevision = computeWorkspaceRevision(observations);
    const evidenceEntries = materializeEntries(sourceRevision, observations);
    return {
      status: "available",
      cwd: resolvedCwd,
      observedAt,
      checkpoint: {
        ...checkpointResult.snapshot,
        freshness: classifyCheckpointFreshness(
          checkpointResult.snapshot.recordedRevision,
          null,
        ),
      },
      sourceRevision,
      evidenceEntries,
      observationAnchors: evidenceEntries
        .filter((entry) => entry.anchor.payloadPath?.startsWith("/git/"))
        .map((entry) => entry.anchor.anchorId),
      git: {
        status: "not_repository",
        reason: previewText(probe.stderr || probe.stdout || "git rev-parse did not identify a work tree", maxObservationChars),
      },
    };
  }

  const commands = [
    ["head", ["rev-parse", "HEAD"], "head"],
    ["status", ["status", "--short", "--branch"], "branchAndStatus"],
    ["log", ["log", "--oneline", "-5"], "recentCommits"],
    ["diffStat", ["diff", "--stat"], "unstagedDiffStat"],
    ["cachedDiffStat", ["diff", "--cached", "--stat"], "stagedDiffStat"],
    ["names", ["diff", "--name-status"], "unstagedNames"],
    ["cachedNames", ["diff", "--cached", "--name-status"], "stagedNames"],
  ];
  const results = await Promise.all(commands.map(([, args]) => commandRunner(resolvedCwd, args)));
  const git = {};
  const failures = [];
  for (let index = 0; index < commands.length; index += 1) {
    const [name, args, field] = commands[index];
    const result = results[index];
    const observation = commandObservation(
      resolvedCwd,
      `git.${name}`,
      args,
      result,
      `/git/${field}`,
    );
    observations.push(observation);
    git[field] = previewText(observation.value, maxObservationChars);
    if (!result.ok) failures.push({ name, reason: previewText(result.stderr || `exit ${result.code}`, maxObservationChars) });
  }

  const sourceRevision = computeWorkspaceRevision(observations);
  const evidenceEntries = materializeEntries(sourceRevision, observations);
  const checkpoint = {
    ...checkpointResult.snapshot,
    freshness: classifyCheckpointFreshness(
      checkpointResult.snapshot.recordedRevision,
      git.head,
    ),
  };
  return {
    status: "available",
    cwd: resolvedCwd,
    observedAt,
    capturedAt: observedAt,
    checkpoint,
    sourceRevision,
    evidenceEntries,
    observationAnchors: evidenceEntries
      .filter((entry) => entry.anchor.payloadPath?.startsWith("/git/"))
      .map((entry) => entry.anchor.anchorId),
    git: {
      status: failures.length === 0 ? "available" : "partial",
      ...git,
      failures,
    },
  };
}
