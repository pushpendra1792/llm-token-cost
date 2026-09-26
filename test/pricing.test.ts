import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingFetchError } from '../src/errors';
import {
  DEFAULT_PRICING_TTL_MS,
  getBundledSnapshot,
  getPricing,
  LITELLM_PRICING_URL,
  resetPricingCache,
  setPricingFetch,
} from '../src/pricing/fetch';
import { findModelPricing } from '../src/pricing/lookup';
import { normalizeLiteLLMPricing, normalizeModelEntry } from '../src/pricing/normalize';
import { toPerToken } from '../src/pricing/units';
import type { PricingTable } from '../src/pricing/types';

const REMOTE_PAYLOAD = {
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
} as const;

const jsonResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  }) as unknown as Response;

const errorResponse = (status: number): Response =>
  ({
    ok: false,
    status,
    statusText: 'Not Found',
    json: async () => ({}),
  }) as unknown as Response;

beforeEach(() => {
  resetPricingCache();
  setPricingFetch(undefined);
});

afterEach(() => {
  resetPricingCache();
  setPricingFetch(undefined);
  vi.restoreAllMocks();
});

describe('toPerToken', () => {
  it('normalizes each supported unit to a per-token price', () => {
    expect(toPerToken(1, 'per_token')).toBe(1);
    expect(toPerToken(1_000, 'per_1k')).toBe(1);
    expect(toPerToken(1_000_000, 'per_1m')).toBe(1);
  });
});

describe('normalizeModelEntry', () => {
  it('reads per-token prices', () => {
    expect(normalizeModelEntry(REMOTE_PAYLOAD['gpt-4o'])).toEqual({
      input: 0.0000025,
      output: 0.00001,
      provider: 'openai',
    });
  });

  it('normalizes 1K and 1M denominators to per-token', () => {
    expect(normalizeModelEntry({ input_cost_per_1k_tokens: 3, output_cost_per_1k_tokens: 15 })).toEqual({
      input: 0.003,
      output: 0.015,
    });
    expect(normalizeModelEntry({ input_cost_per_1m_tokens: 3_000_000 })).toBeUndefined();
  });

  it('prefers the per-token field when several units are present', () => {
    expect(
      normalizeModelEntry({
        input_cost_per_token: 2,
        input_cost_per_1k_tokens: 9_000,
        output_cost_per_token: 4,
        output_cost_per_1k_tokens: 18_000,
      }),
    ).toEqual({ input: 2, output: 4 });
  });

  it('rejects entries missing either price rather than inventing one', () => {
    expect(normalizeModelEntry({ input_cost_per_token: 2 })).toBeUndefined();
    expect(normalizeModelEntry({ output_cost_per_token: 2 })).toBeUndefined();
    expect(normalizeModelEntry({})).toBeUndefined();
  });

  it('rejects malformed values', () => {
    expect(normalizeModelEntry(null)).toBeUndefined();
    expect(normalizeModelEntry('nope')).toBeUndefined();
    expect(normalizeModelEntry([])).toBeUndefined();
    expect(normalizeModelEntry({ input_cost_per_token: -1, output_cost_per_token: 1 })).toBeUndefined();
    expect(normalizeModelEntry({ input_cost_per_token: 'x', output_cost_per_token: 1 })).toBeUndefined();
  });

  it('omits provider when absent or not a string', () => {
    expect(normalizeModelEntry({ input_cost_per_token: 1, output_cost_per_token: 1 })).toEqual({
      input: 1,
      output: 1,
    });
    expect(
      normalizeModelEntry({ input_cost_per_token: 1, output_cost_per_token: 1, litellm_provider: 7 }),
    ).toEqual({ input: 1, output: 1 });
  });
});

describe('normalizeLiteLLMPricing', () => {
  it('normalizes a whole document', () => {
    const table = normalizeLiteLLMPricing(REMOTE_PAYLOAD);
    expect(table.schemaVersion).toBe(1);
    expect(Object.keys(table.models).sort()).toEqual(['claude-sonnet-4-5', 'gpt-4o']);
    expect(table.source).toBe(LITELLM_PRICING_URL);
  });

  it('skips reserved top-level keys', () => {
    const table = normalizeLiteLLMPricing({
      sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: 'a doc, not a provider' },
      version: '1.0.0',
      'gpt-4o': REMOTE_PAYLOAD['gpt-4o'],
    });

    expect(Object.keys(table.models)).toEqual(['gpt-4o']);
    expect(table.models['gpt-4o']?.provider).toBe('openai');
  });

  it('drops entries that cannot yield both prices', () => {
    const table = normalizeLiteLLMPricing({
      'gpt-4o': REMOTE_PAYLOAD['gpt-4o'],
      'embed-only': { input_cost_per_token: 0.0001 },
      broken: 'not an object',
    });

    expect(Object.keys(table.models)).toEqual(['gpt-4o']);
  });

  it('throws on a non-object payload so callers fall back', () => {
    expect(() => normalizeLiteLLMPricing(null)).toThrow(TypeError);
    expect(() => normalizeLiteLLMPricing('[]')).toThrow(TypeError);
    expect(() => normalizeLiteLLMPricing([REMOTE_PAYLOAD])).toThrow(TypeError);
  });
});

describe('getPricing', () => {
  it('fetches live pricing and reports it as exact', async () => {
    setPricingFetch(vi.fn(async () => jsonResponse(REMOTE_PAYLOAD)) as unknown as typeof fetch);

    const resolved = await getPricing();

    expect(resolved.source).toBe('remote');
    expect(resolved.estimated).toBe(false);
    expect(Object.keys(resolved.table.models)).toHaveLength(2);
  });

  it('requests the LiteLLM feed', async () => {
    const fetchMock = vi.fn(async (_url: string) => jsonResponse(REMOTE_PAYLOAD));
    setPricingFetch(fetchMock as unknown as typeof fetch);

    await getPricing();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(LITELLM_PRICING_URL);
  });

  it('serves a fresh cache without refetching', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REMOTE_PAYLOAD));
    setPricingFetch(fetchMock as unknown as typeof fetch);
    let clock = 1_000_000;
    const now = (): number => clock;

    await getPricing({ now });
    clock += DEFAULT_PRICING_TTL_MS - 1;
    const second = await getPricing({ now });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(second.source).toBe('cache');
    expect(second.estimated).toBe(false);
  });

  it('refetches once the TTL expires', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REMOTE_PAYLOAD));
    setPricingFetch(fetchMock as unknown as typeof fetch);
    let clock = 1_000_000;
    const now = (): number => clock;

    await getPricing({ now });
    clock += DEFAULT_PRICING_TTL_MS;
    const second = await getPricing({ now });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.source).toBe('remote');
  });

  it('honours a custom TTL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REMOTE_PAYLOAD));
    setPricingFetch(fetchMock as unknown as typeof fetch);
    let clock = 0;
    const now = (): number => clock;

    await getPricing({ ttlMs: 50, now });
    clock += 49;
    await getPricing({ ttlMs: 50, now });
    clock += 1;
    await getPricing({ ttlMs: 50, now });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forceRefresh bypasses a fresh cache', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REMOTE_PAYLOAD));
    setPricingFetch(fetchMock as unknown as typeof fetch);

    await getPricing();
    const second = await getPricing({ forceRefresh: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.source).toBe('remote');
  });

  it('falls back to the bundled snapshot when the fetch fails', async () => {
    setPricingFetch(vi.fn(async () => errorResponse(404)) as unknown as typeof fetch);

    const resolved = await getPricing();

    expect(resolved.source).toBe('snapshot');
    expect(resolved.estimated).toBe(true);
    expect(resolved.error).toBeInstanceOf(PricingFetchError);
    expect(Object.keys(resolved.table.models).length).toBeGreaterThan(1000);
  });

  it('falls back to the snapshot when fetch throws outright', async () => {
    setPricingFetch(
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
      }) as unknown as typeof fetch,
    );

    const resolved = await getPricing();

    expect(resolved.source).toBe('snapshot');
    expect(resolved.estimated).toBe(true);
    expect(resolved.error?.message).toContain('ENOTFOUND');
  });

  it('falls back to the snapshot on a malformed payload', async () => {
    setPricingFetch(vi.fn(async () => jsonResponse('not an object')) as unknown as typeof fetch);

    const resolved = await getPricing();

    expect(resolved.source).toBe('snapshot');
    expect(resolved.estimated).toBe(true);
  });

  it('prefers an expired cache over the snapshot, and marks it estimated', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(REMOTE_PAYLOAD));
    setPricingFetch(fetchMock as unknown as typeof fetch);
    let clock = 0;
    const now = (): number => clock;

    const fresh = await getPricing({ ttlMs: 10, now });
    expect(fresh.source).toBe('remote');

    fetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });
    clock += 11;
    const stale = await getPricing({ ttlMs: 10, now });

    expect(stale.source).toBe('stale-cache');
    expect(stale.estimated).toBe(true);
    expect(Object.keys(stale.table.models).sort()).toEqual(['claude-sonnet-4-5', 'gpt-4o']);
  });

  it('never rejects, even with no fetch implementation at all', async () => {
    setPricingFetch(undefined);
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as { fetch?: unknown }).fetch = undefined;
      const resolved = await getPricing();
      expect(resolved.source).toBe('snapshot');
    } finally {
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
    }
  });
});

describe('findModelPricing', () => {
  const table: PricingTable = normalizeLiteLLMPricing(REMOTE_PAYLOAD);

  it('finds an exact key', () => {
    expect(findModelPricing(table, 'gpt-4o')?.input).toBe(0.0000025);
  });

  it('matches case-insensitively', () => {
    expect(findModelPricing(table, 'GPT-4O')?.input).toBe(0.0000025);
  });

  it('strips provider prefixes', () => {
    expect(findModelPricing(table, 'azure/gpt-4o')?.input).toBe(0.0000025);
  });

  it('returns undefined for an unknown model', () => {
    expect(findModelPricing(table, 'nope-9000')).toBeUndefined();
    expect(findModelPricing(table, '')).toBeUndefined();
  });
});

describe('bundled snapshot', () => {
  const snapshot = getBundledSnapshot();

  it('has the expected schema version and provenance', () => {
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.source).toBe(LITELLM_PRICING_URL);
    expect(snapshot.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('contains thousands of models and excludes the LiteLLM template key', () => {
    expect(Object.keys(snapshot.models).length).toBeGreaterThan(1000);
    expect(snapshot.models['sample_spec']).toBeUndefined();
  });

  it('only contains well-formed per-token entries', () => {
    for (const [key, pricing] of Object.entries(snapshot.models)) {
      expect(Number.isFinite(pricing.input), key).toBe(true);
      expect(Number.isFinite(pricing.output), key).toBe(true);
      expect(pricing.input, key).toBeGreaterThanOrEqual(0);
      expect(pricing.output, key).toBeGreaterThanOrEqual(0);
      if (pricing.provider !== undefined) {
        expect(typeof pricing.provider, key).toBe('string');
      }
    }
  });

  it('has correct prices for well-known models', () => {
    expect(snapshot.models['gpt-4o']?.input).toBe(0.0000025);
    expect(snapshot.models['gpt-4o']?.output).toBe(0.00001);
    expect(snapshot.models['gpt-4o']?.provider).toBe('openai');
    expect(snapshot.models['claude-sonnet-4-5']?.provider).toBe('anthropic');
  });
});
