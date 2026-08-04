import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContinuationPreservationLedger,
  createEvidenceEntry,
  extractExactIdentifiers,
  preservationLedgerMetrics,
  selectCriticalAnchors,
} from "../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../scripts/lib/evidence-index.mjs";
import { HIGH_ENTROPY_PATH_FALSE_POSITIVE } from "./fixtures/continuation-grade-fixtures.mjs";

const SOURCE_REVISION = `sha256:${"a".repeat(64)}`;
const WORKSPACE_REVISION = `sha256:${"b".repeat(64)}`;
const SESSION_ID = "00000000-0000-7000-8000-0000000000a1";

function sourceEntry(index, value) {
  return createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: SOURCE_REVISION,
    turnId: `turn-${index}`,
    eventOrdinal: index,
    rolloutLine: index,
    payloadPath: "/payload/content/0/text",
    value,
    locator: { kind: "rollout_payload" },
  });
}

function workspaceEntry(index, payloadPath, value) {
  return createEvidenceEntry({
    sourceKind: "workspace",
    sourceRevision: WORKSPACE_REVISION,
    payloadPath,
    value,
    locator: {
      kind: "command",
      observationId: `workspace-${index}`,
      executable: "git",
      cwd: "C:/synthetic/workspace",
      args: ["status", "--short"],
      expectedOk: true,
      stream: "stdout",
    },
  });
}

function continuationSelectionFixture() {
  const oldGoal = sourceEntry(1, "Earlier goal references C:\\legacy\\old.txt");
  const preserve = sourceEntry(2, "Preserve exactly symbol: criticalBoundary");
  const routineTool = sourceEntry(3, "routine output at C:\\temp\\discard.txt");
  const failedTool = sourceEntry(4, "FAILED verification for C:\\repo\\tests\\critical.test.mjs");
  const latestGoal = sourceEntry(5, "Implement R1; do not change MAP or REDUCE.");
  const checkpoint = workspaceEntry(6, "/checkpoint/content", "Next: implement R1.");
  const git = workspaceEntry(7, "/git/branchAndStatus", "## main\n M runtime.mjs");
  const entries = [oldGoal, preserve, routineTool, failedTool, latestGoal, checkpoint, git];
  const turns = [
    {
      turnId: "turn-old",
      userMessages: [
        { text: "Earlier goal", anchors: [oldGoal.anchor.anchorId] },
        { text: "Preserve exactly symbol: criticalBoundary", anchors: [preserve.anchor.anchorId] },
      ],
      toolReceipts: [
        { status: "ok", outputAnchor: routineTool.anchor.anchorId },
        { status: "error", outputAnchor: failedTool.anchor.anchorId },
      ],
    },
    {
      turnId: "turn-latest",
      userMessages: [{
        text: "Implement R1; do not change MAP or REDUCE.",
        anchors: [latestGoal.anchor.anchorId],
      }],
      toolReceipts: [],
    },
  ];
  return {
    entries,
    turns,
    selected: [
      preserve.anchor.anchorId,
      failedTool.anchor.anchorId,
      latestGoal.anchor.anchorId,
      checkpoint.anchor.anchorId,
      git.anchor.anchorId,
    ],
    nonCritical: [oldGoal.anchor.anchorId, routineTool.anchor.anchorId],
  };
}

test("R1 selects a justified Critical Anchor subset without shrinking the Evidence Index", () => {
  const fixture = continuationSelectionFixture();
  const requiredAnchors = selectCriticalAnchors(fixture.entries, { turns: fixture.turns });
  const ledger = buildContinuationPreservationLedger(
    SOURCE_REVISION,
    fixture.entries,
    { turns: fixture.turns },
  );
  const evidenceIndex = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source: {
      rolloutPath: "C:/synthetic/rollout.jsonl",
      sourceRevision: SOURCE_REVISION,
      sourceBytes: 1,
    },
    workspace: {
      cwd: "C:/synthetic/workspace",
      sourceRevision: WORKSPACE_REVISION,
    },
    entries: fixture.entries,
    preservationLedger: ledger,
  });

  assert.deepEqual(requiredAnchors, fixture.selected);
  assert.deepEqual(ledger.requiredAnchors, fixture.selected);
  assert.ok(ledger.requiredAnchors.length < fixture.entries.length);
  assert.equal(evidenceIndex.anchors.length, fixture.entries.length);
  for (const anchorId of fixture.nonCritical) {
    assert.ok(evidenceIndex.anchors.some((entry) => entry.anchor.anchorId === anchorId));
    assert.equal(ledger.requiredAnchors.includes(anchorId), false);
  }
  assert.equal(
    ledger.exactIdentifiers.some((identifier) => identifier.value === "C:\\temp\\discard.txt"),
    false,
  );
  assert.ok(ledger.exactIdentifiers.some((identifier) => (
    identifier.kind === "symbol" && identifier.value === "criticalBoundary"
  )));
});

test("R1 identifier hygiene rejects opaque blobs and invalid path or URL syntax", () => {
  const identifiers = extractExactIdentifiers([
    HIGH_ENTROPY_PATH_FALSE_POSITIVE.text,
    "opaque=/QWxhZGRpbjpvcGVuIHNlc2FtZQ==/QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
    `opaque URL https://example.com/api?token=${"QWxhZGRpbjpvcGVuIHNlc2FtZQ==".repeat(3)}`,
    "invalid path /repo/../secret and invalid URL https://-bad.example/path",
    "valid path C:\\repo\\src\\index.mjs and URL https://example.com/docs/r1",
  ].join("\n"));
  const values = new Set(identifiers.map((identifier) => identifier.value));

  assert.equal(values.has(HIGH_ENTROPY_PATH_FALSE_POSITIVE.falsePath), false);
  assert.equal(values.has("/repo/../secret"), false);
  assert.equal(values.has("https://-bad.example/path"), false);
  assert.ok(values.has("C:\\repo\\src\\index.mjs"));
  assert.ok(values.has("https://example.com/docs/r1"));
});

test("R1 Critical Anchor selection fails closed on an unknown hard obligation", () => {
  const fixture = continuationSelectionFixture();
  assert.throws(
    () => selectCriticalAnchors(fixture.entries, {
      turns: fixture.turns,
      additionalRequiredAnchors: [`anchor-${"f".repeat(64)}`],
    }),
    /unknown anchor/u,
  );
});

test("R1 Critical Anchor and exact-identifier counts and digests are deterministic", () => {
  const fixture = continuationSelectionFixture();
  const first = buildContinuationPreservationLedger(
    SOURCE_REVISION,
    fixture.entries,
    { turns: fixture.turns },
  );
  const second = buildContinuationPreservationLedger(
    SOURCE_REVISION,
    structuredClone(fixture.entries),
    { turns: structuredClone(fixture.turns) },
  );

  assert.deepEqual(second, first);
  const metrics = preservationLedgerMetrics(first);
  assert.deepEqual(preservationLedgerMetrics(second), metrics);
  assert.equal(metrics.requiredAnchorCount, fixture.selected.length);
  assert.equal(metrics.exactIdentifierCount, first.exactIdentifiers.length);
  assert.match(metrics.requiredAnchorDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(metrics.exactIdentifierDigest, /^sha256:[0-9a-f]{64}$/);
});
