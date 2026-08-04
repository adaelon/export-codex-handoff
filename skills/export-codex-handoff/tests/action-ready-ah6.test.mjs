import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  analyzeActionReadyContinuation,
  comparePackageTrees,
} from "./lib/action-ready-acceptance.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");

function responseItem(payload, timestamp) {
  return { timestamp, type: "response_item", payload };
}

function assistantMessage(text, timestamp) {
  return responseItem({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  }, timestamp);
}

function toolCall(name, args, timestamp) {
  return responseItem({
    type: "function_call",
    name,
    call_id: `call-${timestamp}`,
    arguments: JSON.stringify(args),
  }, timestamp);
}

test("AH6 package comparison binds identical relative files and SHA-256 content", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-ah6-package-"));
  const sourceDir = path.join(root, "source");
  const mirrorDir = path.join(root, "mirror");
  try {
    await fs.promises.mkdir(path.join(sourceDir, "nested"), { recursive: true });
    await fs.promises.mkdir(path.join(mirrorDir, "nested"), { recursive: true });
    await fs.promises.writeFile(path.join(sourceDir, "SKILL.md"), "same\n", "utf8");
    await fs.promises.writeFile(path.join(mirrorDir, "SKILL.md"), "same\n", "utf8");
    await fs.promises.writeFile(path.join(sourceDir, "nested", "contract.md"), "v2\n", "utf8");
    await fs.promises.writeFile(path.join(mirrorDir, "nested", "contract.md"), "v2\n", "utf8");

    const matching = await comparePackageTrees(sourceDir, mirrorDir);
    assert.equal(matching.matches, true);
    assert.equal(matching.fileCount, 2);
    assert.match(matching.packageDigest, /^sha256:[0-9a-f]{64}$/u);

    await fs.promises.writeFile(path.join(mirrorDir, "nested", "contract.md"), "mutated\n", "utf8");
    await fs.promises.writeFile(path.join(mirrorDir, "unexpected.txt"), "extra\n", "utf8");
    const mismatching = await comparePackageTrees(sourceDir, mirrorDir);
    assert.equal(mismatching.matches, false);
    assert.deepEqual(mismatching.changed, ["nested/contract.md"]);
    assert.deepEqual(mismatching.onlyInMirror, ["unexpected.txt"]);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test("AH6 continuation acceptance measures synthesize-first behavior from rollout order", () => {
  const records = [
    assistantMessage(
      "流程草稿：验证器先完成 Actionability 和 Hot Context 投影，渲染器随后只输出可执行区块。复杂度草稿：键映射和列表扫描均为线性。",
      "2026-08-04T12:00:01.000Z",
    ),
    toolCall(
      "read_file",
      { path: "src/review-target.mjs", line_start: 10, line_end: 30 },
      "2026-08-04T12:00:02.000Z",
    ),
    assistantMessage(
      "最终交付：流程说明已完成；复杂度说明已完成；定向读取只用于 claim verification，没有未决项。",
      "2026-08-04T12:00:03.000Z",
    ),
  ];
  const result = analyzeActionReadyContinuation(records, {
    consumerContract: {
      mode: "synthesize_first",
      preDraftEvidenceReads: 0,
      maxTargetedReads: 3,
      allowedReadReasons: ["claim_verification", "named_uncertainty"],
      forbidBroadSearch: true,
      forbidFullFileReread: true,
    },
    draftMarkers: ["流程草稿", "复杂度草稿"],
    deliverableMarkers: ["流程说明已完成", "复杂度说明已完成"],
  });

  assert.equal(result.accepted, true);
  assert.equal(result.substantiveDraftBeforeFirstToolCall, true);
  assert.equal(result.preDraftEvidenceReads, 0);
  assert.equal(result.broadSearches, 0);
  assert.equal(result.fullFileRereads, 0);
  assert.equal(result.targetedReads, 1);
  assert.deepEqual(result.missingDeliverables, []);
  assert.deepEqual(result.diagnosticCodes, []);
});

test("AH6 continuation acceptance rejects pre-draft broad and full-file rereads", () => {
  const records = [
    toolCall(
      "shell_command",
      { command: "rg -n reviewTarget .; Get-Content -Raw src/review-target.mjs" },
      "2026-08-04T12:00:01.000Z",
    ),
    assistantMessage("流程说明仍未完成。", "2026-08-04T12:00:02.000Z"),
  ];
  const result = analyzeActionReadyContinuation(records, {
    consumerContract: {
      mode: "synthesize_first",
      preDraftEvidenceReads: 0,
      maxTargetedReads: 3,
      allowedReadReasons: ["claim_verification", "named_uncertainty"],
      forbidBroadSearch: true,
      forbidFullFileReread: true,
    },
    draftMarkers: ["流程草稿", "复杂度草稿"],
    deliverableMarkers: ["流程说明已完成", "复杂度说明已完成"],
  });

  assert.equal(result.accepted, false);
  assert.equal(result.substantiveDraftBeforeFirstToolCall, false);
  assert.equal(result.preDraftEvidenceReads, 1);
  assert.equal(result.broadSearches, 1);
  assert.equal(result.fullFileRereads, 1);
  assert.deepEqual(result.missingDeliverables, ["流程说明已完成", "复杂度说明已完成"]);
  assert.deepEqual(result.diagnosticCodes, [
    "DRAFT_NOT_FIRST",
    "PRE_DRAFT_EVIDENCE_READ",
    "BROAD_SEARCH_FORBIDDEN",
    "FULL_FILE_REREAD_FORBIDDEN",
    "DELIVERABLE_INCOMPLETE",
  ]);
});

test("AH6 Skill promotes new user-facing Compression Runs to continuation-map-v2", () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");

  assert.match(
    skill,
    /prepare <UUID> --map-result-mode continuation-map-v2/,
  );
  assert.match(skill, /separate fresh continuation task/i);
  assert.match(skill, /draft\s+before (?:its )?first tool call/i);
  assert.match(skill, /zero broad searches/i);
  assert.match(skill, /zero full-file rereads/i);
  assert.doesNotMatch(skill, /Keep new\s+user-facing runs on `continuation-map-v1`/u);
});
