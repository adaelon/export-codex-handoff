function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sourceSuffix(sources, anchors) {
  const parts = [];
  if (sources?.length) parts.push(`sources: ${sources.join(", ")}`);
  if (anchors?.length) parts.push(`evidence: ${anchors.join(", ")}`);
  return parts.length ? ` _(${parts.join("; ")})_` : "";
}

function renderClaims(title, claims) {
  const lines = [`## ${title}`, ""];
  if (!claims?.length) return [...lines, "- None recorded.", ""];
  for (const claim of claims) {
    lines.push(
      `- ${oneLine(claim.text)}${sourceSuffix(claim.sources, claim.anchors)}`,
    );
  }
  lines.push("");
  return lines;
}

function renderDecisions(title, decisions) {
  const lines = [`## ${title}`, ""];
  if (decisions.length === 0) return [...lines, "- None recorded.", ""];
  for (const decision of decisions) {
    lines.push(
      `- ${oneLine(decision.statement.text)}${sourceSuffix(undefined, decision.statement.anchors)}`,
    );
    for (const rationale of decision.rationale) {
      lines.push(
        `  - Rationale: ${oneLine(rationale.text)}${sourceSuffix(undefined, rationale.anchors)}`,
      );
    }
    if (decision.supersedes.length > 0) {
      lines.push(`  - Supersedes: ${decision.supersedes.map((id) => `\`${id}\``).join(", ")}`);
    }
  }
  lines.push("");
  return lines;
}

function renderFailedAttempts(attempts) {
  const failed = attempts.filter((attempt) => attempt.failureClass || attempt.lesson);
  const lines = ["## Failed attempts", ""];
  if (failed.length === 0) return [...lines, "- None recorded.", ""];
  for (const attempt of failed) {
    lines.push(
      `- Goal: ${oneLine(attempt.goal.text)}${sourceSuffix(undefined, attempt.goal.anchors)}`,
      `  - Action: ${oneLine(attempt.action.text)}${sourceSuffix(undefined, attempt.action.anchors)}`,
      `  - Outcome: ${oneLine(attempt.outcome.text)}${sourceSuffix(undefined, attempt.outcome.anchors)}`,
    );
    if (attempt.failureClass) {
      lines.push(`  - Failure class: \`${oneLine(attempt.failureClass)}\``);
    }
    if (attempt.lesson) {
      lines.push(
        `  - Lesson: ${oneLine(attempt.lesson.text)}${sourceSuffix(undefined, attempt.lesson.anchors)}`,
      );
    }
  }
  lines.push("");
  return lines;
}

function renderVerification(verification) {
  const lines = ["## Verification outcomes", ""];
  if (verification.length === 0) return [...lines, "- None recorded.", ""];
  for (const item of verification) {
    lines.push(
      `- \`${oneLine(item.result)}\` — \`${oneLine(item.command)}\`${sourceSuffix(undefined, item.anchors)}`,
    );
  }
  lines.push("");
  return lines;
}

export function renderHandoff({
  evidencePack,
  reduced,
  coverage,
  provenance = [],
  generatedAt,
}) {
  const source = evidencePack.source;
  const workspace = evidencePack.workspace;
  const ledger = reduced.archivalLedger || {
    decisions: [],
    attempts: [],
    verification: [],
  };
  const lines = [
    "# Codex Handoff",
    "",
    "> This file is the continuation boundary for a fresh Codex task. Read it before acting; treat the original rollout as provenance only.",
    "",
  ];
  if (workspace.status === "unavailable") {
    lines.push(`> **Warning:** Workspace evidence unavailable: ${oneLine(workspace.reason)}`, "");
  }
  lines.push(
    "## Source",
    "",
    `- Session UUID: \`${source.sessionId}\``,
    `- Source revision: \`${source.sourceRevision || "unknown"}\``,
    `- Generated: ${generatedAt}`,
    `- Source started: ${source.session.startedAt || "unknown"}`,
    `- Original cwd: \`${source.session.cwd || "unknown"}\``,
    `- Rollout: \`${source.rolloutPath}\``,
    `- Workspace evidence: ${workspace.status}${workspace.git?.status ? ` / git ${workspace.git.status}` : ""}`,
    "",
    "## Continuation directive",
    "",
    oneLine(reduced.continuationDirective),
    "",
    "## Objective",
    "",
    oneLine(reduced.objective.goal),
    "",
    "**Explicit exclusions**:",
  );
  if (reduced.objective.explicitExclusions.length === 0) lines.push("- None recorded.");
  else for (const item of reduced.objective.explicitExclusions) lines.push(`- ${oneLine(item)}`);
  lines.push("");

  if (Object.hasOwn(reduced, "terminalState")) {
    lines.push("## Accepted proposal", "");
    if (reduced.acceptedProposal) {
      lines.push(
        reduced.acceptedProposal.text,
        sourceSuffix(undefined, reduced.acceptedProposal.anchors),
      );
    } else {
      lines.push("- None; the final user goal is standalone.");
    }
    lines.push("", "## Terminal state", "");
    lines.push(
      reduced.terminalState.text,
      sourceSuffix(undefined, reduced.terminalState.anchors),
      "",
    );
  }

  lines.push(...renderClaims("Constraints", reduced.constraints));
  lines.push(...renderDecisions(
    "Superseded decisions",
    ledger.decisions.filter((decision) => decision.status === "superseded"),
  ));
  lines.push(...renderDecisions(
    "Rejected decisions",
    ledger.decisions.filter((decision) => decision.status === "rejected"),
  ));
  lines.push(...renderDecisions(
    "Active decisions",
    ledger.decisions.filter((decision) => decision.status === "active"),
  ));
  lines.push(...renderFailedAttempts(ledger.attempts));

  lines.push(
    "## Workspace state",
    "",
    oneLine(reduced.workspaceState.summary.text),
    sourceSuffix(undefined, reduced.workspaceState.summary.anchors),
    "",
  );
  lines.push(...renderClaims("Workspace conflicts", reduced.workspaceState.conflicts));
  lines.push(...renderClaims("Completed work", reduced.completedWork));
  lines.push(...renderClaims("Open work", reduced.openWork));

  lines.push("## Next actions", "");
  if (reduced.nextActions.length === 0) {
    lines.push("1. Re-establish the objective with the user before changing files.");
  } else {
    reduced.nextActions.forEach((claim, index) => {
      lines.push(
        `${index + 1}. ${oneLine(claim.text)}${sourceSuffix(undefined, claim.anchors)}`,
      );
    });
  }
  lines.push("");

  lines.push(...renderVerification(ledger.verification));
  lines.push("## Important locations", "");
  if (reduced.importantLocations.length === 0) lines.push("- None recorded.");
  else for (const item of reduced.importantLocations) {
    lines.push(
      `- \`${oneLine(item.location)}\` — ${oneLine(item.purpose)}${sourceSuffix(undefined, item.anchors)}`,
    );
  }

  lines.push("", "## Preservation coverage", "");
  for (const item of reduced.preservationCoverage || []) {
    const claims = item.claimIds.length > 0 ? `; claims: ${item.claimIds.join(", ")}` : "";
    lines.push(
      `- \`${item.category}\` — ${item.status}: ${oneLine(item.reason)}${claims}`,
    );
  }

  lines.push("", "## Derived claim provenance", "");
  if (provenance.length === 0) lines.push("- No Source Thread turns retained by final claims.");
  else for (const turnId of provenance) lines.push(`- \`${turnId}\``);

  lines.push("", "## Semantic coverage", "");
  for (const item of coverage) {
    const claims = item.claimIds.length > 0 ? `; claims: ${item.claimIds.join(", ")}` : "";
    lines.push(`- \`${item.turnId}\` — ${item.status}: ${oneLine(item.reason)}${claims}`);
  }
  for (const note of reduced.provenance.notes) lines.push(`- Note: ${oneLine(note)}`);
  for (const note of reduced.compressionNotes) lines.push(`- Compression: ${oneLine(note)}`);
  lines.push("");
  return `${lines.join("\n").trimEnd()}\n`;
}
