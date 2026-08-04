import { ExportHandoffError } from "./source-thread.mjs";

function fail(message) {
  throw new ExportHandoffError("HANDOFF_LOW_VALUE", message);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    fail(`${label} must be an array of non-empty strings`);
  }
  return value;
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function tableCell(value) {
  return oneLine(value).replace(/\|/gu, "\\|");
}

function inlineCode(value) {
  return `\`${oneLine(value).replace(/`/gu, "\\`")}\``;
}

function evidenceSuffix(keys) {
  return keys.length > 0 ? ` [${keys.join(", ")}]` : "";
}

function evidenceCell(keys) {
  return keys.length > 0 ? keys.join(", ") : "—";
}

function validatedProjection(projection, evidenceIndex) {
  requireObject(projection, "Action-ready projection");
  if (
    projection.formatVersion !== 1 ||
    projection.kind !== "codex-handoff-action-ready-projection"
  ) {
    fail("Action-ready renderer requires projection v1");
  }
  const hotContext = requireObject(projection.hotContext, "Hot Context");
  const evidenceKeyMap = requireObject(projection.evidenceKeyMap, "Handoff Evidence Key map");
  if (
    evidenceKeyMap.formatVersion !== 1 ||
    evidenceKeyMap.kind !== "codex-handoff-evidence-key-map" ||
    !Array.isArray(evidenceKeyMap.entries) ||
    evidenceKeyMap.entries.length === 0
  ) {
    fail("Action-ready renderer requires a non-empty Handoff Evidence Key map v1");
  }
  if (
    !evidenceIndex?.evidenceKeyMap ||
    JSON.stringify(evidenceIndex.evidenceKeyMap) !== JSON.stringify(evidenceKeyMap)
  ) {
    fail("Published Evidence Index must carry the exact rendered Handoff Evidence Key map");
  }

  const knownAnchors = new Set(
    (evidenceIndex.anchors || []).map((entry) => entry?.anchor?.anchorId),
  );
  const knownKeys = new Set();
  const claimIds = new Set();
  for (const [index, entry] of evidenceKeyMap.entries.entries()) {
    requireObject(entry, `Handoff Evidence Key map entries[${index}]`);
    const expectedKey = `E${index + 1}`;
    if (
      entry.key !== expectedKey ||
      typeof entry.claimId !== "string" ||
      !entry.claimId ||
      claimIds.has(entry.claimId) ||
      !Array.isArray(entry.anchors) ||
      entry.anchors.length === 0 ||
      new Set(entry.anchors).size !== entry.anchors.length ||
      entry.anchors.some((anchorId) => !knownAnchors.has(anchorId))
    ) {
      fail(`Handoff Evidence Key ${entry.key ?? "<missing>"} does not resolve exactly`);
    }
    knownKeys.add(entry.key);
    claimIds.add(entry.claimId);
  }

  const keys = (value, label) => {
    requireStringArray(value, label);
    if (new Set(value).size !== value.length || value.some((key) => !knownKeys.has(key))) {
      fail(`${label} contains a duplicate or unknown Handoff Evidence Key`);
    }
    return value;
  };
  const key = (value, label) => {
    if (typeof value !== "string" || !knownKeys.has(value)) {
      fail(`${label} must resolve through the Handoff Evidence Key map`);
    }
    return value;
  };

  requireObject(hotContext.objective, "Hot Context objective");
  requireString(hotContext.objective.text, "Hot Context objective text");
  key(hotContext.objective.evidenceKey, "Hot Context objective evidenceKey");
  if (!Array.isArray(hotContext.explicitExclusions)) {
    fail("Hot Context explicitExclusions must be an array");
  }
  for (const [index, exclusion] of hotContext.explicitExclusions.entries()) {
    requireObject(exclusion, `Hot Context explicitExclusions[${index}]`);
    requireString(exclusion.text, `Hot Context explicitExclusions[${index}].text`);
    key(exclusion.evidenceKey, `Hot Context explicitExclusions[${index}].evidenceKey`);
  }

  requireObject(hotContext.workingSynthesis, "Working Synthesis");
  if (!Array.isArray(hotContext.workingSynthesis.sections)) {
    fail("Working Synthesis sections must be an array");
  }
  for (const [index, section] of hotContext.workingSynthesis.sections.entries()) {
    requireObject(section, `Working Synthesis sections[${index}]`);
    requireString(section.title, `Working Synthesis sections[${index}].title`);
    requireString(section.body, `Working Synthesis sections[${index}].body`);
    keys(section.evidenceKeys, `Working Synthesis sections[${index}].evidenceKeys`);
  }
  if (
    !Array.isArray(hotContext.workingSynthesis.confirmedFindings) ||
    !Array.isArray(hotContext.workingSynthesis.uncertainties)
  ) {
    fail("Working Synthesis findings and uncertainties must be arrays");
  }
  for (const [index, finding] of hotContext.workingSynthesis.confirmedFindings.entries()) {
    requireObject(finding, `Working Synthesis confirmedFindings[${index}]`);
    requireString(finding.text, `Working Synthesis confirmedFindings[${index}].text`);
    key(finding.evidenceKey, `Working Synthesis confirmedFindings[${index}].evidenceKey`);
  }
  for (const [index, uncertainty] of hotContext.workingSynthesis.uncertainties.entries()) {
    requireObject(uncertainty, `Working Synthesis uncertainties[${index}]`);
    requireString(uncertainty.question, `Working Synthesis uncertainties[${index}].question`);
    requireStringArray(
      uncertainty.allowedScopes,
      `Working Synthesis uncertainties[${index}].allowedScopes`,
    );
    keys(
      uncertainty.evidenceKeys,
      `Working Synthesis uncertainties[${index}].evidenceKeys`,
    );
  }

  for (const name of [
    "deliverableStatus",
    "constraints",
    "decisions",
    "inspectedEvidenceMap",
    "nextActions",
    "relevantVerifications",
  ]) {
    if (!Array.isArray(hotContext[name])) fail(`Hot Context ${name} must be an array`);
  }
  for (const [index, deliverable] of hotContext.deliverableStatus.entries()) {
    requireObject(deliverable, `Deliverable Status[${index}]`);
    requireString(deliverable.deliverableId, `Deliverable Status[${index}].deliverableId`);
    requireString(deliverable.request, `Deliverable Status[${index}].request`);
    requireString(deliverable.status, `Deliverable Status[${index}].status`);
    keys(deliverable.evidenceKeys, `Deliverable Status[${index}].evidenceKeys`);
  }
  for (const [index, constraint] of hotContext.constraints.entries()) {
    requireObject(constraint, `Constraints[${index}]`);
    requireString(constraint.text, `Constraints[${index}].text`);
    key(constraint.evidenceKey, `Constraints[${index}].evidenceKey`);
  }
  for (const [index, decision] of hotContext.decisions.entries()) {
    requireObject(decision, `Decisions[${index}]`);
    requireObject(decision.statement, `Decisions[${index}].statement`);
    requireString(decision.statement.text, `Decisions[${index}].statement.text`);
    key(decision.statement.evidenceKey, `Decisions[${index}].statement.evidenceKey`);
    if (!Array.isArray(decision.rationale)) fail(`Decisions[${index}].rationale must be an array`);
    for (const [rationaleIndex, rationale] of decision.rationale.entries()) {
      requireObject(rationale, `Decisions[${index}].rationale[${rationaleIndex}]`);
      requireString(
        rationale.text,
        `Decisions[${index}].rationale[${rationaleIndex}].text`,
      );
      key(
        rationale.evidenceKey,
        `Decisions[${index}].rationale[${rationaleIndex}].evidenceKey`,
      );
    }
  }
  for (const [index, inspection] of hotContext.inspectedEvidenceMap.entries()) {
    requireObject(inspection, `Inspected Evidence Map[${index}]`);
    requireStringArray(inspection.symbols, `Inspected Evidence Map[${index}].symbols`);
    keys(inspection.evidenceKeys, `Inspected Evidence Map[${index}].evidenceKeys`);
  }
  for (const [index, action] of hotContext.nextActions.entries()) {
    requireObject(action, `Next Actions[${index}]`);
    requireString(action.text, `Next Actions[${index}].text`);
    key(action.evidenceKey, `Next Actions[${index}].evidenceKey`);
  }
  for (const [index, verification] of hotContext.relevantVerifications.entries()) {
    requireObject(verification, `Relevant Verifications[${index}]`);
    requireString(verification.command, `Relevant Verifications[${index}].command`);
    requireString(verification.result, `Relevant Verifications[${index}].result`);
    key(verification.evidenceKey, `Relevant Verifications[${index}].evidenceKey`);
  }
  return { hotContext, evidenceKeyMap };
}

export function buildActionReadyConsumerContract(resumePolicy) {
  requireObject(resumePolicy, "Resume Policy");
  requireString(resumePolicy.mode, "Resume Policy mode");
  requireStringArray(resumePolicy.firstDeliverableIds, "Resume Policy firstDeliverableIds");
  requireStringArray(resumePolicy.allowedReadReasons, "Resume Policy allowedReadReasons");
  if (
    !Number.isInteger(resumePolicy.maxTargetedReads) ||
    resumePolicy.maxTargetedReads < 0 ||
    typeof resumePolicy.forbidBroadSearch !== "boolean" ||
    typeof resumePolicy.forbidFullFileReread !== "boolean"
  ) {
    fail("Resume Policy has an invalid targeted-read contract");
  }
  if (
    resumePolicy.mode === "synthesize_first" &&
    (
      resumePolicy.firstDeliverableIds.length === 0 ||
      resumePolicy.maxTargetedReads > 3 ||
      resumePolicy.forbidBroadSearch !== true ||
      resumePolicy.forbidFullFileReread !== true
    )
  ) {
    fail("synthesize_first requires a first deliverable, at most three targeted reads, and both exploration prohibitions");
  }
  return {
    formatVersion: 1,
    kind: resumePolicy.mode === "synthesize_first"
      ? "codex-handoff-synthesize-first-consumer-contract"
      : "codex-handoff-action-ready-consumer-contract",
    mode: resumePolicy.mode,
    firstDeliverableIds: [...resumePolicy.firstDeliverableIds],
    ...(resumePolicy.mode === "synthesize_first" ? { preDraftEvidenceReads: 0 } : {}),
    maxTargetedReads: resumePolicy.maxTargetedReads,
    allowedReadReasons: [...resumePolicy.allowedReadReasons],
    forbidBroadSearch: resumePolicy.forbidBroadSearch,
    forbidFullFileReread: resumePolicy.forbidFullFileReread,
  };
}

export function buildActionReadySuggestedContinuation({
  workspacePath,
  handoffPath,
  evidenceIndexPath,
  consumerContract,
}) {
  requireObject(consumerContract, "Action-ready consumer contract");
  const base = `Start a fresh Codex task in ${workspacePath || "the intended workspace"}, read ${handoffPath}, and follow its Resume Policy without resuming the Source Thread.`;
  if (consumerContract.mode !== "synthesize_first") {
    return `${base} Use ${evidenceIndexPath} only within the policy's targeted-read budget.`;
  }
  const reasons = consumerContract.allowedReadReasons.join(" or ");
  return `${base} Produce ${consumerContract.firstDeliverableIds.join(", ")} before any Evidence Index read; then use ${evidenceIndexPath} for at most ${consumerContract.maxTargetedReads} targeted reads limited to ${reasons}, with no broad search or full-file reread.`;
}

export function renderActionReadyHandoff({
  projection,
  evidencePack,
  evidenceIndex,
  evidenceIndexPath,
  frameDigest,
}) {
  const { hotContext, evidenceKeyMap } = validatedProjection(projection, evidenceIndex);
  const consumerContract = buildActionReadyConsumerContract(hotContext.resumePolicy);
  const deliverablesById = new Map(
    hotContext.deliverableStatus.map((deliverable) => [deliverable.deliverableId, deliverable]),
  );
  const lines = [
    "# Codex Handoff v2",
    "",
    "> Continue from the Working Synthesis. Follow the Resume Policy before retrieving Cold Evidence.",
    "",
    "## Objective and first deliverable",
    "",
    `- Objective: ${oneLine(hotContext.objective.text)}${evidenceSuffix([hotContext.objective.evidenceKey])}`,
  ];
  for (const exclusion of hotContext.explicitExclusions) {
    lines.push(
      `- Explicit exclusion: ${oneLine(exclusion.text)}${evidenceSuffix([exclusion.evidenceKey])}`,
    );
  }
  for (const deliverableId of consumerContract.firstDeliverableIds) {
    const deliverable = deliverablesById.get(deliverableId);
    if (!deliverable) fail(`Resume Policy references unknown first deliverable ${deliverableId}`);
    lines.push(
      `- First deliverable ${inlineCode(deliverableId)}: ${oneLine(deliverable.request)} — ${inlineCode(deliverable.status)}${evidenceSuffix(deliverable.evidenceKeys)}`,
    );
  }

  lines.push(
    "",
    "## Working Synthesis",
    "",
    `- Status: ${inlineCode(hotContext.workingSynthesis.status)}`,
  );
  for (const section of hotContext.workingSynthesis.sections) {
    lines.push(
      "",
      `### ${oneLine(section.title)}`,
      "",
      section.body.replace(/\r\n?/gu, "\n").trim(),
      "",
      `Evidence: ${evidenceCell(section.evidenceKeys)}`,
    );
  }

  lines.push("", "## Deliverable status", "");
  for (const deliverable of hotContext.deliverableStatus) {
    lines.push(
      `- ${inlineCode(deliverable.deliverableId)} — ${inlineCode(deliverable.status)}: ${oneLine(deliverable.request)}${evidenceSuffix(deliverable.evidenceKeys)}`,
    );
    if (deliverable.missingReason) {
      lines.push(`  - Missing: ${oneLine(deliverable.missingReason)}`);
    }
  }

  lines.push("", "## Confirmed findings and uncertainties", "", "### Confirmed findings", "");
  if (hotContext.workingSynthesis.confirmedFindings.length === 0) {
    lines.push("- None.");
  } else {
    for (const finding of hotContext.workingSynthesis.confirmedFindings) {
      lines.push(`- ${oneLine(finding.text)}${evidenceSuffix([finding.evidenceKey])}`);
    }
  }
  lines.push("", "### Uncertainties", "");
  if (hotContext.workingSynthesis.uncertainties.length === 0) {
    lines.push("- None.");
  } else {
    for (const uncertainty of hotContext.workingSynthesis.uncertainties) {
      lines.push(
        `- ${oneLine(uncertainty.question)}${evidenceSuffix(uncertainty.evidenceKeys)}`,
        `  - Allowed scopes: ${uncertainty.allowedScopes.map(inlineCode).join(", ")}`,
      );
    }
  }

  lines.push(
    "",
    "## Inspected Evidence Map",
    "",
    "| Location | Symbols | Scope | Reread policy | Evidence |",
    "| --- | --- | --- | --- | --- |",
  );
  if (hotContext.inspectedEvidenceMap.length === 0) {
    lines.push("| — | — | — | — | — |");
  } else {
    for (const inspection of hotContext.inspectedEvidenceMap) {
      lines.push(
        `| ${tableCell(inspection.location ?? "—")} | ${tableCell(inspection.symbols.join(", ") || "—")} | ${tableCell(inspection.scope ?? "—")} | ${tableCell(inspection.rereadPolicy)} | ${tableCell(evidenceCell(inspection.evidenceKeys))} |`,
      );
    }
  }

  lines.push(
    "",
    "## Resume Policy",
    "",
    `- Mode: ${inlineCode(consumerContract.mode)}`,
    `- First deliverable IDs: ${consumerContract.firstDeliverableIds.map(inlineCode).join(", ")}`,
  );
  if (consumerContract.mode === "synthesize_first") {
    lines.push(
      `- Pre-draft evidence reads: ${inlineCode(consumerContract.preDraftEvidenceReads)}`,
      `- Maximum targeted reads after the first draft: ${inlineCode(consumerContract.maxTargetedReads)}`,
    );
  } else {
    lines.push(`- Maximum targeted reads: ${inlineCode(consumerContract.maxTargetedReads)}`);
  }
  lines.push(
    `- Allowed read reasons: ${consumerContract.allowedReadReasons.map(inlineCode).join(", ")}`,
    `- Broad search: ${inlineCode(consumerContract.forbidBroadSearch ? "forbidden" : "allowed")}`,
    `- Full-file reread: ${inlineCode(consumerContract.forbidFullFileReread ? "forbidden" : "allowed")}`,
    "",
    "## Next actions and constraints",
    "",
    "### Next actions",
    "",
  );
  if (hotContext.nextActions.length === 0) lines.push("- None; produce the first deliverable.");
  else hotContext.nextActions.forEach((action, index) => {
    lines.push(`${index + 1}. ${oneLine(action.text)}${evidenceSuffix([action.evidenceKey])}`);
  });

  lines.push("", "### Constraints", "");
  if (hotContext.constraints.length === 0) lines.push("- None beyond the explicit exclusions above.");
  else for (const constraint of hotContext.constraints) {
    lines.push(`- ${oneLine(constraint.text)}${evidenceSuffix([constraint.evidenceKey])}`);
  }

  lines.push("", "### Active decisions", "");
  if (hotContext.decisions.length === 0) lines.push("- None recorded.");
  else for (const decision of hotContext.decisions) {
    lines.push(
      `- ${oneLine(decision.statement.text)}${evidenceSuffix([decision.statement.evidenceKey])}`,
    );
    for (const rationale of decision.rationale) {
      lines.push(
        `  - Rationale: ${oneLine(rationale.text)}${evidenceSuffix([rationale.evidenceKey])}`,
      );
    }
  }

  lines.push("", "### Relevant verification", "");
  if (hotContext.relevantVerifications.length === 0) lines.push("- None required before the first draft.");
  else for (const verification of hotContext.relevantVerifications) {
    lines.push(
      `- ${inlineCode(verification.result)} — ${inlineCode(verification.command)}${evidenceSuffix([verification.evidenceKey])}`,
    );
  }

  const workspacePath = evidencePack?.workspace?.cwd ?? evidenceIndex.workspace?.cwd ?? "unknown";
  const sourceRevision = evidencePack?.source?.sourceRevision ?? evidenceIndex.source?.sourceRevision;
  const coveredTurns = evidenceIndex.semanticCoverage?.turns?.length ?? 0;
  lines.push(
    "",
    "## Audit footer",
    "",
    `- Original workspace: ${inlineCode(workspacePath)}`,
    "- Artifact version: `handoff-v2`",
    `- Source revision digest: ${inlineCode(sourceRevision || "unknown")}`,
    `- Evidence Index: ${inlineCode(evidenceIndexPath)}`,
    `- Coverage: ${coveredTurns} Source Thread turns; ${evidenceKeyMap.entries.length} Handoff Evidence Keys; ${evidenceIndex.anchors.length} indexed anchors.`,
    `- Frame digest: ${inlineCode(frameDigest)}`,
    `- Evidence Index digest: ${inlineCode(evidenceIndex.integrity?.indexDigest || "unknown")}`,
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}
