import { buildContinuationPreservationLedger } from "./evidence-addressing.mjs";
import { buildEvidenceIndex } from "./evidence-index.mjs";
import { findSourceThread, parseSourceThread, ExportHandoffError } from "./source-thread.mjs";
import { captureWorkspaceSnapshot } from "./workspace-snapshot.mjs";
import { buildTerminalStateArtifacts } from "./terminal-state.mjs";
import { buildProgressEvidence } from "./progress-evidence.mjs";

export async function buildEvidencePack(sessionId, options = {}) {
  const source = await findSourceThread(sessionId, { codexHome: options.codexHome });
  const parsed = await parseSourceThread(source.path, {
    maxToolChars: options.maxToolChars,
  });

  if (parsed.session.id && parsed.session.id.toLowerCase() !== source.sessionId) {
    throw new ExportHandoffError(
      "SESSION_ID_MISMATCH",
      `Rollout metadata identifies ${parsed.session.id}, expected ${source.sessionId}`,
    );
  }

  const capturedWorkspace = await captureWorkspaceSnapshot(parsed.session.cwd, {
    maxCheckpointChars: options.maxCheckpointChars,
    maxObservationChars: options.maxObservationChars,
    commandRunner: options.commandRunner,
  });
  const workspaceEntries = capturedWorkspace.evidenceEntries || [];
  const workspace = { ...capturedWorkspace };
  delete workspace.evidenceEntries;

  const evidenceEntries = [...parsed.evidenceEntries, ...workspaceEntries];
  const terminalArtifacts = buildTerminalStateArtifacts(
    parsed.sourceContinuation,
    workspace,
  );
  const preservationLedger = buildContinuationPreservationLedger(
    parsed.sourceRevision,
    evidenceEntries,
    {
      turns: parsed.turns,
      workspace,
      additionalRequiredAnchors: [
        ...(parsed.sourceContinuation?.acceptedProposal?.anchors || []),
        ...terminalArtifacts.terminalStateClaim.anchors,
      ],
    },
  );
  const evidencePack = {
    formatVersion: 1,
    source: {
      sessionId: source.sessionId,
      storageKind: source.storageKind,
      rolloutPath: source.path,
      sourceChars: parsed.sourceChars,
      sourceBytes: parsed.sourceBytes,
      sourceRevision: parsed.sourceRevision,
      session: parsed.session,
    },
    turns: parsed.turns,
    ignoredEvents: parsed.ignored,
    workspace,
    evidenceAnchors: evidenceEntries.map((entry) => entry.anchor),
    preservationLedger,
    sourceContinuation: parsed.sourceContinuation,
    ...terminalArtifacts,
  };
  const evidenceIndex = buildEvidenceIndex({
    sessionId: source.sessionId,
    source: evidencePack.source,
    workspace,
    entries: evidenceEntries,
    preservationLedger,
  });
  evidencePack.progressEvidence = buildProgressEvidence(parsed.turns, evidenceIndex, {
    maxInputChars: options.maxProgressInputChars,
    maxDispatchChars: options.maxProgressDispatchChars,
  });
  const evidenceChars = JSON.stringify(evidencePack).length;

  return { ...evidencePack, evidenceChars, evidenceIndex };
}
