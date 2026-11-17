import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../src/errors';
import { estimateCostFromTokens } from '../src/estimate';
import { resetPricingCache, setPricingFetch } from '../src/pricing/fetch';
import { PRICING_CURRENCY } from '../src/pricing/types';

/**
 * Small fixtures with round per-token prices so every expected value below can
 * be checked by hand. All prices are USD per single token.
 */
const FIXTURES = {
  // input 1e-6, output 2e-6, plus every optional price we support.
  'priced-model': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
    cache_creation_input_token_cost_above_1hr: 2e-6,
    output_cost_per_reasoning_token: 4e-6,
    input_cost_per_token_batches: 5e-7,
    output_cost_per_token_batches: 1e-6,
    litellm_provider: 'test',
  },
  // Same base prices, a 5-minute cache-write price, but no 1-hour price.
  'five-minute-only-model': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    cache_creation_input_token_cost: 1.25e-6,
    litellm_provider: 'test',
  },
  // Base prices only: every optional price is missing.
  'no-extras-model': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
    litellm_provider: 'test',
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

describe('estimateCostFromTokens plain call', () => {
  it('is unchanged when no breakdown inputs are supplied', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'no-extras-model',
      inputTokens: 1000,
      outputTokens: 500,
    });

    // 1000 * 1e-6 + 500 * 2e-6 = 0.001 + 0.001 = 0.002
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(result.cost).toBeCloseTo(0.002, 15);
    expect(result.currency).toBe(PRICING_CURRENCY);
    expect(result.estimated).toBe(false);
    expect(result).not.toHaveProperty('breakdown');
    expect(result).not.toHaveProperty('warnings');
  });
});

describe('cache read pricing', () => {
  it('bills cache reads at the cache-read rate and the rest at input', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'priced-model',
      inputTokens: 1000,
      cacheReadInputTokens: 400,
    });

    // regular input: (1000 - 400) * 1e-6 = 0.0006
    // cache read:    400 * 1e-7            = 0.00004
    // total:         0.00064
    expect(result.breakdown).toEqual({
      input: 600 * 1e-6,
      cacheRead: 400 * 1e-7,
      cacheCreation: 0,
      output: 0,
      reasoning: 0,
    });
    expect(result.cost).toBeCloseTo(600 * 1e-6 + 400 * 1e-7, 15);
    expect(result).not.toHaveProperty('warnings');
  });

  it('falls back to the normal input price and warns when cache read is missing', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'no-extras-model',
      inputTokens: 1000,
      cacheReadInputTokens: 400,
    });

    // (1000 - 400) * 1e-6 + 400 * 1e-6 = 0.0006 + 0.0004 = 0.001
    expect(result.cost).toBeCloseTo(600 * 1e-6 + 400 * 1e-6, 15);
    expect(result.warnings).toContain('No cache read price for no-extras-model; using the normal input price.');
  });
});

describe('cache creation pricing', () => {
  it('bills cache writes at the 5-minute rate by default', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'priced-model',
      inputTokens: 1000,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 200,
    });

    // regular input: (1000 - 300 - 200) * 1e-6 = 500 * 1e-6 = 0.0005
    // cache read:    300 * 1e-7                = 0.00003
    // cache write:   200 * 1.25e-6             = 0.00025
    // total:         0.00078
    expect(result.breakdown).toEqual({
      input: 500 * 1e-6,
      cacheRead: 300 * 1e-7,
      cacheCreation: 200 * 1.25e-6,
      output: 0,
      reasoning: 0,
    });
    expect(result.cost).toBeCloseTo(500 * 1e-6 + 300 * 1e-7 + 200 * 1.25e-6, 15);
  });

  it('bills cache writes at the 1-hour rate when requested', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'priced-model',
      inputTokens: 1000,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 200,
      cacheTtl: '1h',
    });

    // regular input: (1000 - 300 - 200) * 1e-6 = 0.0005
    // cache read:    300 * 1e-7                = 0.00003
    // cache write:   200 * 2e-6                = 0.0004
    // total:         0.00093
    expect(result.breakdown).toEqual({
      input: 500 * 1e-6,
      cacheRead: 300 * 1e-7,
      cacheCreation: 200 * 2e-6,
      output: 0,
      reasoning: 0,
    });
    expect(result.cost).toBeCloseTo(500 * 1e-6 + 300 * 1e-7 + 200 * 2e-6, 15);
  });

  it('falls back to the 5-minute write price and warns when 1h is missing', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'five-minute-only-model',
      inputTokens: 1000,
      cacheCreationInputTokens: 200,
      cacheTtl: '1h',
    });

    // regular input: (1000 - 200) * 1e-6 = 0.0008
    // cache write:   200 * 1.25e-6       = 0.00025
    // total:         0.00105
    expect(result.cost).toBeCloseTo(800 * 1e-6 + 200 * 1.25e-6, 15);
    expect(result.warnings).toContain(
      'No 1-hour cache creation price for five-minute-only-model; using the 5-minute cache write price.',
    );
  });

  it('falls back to the normal input price when no cache write price exists', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'no-extras-model',
      inputTokens: 1000,
      cacheCreationInputTokens: 200,
    });

    // (1000 - 200) * 1e-6 + 200 * 1e-6 = 0.0008 + 0.0002 = 0.001
    expect(result.cost).toBeCloseTo(800 * 1e-6 + 200 * 1e-6, 15);
    expect(result.warnings).toContain(
      'No cache creation price for no-extras-model; using the normal input price.',
    );
  });
});

describe('reasoning token pricing', () => {
  it('bills reasoning at its own rate and the remaining output at output rate', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'priced-model',
      inputTokens: 100,
      outputTokens: 100,
      reasoningOutputTokens: 40,
    });

    // input:     100 * 1e-6       = 0.0001
    // output:    (100 - 40) * 2e-6 = 0.00012
    // reasoning: 40 * 4e-6         = 0.00016
    // total:     0.00038
    expect(result.breakdown).toEqual({
      input: 100 * 1e-6,
      cacheRead: 0,
      cacheCreation: 0,
      output: 60 * 2e-6,
      reasoning: 40 * 4e-6,
    });
    expect(result.cost).toBeCloseTo(100 * 1e-6 + 60 * 2e-6 + 40 * 4e-6, 15);
  });

  it('falls back to the normal output price and warns when reasoning price is missing', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'no-extras-model',
      inputTokens: 100,
      outputTokens: 100,
      reasoningOutputTokens: 40,
    });

    // input:     100 * 1e-6        = 0.0001
    // output:    (100 - 40) * 2e-6 = 0.00012
    // reasoning: 40 * 2e-6         = 0.00008
    // total:     0.0003
    expect(result.cost).toBeCloseTo(100 * 1e-6 + 60 * 2e-6 + 40 * 2e-6, 15);
    expect(result.warnings).toContain(
      'No reasoning price for no-extras-model; using the normal output price.',
    );
  });

  it('does not warn about reasoning when the reasoning count is zero', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'no-extras-model',
      inputTokens: 100,
      outputTokens: 100,
      reasoningOutputTokens: 0,
    });

    expect(result).not.toHaveProperty('warnings');
    // breakdown is still present because a breakdown input was supplied.
    expect(result.breakdown).toEqual({
      input: 100 * 1e-6,
      cacheRead: 0,
      cacheCreation: 0,
      output: 100 * 2e-6,
      reasoning: 0,
    });
  });
});

describe('service tiers', () => {
  it('prices the whole request at batch rates when available', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'priced-model',
      inputTokens: 1000,
      outputTokens: 500,
      serviceTier: 'batch',
    });

    // 1000 * 5e-7 + 500 * 1e-6 = 0.0005 + 0.0005 = 0.001
    expect(result.cost).toBeCloseTo(1000 * 5e-7 + 500 * 1e-6, 15);
    expect(result).not.toHaveProperty('warnings');
    // No breakdown input was supplied, so no breakdown is returned.
    expect(result).not.toHaveProperty('breakdown');
  });

  it('falls back to standard rates per side and warns when tier prices are missing', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'no-extras-model',
      inputTokens: 1000,
      outputTokens: 500,
      serviceTier: 'batch',
    });

    // Standard: 1000 * 1e-6 + 500 * 2e-6 = 0.001 + 0.001 = 0.002
    expect(result.cost).toBeCloseTo(1000 * 1e-6 + 500 * 2e-6, 15);
    expect(result.warnings).toContain(
      'No batch input price for no-extras-model; using the standard input price.',
    );
    expect(result.warnings).toContain(
      'No batch output price for no-extras-model; using the standard output price.',
    );
  });

  it('keeps cache rates independent of the service tier', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'priced-model',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 400,
      serviceTier: 'batch',
    });

    // batch input: (1000 - 400) * 5e-7 = 0.0003
    // cache read:  400 * 1e-7          = 0.00004
    // batch output: 500 * 1e-6         = 0.0005
    // total:       0.00084
    expect(result.cost).toBeCloseTo(600 * 5e-7 + 400 * 1e-7 + 500 * 1e-6, 15);
    expect(result.breakdown).toEqual({
      input: 600 * 5e-7,
      cacheRead: 400 * 1e-7,
      cacheCreation: 0,
      output: 500 * 1e-6,
      reasoning: 0,
    });
  });
});

describe('validation', () => {
  it('rejects cache tokens that exceed the input total, before fetching', async () => {
    const fetchSpy = vi.fn();
    setPricingFetch(fetchSpy as unknown as typeof fetch);

    await expect(
      estimateCostFromTokens({
        model: 'priced-model',
        inputTokens: 100,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 30,
      }),
    ).rejects.toThrow(InvalidInputError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects reasoning tokens that exceed the output total', async () => {
    liveFetch();

    await expect(
      estimateCostFromTokens({
        model: 'priced-model',
        inputTokens: 100,
        outputTokens: 10,
        reasoningOutputTokens: 11,
      }),
    ).rejects.toThrow(InvalidInputError);
  });

  it('rejects negative and fractional breakdown counts', async () => {
    liveFetch();

    await expect(
      estimateCostFromTokens({
        model: 'priced-model',
        inputTokens: 100,
        cacheReadInputTokens: -1,
      }),
    ).rejects.toThrow(InvalidInputError);

    await expect(
      estimateCostFromTokens({
        model: 'priced-model',
        inputTokens: 100,
        cacheCreationInputTokens: 1.5,
      }),
    ).rejects.toThrow(InvalidInputError);

    await expect(
      estimateCostFromTokens({
        model: 'priced-model',
        inputTokens: 100,
        outputTokens: 100,
        reasoningOutputTokens: Number.NaN,
      }),
    ).rejects.toThrow(InvalidInputError);
  });

  it('rejects an unknown service tier', async () => {
    liveFetch();

    await expect(
      estimateCostFromTokens({
        model: 'priced-model',
        inputTokens: 100,
        serviceTier: 'turbo' as unknown as 'batch',
      }),
    ).rejects.toThrow(InvalidInputError);
  });

  it('rejects an unknown cache TTL', async () => {
    liveFetch();

    await expect(
      estimateCostFromTokens({
        model: 'priced-model',
        inputTokens: 100,
        cacheTtl: '24h' as unknown as '1h',
      }),
    ).rejects.toThrow(InvalidInputError);
  });
});

describe('real snapshot entries', () => {
  it('prices gpt-4o cache reads from the bundled snapshot', async () => {
    offlineFetch();

    const result = await estimateCostFromTokens({
      model: 'gpt-4o',
      inputTokens: 1000,
      cacheReadInputTokens: 400,
    });

    // Snapshot gpt-4o: input 2.5e-6, cacheReadInput 1.25e-6.
    // regular input: (1000 - 400) * 2.5e-6 = 0.0015
    // cache read:    400 * 1.25e-6         = 0.0005
    // total:         0.002
    expect(result.cost).toBeCloseTo(600 * 2.5e-6 + 400 * 1.25e-6, 15);
    expect(result.breakdown).toEqual({
      input: 600 * 2.5e-6,
      cacheRead: 400 * 1.25e-6,
      cacheCreation: 0,
      output: 0,
      reasoning: 0,
    });
    expect(result).not.toHaveProperty('warnings');
    expect(result.estimated).toBe(true);
  });

  it('prices claude-sonnet-4-5 1-hour cache writes from the bundled snapshot', async () => {
    offlineFetch();

    const result = await estimateCostFromTokens({
      model: 'claude-sonnet-4-5',
      inputTokens: 1000,
      cacheCreationInputTokens: 200,
      cacheTtl: '1h',
    });

    // Snapshot claude-sonnet-4-5: input 3e-6, cacheCreationInputAbove1hr 6e-6.
    // regular input: (1000 - 200) * 3e-6 = 0.0024
    // cache write:   200 * 6e-6         = 0.0012
    // total:         0.0036
    expect(result.cost).toBeCloseTo(800 * 3e-6 + 200 * 6e-6, 15);
    expect(result).not.toHaveProperty('warnings');
  });
});

describe('cost equals the sum of the breakdown', () => {
  it('holds for a request using every category at once', async () => {
    liveFetch();

    const result = await estimateCostFromTokens({
      model: 'priced-model',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      reasoningOutputTokens: 50,
      serviceTier: 'batch',
    });

    const breakdown = result.breakdown;
    expect(breakdown).toBeDefined();
    if (breakdown === undefined) throw new Error('expected breakdown');

    // input:       (1000 - 200 - 100) * 5e-7 = 700 * 5e-7 = 0.00035
    // cache read:  200 * 1e-7                 = 0.00002
    // cache write: 100 * 1.25e-6              = 0.000125
    // output:      (500 - 50) * 1e-6          = 450 * 1e-6 = 0.00045
    // reasoning:   50 * 4e-6                  = 0.0002
    // total:       0.001145
    expect(breakdown.input).toBeCloseTo(700 * 5e-7, 15);
    expect(breakdown.cacheRead).toBeCloseTo(200 * 1e-7, 15);
    expect(breakdown.cacheCreation).toBeCloseTo(100 * 1.25e-6, 15);
    expect(breakdown.output).toBeCloseTo(450 * 1e-6, 15);
    expect(breakdown.reasoning).toBeCloseTo(50 * 4e-6, 15);

    const sum =
      breakdown.input +
      breakdown.cacheRead +
      breakdown.cacheCreation +
      breakdown.output +
      breakdown.reasoning;
    expect(result.cost).toBeCloseTo(sum, 15);
  });
});
