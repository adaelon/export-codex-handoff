import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPreservationLedger,
  createEvidenceEntry,
  hashFileRevision,
} from "../../scripts/lib/evidence-addressing.mjs";
import { buildEvidenceIndex } from "../../scripts/lib/evidence-index.mjs";
import { MIDDLE_ONLY_MARKER, largeToolOutput } from "./slice1-semantic-fixture.mjs";

const PREFIX = "codex-slice1-cli-smoke-";
const SESSION_ID = "019fa2c3-b7b8-7621-9d2a-75b93e1d97f7";

function validateRoot(value) {
  const root = path.resolve(value);
  if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith(PREFIX)) {
    throw new Error(`Refusing unmanaged CLI fixture root: ${root}`);
  }
  return root;
}

async function create(root) {
  await fs.promises.mkdir(root, { recursive: false });
  const rolloutPath = path.join(root, "rollout.jsonl");
  const indexPath = path.join(root, "handoff.evidence.json");
  const record = { payload: { output: largeToolOutput() } };
  await fs.promises.writeFile(rolloutPath, `${JSON.stringify(record)}\n`, "utf8");
  const revision = await hashFileRevision(rolloutPath);
  const entry = createEvidenceEntry({
    sourceKind: "source_thread",
    sourceRevision: revision.sourceRevision,
    eventOrdinal: 1,
    rolloutLine: 1,
    payloadPath: "/payload/output",
    callId: "call-cli-smoke",
    value: record.payload.output,
    locator: { kind: "rollout_payload" },
  });
  const preservationLedger = buildPreservationLedger(revision.sourceRevision, [entry]);
  const index = buildEvidenceIndex({
    sessionId: SESSION_ID,
    source: { rolloutPath, ...revision },
    workspace: { cwd: root, sourceRevision: null },
    entries: [entry],
    preservationLedger,
  });
  await fs.promises.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return {
    root,
    rolloutPath,
    indexPath,
    anchorId: entry.anchor.anchorId,
    marker: MIDDLE_ONLY_MARKER,
  };
}

const [command, rootArg] = process.argv.slice(2);
const root = validateRoot(rootArg);
if (command === "create") {
  process.stdout.write(`${JSON.stringify(await create(root))}\n`);
} else if (command === "cleanup") {
  await fs.promises.rm(root, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify({ removed: root })}\n`);
} else {
  throw new Error(`Unknown fixture command: ${command}`);
}
