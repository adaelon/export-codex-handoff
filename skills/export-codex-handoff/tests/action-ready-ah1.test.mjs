import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { preservationLedgerMetrics } from "../scripts/lib/evidence-addressing.mjs";
import {
  buildProgressEvidence,
  classifyToolOperation,
  validateProgressEvidence,
} from "../scripts/lib/progress-evidence.mjs";
import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import {
  ACTION_READY_SOURCE_PATH,
  ACTION_READY_TEST_PATH,
  FINAL_PROGRESS,
  SOURCE_READ_CALL_ID,
  SOURCE_READ_OUTPUT,
  actionReadyEvidencePack,
  actionReadyHandoffRolloutRecords,
} from "./fixtures/action-ready-handoff-fixtures.mjs";

const DUPLICATE_SOURCE_READ_CALL_ID = "call-read-review-source-again";
const MECHANICAL_CALL_ID = "call-notify-review-progress";

async function withParsedRecords(records, run) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ah1-progress-"));
  const rolloutPath = path.join(root, "synthetic-rollout.jsonl");
  try {
    await fs.promises.writeFile(
      rolloutPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const parsed = await parseSourceThread(rolloutPath);
    const pack = actionReadyEvidencePack(parsed);
    return await run({ parsed, pack });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

function recordsWithDuplicateAndMechanicalSuccess() {
  const records = actionReadyHandoffRolloutRecords();
  const finalProgressIndex = records.findIndex((record) => (
    record.type === "response_item" &&
    record.payload?.type === "message" &&
    record.payload?.role === "assistant" &&
    record.payload?.content?.[0]?.text === FINAL_PROGRESS
  ));
  assert.notEqual(finalProgressIndex, -1);
  records.splice(finalProgressIndex, 0,
    {
      timestamp: "2026-08-01T08:00:09.100Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "read_file",
        call_id: DUPLICATE_SOURCE_READ_CALL_ID,
        arguments: JSON.stringify({ path: ACTION_READY_SOURCE_PATH }),
      },
    },
    {
      timestamp: "2026-08-01T08:00:09.200Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: DUPLICATE_SOURCE_READ_CALL_ID,
        output: SOURCE_READ_OUTPUT,
      },
    },
    {
      timestamp: "2026-08-01T08:00:09.300Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "notify",
        call_id: MECHANICAL_CALL_ID,
        arguments: JSON.stringify({ message: "review progress recorded" }),
      },
    },
    {
      timestamp: "2026-08-01T08:00:09.400Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: MECHANICAL_CALL_ID,
        output: "ok",
      },
    },
  );
  return records;
}

function receiptFor(turn, callId, valueKind) {
  return turn.toolReceipts.find((receipt) => (
    receipt.callId === callId && receipt.valueKind === valueKind
  ));
}

test("AH1 selects bounded assistant progress and content inspections while cold operations stay out", async () => {
  await withParsedRecords(actionReadyHandoffRolloutRecords(), ({ parsed, pack }) => {
    const indexBefore = structuredClone(pack.evidenceIndex);
    const ledgerBefore = preservationLedgerMetrics(pack.preservationLedger);
    const progress = buildProgressEvidence(parsed.turns, pack.evidenceIndex, {
      maxInputChars: 20_000,
      maxDispatchChars: 16_000,
    });

    assert.equal(
      validateProgressEvidence(pack.progressEvidence, parsed.turns, pack.evidenceIndex),
      pack.progressEvidence,
    );
    assert.equal(validateProgressEvidence(progress, parsed.turns, pack.evidenceIndex), progress);
    assert.equal(progress.kind, "codex-handoff-progress-evidence");
    assert.equal(progress.formatVersion, 1);
    assert.deepEqual(progress.budgets, {
      maxInputChars: 20_000,
      maxDispatchChars: 16_000,
      digest: progress.budgets.digest,
    });
    assert.match(progress.budgets.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(progress.assistantProgress.some((reference) => reference.text === FINAL_PROGRESS));
    assert.deepEqual(
      progress.inspections.map((inspection) => inspection.location),
      [ACTION_READY_SOURCE_PATH, ACTION_READY_TEST_PATH],
    );
    assert.ok(progress.inspections.every((inspection) => (
      inspection.operationClass === "content_inspection" &&
      inspection.scope === "full" &&
      inspection.symbols.length === 0
    )));
    const knownAnchors = new Set(pack.evidenceIndex.anchors.map((entry) => entry.anchor.anchorId));
    assert.ok(progress.assistantProgress.every((reference) => (
      reference.anchors.every((anchorId) => knownAnchors.has(anchorId))
    )));
    assert.ok(progress.inspections.every((inspection) => (
      inspection.outputEvidence.anchors.every((anchorId) => knownAnchors.has(anchorId))
    )));
    assert.equal(progress.inputMetrics.successfulToolReceipts, 3);
    assert.equal(progress.inputMetrics.classifiedReceiptCount, 3);
    assert.deepEqual(progress.inputMetrics.operationClassCounts, {
      content_inspection: 2,
      existence_probe: 1,
      verification: 0,
      mutation: 0,
      mechanical_success: 0,
    });
    assert.equal(progress.inputMetrics.coldReceipts, 1);
    assert.ok(progress.inputMetrics.selectedInputChars <= progress.budgets.maxInputChars);
    assert.ok(progress.inputMetrics.dispatchChars <= progress.budgets.maxDispatchChars);
    assert.equal(
      progress.inputMetrics.dispatchChars,
      JSON.stringify({
        assistantProgress: progress.assistantProgress,
        inspections: progress.inspections,
      }).length,
    );
    assert.deepEqual(pack.evidenceIndex, indexBefore);
    assert.deepEqual(preservationLedgerMetrics(pack.preservationLedger), ledgerBefore);
  });
});

test("AH1 classifies each successful receipt once and folds duplicate content scopes deterministically", async () => {
  await withParsedRecords(recordsWithDuplicateAndMechanicalSuccess(), ({ parsed, pack }) => {
    const first = buildProgressEvidence(parsed.turns, pack.evidenceIndex);
    const second = buildProgressEvidence(
      structuredClone(parsed.turns),
      structuredClone(pack.evidenceIndex),
    );
    assert.deepEqual(second, first);

    const turn = parsed.turns.at(-1);
    assert.equal(classifyToolOperation({
      toolName: "read_file",
      inputReceipt: receiptFor(turn, SOURCE_READ_CALL_ID, "input"),
    }), "content_inspection");
    assert.equal(classifyToolOperation({
      toolName: "path_exists",
      inputReceipt: receiptFor(turn, "call-probe-review-source", "input"),
    }), "existence_probe");
    assert.equal(classifyToolOperation({
      toolName: "notify",
      inputReceipt: receiptFor(turn, MECHANICAL_CALL_ID, "input"),
    }), "mechanical_success");

    assert.equal(first.inspections.length, 2);
    assert.equal(first.inputMetrics.successfulToolReceipts, 5);
    assert.equal(first.inputMetrics.classifiedReceiptCount, 5);
    assert.equal(first.inputMetrics.duplicateScopesFolded, 1);
    assert.equal(first.inputMetrics.coldReceipts, 3);
    assert.deepEqual(first.inputMetrics.operationClassCounts, {
      content_inspection: 3,
      existence_probe: 1,
      verification: 0,
      mutation: 0,
      mechanical_success: 1,
    });
    assert.equal(first.coverage.receiptClassifications.count, 5);
    assert.match(first.coverage.receiptClassifications.digest, /^sha256:[0-9a-f]{64}$/u);

    const duplicateOutput = receiptFor(turn, DUPLICATE_SOURCE_READ_CALL_ID, "output");
    const sourceInspection = first.inspections.find((inspection) => (
      inspection.location === ACTION_READY_SOURCE_PATH
    ));
    assert.deepEqual(sourceInspection.outputEvidence.anchors, [duplicateOutput.outputAnchor]);
    const coldAnchors = [
      receiptFor(turn, "call-probe-review-source", "output").outputAnchor,
      receiptFor(turn, MECHANICAL_CALL_ID, "output").outputAnchor,
    ];
    const serialized = JSON.stringify(first);
    assert.ok(coldAnchors.every((anchorId) => !serialized.includes(anchorId)));
  });
});

test("AH1 budgets independently bound progress dispatch without changing complete evidence", async () => {
  await withParsedRecords(actionReadyHandoffRolloutRecords(), ({ parsed, pack }) => {
    const indexDigest = pack.evidenceIndex.integrity.indexDigest;
    const criticalDigest = preservationLedgerMetrics(
      pack.evidenceIndex.preservationLedger,
    ).requiredAnchorDigest;
    const progress = buildProgressEvidence(parsed.turns, pack.evidenceIndex, {
      maxInputChars: 640,
      maxDispatchChars: 512,
    });

    assert.ok(progress.inputMetrics.selectedInputChars <= 640);
    assert.ok(progress.inputMetrics.dispatchChars <= 512);
    assert.ok(
      progress.assistantProgress.length + progress.inspections.length <
      progress.inputMetrics.assistantProgressCandidates +
        progress.inputMetrics.contentInspectionCandidates,
    );
    assert.equal(pack.evidenceIndex.integrity.indexDigest, indexDigest);
    assert.equal(
      preservationLedgerMetrics(pack.evidenceIndex.preservationLedger).requiredAnchorDigest,
      criticalDigest,
    );

    const changedBudget = structuredClone(progress);
    changedBudget.budgets.maxDispatchChars += 1;
    assert.throws(
      () => validateProgressEvidence(changedBudget, parsed.turns, pack.evidenceIndex),
      /Progress Evidence does not match its source and budgets/u,
    );
  });
});
