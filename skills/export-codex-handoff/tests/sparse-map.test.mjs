import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSemanticCoverageGraph,
  expandSparseMapResult,
  validateSparseMapResult,
} from "../scripts/lib/validation.mjs";
import {
  ANCHORS,
  FRAME_DIGEST,
  FRAME_ID,
  claim,
  fullFixture,
  importantLocationsSparseFixture,
  reusedVerificationSparseDiagnosticFixture,
  segmentChunk,
  sparseFixture,
} from "./fixtures/sparse-map-fixtures.mjs";

test("complete sparse bindings expand to the existing full MAP shape without mutation", () => {
  const chunk = segmentChunk();
  const sparse = sparseFixture();
  const before = structuredClone(sparse);
  const expanded = expandSparseMapResult(sparse, chunk);

  assert.deepEqual(expanded, fullFixture());
  assert.deepEqual(sparse, before);
  assert.equal(validateSparseMapResult(sparse, chunk), sparse);
  assert.deepEqual(
    buildSemanticCoverageGraph([expanded], chunk.expectedTurnIds),
    buildSemanticCoverageGraph([fullFixture()], chunk.expectedTurnIds),
  );
});

test("S0 importantLocations fixture expands as the existing MAP Claim shape", () => {
  const expanded = expandSparseMapResult(
    importantLocationsSparseFixture(),
    segmentChunk(),
  );
  assert.deepEqual(expanded.importantLocations, [{
    claimId: "map009-important-location",
    kind: "important_location",
    text: "C:/synthetic/workspace/reduce-input.json — synthetic MAP Claim location",
    anchors: [ANCHORS[0]],
  }]);
  assert.ok(expanded.turnCoverage[0].claimIds.includes("map009-important-location"));
});

test("fragment indexes expand to ordered fragment coverage", () => {
  const chunk = {
    segmentId: "fragment-map-001",
    stage: "fragment_map",
    expectedFragmentIds: ["fragment-1", "fragment-2"],
    fragments: [
      { fragmentId: "fragment-1", anchors: [ANCHORS[0]] },
      { fragmentId: "fragment-2", anchors: [ANCHORS[1]] },
    ],
    compressionFrame: { frameId: FRAME_ID },
    frameDigest: FRAME_DIGEST,
  };
  const sparse = {
    formatVersion: 1,
    kind: "codex-handoff-sparse-map",
    frameId: FRAME_ID,
    frameDigest: FRAME_DIGEST,
    segmentId: chunk.segmentId,
    claims: [claim("fragment-claim", "objective", "Retain fragment one", 0)],
    claimGroups: {
      objectiveFacts: ["fragment-claim"],
      userConstraints: [],
      completedWork: [],
      openWork: [],
      nextActions: [],
      importantLocations: [],
      conflicts: [],
    },
    claimBindings: [{ claimId: "fragment-claim", evidenceIndexes: [0] }],
    exclusionRanges: [{
      startIndex: 1,
      endIndexExclusive: 2,
      reasonCode: "duplicate",
    }],
    archivalLedger: { decisions: [], attempts: [], verification: [] },
    compressionNotes: [],
  };

  assert.deepEqual(expandSparseMapResult(sparse, chunk).fragmentCoverage, [
    {
      fragmentId: "fragment-1",
      status: "summarized",
      claimIds: ["fragment-claim"],
      reason: "captured by sparse MAP claim bindings",
    },
    {
      fragmentId: "fragment-2",
      status: "ignored",
      claimIds: [],
      reason: "excluded by sparse MAP: duplicate evidence",
    },
  ]);
});

test("sparse validation fails deterministically on coverage and Claim errors", async (t) => {
  const rejects = (mutate, code) => {
    const candidate = sparseFixture();
    mutate(candidate);
    assert.throws(() => expandSparseMapResult(candidate, segmentChunk()), { code });
  };

  await t.test("gap", () => {
    rejects((candidate) => { candidate.exclusionRanges = []; }, "INCOMPLETE_SPARSE_COVERAGE");
  });

  await t.test("overlap", () => {
    rejects((candidate) => {
      candidate.exclusionRanges = [{
        startIndex: 0,
        endIndexExclusive: 2,
        reasonCode: "non_semantic",
      }];
    }, "OVERLAPPING_SPARSE_COVERAGE");
  });

  await t.test("overlapping exclusion ranges", () => {
    rejects((candidate) => {
      candidate.exclusionRanges.push({
        startIndex: 1,
        endIndexExclusive: 2,
        reasonCode: "duplicate",
      });
    }, "OVERLAPPING_SPARSE_COVERAGE");
  });

  await t.test("unknown Claim ID", () => {
    rejects((candidate) => {
      candidate.claimGroups.objectiveFacts = ["claim-missing"];
    }, "UNSUPPORTED_CLAIM");
  });

  await t.test("duplicate Claim", () => {
    rejects((candidate) => {
      candidate.claims.push(structuredClone(candidate.claims[0]));
    }, "DUPLICATE_CLAIM");
  });

  await t.test("Claim anchored to the wrong evidence index", () => {
    rejects((candidate) => {
      candidate.claims.find((item) => item.claimId === "claim-objective").anchors = [ANCHORS[2]];
    }, "INCOMPLETE_SPARSE_COVERAGE");
  });

  await t.test("unknown Evidence Anchor", () => {
    rejects((candidate) => {
      candidate.claims.find((item) => item.claimId === "claim-objective").anchors = [
        `anchor-${"d".repeat(64)}`,
      ];
    }, "UNSUPPORTED_CLAIM");
  });

  await t.test("unknown ledger reference", () => {
    rejects((candidate) => {
      candidate.archivalLedger.decisions[0].rationaleClaimIds = ["claim-missing"];
    }, "UNSUPPORTED_CLAIM");
  });

  await t.test("reused verification Claim ID", () => {
    assert.throws(
      () => expandSparseMapResult(
        reusedVerificationSparseDiagnosticFixture(),
        segmentChunk(),
      ),
      { code: "DUPLICATE_CLAIM" },
    );
  });
});
