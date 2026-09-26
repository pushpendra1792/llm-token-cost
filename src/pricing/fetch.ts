import { PricingFetchError } from '../errors';
import snapshotJson from './snapshot.json';
import { LITELLM_PRICING_URL, normalizeLiteLLMPricing } from './normalize';
import type { PricingTable, ResolvedPricing } from './types';

export const DEFAULT_PRICING_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_PRICING_TIMEOUT_MS = 10_000;

/**
 * Overrides the pricing feed URL. Useful behind a corporate proxy or against an
 * internal mirror of the LiteLLM data, and it is how the CLI integration tests
 * point at a local fixture instead of downloading the real 3 MB document.
 */
export const PRICING_URL_ENV = 'LLM_TOKEN_COST_PRICING_URL';

export { LITELLM_PRICING_URL };

const resolvePricingUrl = (override: string | undefined): string => {
  if (override !== undefined && override !== '') return override;
  const fromEnv = process.env[PRICING_URL_ENV];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : LITELLM_PRICING_URL;
};

/**
 * Offline fallback. Inlined at build time by tsup, so pricing works with no
 * network access at all. Regenerate with `npm run update:pricing`.
 */
const bundledSnapshot = snapshotJson as unknown as PricingTable;

interface CacheEntry {
  readonly table: PricingTable;
  readonly storedAt: number;
}

let cache: CacheEntry | undefined;
let fetchOverride: typeof fetch | undefined;

export const getBundledSnapshot = (): PricingTable => bundledSnapshot;

export const resetPricingCache = (): void => {
  cache = undefined;
};

/** Test seam for injecting a stub `fetch`. Pass `undefined` to restore. */
export const setPricingFetch = (impl: typeof fetch | undefined): void => {
  fetchOverride = impl;
};

export interface GetPricingOptions {
  /** How long a cached table stays fresh. Defaults to 6 hours. */
  readonly ttlMs?: number;
  /** Per-request timeout. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
  /** Clock injection point for tests. */
  readonly now?: () => number;
  /** Skip the cache freshness check and refetch. */
  readonly forceRefresh?: boolean;
  /** Pricing feed URL. Defaults to the `LLM_TOKEN_COST_PRICING_URL` env var, then LiteLLM. */
  readonly url?: string;
}

const fetchPricingTable = async (
  url: string,
  timeoutMs: number,
  now: () => number,
): Promise<PricingTable> => {
  const impl = fetchOverride ?? globalThis.fetch;
  if (typeof impl !== 'function') {
    throw new PricingFetchError('No fetch implementation available', url);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await impl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      throw new PricingFetchError(
        `Pricing fetch failed with HTTP ${response.status} ${response.statusText}`.trim(),
        url,
        response.status,
      );
    }

    return normalizeLiteLLMPricing(await response.json(), { updatedAt: new Date(now()).toISOString() });
  } catch (error) {
    if (error instanceof PricingFetchError) throw error;
    throw new PricingFetchError(
      `Pricing fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      url,
      undefined,
      error instanceof Error ? { cause: error } : undefined,
    );
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Resolves a pricing table, preferring live data.
 *
 * Order of preference:
 *   1. fresh in-memory cache  -> `cache`       (not estimated)
 *   2. live LiteLLM fetch     -> `remote`      (not estimated)
 *   3. expired cache entry    -> `stale-cache` (estimated)
 *   4. bundled snapshot       -> `snapshot`    (estimated)
 *
 * Steps 3 and 4 exist so a network failure degrades to an approximation rather
 * than throwing; `estimated` is true whenever the table is not live data.
 *
 * Never rejects: the snapshot is always present, so the worst case is stale
 * pricing rather than an exception.
 */
export const getPricing = async (options: GetPricingOptions = {}): Promise<ResolvedPricing> => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_PRICING_TTL_MS;

  if (options.forceRefresh !== true && cache !== undefined && now() - cache.storedAt < ttlMs) {
    return { table: cache.table, source: 'cache', estimated: false };
  }

  try {
    const table = await fetchPricingTable(
      resolvePricingUrl(options.url),
      options.timeoutMs ?? DEFAULT_PRICING_TIMEOUT_MS,
      now,
    );
    cache = { table, storedAt: now() };
    return { table, source: 'remote', estimated: false };
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));

    if (cache !== undefined) {
      return { table: cache.table, source: 'stale-cache', estimated: true, error: cause };
    }
    return { table: bundledSnapshot, source: 'snapshot', estimated: true, error: cause };
  }
};
