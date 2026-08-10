import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  createMapDispatch,
  scheduleMapDispatches,
  validateMapDispatch,
} from "../scripts/lib/map-worker.mjs";
import { validateMapGenerationObservation } from "../scripts/lib/performance-calibration.mjs";
import {
  PROVIDER_TIMING_PT2_FIXTURE,
  createMapGenerationObservation,
  createProviderTimingDispatches,
} from "./fixtures/provider-timing-fixtures.mjs";
import { comparePackageTrees } from "./lib/action-ready-acceptance.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const REPO_ROOT = path.resolve(SKILL_DIR, "..", "..");
const CLI_PATH = path.join(SKILL_DIR, "scripts", "export-handoff.mjs");
const INSTALLED_SKILL_ENV = "EXPORT_CODEX_HANDOFF_INSTALLED_DIR";
const FRAME_DIGEST = `sha256:${"f".repeat(64)}`;

function compatibilityDispatch(segmentId, mapResultMode = undefined) {
  const base = `C:/synthetic/provider-timing-pt5/${segmentId}`;
  return createMapDispatch({
    segmentId,
    chunkPath: `${base}.json`,
    summaryPath: `${base}-summary.json`,
    framePath: "C:/synthetic/provider-timing-pt5/frame.json",
    frameDigest: FRAME_DIGEST,
    attempt: 1,
    ...(mapResultMode
      ? { mapResultMode, maxMapOutputChars: 4_000 }
      : {}),
  });
}

test("PT5 keeps legacy, missing-mode, sparse, continuation, and single-wave v2 dispatches compatible", () => {
  const routes = {
    legacyV1: compatibilityDispatch("legacy-v1"),
    missingModeV2: compatibilityDispatch("missing-mode-v2"),
    sparseV1: compatibilityDispatch("sparse-v1", "sparse-map-v1"),
    continuationV1: compatibilityDispatch("continuation-v1", "continuation-map-v1"),
    continuationV2: compatibilityDispatch("continuation-v2", "continuation-map-v2"),
  };

  for (const dispatch of Object.values(routes)) {
    assert.equal(validateMapDispatch(dispatch), dispatch);
  }
  assert.equal(Object.hasOwn(routes.legacyV1, "mapResultMode"), false);
  assert.equal(Object.hasOwn(routes.missingModeV2, "mapResultMode"), false);
  assert.equal(routes.sparseV1.mapResultMode, "sparse-map-v1");
  assert.equal(routes.continuationV1.mapResultMode, "continuation-map-v1");

  const singleWave = scheduleMapDispatches([routes.continuationV2], 1);
  assert.equal(singleWave.status, "ready");
  assert.equal(singleWave.availableSlots, 1);
  assert.deepEqual(singleWave.dispatches, [routes.continuationV2]);
});

test("PT5 rejects unsupported multi-wave timing before a claim and keeps provider source strict", () => {
  const dispatches = createProviderTimingDispatches(createMapDispatch);
  const frozenDispatches = structuredClone(dispatches);
  const scheduled = scheduleMapDispatches(
    dispatches,
    PROVIDER_TIMING_PT2_FIXTURE.freshSlots,
    {
      providerTimingCapability:
        PROVIDER_TIMING_PT2_FIXTURE.unavailableProviderTimingCapability,
    },
  );

  assert.deepEqual(scheduled, {
    status: "needs-user",
    diagnosticCode: "PROVIDER_TIMING_UNAVAILABLE",
    dispatches: [],
  });
  assert.deepEqual(dispatches, frozenDispatches);
  assert.throws(
    () => validateMapGenerationObservation(createMapGenerationObservation(
      dispatches[0],
      { source: "workflow" },
    )),
    { code: "INVALID_PROVIDER_LATENCY" },
  );
});

test("PT5 CLI help exposes the fail-early and post-worker provider timing lifecycle", () => {
  const help = execFileSync(process.execPath, [CLI_PATH, "--help"], {
    encoding: "utf8",
    windowsHide: true,
  });

  assert.match(help, /Provider timing for multi-wave MAP:/u);
  assert.match(help, /before any Worker claim/u);
  assert.match(help, /PROVIDER_TIMING_UNAVAILABLE/u);
  assert.match(help, /provider-reported latency only/u);
  assert.match(help, /Never substitute coordinator or harness elapsed time/u);
  assert.ok(help.indexOf("record-map-metric") < help.indexOf("schedule-map"));
});

test("PT5 Skill, contracts, metadata, architecture, and live report name the exact blocker", () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const contracts = fs.readFileSync(
    path.join(SKILL_DIR, "references", "contracts.md"),
    "utf8",
  );
  const metadata = fs.readFileSync(
    path.join(SKILL_DIR, "agents", "openai.yaml"),
    "utf8",
  );
  const architecture = fs.readFileSync(
    path.join(REPO_ROOT, "docs", "architecture.md"),
    "utf8",
  );
  const plan = fs.readFileSync(
    path.join(REPO_ROOT, "docs", "slice-plan-provider-timing-capability.md"),
    "utf8",
  );
  const liveReport = fs.readFileSync(
    path.join(REPO_ROOT, "docs", "provider-timing-live-acceptance.md"),
    "utf8",
  );

  for (const contract of [skill, contracts]) {
    assert.match(contract, /ProviderTimingCapability/u);
    assert.match(contract, /PROVIDER_TIMING_UNAVAILABLE/u);
    assert.match(contract, /record-map-metric <WORK_DIR>/u);
    assert.match(contract, /schedule-map <WORK_DIR>/u);
    assert.match(contract, /provider-reported/u);
  }
  assert.match(metadata, /provider timing capability/iu);
  assert.match(architecture, /provider-timing-live-acceptance\.md/u);
  assert.match(plan, /PT5 packaging complete; live acceptance BLOCKED/u);
  assert.match(liveReport, /^Status: BLOCKED$/mu);
  assert.match(liveReport, /collaboration\.list_agents/u);
  assert.match(liveReport, /no provider-reported per-worker generation duration/iu);
  assert.match(liveReport, /PROVIDER_TIMING_UNAVAILABLE/u);
  assert.match(liveReport, /zero admitted\s+dispatches/u);
  assert.match(liveReport, /No semantic MAP Worker was launched/u);
});

test("PT5 package comparison supports an explicit installed Skill directory", async () => {
  const configured = process.env[INSTALLED_SKILL_ENV]?.trim();
  const mirrorDir = configured ? path.resolve(configured) : SKILL_DIR;
  if (configured) {
    assert.notEqual(
      mirrorDir,
      SKILL_DIR,
      `${INSTALLED_SKILL_ENV} must name the installed package, not the repository source`,
    );
  }

  const comparison = await comparePackageTrees(SKILL_DIR, mirrorDir);
  assert.equal(comparison.matches, true, JSON.stringify(comparison));
  assert.ok(comparison.fileCount >= 72);
  assert.match(comparison.packageDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(comparison.onlyInSource, []);
  assert.deepEqual(comparison.onlyInMirror, []);
  assert.deepEqual(comparison.changed, []);
});
