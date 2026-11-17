import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBudget } from '../src/budget/guardrails';
import { InvalidInputError } from '../src/errors';
import type { EstimateCostFromUsageResult } from '../src/usage';
import { estimateCostFromUsage } from '../src/usage';
import { resetPricingCache, setPricingFetch } from '../src/pricing/fetch';

/**
 * Small hand-made fixtures, all in USD per token. Every expected number in this
 * file is computed by hand in the comment above the assertion.
 */
const FIXTURES = {
  'openai-model': {
    input_cost_per_token: 2.5e-6,
    cache_read_input_token_cost: 1.25e-6,
    output_cost_per_token: 1e-5,
    output_cost_per_reasoning_token: 4e-5,
  },
  'anthropic-model': {
    input_cost_per_token: 3e-6,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
    output_cost_per_token: 1.5e-5,
  },
  'google-model': {
    input_cost_per_token: 1.25e-6,
    cache_read_input_token_cost: 3.125e-7,
    output_cost_per_token: 1e-5,
    output_cost_per_reasoning_token: 1e-5,
  },
  'service-tier-model': {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    input_cost_per_token_flex: 1e-6,
    output_cost_per_token_flex: 5e-6,
    input_cost_per_token_priority: 4e-6,
    output_cost_per_token_priority: 2e-5,
  },
  'tiered-usage-model': {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
    input_cost_per_token_above_200k_tokens: 2.5e-6,
    output_cost_per_token_above_200k_tokens: 1.5e-5,
    cache_read_input_token_cost_above_200k_tokens: 2.5e-7,
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

const expectBreakdownSumsToCost = (result: EstimateCostFromUsageResult): void => {
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

describe('estimateCostFromUsage: openai-chat', () => {
  it('prices prompt/completion tokens with cached and reasoning subsets', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'openai-model',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 400 },
        completion_tokens_details: { reasoning_tokens: 50 },
      },
    });

    // inputTokens  = prompt_tokens = 1000 (cached tokens are already included)
    // outputTokens = completion_tokens = 200 (reasoning tokens are included)
    // Regular input: 600 * 2.5e-6   = 0.0015
    // Cache read:    400 * 1.25e-6  = 0.0005
    // Regular output:150 * 1e-5     = 0.0015
    // Reasoning:      50 * 4e-5     = 0.002
    // Total: 0.0055
    expect(result.usageFormat).toBe('openai-chat');
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(200);
    expect(result.cost).toBeCloseTo(0.0055, 15);
    expect(result.breakdown?.cacheRead).toBeCloseTo(0.0005, 15);
    expect(result.breakdown?.reasoning).toBeCloseTo(0.002, 15);
    expectBreakdownSumsToCost(result);
  });

  it('accepts a whole response with a .usage property', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'openai-model',
      usage: {
        id: 'chatcmpl_123',
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 400 },
          completion_tokens_details: { reasoning_tokens: 50 },
        },
      },
    });

    expect(result.usageFormat).toBe('openai-chat');
    expect(result.cost).toBeCloseTo(0.0055, 15);
  });
});

describe('estimateCostFromUsage: openai-responses', () => {
  it('prices the equivalent Responses field names to the same cost', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'openai-model',
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        input_tokens_details: { cached_tokens: 400 },
        output_tokens_details: { reasoning_tokens: 50 },
      },
    });

    // Same counts as the chat case: 1000 total input, 400 cached,
    // 200 total output, 50 reasoning. Total: 0.0055.
    expect(result.usageFormat).toBe('openai-responses');
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(200);
    expect(result.cost).toBeCloseTo(0.0055, 15);
    expectBreakdownSumsToCost(result);
  });
});

describe('estimateCostFromUsage: anthropic', () => {
  it('adds cache tokens to the input total', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'anthropic-model',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 500,
        output_tokens: 200,
      },
    });

    // inputTokens = 100 + 400 + 500 = 1000
    // Regular input: 100 * 3e-6      = 0.0003
    // Cache read:    400 * 3e-7      = 0.00012
    // Cache write:   500 * 3.75e-6   = 0.001875
    // Output:        200 * 1.5e-5    = 0.003
    // Total: 0.005295
    expect(result.usageFormat).toBe('anthropic');
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(200);
    expect(result.cost).toBeCloseTo(0.005295, 15);
    expectBreakdownSumsToCost(result);
  });

  it('splits mixed 5-minute and 1-hour cache writes', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'anthropic-model',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 400,
        cache_creation_input_tokens: 500,
        cache_creation: {
          ephemeral_5m_input_tokens: 300,
          ephemeral_1h_input_tokens: 200,
        },
        output_tokens: 200,
      },
    });

    // Cache write: 300 * 3.75e-6 = 0.001125
    //              200 * 6e-6    = 0.0012
    //              total         = 0.002325
    // Regular input: 100 * 3e-6    = 0.0003
    // Cache read:    400 * 3e-7    = 0.00012
    // Output:        200 * 1.5e-5  = 0.003
    // Total: 0.005745
    expect(result.usageFormat).toBe('anthropic');
    expect(result.breakdown?.cacheCreation).toBeCloseTo(0.002325, 15);
    expect(result.cost).toBeCloseTo(0.005745, 15);
    expect(result.warnings).toBeUndefined();
    expectBreakdownSumsToCost(result);
  });

  it('uses the 1-hour price for every write token when all writes are 1h', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'anthropic-model',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 500,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 500,
        },
        output_tokens: 200,
      },
    });

    // Cache write: 500 * 6e-6 = 0.003
    // Regular input: 100 * 3e-6 = 0.0003
    // Output: 200 * 1.5e-5 = 0.003
    // Total: 0.0063
    expect(result.cost).toBeCloseTo(0.0063, 15);
    expect(result.breakdown?.cacheCreation).toBeCloseTo(0.003, 15);
    expectBreakdownSumsToCost(result);
  });
});

describe('estimateCostFromUsage: google', () => {
  it('prices usageMetadata with cached content and thinking tokens', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'google-model',
      usage: {
        promptTokenCount: 1000,
        cachedContentTokenCount: 400,
        candidatesTokenCount: 150,
        thoughtsTokenCount: 50,
      },
    });

    // inputTokens = promptTokenCount = 1000 (cached content is included)
    // outputTokens = 150 candidates + 50 thoughts = 200
    // Regular input: 600 * 1.25e-6  = 0.00075
    // Cache read:    400 * 3.125e-7 = 0.000125
    // Regular output:150 * 1e-5     = 0.0015
    // Reasoning:      50 * 1e-5     = 0.0005
    // Total: 0.002875
    expect(result.usageFormat).toBe('google');
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(200);
    expect(result.cost).toBeCloseTo(0.002875, 15);
    expect(result.breakdown?.reasoning).toBeCloseTo(0.0005, 15);
    expectBreakdownSumsToCost(result);
  });

  it('accepts a full response object and the thoughtTokenCount alias', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'google-model',
      usage: {
        candidates: [{ content: { parts: [] } }],
        usageMetadata: {
          promptTokenCount: 1000,
          cachedContentTokenCount: 400,
          candidatesTokenCount: 150,
          thoughtTokenCount: 50,
        },
      },
    });

    // Same counts as above: input 1000, output 150 + 50 = 200, total 0.002875.
    expect(result.usageFormat).toBe('google');
    expect(result.outputTokens).toBe(200);
    expect(result.cost).toBeCloseTo(0.002875, 15);
    expectBreakdownSumsToCost(result);
  });
});

describe('estimateCostFromUsage: generic shapes', () => {
  it('prices camelCase inputTokens/outputTokens', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'openai-model',
      usage: { inputTokens: 1000, outputTokens: 200 },
    });

    // 1000 * 2.5e-6 = 0.0025
    // 200 * 1e-5    = 0.002
    // Total: 0.0045
    expect(result.usageFormat).toBe('generic');
    expect(result.cost).toBeCloseTo(0.0045, 15);
  });

  it('prices Vercel AI SDK promptTokens/completionTokens', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'openai-model',
      usage: { promptTokens: 1000, completionTokens: 200 },
    });

    // Same counts as the camelCase case: total 0.0045.
    expect(result.usageFormat).toBe('generic');
    expect(result.cost).toBeCloseTo(0.0045, 15);
  });

  it('prices bare snake_case input_tokens/output_tokens without cache fields', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'openai-model',
      usage: { input_tokens: 1000, output_tokens: 200 },
    });

    // No cache fields, so this is generic: total 0.0045.
    expect(result.usageFormat).toBe('generic');
    expect(result.cost).toBeCloseTo(0.0045, 15);
  });
});

describe('estimateCostFromUsage: detection and validation', () => {
  it('lets the provider option override detection', async () => {
    liveFetch();

    const anthropicLike = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 400,
    };

    const detected = await estimateCostFromUsage({
      model: 'anthropic-model',
      usage: anthropicLike,
    });

    // Anthropic: inputTokens = 1000 + 400 = 1400
    // Regular input: 1000 * 3e-6 = 0.003
    // Cache read:     400 * 3e-7 = 0.00012
    // Output:         200 * 1.5e-5 = 0.003
    // Total: 0.00612
    expect(detected.usageFormat).toBe('anthropic');
    expect(detected.cost).toBeCloseTo(0.00612, 15);

    const forced = await estimateCostFromUsage({
      model: 'anthropic-model',
      usage: anthropicLike,
      provider: 'generic',
    });

    // Generic ignores the cache field: 1000 * 3e-6 + 200 * 1.5e-5 = 0.006
    expect(forced.usageFormat).toBe('generic');
    expect(forced.inputTokens).toBe(1000);
    expect(forced.cost).toBeCloseTo(0.006, 15);
  });

  it('throws InvalidInputError for an unrecognized usage shape', async () => {
    liveFetch();

    await expect(
      estimateCostFromUsage({ model: 'openai-model', usage: { foo: 'bar' } }),
    ).rejects.toThrow(InvalidInputError);
    await expect(
      estimateCostFromUsage({ model: 'openai-model', usage: { foo: 'bar' } }),
    ).rejects.toThrow(/Unrecognized usage object/);
  });

  it('throws InvalidInputError for a negative or non-numeric token count', async () => {
    liveFetch();

    await expect(
      estimateCostFromUsage({
        model: 'openai-model',
        usage: { prompt_tokens: -1, completion_tokens: 10 },
      }),
    ).rejects.toThrow(InvalidInputError);

    await expect(
      estimateCostFromUsage({
        model: 'openai-model',
        usage: { prompt_tokens: '1000' as unknown as number, completion_tokens: 10 },
      }),
    ).rejects.toThrow(InvalidInputError);
  });
});

describe('estimateCostFromUsage: service tiers', () => {
  it('maps usage.service_tier and lets the explicit option win', async () => {
    liveFetch();

    const flex = await estimateCostFromUsage({
      model: 'service-tier-model',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        service_tier: 'flex',
      },
    });

    // Flex: 1000 * 1e-6 + 200 * 5e-6 = 0.001 + 0.001 = 0.002
    expect(flex.cost).toBeCloseTo(0.002, 15);

    const priority = await estimateCostFromUsage({
      model: 'service-tier-model',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        service_tier: 'flex',
      },
      serviceTier: 'priority',
    });

    // Explicit priority: 1000 * 4e-6 + 200 * 2e-5 = 0.004 + 0.004 = 0.008
    expect(priority.cost).toBeCloseTo(0.008, 15);
  });
});

describe('estimateCostFromUsage: long-context tiers', () => {
  it('applies the tier using the total input including cache tokens', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'tiered-usage-model',
      usage: {
        prompt_tokens: 250000,
        completion_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 100000 },
      },
    });

    // inputTokens = 250000, which is above the 200k threshold.
    // Regular input: 150000 * 2.5e-6 = 0.375
    // Cache read:    100000 * 2.5e-7 = 0.025
    // Output:          1000 * 1.5e-5 = 0.015
    // Total: 0.415
    expect(result.inputTokens).toBe(250000);
    expect(result.pricingTier?.aboveInputTokens).toBe(200000);
    expect(result.cost).toBeCloseTo(0.415, 15);
    expectBreakdownSumsToCost(result);
  });
});

describe('estimateCostFromUsage: real snapshot', () => {
  it('prices gpt-4o chat usage from the bundled snapshot', async () => {
    offlineFetch();

    const result = await estimateCostFromUsage({
      model: 'gpt-4o',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 400 },
      },
    });

    // Snapshot gpt-4o: input 2.5e-6, cache read 1.25e-6, output 1e-5.
    // 600 * 2.5e-6 + 400 * 1.25e-6 + 200 * 1e-5 = 0.004
    expect(result.usageFormat).toBe('openai-chat');
    expect(Number.isFinite(result.cost)).toBe(true);
    expect(result.cost).toBeGreaterThan(0);
    expect(result.cost).toBeCloseTo(0.004, 10);
    expectBreakdownSumsToCost(result);
  });
});

describe('estimateCostFromUsage: budget integration', () => {
  it('can be charged straight to a budget without repacking', async () => {
    liveFetch();

    const result = await estimateCostFromUsage({
      model: 'openai-model',
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    });
    const budget = createBudget({ limit: 1 });

    // 1000 * 2.5e-6 + 200 * 1e-5 = 0.0045
    budget.track(result);

    expect(budget.getTotal()).toBeCloseTo(0.0045, 15);
    expect(budget.isExceeded()).toBe(false);
  });
});
