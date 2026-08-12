function fenceFor(text) {
  const runs = String(text).match(/`+/gu) || [];
  const width = Math.max(3, ...runs.map((run) => run.length + 1));
  return "`".repeat(width);
}

function fencedText(text) {
  const value = String(text);
  const fence = fenceFor(value);
  return `${fence}text\n${value}\n${fence}`;
}

function inlineCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function evidenceLine(anchors) {
  return anchors.length > 0
    ? `Evidence: ${anchors.map(inlineCode).join(", ")}`
    : "Evidence: unavailable";
}

function renderVerifiedField(title, field) {
  const lines = [`## ${title}`];
  if (field.status !== "verified") {
    lines.push(`Status: unavailable — ${field.reason}`);
    return lines;
  }
  lines.push("Status: verified", "", fencedText(field.text), "", evidenceLine(field.anchors));
  return lines;
}

function renderAcceptedWork(acceptedWork) {
  const lines = ["## Accepted MAP work"];
  if (acceptedWork.acceptedMaps === 0) {
    lines.push("Status: unavailable — no MAP receipt was accepted before degradation.");
    return lines;
  }
  lines.push(
    `Status: verified subset — ${acceptedWork.verifiedMaps}/${acceptedWork.acceptedMaps} accepted MAP generations verified.`,
  );
  for (const stage of acceptedWork.stages) {
    lines.push(
      "",
      `### ${inlineCode(stage.segmentId)}`,
      `Receipt: ${inlineCode(stage.receiptDigest)}`,
    );
    if (stage.claims.length === 0) {
      lines.push("No claim body from this accepted generation was evidence-verifiable.");
      continue;
    }
    for (const claim of stage.claims) {
      lines.push(
        "",
        `${claim.kind} ${inlineCode(claim.claimId)}`,
        fencedText(claim.text),
        evidenceLine(claim.anchors),
      );
    }
  }
  if (acceptedWork.omittedClaims > 0) {
    lines.push(
      "",
      `${acceptedWork.omittedClaims} accepted claim(s) were omitted because their evidence was unavailable or the bounded projection limit was reached.`,
    );
  }
  return lines;
}

function renderDiagnostics(diagnostics) {
  const lines = ["## Unresolved diagnostics"];
  for (const diagnostic of diagnostics) {
    lines.push(
      "",
      `### ${inlineCode(diagnostic.code)}`,
      `Request: ${inlineCode(diagnostic.requestId)} · phase: ${inlineCode(diagnostic.phase)} · owner: ${inlineCode(diagnostic.failureOwner)}`,
      fencedText(diagnostic.message),
    );
    if (diagnostic.applicationFailure) {
      lines.push(
        `Failed application: ${inlineCode(diagnostic.applicationFailure.code)}`,
        fencedText(diagnostic.applicationFailure.message),
      );
    }
  }
  return lines;
}

export function renderDegradedHandoff(projection) {
  const lines = [
    "# Degraded Codex Handoff",
    "",
    "> This artifact was explicitly selected by Main Codex Adjudication. It preserves only verified facts and does not claim normal completion.",
    "",
    ...renderVerifiedField("Current goal", projection.currentGoal),
    "",
    ...renderVerifiedField("Verified terminal and workspace facts", projection.terminalState),
    "",
    ...renderAcceptedWork(projection.acceptedWork),
    "",
    ...renderDiagnostics(projection.diagnostics),
    "",
    "## Unavailable / omitted fields",
    ...projection.omissions.map((entry) => `- ${entry.field}: ${entry.reason}`),
    "",
    "## Continuation instructions",
    "1. Treat every diagnostic above as unresolved.",
    "2. Continue from the byte-exact goal and verified accepted work only.",
    "3. Use the companion Evidence Index to retrieve or re-verify retained anchors.",
    "4. Do not infer normal REDUCE output, semantic completion, or facts listed as unavailable.",
    "",
    "## Evidence and adjudication audit",
    `- Evidence scope: ${projection.evidence.scope}`,
    `- Retained anchors: ${projection.evidence.retainedAnchors}/${projection.evidence.totalAnchors}`,
    `- Evidence Index digest: ${inlineCode(projection.evidence.indexDigest)}`,
    `- Run: ${inlineCode(projection.adjudication.runId)}`,
    `- Decision: ${inlineCode(projection.adjudication.decisionId)} (${inlineCode("publish_degraded")})`,
    `- Event chain: ${projection.adjudication.eventCount} event(s), head ${inlineCode(projection.adjudication.headDigest)}`,
    "- Application status at render time: pending immutable success record",
  ];
  return `${lines.join("\n")}\n`;
}
