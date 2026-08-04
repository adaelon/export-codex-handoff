import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPreservationLedger,
  canonicalStringify,
  createEvidenceEntry,
  hashFileRevision,
  sha256Text,
} from "../scripts/lib/evidence-addressing.mjs";
import {
  buildEvidenceIndex,
  validateEvidenceIndex,
} from "../scripts/lib/evidence-index.mjs";

test("Evidence Index schema rejects an integrity-covered raw body field", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-index-schema-"));
  try {
    const rolloutPath = path.join(root, "rollout.jsonl");
    const record = { payload: { output: "private raw tool body" } };
    await fs.promises.writeFile(rolloutPath, `${JSON.stringify(record)}\n`);
    const source = await hashFileRevision(rolloutPath);
    const entry = createEvidenceEntry({
      sourceKind: "source_thread",
      sourceRevision: source.sourceRevision,
      rolloutLine: 1,
      eventOrdinal: 1,
      payloadPath: "/payload/output",
      value: record.payload.output,
      locator: { kind: "rollout_payload" },
    });
    const index = buildEvidenceIndex({
      sessionId: "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7",
      source: { rolloutPath, ...source },
      workspace: { cwd: root, sourceRevision: null },
      entries: [entry],
      preservationLedger: buildPreservationLedger(source.sourceRevision, [entry]),
    });
    index.anchors[0].body = record.payload.output;
    const digestInput = structuredClone(index);
    delete digestInput.integrity.indexDigest;
    index.integrity.indexDigest = sha256Text(canonicalStringify(digestInput));
    assert.throws(() => validateEvidenceIndex(index), { code: "INVALID_EVIDENCE_INDEX" });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
