import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateCostFromTokens, type EstimateCostFromTokensResult } from '../src/estimate';
import { resetPricingCache, setPricingFetch } from '../src/pricing/fetch';

/**
 * Small hand-made fixtures, all in USD per token. Every expected number in this
 * file is computed by hand in the comment above the assertion.
 */
const FIXTURES = {
  // Base: input 1.25e-6, output 1e-5. One tier above 200k.
  'tiered-model': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    input_cost_per_token_above_200k_tokens: 2.5e-6,
    output_cost_per_token_above_200k_tokens: 1.5e-5,
  },
  // Same base, plus a tier-specific cache-read price.
  'tiered-cache-model': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
    input_cost_per_token_above_200k_tokens: 2.5e-6,
    output_cost_per_token_above_200k_tokens: 1.5e-5,
    cache_read_input_token_cost_above_200k_tokens: 2.5e-7,
  },
  // Tier has no cache-read price; the model has a base cache-read price.
  'tier-missing-cache-base': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 2e-7,
    input_cost_per_token_above_200k_tokens: 2.5e-6,
    output_cost_per_token_above_200k_tokens: 1.5e-5,
  },
  // Tier and model both have no cache-read price.
  'tier-missing-cache-all': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    input_cost_per_token_above_200k_tokens: 2.5e-6,
    output_cost_per_token_above_200k_tokens: 1.5e-5,
  },
  // Two thresholds; 500k must win when both match.
  'two-tier-model': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 1e-5,
    input_cost_per_token_above_200k_tokens: 2e-6,
    output_cost_per_token_above_200k_tokens: 1.2e-5,
    input_cost_per_token_above_500k_tokens: 3e-6,
    output_cost_per_token_above_500k_tokens: 2e-5,
  },
  // A tier plus batch prices: batch requests must ignore the long-context tier.
  'batch-tier-model': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    input_cost_per_token_batches: 6.25e-7,
    output_cost_per_token_batches: 5e-6,
    input_cost_per_token_above_200k_tokens: 2.5e-6,
    output_cost_per_token_above_200k_tokens: 1.5e-5,
  },
  // No tiers at all.
  'plain-model': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
  },
} as const;

const liveFetch = (): void => {
  setPricingFetch(
    vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => FIXTURES,
      } as unknown as Response;
    }) as unknown as typeof fetch,
  );
};

const offlineFetch = (): void => {
  setPricingFetch(
    vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch,
  );
};

beforeEach(() => {
  resetPricingCache();
  setPricingFetch(undefined);
});

afterEach(() => {
  resetPricingCache();
  setPricingFetch(undefined);
  vi.restoreAllMocks();
});

/** Every tiered estimate must satisfy cost === sum(breakdown). */
const expectBreakdownSumsToCost = (result: EstimateCostFromTokensResult): void => {
  const breakdown = result.breakdown;
  expect(breakdown).toBeDefined();
  if (breakdown === undefined) return;

  const sum =
    breakdown.input +
    breakdown.cacheRead +
    breakdown.cacheCreation +
    breakdown.output +
    breakdown.reasoning;
  expect(sum).toBeCloseTo(result.cost, 15);
};

describe('long-context tiers: threshold edge', () => {
  it('does not apply the tier at exactly the threshold, and applies it one token later', async () => {
    liveFetch();

    const atThreshold = await estimateCostFromTokens({
      model: 'tiered-model',
      inputTokens: 200000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
    });

    // Base: 200000 * 1.25e-6 = 0.25
    // Output: 1000 * 1e-5   = 0.01
    // Total: 0.26
    expect(atThreshold.cost).toBeCloseTo(0.26, 15);
    expect(atThreshold.pricingTier).toBeUndefined();
    expectBreakdownSumsToCost(atThreshold);

    const aboveThreshold = await estimateCostFromTokens({
      model: 'tiered-model',
      inputTokens: 200001,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
    });

    // Tier input: 200001 * 2.5e-6 = 0.5000025
    // Tier output: 1000 * 1.5e-5 = 0.015
    // Total: 0.5150025
    expect(aboveThreshold.cost).toBeCloseTo(0.5150025, 15);
    expect(aboveThreshold.pricingTier?.aboveInputTokens).toBe(200000);
    expectBreakdownSumsToCost(aboveThreshold);
  });

  it('prices 150k below the tier and 250k above it', async () => {
    liveFetch();

    const below = await estimateCostFromTokens({
      model: 'tiered-model',
      inputTokens: 150000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
    });

    // 150000 * 1.25e-6 = 0.1875
    // 1000 * 1e-5      = 0.01
    // Total: 0.1975
    expect(below.cost).toBeCloseTo(0.1975, 15);
    expect(below.pricingTier).toBeUndefined();
    expectBreakdownSumsToCost(below);

    const above = await estimateCostFromTokens({
      model: 'tiered-model',
      inputTokens: 250000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
    });

    // 250000 * 2.5e-6 = 0.625
    // 1000 * 1.5e-5   = 0.015
    // Total: 0.64
    expect(above.cost).toBeCloseTo(0.64, 15);
    expect(above.pricingTier?.aboveInputTokens).toBe(200000);
    expectBreakdownSumsToCost(above);
  });
});

describe('long-context tiers: cache reads', () => {
  it('uses the tier cache-read price when the tier provides one', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'tiered-cache-model',
      inputTokens: 250000,
      cacheReadInputTokens: 100000,
      outputTokens: 1000,
    });

    // Regular input: 150000 * 2.5e-6 = 0.375
    // Cache read:    100000 * 2.5e-7 = 0.025
    // Output:        1000 * 1.5e-5   = 0.015
    // Total: 0.415
    expect(result.cost).toBeCloseTo(0.415, 15);
    expect(result.breakdown?.cacheRead).toBeCloseTo(0.025, 15);
    expect(result.pricingTier?.aboveInputTokens).toBe(200000);
    expectBreakdownSumsToCost(result);
  });

  it("falls back to the model's base cache-read price and warns when the tier omits it", async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'tier-missing-cache-base',
      inputTokens: 250000,
      cacheReadInputTokens: 100000,
      outputTokens: 1000,
    });

    // Regular input: 150000 * 2.5e-6 = 0.375
    // Cache read:    100000 * 2e-7   = 0.02
    // Output:        1000 * 1.5e-5   = 0.015
    // Total: 0.41
    expect(result.cost).toBeCloseTo(0.41, 15);
    expect(result.breakdown?.cacheRead).toBeCloseTo(0.02, 15);
    expect(result.warnings).toContain(
      'No cache read price in the tier above 200000 tokens for tier-missing-cache-base; using the model\'s base cache read price.',
    );
    expectBreakdownSumsToCost(result);
  });

  it("falls back to the model's base input price when the tier and model both omit cache-read pricing", async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'tier-missing-cache-all',
      inputTokens: 250000,
      cacheReadInputTokens: 100000,
      outputTokens: 1000,
    });

    // Regular input: 150000 * 2.5e-6 = 0.375
    // Cache read:    100000 * 1.25e-6 = 0.125  (model base input)
    // Output:        1000 * 1.5e-5   = 0.015
    // Total: 0.515
    expect(result.cost).toBeCloseTo(0.515, 15);
    expect(result.breakdown?.cacheRead).toBeCloseTo(0.125, 15);
    expect(result.warnings).toContain(
      'No cache read price for tier-missing-cache-all; using the normal input price.',
    );
    expectBreakdownSumsToCost(result);
  });

  it('does not warn about the missing tier cache price when there are no cache-read tokens', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'tier-missing-cache-all',
      inputTokens: 250000,
      cacheReadInputTokens: 0,
      outputTokens: 1000,
    });

    // 250000 * 2.5e-6 = 0.625
    // 1000 * 1.5e-5   = 0.015
    // Total: 0.64
    expect(result.cost).toBeCloseTo(0.64, 15);
    expect(result.warnings).toBeUndefined();
    expectBreakdownSumsToCost(result);
  });
});

describe('long-context tiers: multiple thresholds', () => {
  it('picks the highest matching tier', async () => {
    liveFetch();

    const belowHighest = await estimateCostFromTokens({
      model: 'two-tier-model',
      inputTokens: 300000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
    });

    // 300000 * 2e-6 = 0.6
    // 1000 * 1.2e-5 = 0.012
    // Total: 0.612
    expect(belowHighest.cost).toBeCloseTo(0.612, 15);
    expect(belowHighest.pricingTier?.aboveInputTokens).toBe(200000);
    expectBreakdownSumsToCost(belowHighest);

    const aboveHighest = await estimateCostFromTokens({
      model: 'two-tier-model',
      inputTokens: 600000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
    });

    // 600000 * 3e-6 = 1.8
    // 1000 * 2e-5   = 0.02
    // Total: 1.82
    expect(aboveHighest.cost).toBeCloseTo(1.82, 15);
    expect(aboveHighest.pricingTier?.aboveInputTokens).toBe(500000);
    expectBreakdownSumsToCost(aboveHighest);
  });
});

describe('long-context tiers: service tiers', () => {
  it('does not apply a long-context tier to a batch request and warns', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'batch-tier-model',
      inputTokens: 250000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
      serviceTier: 'batch',
    });

    // Batch input: 250000 * 6.25e-7 = 0.15625
    // Batch output: 1000 * 5e-6    = 0.005
    // Total: 0.16125
    expect(result.cost).toBeCloseTo(0.16125, 15);
    expect(result.pricingTier).toBeUndefined();
    expect(result.warnings).toContain(
      'Long-context tier above 200000 tokens is not applied to the batch service tier for batch-tier-model.',
    );
    expectBreakdownSumsToCost(result);
  });
});

describe('long-context tiers: models without tiers', () => {
  it('leaves the result unchanged and omits pricingTier', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'plain-model',
      inputTokens: 250000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
    });

    // 250000 * 1e-6 = 0.25
    // 1000 * 2e-6   = 0.002
    // Total: 0.252
    expect(result.cost).toBeCloseTo(0.252, 15);
    expect(result).not.toHaveProperty('pricingTier');
    expect(result).not.toHaveProperty('warnings');
  });
});

describe('long-context tiers: real snapshot', () => {
  it('prices gemini-2.5-pro below and above its 200k tier', async () => {
    offlineFetch();

    const below = await estimateCostFromTokens({
      model: 'gemini-2.5-pro',
      inputTokens: 150000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
    });

    // Snapshot gemini-2.5-pro base: input 1.25e-6, output 1e-5.
    // 150000 * 1.25e-6 = 0.1875
    // 1000 * 1e-5      = 0.01
    // Total: 0.1975
    expect(below.cost).toBeCloseTo(0.1975, 6);
    expect(below.pricingTier).toBeUndefined();
    expectBreakdownSumsToCost(below);

    const above = await estimateCostFromTokens({
      model: 'gemini-2.5-pro',
      inputTokens: 250000,
      outputTokens: 1000,
      cacheReadInputTokens: 0,
    });

    // Snapshot tier above 200k: input 2.5e-6, output 1.5e-5.
    // 250000 * 2.5e-6 = 0.625
    // 1000 * 1.5e-5   = 0.015
    // Total: 0.64
    expect(above.cost).toBeCloseTo(0.64, 6);
    expect(above.pricingTier?.aboveInputTokens).toBe(200000);
    expectBreakdownSumsToCost(above);
  });
});
