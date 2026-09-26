import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError, LlmTokenCostError, UnknownModelError } from '../src/errors';
import { estimateCost } from '../src/estimate';
import { resetPricingCache, setPricingFetch } from '../src/pricing/fetch';
import { PRICING_CURRENCY } from '../src/pricing/types';

const PROMPT = 'Estimate the cost of this prompt, please.';
const COMPLETION = 'It is approximately this much.';

const liveFetch = (): void => {
  setPricingFetch(
    vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          'gpt-4o': {
            input_cost_per_token: 0.0000025,
            output_cost_per_token: 0.00001,
            litellm_provider: 'openai',
          },
          'claude-sonnet-4-5': {
            input_cost_per_token: 0.000003,
            output_cost_per_token: 0.000015,
            litellm_provider: 'anthropic',
          },
        }),
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
});

describe('estimateCost', () => {
  it('prices an exact OpenAI model with live data and no approximation', async () => {
    liveFetch();

    const result = await estimateCost({
      model: 'gpt-4o',
      inputText: PROMPT,
      outputText: COMPLETION,
    });

    expect(result.inputTokens).toBe(9);
    expect(result.outputTokens).toBe(6);
    expect(result.currency).toBe(PRICING_CURRENCY);
    expect(result.estimated).toBe(false);
  });

  it('computes cost as input*inputPrice + output*outputPrice', async () => {
    liveFetch();

    const result = await estimateCost({
      model: 'gpt-4o',
      inputText: PROMPT,
      outputText: COMPLETION,
    });

    expect(result.cost).toBeCloseTo(9 * 0.0000025 + 6 * 0.00001, 12);
  });

  it('marks non-OpenAI models as estimated even with live pricing', async () => {
    liveFetch();

    const result = await estimateCost({
      model: 'claude-sonnet-4-5',
      inputText: PROMPT,
      outputText: COMPLETION,
    });

    expect(result.estimated).toBe(true);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.cost).toBeCloseTo(result.inputTokens * 0.000003 + result.outputTokens * 0.000015, 12);
  });

  it('marks the result estimated when pricing falls back to the snapshot', async () => {
    offlineFetch();

    const result = await estimateCost({ model: 'gpt-4o', inputText: PROMPT });

    expect(result.estimated).toBe(true);
    expect(result.cost).toBeGreaterThan(0);
  });

  it('treats omitted outputText as an empty completion', async () => {
    liveFetch();

    const result = await estimateCost({ model: 'gpt-4o', inputText: PROMPT });

    expect(result.outputTokens).toBe(0);
    expect(result.cost).toBeCloseTo(result.inputTokens * 0.0000025, 12);
  });

  it('treats explicit empty strings as zero tokens', async () => {
    liveFetch();

    const result = await estimateCost({ model: 'gpt-4o', inputText: '', outputText: '' });

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cost).toBe(0);
  });

  it('resolves provider-prefixed model ids', async () => {
    liveFetch();

    const plain = await estimateCost({ model: 'gpt-4o', inputText: PROMPT });
    const prefixed = await estimateCost({ model: 'azure/gpt-4o', inputText: PROMPT });

    expect(prefixed.cost).toBeCloseTo(plain.cost, 12);
    expect(prefixed.estimated).toBe(false);
  });

  it('prices a large input without overflowing', async () => {
    liveFetch();

    const result = await estimateCost({ model: 'gpt-4o', inputText: 'word '.repeat(200_000) });

    expect(result.inputTokens).toBeGreaterThan(100_000);
    expect(Number.isFinite(result.cost)).toBe(true);
  });
});

describe('estimateCost error handling', () => {
  it('throws a typed UnknownModelError for an unrecognized model', async () => {
    liveFetch();

    await expect(estimateCost({ model: 'not-a-real-model-xyz', inputText: PROMPT })).rejects.toThrow(
      UnknownModelError,
    );
  });

  it('carries a code, the offending model, and actionable guidance', async () => {
    liveFetch();

    const thrown: unknown = await estimateCost({
      model: 'not-a-real-model-xyz',
      inputText: PROMPT,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(thrown).toBeInstanceOf(UnknownModelError);
    if (!(thrown instanceof UnknownModelError)) throw new Error('expected UnknownModelError');

    expect(thrown).toBeInstanceOf(LlmTokenCostError);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.code).toBe('UNKNOWN_MODEL');
    expect(thrown.name).toBe('UnknownModelError');
    expect(thrown.model).toBe('not-a-real-model-xyz');
    expect(thrown.message).toContain('not-a-real-model-xyz');
    expect(thrown.message).toContain('gpt-4o');
  });

  it('still throws when pricing falls back to the snapshot', async () => {
    offlineFetch();

    await expect(estimateCost({ model: 'not-a-real-model-xyz', inputText: PROMPT })).rejects.toThrow(
      UnknownModelError,
    );
  });

  it('rejects a blank model', async () => {
    liveFetch();

    await expect(estimateCost({ model: '   ', inputText: PROMPT })).rejects.toThrow(InvalidInputError);
  });

  it('rejects a non-string input text', async () => {
    liveFetch();

    await expect(
      estimateCost({ model: 'gpt-4o', inputText: 42 as unknown as string }),
    ).rejects.toThrow(InvalidInputError);
  });
});
