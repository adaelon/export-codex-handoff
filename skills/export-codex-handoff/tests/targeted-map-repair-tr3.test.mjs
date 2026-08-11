import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(TEST_DIR, "..");

function readSkillFile(relativePath) {
  return fs.readFileSync(path.join(SKILL_DIR, relativePath), "utf8");
}

test("TR3 passes the exact MAP repair issue list to the responsible Worker", () => {
  const skill = readSkillFile("SKILL.md");
  const workerContract = readSkillFile(
    "references/continuation-map-v2-worker-contract.md",
  );

  assert.match(
    skill,
    /`MAP_REPAIR_REQUIRED`[\s\S]{0,600}exact ordered `details\.issues\[\]` unchanged[\s\S]{0,600}same dispatch/u,
  );
  assert.match(
    skill,
    /attempt-2 `nextDispatch`[\s\S]{0,600}exact ordered `details\.issues\[\]` unchanged/u,
  );
  assert.match(
    workerContract,
    /`MAP_REPAIR_REQUIRED`[\s\S]{0,600}exact ordered `details\.issues\[\]`[\s\S]{0,600}fieldPath[\s\S]{0,200}correctionHint/u,
  );
});

test("TR3 prohibits clean-run recovery and unrelated MAP replay", () => {
  const skill = readSkillFile("SKILL.md");
  const workerContract = readSkillFile(
    "references/continuation-map-v2-worker-contract.md",
  );

  for (const contract of [skill, workerContract]) {
    assert.match(contract, /Never start a clean Compression Run/u);
    assert.match(contract, /never\s+replay unrelated MAP Workers/iu);
  }
});

test("TR3 routes REDUCE-owned failures to REDUCE-only correction", () => {
  const skill = readSkillFile("SKILL.md");

  assert.match(
    skill,
    /REDUCE-owned[\s\S]{0,300}rewrite only `reducedPath`[\s\S]{0,300}rerun the `validate-reduce` preflight/u,
  );
  assert.match(
    skill,
    /REDUCE-owned[\s\S]{0,600}must not create a MAP attempt-2 dispatch or replay a MAP Worker/u,
  );
});
