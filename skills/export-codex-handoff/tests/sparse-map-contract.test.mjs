import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateMapResult,
  validateSparseMapResult,
} from "../scripts/lib/validation.mjs";
import {
  fullFixture,
  importantLocationsFullDiagnosticFixture,
  reusedVerificationFullDiagnosticFixture,
  segmentChunk,
} from "./fixtures/sparse-map-fixtures.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, "..", "..", "..");
const MAP_WORKER_CONTRACT = path.resolve(
  TEST_DIR,
  "..",
  "references",
  "map-worker-contract.md",
);

test("S0 synthetic fixture reproduces the MAP importantLocations shape diagnostic", () => {
  assert.throws(
    () => validateMapResult(importantLocationsFullDiagnosticFixture(), segmentChunk()),
    { code: "INVALID_MODEL_OUTPUT" },
  );
});

test("S0 synthetic fixture reproduces the reused verification Claim diagnostic", () => {
  assert.throws(
    () => validateMapResult(reusedVerificationFullDiagnosticFixture(), segmentChunk()),
    { code: "DUPLICATE_CLAIM" },
  );
});

test("S0 fixtures preserve the valid legacy full-MAP contract", () => {
  const candidate = fullFixture();
  assert.equal(validateMapResult(candidate, segmentChunk()), candidate);
});

test("S3 MAP-only contract carries a validator-backed sparse example", () => {
  const contract = fs.readFileSync(MAP_WORKER_CONTRACT, "utf8");
  const match = contract.match(
    /<!-- sparse-map-example:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- sparse-map-example:end -->/u,
  );
  assert.ok(match, "MAP Worker contract must contain the marked sparse JSON example");
  const example = JSON.parse(match[1]);
  assert.equal(validateSparseMapResult(example, segmentChunk()), example);
  assert.doesNotMatch(contract, /"location"\s*:/u);
  assert.doesNotMatch(contract, /"purpose"\s*:/u);
});

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(target);
    return entry.isFile() && entry.name.endsWith(".md") ? [target] : [];
  });
}

test("S0 documentation has no broken local Markdown links", () => {
  const broken = [];
  for (const documentPath of markdownFiles(path.join(REPOSITORY_ROOT, "docs"))) {
    const markdown = fs.readFileSync(documentPath, "utf8");
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const rawTarget = match[1].trim().replace(/^<|>$/gu, "");
      if (/^(?:[a-z]+:|#)/iu.test(rawTarget)) continue;
      const fileTarget = decodeURIComponent(rawTarget.split("#", 1)[0]);
      if (!fileTarget) continue;
      const resolved = path.resolve(path.dirname(documentPath), fileTarget);
      if (!fs.existsSync(resolved)) {
        broken.push(`${path.relative(REPOSITORY_ROOT, documentPath)} -> ${rawTarget}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
