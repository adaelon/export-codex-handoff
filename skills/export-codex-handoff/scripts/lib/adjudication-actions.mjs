import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import { canonicalStringify, sha256Text } from "./evidence-addressing.mjs";
import { createMapDispatch } from "./map-worker.mjs";
import { ExportHandoffError } from "./source-thread.mjs";

const MANIFEST_FILE = "manifest.json";

function fail(code, message, details = undefined) {
  throw new ExportHandoffError(code, message, details);
}

async function pathExists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

function assertInsideWorkDir(workDir, target, label) {
  const relative = path.relative(workDir, path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("INVALID_ADJUDICATION_APPLICATION", `${label} escapes the work directory`);
  }
}

function assertOutsideWorkDir(workDir, target, label) {
  const relative = path.relative(workDir, path.resolve(target));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    fail(
      "INVALID_PUBLICATION_TARGET",
      `${label} must remain outside the disposable Compression Task directory`,
    );
  }
}

async function readManifest(workDir, contract) {
  const target = path.join(workDir, MANIFEST_FILE);
  let text;
  try {
    text = await fs.promises.readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      fail("ADJUDICATION_RUN_INVALID", "Compression Task manifest is missing");
    }
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    fail("ADJUDICATION_RUN_INVALID", "Compression Task manifest is not valid JSON");
  }
  if (
    manifest?.formatVersion !== 2 ||
    manifest?.kind !== "codex-handoff-compression-task" ||
    path.resolve(manifest.workDir || "") !== workDir ||
    manifest.sessionId !== contract.sessionId ||
    manifest.sourceRevision !== contract.sourceRevision ||
    manifest.mapResultMode !== contract.mapResultMode
  ) {
    fail(
      "ADJUDICATION_RUN_INVALID",
      "Decision application requires the v2 manifest bound by its immutable contract",
    );
  }
  return manifest;
}

async function writeManifest(workDir, manifest) {
  await fs.promises.writeFile(
    path.join(workDir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

function requireCoordinate(coordinates, name, phase) {
  const value = coordinates?.[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(
      "ADJUDICATION_APPLICATION_INPUT_MISSING",
      `${phase} decision application requires artifact.coordinates.${name}`,
    );
  }
  return value;
}

function resumeForPhase(phase, workDir, coordinates = {}) {
  const mapCommand = (operation) => {
    const segmentId = requireCoordinate(coordinates, "segmentId", phase);
    const dispatchId = coordinates.dispatchId;
    const command = ["validate-map", workDir, segmentId];
    if (operation) {
      if (typeof dispatchId !== "string" || dispatchId.length === 0) {
        fail(
          "ADJUDICATION_APPLICATION_INPUT_MISSING",
          `${phase} decision application requires artifact.coordinates.dispatchId`,
        );
      }
      command.push(`--${operation}`, dispatchId);
      if (operation === "claim") command.push("--worker", "<WORKER_ID>");
    }
    return command;
  };

  const commands = {
    "prepare-frame": () => ["prepare-frame", workDir],
    "validate-frame": () => ["validate-frame", workDir],
    "pre-dispatch": () => ["validate-frame", workDir],
    "validate-map": () => mapCommand(null),
    "validate-map-claim": () => mapCommand("claim"),
    "validate-map-check": () => mapCommand("check"),
    "validate-map-complete": () => mapCommand("complete"),
    "validate-map-accept": () => mapCommand("accept"),
    "record-map-metric": () => [
      "record-map-metric",
      workDir,
      requireCoordinate(coordinates, "segmentId", phase),
      requireCoordinate(coordinates, "dispatchId", phase),
      "<OBSERVATION_FILE>",
    ],
    "schedule-map": () => [
      "schedule-map",
      workDir,
      "<AVAILABLE_SLOTS>",
    ],
    "prepare-reduce": () => ["prepare-reduce", workDir],
    "validate-reduce": () => ["validate-reduce", workDir, "--check"],
    publish: () => ["publish", workDir],
  };
  const command = commands[phase]?.();
  if (!command) {
    fail("INVALID_ADJUDICATION_PHASE", `No resume contract exists for ${phase}`);
  }
  return { phase, command };
}

function generationPath(target, token) {
  const parsed = path.parse(target);
  return path.join(parsed.dir, `${parsed.name}.${token}${parsed.ext}`);
}

async function archiveCandidate(workDir, sourcePath, decisionId) {
  assertInsideWorkDir(workDir, sourcePath, "Regenerated candidate");
  const archivePath = path.join(
    workDir,
    "adjudication",
    "archives",
    decisionId,
    path.basename(sourcePath),
  );
  assertInsideWorkDir(workDir, archivePath, "Candidate archive");
  const [sourceExists, archiveExists] = await Promise.all([
    pathExists(sourcePath),
    pathExists(archivePath),
  ]);
  if (archiveExists) {
    if (sourceExists) {
      fail(
        "ADJUDICATION_ARCHIVE_CONFLICT",
        "Both the mutable candidate and its immutable application archive exist",
      );
    }
    const bytes = await fs.promises.readFile(archivePath);
    return {
      archivePath,
      archiveDigest: `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`,
    };
  }
  if (!sourceExists) {
    fail(
      "ADJUDICATION_ARTIFACT_MISSING",
      `The candidate selected for regeneration is missing: ${sourcePath}`,
    );
  }
  const bytes = await fs.promises.readFile(sourcePath);
  const archiveDigest = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.promises.rename(sourcePath, archivePath);
  return { archivePath, archiveDigest };
}

function createStageDispatch(manifest, stage) {
  const input = {
    segmentId: stage.segmentId,
    chunkPath: stage.chunkPath,
    summaryPath: stage.summaryPath,
    frameDigest: manifest.frameDigest,
    attempt: 1,
  };
  if (manifest.mapResultMode) input.mapResultMode = manifest.mapResultMode;
  if (stage.maxMapOutputChars) input.maxMapOutputChars = stage.maxMapOutputChars;
  if (stage.contextPath && stage.contextDigest) {
    input.contextPath = stage.contextPath;
    input.contextDigest = stage.contextDigest;
    if (stage.dictionaryPath && stage.dictionaryDigest) {
      input.dictionaryPath = stage.dictionaryPath;
      input.dictionaryDigest = stage.dictionaryDigest;
    }
  } else {
    input.framePath = manifest.paths.frame;
  }
  return createMapDispatch(input);
}

async function supersedeMapGeneration(workDir, request, decision, manifest) {
  const segmentId = requireCoordinate(
    request.artifact.coordinates,
    "segmentId",
    request.phase,
  );
  const history = manifest.supersededMapGenerations || [];
  const replayed = history.find((entry) => entry.decisionId === decision.decisionId);
  if (replayed) {
    const current = [...(manifest.segments || []), ...(manifest.turnAggregates || [])]
      .find((stage) => stage.segmentId === segmentId);
    if (!current || current.dispatch?.dispatchId !== replayed.supersedingDispatchId) {
      fail(
        "ADJUDICATION_GENERATION_INTEGRITY_MISMATCH",
        "Replayed MAP supersession disagrees with the active generation",
      );
    }
    const generationDigest = `sha256:${sha256Text(canonicalStringify(replayed))}`;
    return {
      effect: "map_generation_superseded",
      segmentId,
      supersededDispatchId: replayed.generation.dispatch.dispatchId,
      dispatchId: current.dispatch.dispatchId,
      supersededGenerationDigest: generationDigest,
      resume: resumeForPhase(request.phase, workDir, {
        ...request.artifact.coordinates,
        dispatchId: current.dispatch.dispatchId,
      }),
    };
  }

  const stages = [...(manifest.segments || []), ...(manifest.turnAggregates || [])];
  const stage = stages.find((candidate) => candidate.segmentId === segmentId);
  if (!stage?.dispatch) {
    fail("MAP_DISPATCH_MISSING", `${segmentId} has no MAP generation to supersede`);
  }
  const expectedDispatchId = request.artifact.coordinates.dispatchId;
  if (
    typeof expectedDispatchId === "string" &&
    expectedDispatchId !== stage.dispatch.dispatchId
  ) {
    fail(
      "ADJUDICATION_DECISION_BINDING_MISMATCH",
      "MAP regeneration must supersede the exact dispatch named by the request",
    );
  }

  const generation = structuredClone(stage);
  if (request.immutableDigests.frameDigest) {
    const frameDigest = request.immutableDigests.frameDigest;
    if (manifest.frameDigest !== frameDigest || stage.dispatch.frameDigest !== frameDigest) {
      fail(
        "ADJUDICATION_ARTIFACT_INTEGRITY_MISMATCH",
        "The active MAP generation no longer matches the request Frame digest",
      );
    }
  }
  if (request.immutableDigests.receiptDigest) {
    const receiptBytes = await fs.promises.readFile(stage.receiptPath);
    const receiptDigest = `sha256:${crypto.createHash("sha256").update(receiptBytes).digest("hex")}`;
    if (receiptDigest !== request.immutableDigests.receiptDigest) {
      fail(
        "ADJUDICATION_ARTIFACT_INTEGRITY_MISMATCH",
        "The accepted MAP receipt no longer matches the request digest",
      );
    }
  }
  const token = decision.decisionId.replace("adjudication-decision-", "generation-");
  stage.summaryPath = generationPath(stage.summaryPath, token);
  stage.receiptPath = generationPath(stage.receiptPath, token);
  stage.diagnosticsDir = `${stage.diagnosticsDir}.${token}`;
  if (stage.normalizedSummaryPath) {
    stage.normalizedSummaryPath = generationPath(stage.normalizedSummaryPath, token);
  }
  if (stage.completedSummaryPath) {
    stage.completedSummaryPath = generationPath(stage.completedSummaryPath, token);
  }
  for (const field of [
    "receiptAcceptedAt",
    "claimDurationMs",
    "checkDurationMs",
    "completeDurationMs",
    "acceptDurationMs",
    "summaryDigest",
    "normalizedSummaryDigest",
    "completedSummaryDigest",
    "rawMapOutputChars",
    "normalizedMapOutputChars",
    "completedMapOutputChars",
    "checkedSummaryDigest",
    "summaryCheckedAt",
    "lastDiagnosticCode",
    "mapGenerationMetric",
  ]) delete stage[field];
  stage.workerStatus = "pending";
  stage.dispatch = createStageDispatch(manifest, stage);

  const generationRecord = {
    segmentId,
    supersededAt: new Date().toISOString(),
    requestId: request.requestId,
    decisionId: decision.decisionId,
    supersedingDispatchId: stage.dispatch.dispatchId,
    generation,
  };
  manifest.supersededMapGenerations = [
    ...history,
    generationRecord,
  ];
  await writeManifest(workDir, manifest);
  return {
    effect: "map_generation_superseded",
    segmentId,
    supersededDispatchId: generation.dispatch.dispatchId,
    dispatchId: stage.dispatch.dispatchId,
    supersededGenerationDigest:
      `sha256:${sha256Text(canonicalStringify(generationRecord))}`,
    resume: resumeForPhase(request.phase, workDir, {
      ...request.artifact.coordinates,
      dispatchId: stage.dispatch.dispatchId,
    }),
  };
}

async function regenerateStage(workDir, contract, request, decision) {
  const manifest = await readManifest(workDir, contract);
  if (request.phase.startsWith("validate-map")) {
    return supersedeMapGeneration(workDir, request, decision, manifest);
  }

  if (request.phase === "record-map-metric") {
    return {
      effect: "stage_regenerated",
      regeneratedArtifact: "provider-observation",
      resume: resumeForPhase(
        request.phase,
        workDir,
        request.artifact.coordinates,
      ),
    };
  }

  const candidateByPhase = {
    "prepare-frame": manifest.paths.frameInput,
    "validate-frame": manifest.paths.frame,
    "pre-dispatch": manifest.paths.frame,
    "prepare-reduce": manifest.paths.reduceInput,
    "validate-reduce": manifest.paths.reduced,
  };
  const candidatePath = request.artifact.coordinates.candidatePath ||
    candidateByPhase[request.phase];
  if (!candidatePath) {
    fail(
      "ADJUDICATION_ACTION_NOT_ALLOWED",
      `regenerate_stage has no mutable generation for ${request.phase}`,
    );
  }
  if (["validate-frame", "pre-dispatch"].includes(request.phase)) {
    const stages = [...(manifest.segments || []), ...(manifest.turnAggregates || [])];
    if (
      Number(request.acceptedWork?.acceptedMaps || 0) > 0 ||
      stages.some((stage) => stage.dispatch)
    ) {
      fail(
        "FRAME_REGENERATION_REQUIRES_UNDISPATCHED_RUN",
        "A frozen Frame cannot be regenerated after a MAP dispatch exists",
      );
    }
  }
  const archived = await archiveCandidate(
    workDir,
    path.resolve(candidatePath),
    decision.decisionId,
  );
  if (request.phase === "prepare-frame") {
    manifest.frameInputDigest = null;
    await writeManifest(workDir, manifest);
  } else if (["validate-frame", "pre-dispatch"].includes(request.phase)) {
    manifest.frameId = null;
    manifest.frameDigest = null;
    delete manifest.frameValidatedAt;
    await writeManifest(workDir, manifest);
  } else if (["prepare-reduce", "validate-reduce"].includes(request.phase)) {
    delete manifest.checkedReducedDigest;
    delete manifest.reduceCheckedAt;
    delete manifest.checkedFinalProvenance;
    await writeManifest(workDir, manifest);
  }
  return {
    effect: "stage_regenerated",
    archivedArtifact: {
      sourcePath: path.resolve(candidatePath),
      archivePath: archived.archivePath,
      archiveDigest: archived.archiveDigest,
    },
    resume: resumeForPhase(request.phase, workDir, request.artifact.coordinates),
  };
}

async function relocatePublication(workDir, contract, request, decision) {
  const manifest = await readManifest(workDir, contract);
  const { outputPath, evidenceIndexPath } = decision.action;
  assertOutsideWorkDir(workDir, outputPath, "Relocated Handoff path");
  assertOutsideWorkDir(workDir, evidenceIndexPath, "Relocated Evidence Index path");
  const history = manifest.publicationRelocations || [];
  const replayed = history.find((entry) => entry.decisionId === decision.decisionId);
  if (replayed) {
    if (
      path.resolve(manifest.outputPath) !== path.resolve(outputPath) ||
      path.resolve(manifest.evidenceIndexPath) !== path.resolve(evidenceIndexPath)
    ) {
      fail(
        "ADJUDICATION_RELOCATION_INTEGRITY_MISMATCH",
        "Replayed publication relocation disagrees with the active manifest targets",
      );
    }
  } else {
    const prior = history.at(-1);
    const expectedOutputPath = prior?.outputPath || contract.outputPath;
    const expectedEvidenceIndexPath = prior?.evidenceIndexPath || contract.evidenceIndexPath;
    if (
      path.resolve(manifest.outputPath) !== path.resolve(expectedOutputPath) ||
      path.resolve(manifest.evidenceIndexPath) !== path.resolve(expectedEvidenceIndexPath)
    ) {
      fail(
        "ADJUDICATION_RELOCATION_INTEGRITY_MISMATCH",
        "Publication relocation cannot replace targets outside the recorded relocation chain",
      );
    }
    if (await pathExists(outputPath) || await pathExists(evidenceIndexPath)) {
      fail(
        "OUTPUT_EXISTS",
        "Relocated publication targets must both remain absent until publication",
      );
    }
    manifest.publicationRelocations = [
      ...history,
      {
        relocatedAt: new Date().toISOString(),
        requestId: request.requestId,
        decisionId: decision.decisionId,
        priorOutputPath: manifest.outputPath,
        priorEvidenceIndexPath: manifest.evidenceIndexPath,
        outputPath: path.resolve(outputPath),
        evidenceIndexPath: path.resolve(evidenceIndexPath),
      },
    ];
    manifest.outputPath = path.resolve(outputPath);
    manifest.evidenceIndexPath = path.resolve(evidenceIndexPath);
    await writeManifest(workDir, manifest);
  }
  return {
    effect: "publication_relocated",
    outputPath: path.resolve(outputPath),
    evidenceIndexPath: path.resolve(evidenceIndexPath),
    resume: resumeForPhase("publish", workDir),
  };
}

export async function executeAdjudicationAction({ workDir, contract, request, decision }) {
  const resolved = path.resolve(workDir);
  if (decision.action.type === "retry_stage") {
    return {
      effect: "stage_resumed",
      resume: resumeForPhase(request.phase, resolved, request.artifact.coordinates),
    };
  }
  if (decision.action.type === "regenerate_stage") {
    return regenerateStage(resolved, contract, request, decision);
  }
  if (decision.action.type === "relocate_publication") {
    return relocatePublication(resolved, contract, request, decision);
  }
  fail(
    "ADJUDICATION_ACTION_NOT_IMPLEMENTED",
    "publish_degraded is implemented by Slice MA4, not MA3",
  );
}
