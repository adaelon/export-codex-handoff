import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildFrameInput } from "../scripts/lib/compression-frame.mjs";
import { parseSourceThread } from "../scripts/lib/source-thread.mjs";
import {
  captureWorkspaceSnapshot,
  classifyCheckpointFreshness,
  parseCheckpointRevision,
} from "../scripts/lib/workspace-snapshot.mjs";
import {
  CHECKPOINT_REVISION,
  COMPRESSION_GIT_HEAD,
  STALE_AA_CHECKPOINT,
  acceptedTerminalEvidencePack,
  acceptedTerminalRolloutRecords,
} from "./fixtures/accepted-terminal-fixtures.mjs";

async function parseFixtureRollout(root) {
  const rolloutPath = path.join(root, "synthetic-rollout.jsonl");
  await fs.promises.writeFile(
    rolloutPath,
    `${acceptedTerminalRolloutRecords().map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  return parseSourceThread(rolloutPath);
}

test("TS2 checkpoint revision parsing and freshness classification are deterministic", () => {
  assert.equal(parseCheckpointRevision(STALE_AA_CHECKPOINT), CHECKPOINT_REVISION);
  assert.equal(
    parseCheckpointRevision(`Commit at write time: ${COMPRESSION_GIT_HEAD} synthetic`),
    COMPRESSION_GIT_HEAD,
  );
  assert.equal(parseCheckpointRevision("Commit at write time: unavailable"), null);
  assert.equal(
    classifyCheckpointFreshness(COMPRESSION_GIT_HEAD, COMPRESSION_GIT_HEAD.toUpperCase()),
    "fresh",
  );
  assert.equal(
    classifyCheckpointFreshness(CHECKPOINT_REVISION, COMPRESSION_GIT_HEAD),
    "stale",
  );
  assert.equal(classifyCheckpointFreshness(null, COMPRESSION_GIT_HEAD), "unknown");
  assert.equal(classifyCheckpointFreshness(CHECKPOINT_REVISION, "not-a-revision"), "unknown");
});

test("TS2 workspace capture records full Git HEAD and classifies the checkpoint", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ts2-workspace-"));
  try {
    await fs.promises.writeFile(path.join(root, "SESSION_CHECKPOINT.md"), STALE_AA_CHECKPOINT, "utf8");
    const commandRunner = async (_cwd, args) => {
      const command = args.join(" ");
      if (command === "rev-parse --is-inside-work-tree") return { ok: true, stdout: "true", stderr: "" };
      if (command === "rev-parse HEAD") return { ok: true, stdout: COMPRESSION_GIT_HEAD, stderr: "" };
      if (command === "log --oneline -5") {
        return { ok: true, stdout: `${COMPRESSION_GIT_HEAD} Complete AA implementation`, stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    };
    const snapshot = await captureWorkspaceSnapshot(root, { commandRunner });

    assert.equal(snapshot.git.status, "available");
    assert.equal(snapshot.git.head, COMPRESSION_GIT_HEAD);
    assert.equal(snapshot.checkpoint.recordedRevision, CHECKPOINT_REVISION);
    assert.equal(snapshot.checkpoint.freshness, "stale");
    assert.ok(Number.isFinite(Date.parse(snapshot.observedAt)));
    assert.ok(snapshot.evidenceEntries.some((entry) => entry.anchor.payloadPath === "/git/head"));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("TS2 stale checkpoint stays indexed but loses current Critical and Frame authority", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ts2-authority-"));
  try {
    const parsed = await parseFixtureRollout(root);
    const pack = acceptedTerminalEvidencePack(parsed);
    const checkpointAnchor = pack.evidenceAnchors.find((anchor) => (
      anchor.payloadPath === "/checkpoint/content"
    )).anchorId;
    const gitAnchors = pack.evidenceAnchors
      .filter((anchor) => anchor.payloadPath?.startsWith("/git/"))
      .map((anchor) => anchor.anchorId);
    const frameInput = buildFrameInput(pack, pack.evidenceIndex);

    assert.ok(pack.evidenceIndex.anchors.some((entry) => entry.anchor.anchorId === checkpointAnchor));
    assert.equal(pack.preservationLedger.requiredAnchors.includes(checkpointAnchor), false);
    assert.ok(gitAnchors.every((anchorId) => pack.preservationLedger.requiredAnchors.includes(anchorId)));
    assert.equal(frameInput.workspaceCheckpoint, null);
    assert.equal(frameInput.requiredFrameAnchors.includes(checkpointAnchor), false);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
