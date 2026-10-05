/**
 * Interface boundary for the still-unselected live pool source.
 * A client must never submit a price; only a keeper using an adapter can do so.
 */
export class MockPriceAdapter {
  constructor({ poolAddress = "mock-pool", startPrice = 100_000n, endPrice = 105_500n } = {}) {
    this.poolAddress = poolAddress;
    this.startPrice = startPrice;
    this.endPrice = endPrice;
  }

  async quoteWindow({ windowStart, windowEnd, kind }) {
    if (!Number.isInteger(windowStart) || !Number.isInteger(windowEnd) || windowEnd <= windowStart) {
      throw new Error("Invalid price window");
    }
    const price = kind === "P0" ? this.startPrice : this.endPrice;
    return {
      source: "MOCK_ONLY",
      poolAddress: this.poolAddress,
      price,
      windowStart,
      windowEnd,
      sampleCount: 3,
      observedAt: windowEnd,
      reproducible: false,
    };
  }
}

export function assertObservation(observation, { expectedPool, minSamples, maxAgeSeconds, now }) {
  if (observation.poolAddress !== expectedPool) throw new Error("Unexpected pool");
  if (observation.sampleCount < minSamples) throw new Error("Insufficient observations");
  if (now - observation.observedAt > maxAgeSeconds) throw new Error("Stale observation");
  if (observation.price <= 0n) throw new Error("Non-positive price");
  return observation;
}
