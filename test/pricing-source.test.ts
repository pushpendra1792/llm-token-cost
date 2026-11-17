import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateCost, estimateCostFromTokens } from '../src/estimate';
import { estimateCostFromUsage } from '../src/usage';
import {
  getBundledSnapshot,
  resetPricingCache,
  setPricingFetch,
} from '../src/pricing/fetch';
import { formatSnapshot, planSnapshotUpdate } from '../scripts/pricing-snapshot.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

const FIXTURE = {
  'gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    litellm_provider: 'openai',
  },
} as const;

const liveFetch = (): void => {
  setPricingFetch(
    vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => FIXTURE,
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

const snapshotGeneratedAt = (): string => {
  const generatedAt = getBundledSnapshot().generatedAt;
  expect(generatedAt).toBeDefined();
  if (generatedAt === undefined) throw new Error('snapshot has no generatedAt');
  return generatedAt;
};

describe('pricing source: bundled snapshot', () => {
  it('reports snapshot and the snapshot generatedAt', async () => {
    offlineFetch();
    const generatedAt = snapshotGeneratedAt();
    const now = Date.parse(generatedAt) + DAY_MS;

    const result = await estimateCostFromTokens(
      { model: 'gpt-4o', inputTokens: 1000 },
      { now: () => now },
    );

    expect(result.pricingSource).toBe('snapshot');
    expect(result.pricingUpdatedAt).toBe(generatedAt);
    expect(result.warnings).toBeUndefined();
  });

  it('warns when the snapshot is 91 days old', async () => {
    offlineFetch();
    const generatedAt = snapshotGeneratedAt();
    const now = Date.parse(generatedAt) + 91 * DAY_MS;

    const result = await estimateCostFromTokens(
      { model: 'gpt-4o', inputTokens: 1000 },
      { now: () => now },
    );

    expect(result.pricingSource).toBe('snapshot');
    expect(result.warnings).toEqual([
      `Bundled pricing is 91 days old (generated ${generatedAt}); updating the package or enabling live pricing may give newer prices.`,
    ]);
  });

  it('does not warn when the snapshot is 89 days old', async () => {
    offlineFetch();
    const generatedAt = snapshotGeneratedAt();
    const now = Date.parse(generatedAt) + 89 * DAY_MS;

    const result = await estimateCostFromTokens(
      { model: 'gpt-4o', inputTokens: 1000 },
      { now: new Date(now) },
    );

    expect(result.pricingSource).toBe('snapshot');
    expect(result.warnings).toBeUndefined();
  });

  it('honours staleAfterDays', async () => {
    offlineFetch();
    const generatedAt = snapshotGeneratedAt();
    const base = Date.parse(generatedAt);

    const at31 = await estimateCostFromTokens(
      { model: 'gpt-4o', inputTokens: 1000 },
      { now: () => base + 31 * DAY_MS, staleAfterDays: 30 },
    );
    expect(at31.warnings?.[0]).toContain('31 days old');

    const at29 = await estimateCostFromTokens(
      { model: 'gpt-4o', inputTokens: 1000 },
      { now: () => base + 29 * DAY_MS, staleAfterDays: 30 },
    );
    expect(at29.warnings).toBeUndefined();
  });

  it('adds the staleness warning to estimateCost results too', async () => {
    offlineFetch();
    const generatedAt = snapshotGeneratedAt();
    const now = Date.parse(generatedAt) + 91 * DAY_MS;

    const result = await estimateCost(
      { model: 'gpt-4o', inputText: 'hello' },
      { now: () => now },
    );

    expect(result.pricingSource).toBe('snapshot');
    expect(result.pricingUpdatedAt).toBe(generatedAt);
    expect(result.warnings?.[0]).toContain('Bundled pricing is 91 days old');
  });
});

describe('pricing source: live fetch and cache', () => {
  it('reports live with the fetch time as pricingUpdatedAt', async () => {
    liveFetch();
    const fetchedAt = Date.UTC(2026, 0, 2, 3, 4, 5);

    const result = await estimateCostFromTokens(
      { model: 'gpt-4o', inputTokens: 1000 },
      { now: () => fetchedAt },
    );

    expect(result.pricingSource).toBe('live');
    expect(result.pricingUpdatedAt).toBe(new Date(fetchedAt).toISOString());
    expect(result.warnings).toBeUndefined();
  });

  it('reports cache while preserving the original fetch time', async () => {
    liveFetch();
    const fetchedAt = Date.UTC(2026, 0, 2, 3, 4, 5);

    await estimateCostFromTokens(
      { model: 'gpt-4o', inputTokens: 1000 },
      { now: () => fetchedAt },
    );
    const cached = await estimateCostFromTokens(
      { model: 'gpt-4o', inputTokens: 1000 },
      { now: () => fetchedAt + 1000 },
    );

    expect(cached.pricingSource).toBe('cache');
    expect(cached.pricingUpdatedAt).toBe(new Date(fetchedAt).toISOString());
  });
});

describe('pricing source: estimateCostFromUsage forwarding', () => {
  it('forwards the snapshot metadata and staleness options', async () => {
    offlineFetch();
    const generatedAt = snapshotGeneratedAt();
    const now = Date.parse(generatedAt) + 91 * DAY_MS;
    const usage = { prompt_tokens: 1000, completion_tokens: 10 };

    const result = await estimateCostFromUsage({
      model: 'gpt-4o',
      usage,
      staleAfterDays: 100,
      now: () => now,
    });

    expect(result.usageFormat).toBe('openai-chat');
    expect(result.pricingSource).toBe('snapshot');
    expect(result.pricingUpdatedAt).toBe(generatedAt);
    expect(result.warnings).toBeUndefined();

    const stale = await estimateCostFromUsage({
      model: 'gpt-4o',
      usage,
      now: () => now,
    });
    expect(stale.warnings?.[0]).toContain('91 days old');
  });
});

describe('pricing snapshot refresh comparison', () => {
  const models = {
    'gpt-4o': { input: 0.0000025, output: 0.00001 },
    'gpt-4o-mini': { input: 1.5e-7, output: 6e-7 },
  };
  const updatedAt = '2026-11-17T07:24:17.194Z';
  const generatedAt = '2026-11-17';
  const previous = {
    text: formatSnapshot(models, updatedAt, generatedAt),
    updatedAt,
    generatedAt,
    models,
  };

  it('leaves the file byte-identical when only the run time changes', () => {
    const plan = planSnapshotUpdate({
      previous,
      models,
      now: new Date('2027-01-01T10:00:00.000Z'),
    });

    expect(plan.changed).toBe(false);
    expect(plan.modelsChanged).toBe(false);
    expect(plan.text).toBe(previous.text);
    expect(plan.updatedAt).toBe(updatedAt);
    expect(plan.generatedAt).toBe(generatedAt);
  });

  it('changes generatedAt only when model contents change', () => {
    const now = new Date('2027-01-01T10:00:00.000Z');
    const plan = planSnapshotUpdate({
      previous,
      models: {
        ...models,
        'gpt-4o': { input: 0.000003, output: 0.000012 },
      },
      now,
    });

    expect(plan.changed).toBe(true);
    expect(plan.modelsChanged).toBe(true);
    expect(plan.updatedAt).toBe(now.toISOString());
    expect(plan.generatedAt).toBe('2027-01-01');
    expect(plan.text).not.toBe(previous.text);
  });
});
