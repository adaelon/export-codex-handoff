import test from "node:test";
import assert from "node:assert/strict";

import { validateReduceResult } from "../scripts/lib/validation.mjs";
import {
  CONTINUATION_ACCEPTANCE_TARGETS,
  HIGH_ENTROPY_PATH_FALSE_POSITIVE,
  REDUCE_DEFAULT_CATEGORIES,
  RETAINED_BASELINE_METRICS,
  allAnchorsRequiredGrowthFixture,
  compareRetainedMetrics,
  emptyCriticalCategoriesReduceFixture,
  repeatedClaimBookkeepingFixture,
} from "./fixtures/continuation-grade-fixtures.mjs";

function occurrences(text, value) {
  return text.split(value).length - 1;
}

test("R0 all-anchors-required fixture reproduces retained count and frame growth classes", () => {
  const fixture = allAnchorsRequiredGrowthFixture();
  const frameBytes = Buffer.byteLength(JSON.stringify(fixture.frame), "utf8");

  assert.equal(
    fixture.preservationLedger.requiredAnchors.length,
    RETAINED_BASELINE_METRICS.requiredAnchors,
  );
  assert.equal(fixture.preservationLedger.requiredAnchors.length, fixture.entries.length);
  assert.equal(
    fixture.preservationLedger.exactIdentifiers.length,
    RETAINED_BASELINE_METRICS.exactIdentifiers,
  );
  assert.equal(fixture.preservationLedger.criticalCategories.length, 0);
  assert.ok(frameBytes >= RETAINED_BASELINE_METRICS.frameBytes, {
    frameBytes,
    retainedFrameBytes: RETAINED_BASELINE_METRICS.frameBytes,
  });
});

test("R0 high-entropy fixture reproduces the frozen pre-R1 path false positive", () => {
  const legacyPathCandidates = [
    ...HIGH_ENTROPY_PATH_FALSE_POSITIVE.text.matchAll(/(?:\/[A-Za-z0-9._-]+){2,}/g),
  ].map((match) => match[0]);
  assert.ok(legacyPathCandidates.includes(HIGH_ENTROPY_PATH_FALSE_POSITIVE.falsePath));
});

test("R0 empty critical categories with six REDUCE defaults reproduce late shape failure", () => {
  const fixture = emptyCriticalCategoriesReduceFixture();
  assert.equal(fixture.preservationLedger.criticalCategories.length, 0);
  assert.deepEqual(
    fixture.reduced.preservationCoverage.map((entry) => entry.category),
    REDUCE_DEFAULT_CATEGORIES,
  );
  assert.throws(
    () => validateReduceResult(
      fixture.reduced,
      fixture.turnIds,
      fixture.expectedFrame,
      {
        evidenceIndex: fixture.evidenceIndex,
        preservationLedger: fixture.preservationLedger,
      },
    ),
    { code: "INCOMPLETE_PRESERVATION_COVERAGE" },
  );
});

test("R0 repeated-Claim fixture exposes current REDUCE bookkeeping amplification", () => {
  const fixture = repeatedClaimBookkeepingFixture();
  const serialized = JSON.stringify(fixture.reduceInput);

  assert.equal(occurrences(serialized, fixture.claim.text), 1);
  assert.equal(occurrences(serialized, fixture.claim.claimId), 4);
  assert.equal(occurrences(serialized, fixture.anchorId), 3);
});

test("R0 retained metric comparator preserves units, deltas, and target semantics", () => {
  const compared = compareRetainedMetrics({
    evidencePackChars: CONTINUATION_ACCEPTANCE_TARGETS.evidencePackChars,
    initialMapDispatches: CONTINUATION_ACCEPTANCE_TARGETS.initialMapDispatches,
    reduceInputChars: CONTINUATION_ACCEPTANCE_TARGETS.reduceInputChars,
    phaseTimingsTotalMs: CONTINUATION_ACCEPTANCE_TARGETS.phaseTimingsTotalMs,
  });
  const byMetric = new Map(compared.map((entry) => [entry.metric, entry]));

  assert.equal(byMetric.get("evidencePackChars").targetPassed, true);
  assert.equal(
    byMetric.get("evidencePackChars").deltaFromBaseline,
    CONTINUATION_ACCEPTANCE_TARGETS.evidencePackChars
      - RETAINED_BASELINE_METRICS.evidencePackChars,
  );
  assert.equal(byMetric.get("initialMapDispatches").targetPassed, true);
  assert.equal(byMetric.get("reduceInput").comparableToBaseline, false);
  assert.equal(byMetric.get("reduceInput").deltaFromBaseline, null);
  assert.equal(byMetric.get("reduceInput").comparableToTarget, true);
  assert.equal(byMetric.get("reduceInput").targetPassed, true);
  assert.equal(byMetric.get("frameBytes").candidate, null);
  assert.equal(byMetric.get("prepublicationLowerBoundMs").targetPassed, true);
});
