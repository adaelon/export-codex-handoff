import test from "node:test";
import assert from "node:assert/strict";

import {
  createMapDispatch,
  scheduleMapDispatches,
} from "../scripts/lib/map-worker.mjs";
import * as performanceCalibration from "../scripts/lib/performance-calibration.mjs";
import {
  PROVIDER_TIMING_PT2_FIXTURE,
  createProviderTimingDispatches,
} from "./fixtures/provider-timing-fixtures.mjs";

function providerTimingDispatches() {
  return createProviderTimingDispatches(createMapDispatch);
}

test("PT2 validates the exact ProviderTimingCapability variants", () => {
  assert.equal(
    typeof performanceCalibration.validateProviderTimingCapability,
    "function",
  );
  const validate = performanceCalibration.validateProviderTimingCapability;
  assert.deepEqual(
    validate(PROVIDER_TIMING_PT2_FIXTURE.availableProviderTimingCapability),
    PROVIDER_TIMING_PT2_FIXTURE.availableProviderTimingCapability,
  );
  assert.deepEqual(
    validate(PROVIDER_TIMING_PT2_FIXTURE.unavailableProviderTimingCapability),
    PROVIDER_TIMING_PT2_FIXTURE.unavailableProviderTimingCapability,
  );

  const invalidCapabilities = [
    undefined,
    {
      ...PROVIDER_TIMING_PT2_FIXTURE.availableProviderTimingCapability,
      model: "inferred-model",
    },
    {
      ...PROVIDER_TIMING_PT2_FIXTURE.availableProviderTimingCapability,
      source: null,
    },
    {
      ...PROVIDER_TIMING_PT2_FIXTURE.availableProviderTimingCapability,
      reasonCode: "not_exposed",
    },
    {
      ...PROVIDER_TIMING_PT2_FIXTURE.unavailableProviderTimingCapability,
      observationPoint: "post_worker",
    },
    {
      ...PROVIDER_TIMING_PT2_FIXTURE.unavailableProviderTimingCapability,
      reasonCode: "model_not_supported",
    },
  ];
  for (const capability of invalidCapabilities) {
    assert.throws(
      () => validate(capability),
      { code: PROVIDER_TIMING_PT2_FIXTURE.diagnostics.invalidCapability },
    );
  }
});

test("PT2 observes zero fresh slots before timing capability", () => {
  const scheduled = scheduleMapDispatches(providerTimingDispatches(), 0, {
    providerTimingCapability: { available: "inferred" },
  });

  assert.deepEqual(scheduled, {
    status: "needs-user",
    diagnosticCode: "MAP_WORKER_UNAVAILABLE",
    dispatches: [],
  });
});

test("PT2 validates optional timing capability without using it for admission", () => {
  const dispatches = providerTimingDispatches();
  const { freshSlots } = PROVIDER_TIMING_PT2_FIXTURE;

  assert.deepEqual(
    scheduleMapDispatches(dispatches.slice(0, freshSlots), freshSlots),
    {
      status: "ready",
      availableSlots: freshSlots,
      dispatches: dispatches.slice(0, freshSlots),
    },
  );
  assert.deepEqual(
    scheduleMapDispatches(dispatches, freshSlots, {
      providerTimingCapability:
        PROVIDER_TIMING_PT2_FIXTURE.unavailableProviderTimingCapability,
    }),
    {
      status: "ready",
      availableSlots: freshSlots,
      dispatches: dispatches.slice(0, freshSlots),
    },
  );
  assert.deepEqual(
    scheduleMapDispatches(dispatches, freshSlots, {
      providerTimingCapability:
        PROVIDER_TIMING_PT2_FIXTURE.availableProviderTimingCapability,
    }),
    {
      status: "ready",
      availableSlots: freshSlots,
      dispatches: dispatches.slice(0, freshSlots),
    },
  );
});
