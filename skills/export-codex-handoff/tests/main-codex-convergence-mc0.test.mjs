import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADJUDICATION_DECISION_ACTIONS,
  ADJUDICATION_PHASE_POLICIES,
} from "../scripts/lib/adjudication.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");
const REPO_ROOT = path.resolve(SKILL_DIR, "..", "..");

test("MC0 exposes only Main Codex convergence actions", () => {
  assert.deepEqual(ADJUDICATION_DECISION_ACTIONS, [
    "repair_stage",
    "regenerate_stage",
    "relocate_publication",
  ]);

  for (const [phase, policy] of Object.entries(ADJUDICATION_PHASE_POLICIES)) {
    assert.equal(
      policy.allowedActions.includes("publish_degraded"),
      false,
      `${phase} must not terminate through an incomplete Handoff`,
    );
    assert.equal(
      policy.allowedActions.includes("retry_stage"),
      false,
      `${phase} must not delegate recovery to a blind retry`,
    );
    assert.ok(
      policy.allowedActions.includes("repair_stage") ||
        policy.allowedActions.includes("regenerate_stage") ||
        policy.allowedActions.includes("relocate_publication"),
      `${phase} must expose a Main Codex convergence action`,
    );
  }
});

test("MC0 runtime and operator contracts forbid degraded publication", () => {
  const adjudicationActions = fs.readFileSync(
    path.join(SKILL_DIR, "scripts", "lib", "adjudication-actions.mjs"),
    "utf8",
  );
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const workerContract = fs.readFileSync(
    path.join(SKILL_DIR, "references", "continuation-map-v2-worker-contract.md"),
    "utf8",
  );
  const context = fs.readFileSync(path.join(REPO_ROOT, "CONTEXT.md"), "utf8");

  assert.doesNotMatch(adjudicationActions, /publishDegradedHandoff|publish_degraded/u);
  assert.doesNotMatch(skill, /`publish_degraded`|Degraded Handoff/u);
  assert.doesNotMatch(workerContract, /`publish_degraded`|degradation action/iu);
  assert.match(skill, /Main Codex Convergence/u);
  assert.match(skill, /normal Handoff/iu);
  assert.match(context, /\*\*Verified Handoff\*\*/u);
  assert.match(context, /only successful terminal artifact/iu);
});
