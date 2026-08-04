import {
  buildContinuationPreservationLedger,
  createEvidenceEntry,
} from "../../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../../scripts/lib/evidence-index.mjs";
import { buildProgressEvidence } from "../../scripts/lib/progress-evidence.mjs";
import { buildTerminalStateArtifacts } from "../../scripts/lib/terminal-state.mjs";
import { compareFixtureItems } from "../lib/fixture-comparator.mjs";

export const ACTION_READY_SESSION_ID = "00000000-0000-7000-8000-0000000000c0";
export const ACTION_READY_TURN_ID = "00000000-0000-7000-8000-0000000000c1";
export const ACTION_READY_GIT_HEAD = "3333333333333333333333333333333333333333";
export const ACTION_READY_SOURCE_PATH = "src/review-target.mjs";
export const ACTION_READY_TEST_PATH = "tests/review-target.test.mjs";
export const MIXED_REVIEW_GOAL = "看代码，说明流程和复杂度，不要跑测试";
export const EXPECTED_EXCLUSION_CLAUSE = "不要跑测试";

export const FLOW_FINDING = [
  "流程结论：reviewTarget 先调用 collectNodes 归一化输入，",
  "再用 pairwiseConflicts 比较节点对，最后返回 conflicts。",
].join("");
export const COMPLEXITY_FINDING = [
  "复杂度结论：pairwiseConflicts 的双层循环使时间复杂度为 O(n²)，",
  "结果数组最坏也占 O(n²) 空间。",
].join("");

export const SOURCE_READ_OUTPUT = `export function reviewTarget(input) {
  const nodes = collectNodes(input);
  return { nodes, conflicts: pairwiseConflicts(nodes) };
}

function pairwiseConflicts(nodes) {
  const conflicts = [];
  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      if (nodes[left].key === nodes[right].key) conflicts.push([left, right]);
    }
  }
  return conflicts;
}`;

export const TEST_READ_OUTPUT = `test("reviewTarget reports duplicate keys", () => {
  assert.deepEqual(
    reviewTarget([{ key: "same" }, { key: "same" }]).conflicts,
    [[0, 1]],
  );
});`;

export const SOURCE_READ_CALL_ID = "call-read-review-source";
export const TEST_READ_CALL_ID = "call-read-review-test";
export const EXISTENCE_PROBE_CALL_ID = "call-probe-review-source";
export const EXISTENCE_PROBE_COMMAND = `Test-Path ${ACTION_READY_SOURCE_PATH}`;

const FIRST_PROGRESS = [
  `我先读取 ${ACTION_READY_SOURCE_PATH} 与现有测试，`,
  "只做静态审查，不执行测试。",
].join("");
export const FINAL_PROGRESS = [
  "两处内容读取已完成。",
  FLOW_FINDING,
  COMPLEXITY_FINDING,
  "我正在把这两项结论整理成用户可直接阅读的答复。",
].join("");

export const EXPECTED_HOT_COLD_CLASSIFICATION = Object.freeze([
  {
    claimId: "ah0-objective",
    tier: "hot",
    role: "objective",
    text: MIXED_REVIEW_GOAL,
  },
  {
    claimId: "ah0-explicit-exclusion",
    tier: "hot",
    role: "constraint",
    text: EXPECTED_EXCLUSION_CLAUSE,
  },
  {
    claimId: "ah0-flow-finding",
    tier: "hot",
    role: "confirmed_finding",
    text: FLOW_FINDING,
  },
  {
    claimId: "ah0-complexity-finding",
    tier: "hot",
    role: "confirmed_finding",
    text: COMPLEXITY_FINDING,
  },
  {
    claimId: "ah0-source-read-payload",
    tier: "cold",
    role: "content_inspection",
    text: SOURCE_READ_OUTPUT,
  },
  {
    claimId: "ah0-test-read-payload",
    tier: "cold",
    role: "content_inspection",
    text: TEST_READ_OUTPUT,
  },
  {
    claimId: "ah0-existence-probe",
    tier: "cold",
    role: "existence_probe",
    text: EXISTENCE_PROBE_COMMAND,
  },
  {
    claimId: "ah0-read-success",
    tier: "cold",
    role: "mechanical_success",
    text: `read_file ${ACTION_READY_SOURCE_PATH}`,
  },
  {
    claimId: "ah0-terminal-audit",
    tier: "cold",
    role: "terminal_audit",
    text: "Terminal-State JSON",
  },
  {
    claimId: "ah0-semantic-coverage",
    tier: "cold",
    role: "audit_ledger",
    text: "Semantic coverage ledger",
  },
]);

export const ACTION_READY_AH0_BASELINE_METRICS = Object.freeze({
  handoffChars: 4_860,
  readableSectionChars: 4_386,
  auditChars: 3_476,
  auditShareBps: 7_925,
  inlineEvidenceSuffixes: 10,
  inlineEvidenceChars: 1_653,
  inlineEvidenceNoiseBps: 3_721,
  rawAnchorReferences: 21,
  rawClaimReferences: 9,
  missingActionabilitySections: 4,
  readyDeliverables: 0,
  requestedDeliverables: 2,
});

export const ACTION_READY_AH4_INTERIM_METRICS = Object.freeze({
  handoffChars: 4_847,
  readableSectionChars: 4_373,
  auditChars: 3_476,
  auditShareBps: 7_949,
  inlineEvidenceSuffixes: 10,
  inlineEvidenceChars: 1_653,
  inlineEvidenceNoiseBps: 3_732,
  rawAnchorReferences: 21,
  rawClaimReferences: 9,
  missingActionabilitySections: 4,
  readyDeliverables: 0,
  requestedDeliverables: 2,
});

export function actionReadyHandoffRolloutRecords() {
  return [
    {
      timestamp: "2026-08-01T08:00:00.000Z",
      type: "session_meta",
      payload: {
        session_id: ACTION_READY_SESSION_ID,
        cwd: "C:/synthetic/action-ready-workspace",
        timestamp: "2026-08-01T08:00:00.000Z",
        cli_version: "synthetic",
      },
    },
    {
      timestamp: "2026-08-01T08:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: ACTION_READY_TURN_ID,
        started_at: 1785571201,
      },
    },
    {
      timestamp: "2026-08-01T08:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: MIXED_REVIEW_GOAL }],
      },
    },
    {
      timestamp: "2026-08-01T08:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: FIRST_PROGRESS }],
      },
    },
    {
      timestamp: "2026-08-01T08:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "read_file",
        call_id: SOURCE_READ_CALL_ID,
        arguments: JSON.stringify({ path: ACTION_READY_SOURCE_PATH }),
      },
    },
    {
      timestamp: "2026-08-01T08:00:05.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: SOURCE_READ_CALL_ID,
        output: SOURCE_READ_OUTPUT,
      },
    },
    {
      timestamp: "2026-08-01T08:00:06.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "read_file",
        call_id: TEST_READ_CALL_ID,
        arguments: JSON.stringify({ path: ACTION_READY_TEST_PATH }),
      },
    },
    {
      timestamp: "2026-08-01T08:00:07.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: TEST_READ_CALL_ID,
        output: TEST_READ_OUTPUT,
      },
    },
    {
      timestamp: "2026-08-01T08:00:08.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "path_exists",
        call_id: EXISTENCE_PROBE_CALL_ID,
        arguments: JSON.stringify({ command: EXISTENCE_PROBE_COMMAND }),
      },
    },
    {
      timestamp: "2026-08-01T08:00:09.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: EXISTENCE_PROBE_CALL_ID,
        output: "True",
      },
    },
    {
      timestamp: "2026-08-01T08:00:10.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: FINAL_PROGRESS }],
      },
    },
    {
      timestamp: "2026-08-01T08:00:11.000Z",
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: ACTION_READY_TURN_ID,
        started_at: 1785571201,
        completed_at: 1785571211,
        reason: "interrupted",
      },
    },
  ];
}

function actionReadyWorkspaceFixture(parsed) {
  const sourceRevision = `sha256:${"c".repeat(64)}`;
  const cwd = parsed.session.cwd;
  const observations = [
    {
      payloadPath: "/git/head",
      value: ACTION_READY_GIT_HEAD,
      observationId: "git.head",
      args: ["rev-parse", "HEAD"],
    },
    {
      payloadPath: "/git/branchAndStatus",
      value: "## main",
      observationId: "git.status",
      args: ["status", "--short", "--branch"],
    },
    {
      payloadPath: "/git/recentCommits",
      value: `${ACTION_READY_GIT_HEAD} Synthetic review baseline`,
      observationId: "git.log",
      args: ["log", "--oneline", "-5"],
    },
  ];
  const evidenceEntries = observations.map((observation) => createEvidenceEntry({
    sourceKind: "workspace",
    sourceRevision,
    payloadPath: observation.payloadPath,
    value: observation.value,
    locator: {
      kind: "command",
      observationId: observation.observationId,
      executable: "git",
      cwd,
      args: observation.args,
      expectedOk: true,
      stream: "stdout",
    },
  }));
  return {
    evidenceEntries,
    workspace: {
      status: "available",
      cwd,
      observedAt: "2026-08-01T08:05:00.000Z",
      sourceRevision,
      observationAnchors: evidenceEntries.map((entry) => entry.anchor.anchorId),
      checkpoint: { status: "missing" },
      git: {
        status: "available",
        head: ACTION_READY_GIT_HEAD,
        branchAndStatus: "## main",
        recentCommits: `${ACTION_READY_GIT_HEAD} Synthetic review baseline`,
        unstagedDiffStat: "",
        stagedDiffStat: "",
        unstagedNames: "",
        stagedNames: "",
      },
    },
  };
}

export function actionReadyEvidencePack(parsed) {
  const workspaceFixture = actionReadyWorkspaceFixture(parsed);
  const evidenceEntries = [
    ...parsed.evidenceEntries,
    ...workspaceFixture.evidenceEntries,
  ];
  const terminalArtifacts = buildTerminalStateArtifacts(
    parsed.sourceContinuation,
    workspaceFixture.workspace,
  );
  const preservationLedger = buildContinuationPreservationLedger(
    parsed.sourceRevision,
    evidenceEntries,
    {
      turns: parsed.turns,
      workspace: workspaceFixture.workspace,
      additionalRequiredAnchors: terminalArtifacts.terminalStateClaim.anchors,
    },
  );
  const source = {
    sessionId: ACTION_READY_SESSION_ID,
    storageKind: "active",
    rolloutPath: "C:/synthetic/action-ready/source-rollout.jsonl",
    sourceChars: parsed.sourceChars,
    sourceBytes: parsed.sourceBytes,
    sourceRevision: parsed.sourceRevision,
    session: parsed.session,
  };
  const pack = {
    formatVersion: 1,
    source,
    turns: parsed.turns,
    ignoredEvents: parsed.ignored,
    workspace: workspaceFixture.workspace,
    evidenceAnchors: evidenceEntries.map((entry) => entry.anchor),
    preservationLedger,
    sourceContinuation: parsed.sourceContinuation,
    ...terminalArtifacts,
  };
  pack.evidenceIndex = buildEvidenceIndex({
    sessionId: ACTION_READY_SESSION_ID,
    source,
    workspace: pack.workspace,
    entries: evidenceEntries,
    preservationLedger,
  });
  pack.progressEvidence = buildProgressEvidence(parsed.turns, pack.evidenceIndex);
  const evidencePack = { ...pack };
  delete evidencePack.evidenceIndex;
  pack.evidenceChars = JSON.stringify(evidencePack).length;
  return pack;
}

function outputAnchor(parsed, callId) {
  const receipt = parsed.turns
    .flatMap((turn) => turn.toolReceipts)
    .find((item) => item.callId === callId && item.valueKind === "output");
  if (!receipt) throw new TypeError(`Missing synthetic output receipt for ${callId}`);
  return receipt.outputAnchor;
}

function workspaceAnchor(pack, payloadPath) {
  const anchor = pack.evidenceAnchors.find((item) => (
    item.sourceKind === "workspace" && item.payloadPath === payloadPath
  ));
  if (!anchor) throw new TypeError(`Missing synthetic workspace anchor ${payloadPath}`);
  return anchor.anchorId;
}

function fixtureClaim(claimId, kind, text, anchors) {
  return { claimId, kind, text, anchors };
}

export function currentEvidenceValidReviewReduction(parsed, pack, frameBinding) {
  const sourceAnchor = outputAnchor(parsed, SOURCE_READ_CALL_ID);
  const testAnchor = outputAnchor(parsed, TEST_READ_CALL_ID);
  const probeAnchor = outputAnchor(parsed, EXISTENCE_PROBE_CALL_ID);
  const progressAnchor = parsed.turns.at(-1).assistantMessages.at(-1).anchors[0];
  const gitAnchor = workspaceAnchor(pack, "/git/branchAndStatus");
  const completedWork = fixtureClaim(
    "claim-ah0-mechanical-completion",
    "completed_work",
    "Two code reads and one existence probe completed successfully.",
    [sourceAnchor, testAnchor, probeAnchor],
  );
  const openWork = fixtureClaim(
    "claim-ah0-draft-missing",
    "open_work",
    "The requested process and complexity explanation has not been drafted.",
    [progressAnchor],
  );
  const nextAction = fixtureClaim(
    "claim-ah0-reread-next",
    "next_action",
    "Re-read both files and repeat the existence probe before drafting the answer.",
    [sourceAnchor, testAnchor, probeAnchor],
  );
  const importantLocations = [
    {
      claimId: "claim-ah0-source-location",
      kind: "important_location",
      location: ACTION_READY_SOURCE_PATH,
      purpose: "A successful Tool Receipt reported this source read.",
      anchors: [sourceAnchor],
    },
    {
      claimId: "claim-ah0-test-location",
      kind: "important_location",
      location: ACTION_READY_TEST_PATH,
      purpose: "A successful Tool Receipt reported this test read.",
      anchors: [testAnchor],
    },
  ];
  const verification = [
    {
      claimId: "claim-ah0-source-read-pass",
      command: `read_file ${ACTION_READY_SOURCE_PATH}`,
      result: "pass",
      anchors: [sourceAnchor],
    },
    {
      claimId: "claim-ah0-test-read-pass",
      command: `read_file ${ACTION_READY_TEST_PATH}`,
      result: "pass",
      anchors: [testAnchor],
    },
    {
      claimId: "claim-ah0-existence-pass",
      command: EXISTENCE_PROBE_COMMAND,
      result: "pass",
      anchors: [probeAnchor],
    },
  ];
  const reduced = {
    frameId: frameBinding.frameId,
    frameDigest: frameBinding.frameDigest,
    continuationDirective: "Re-open the inspected files, then write the requested review.",
    objective: {
      goal: frameBinding.frame.currentGoal.text,
      explicitExclusions: frameBinding.frame.explicitExclusions.map((claim) => claim.text),
    },
    acceptedProposal: null,
    terminalState: structuredClone(frameBinding.frame.terminalStateClaim),
    constraints: [],
    workspaceState: {
      summary: fixtureClaim(
        "claim-ah0-workspace",
        "workspace_state",
        "Synthetic Git observations completed successfully.",
        [gitAnchor],
      ),
      evidenceStatus: "full",
      conflicts: [],
    },
    completedWork: [completedWork],
    openWork: [openWork],
    nextActions: [nextAction],
    importantLocations,
    archivalLedger: { decisions: [], attempts: [], verification },
    preservationCoverage: [],
    provenance: { sourceTurnIds: [ACTION_READY_TURN_ID], notes: [] },
    compressionNotes: ["Complete evidence remains retrievable through the Evidence Index."],
  };
  const sourceClaimIds = [
    completedWork.claimId,
    openWork.claimId,
    nextAction.claimId,
    ...importantLocations.map((item) => item.claimId),
    ...verification.map((item) => item.claimId),
    reduced.terminalState.claimId,
  ];
  return {
    reduced,
    coverage: [{
      turnId: ACTION_READY_TURN_ID,
      status: "summarized",
      claimIds: sourceClaimIds,
      reason: "Existing evidence-valid output retains operational and audit Claims.",
    }],
    provenance: [ACTION_READY_TURN_ID],
  };
}

function markdownSections(markdown) {
  const headings = [...markdown.matchAll(/^## ([^\r\n]+)\r?$/gmu)];
  return headings.map((heading, index) => ({
    title: heading[1],
    text: markdown.slice(
      heading.index,
      headings[index + 1]?.index ?? markdown.length,
    ).trim(),
  }));
}

function compactChars(value) {
  return value.replace(/\s/gu, "").length;
}

function currentClassification(handoff, reduced, sectionsByTitle) {
  const workingSynthesis = sectionsByTitle.get("Working Synthesis") || "";
  const terminalState = sectionsByTitle.get("Terminal state") || "";
  const verification = sectionsByTitle.get("Verification outcomes") || "";
  const classification = [
    {
      claimId: "ah0-objective",
      tier: "hot",
      role: "objective",
      text: reduced.objective.goal,
    },
    {
      claimId: "ah0-explicit-exclusion",
      tier: "hot",
      role: "constraint",
      text: reduced.objective.explicitExclusions[0],
    },
  ];
  for (const [claimId, finding] of [
    ["ah0-flow-finding", FLOW_FINDING],
    ["ah0-complexity-finding", COMPLEXITY_FINDING],
  ]) {
    classification.push({
      claimId,
      tier: handoff.includes(finding) ? "hot" : "cold",
      role: workingSynthesis.includes(finding)
        ? "confirmed_finding"
        : terminalState.includes(finding) ? "terminal_audit" : "unavailable",
      text: finding,
    });
  }
  classification.push(
    {
      claimId: "ah0-source-read-payload",
      tier: handoff.includes(SOURCE_READ_OUTPUT) ? "hot" : "cold",
      role: "content_inspection",
      text: SOURCE_READ_OUTPUT,
    },
    {
      claimId: "ah0-test-read-payload",
      tier: handoff.includes(TEST_READ_OUTPUT) ? "hot" : "cold",
      role: "content_inspection",
      text: TEST_READ_OUTPUT,
    },
    {
      claimId: "ah0-existence-probe",
      tier: handoff.includes(EXISTENCE_PROBE_COMMAND) ? "hot" : "cold",
      role: verification.includes(EXISTENCE_PROBE_COMMAND)
        ? "audit_verification"
        : "existence_probe",
      text: EXISTENCE_PROBE_COMMAND,
    },
    {
      claimId: "ah0-read-success",
      tier: handoff.includes(`read_file ${ACTION_READY_SOURCE_PATH}`) ? "hot" : "cold",
      role: verification.includes(`read_file ${ACTION_READY_SOURCE_PATH}`)
        ? "audit_verification"
        : "mechanical_success",
      text: `read_file ${ACTION_READY_SOURCE_PATH}`,
    },
    {
      claimId: "ah0-terminal-audit",
      tier: sectionsByTitle.has("Terminal state") ? "hot" : "cold",
      role: "terminal_audit",
      text: "Terminal-State JSON",
    },
    {
      claimId: "ah0-semantic-coverage",
      tier: sectionsByTitle.has("Semantic coverage") ? "hot" : "cold",
      role: "audit_ledger",
      text: "Semantic coverage ledger",
    },
  );
  return classification;
}

export function compareActionReadyHandoff(handoff, reduced) {
  const sections = markdownSections(handoff);
  const sectionsByTitle = new Map(sections.map((section) => [section.title, section.text]));
  const continuationValueSections = new Set([
    "Continuation directive",
    "Objective",
    "Completed work",
    "Open work",
    "Next actions",
  ]);
  const readableSectionChars = sections.reduce(
    (total, section) => total + compactChars(section.text),
    0,
  );
  const auditChars = sections
    .filter((section) => !continuationValueSections.has(section.title))
    .reduce((total, section) => total + compactChars(section.text), 0);
  const inlineEvidenceMatches = [
    ...handoff.matchAll(/_\((?:sources|evidence):[^)]*\)_/gu),
  ].map((match) => match[0]);
  const rawAnchorReferences = [...handoff.matchAll(/\banchor-[0-9a-f]{64}\b/gu)].length;
  const rawClaimReferences = [
    ...handoff.matchAll(/\bclaim-[A-Za-z0-9][A-Za-z0-9-]*\b/gu),
  ].length;
  const requiredActionabilitySections = [
    "Working Synthesis",
    "Deliverable status",
    "Inspected Evidence Map",
    "Resume Policy",
  ];
  const missingActionabilitySections = requiredActionabilitySections.filter(
    (title) => !sectionsByTitle.has(title),
  );
  const firstDeliverableReadiness = {
    requested: ["flow-explanation", "complexity-explanation"],
    ready: [],
    firstDeliverableReady: false,
    draftBeforeRead: false,
    requiresPreDraftRead: reduced.nextActions.some((claim) => /re-read/i.test(claim.text)),
  };
  const auditExpansion = {
    readableSectionChars,
    auditChars,
    auditShareBps: readableSectionChars === 0
      ? 0
      : Math.round((auditChars * 10_000) / readableSectionChars),
    auditDominates: auditChars * 2 > readableSectionChars,
  };
  const inlineEvidenceNoise = {
    suffixCount: inlineEvidenceMatches.length,
    inlineChars: inlineEvidenceMatches.reduce((total, item) => total + item.length, 0),
    shareBps: readableSectionChars === 0
      ? 0
      : Math.round(
        (inlineEvidenceMatches.reduce((total, item) => total + compactChars(item), 0) * 10_000)
          / readableSectionChars,
      ),
    rawAnchorReferences,
    rawClaimReferences,
  };
  const actualClassification = currentClassification(handoff, reduced, sectionsByTitle);
  const classification = compareFixtureItems(
    actualClassification,
    EXPECTED_HOT_COLD_CLASSIFICATION,
  );
  const diagnosticCodes = [];
  if (
    missingActionabilitySections.length > 0 ||
    firstDeliverableReadiness.ready.length < firstDeliverableReadiness.requested.length
  ) {
    diagnosticCodes.push("HANDOFF_NOT_ACTIONABLE");
  }
  if (
    auditExpansion.auditDominates ||
    classification.mutated.some((claimId) => [
      "ah0-existence-probe",
      "ah0-read-success",
      "ah0-terminal-audit",
      "ah0-semantic-coverage",
    ].includes(claimId))
  ) {
    diagnosticCodes.push("HANDOFF_LOW_VALUE");
  }
  const baselineMetrics = {
    handoffChars: handoff.length,
    readableSectionChars,
    auditChars,
    auditShareBps: auditExpansion.auditShareBps,
    inlineEvidenceSuffixes: inlineEvidenceNoise.suffixCount,
    inlineEvidenceChars: inlineEvidenceNoise.inlineChars,
    inlineEvidenceNoiseBps: inlineEvidenceNoise.shareBps,
    rawAnchorReferences,
    rawClaimReferences,
    missingActionabilitySections: missingActionabilitySections.length,
    readyDeliverables: firstDeliverableReadiness.ready.length,
    requestedDeliverables: firstDeliverableReadiness.requested.length,
  };
  return {
    actionability: {
      requiredSections: requiredActionabilitySections,
      missingSections: missingActionabilitySections,
      usableDraft: sectionsByTitle.has("Working Synthesis"),
      diagnosticCodes,
    },
    auditExpansion,
    inlineEvidenceNoise,
    firstDeliverableReadiness,
    classification,
    actualClassification,
    baselineMetrics,
  };
}
