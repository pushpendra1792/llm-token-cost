import { PRICING_CURRENCY, type ModelPricing, type PricingTable } from './types';
import { toPerToken, type PriceUnit } from './units';

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export const PRICING_SCHEMA_VERSION = 1;

/**
 * Raw LiteLLM entry. Every field is `unknown` because the upstream document is
 * community-maintained and mixes shapes freely (numbers, strings, nested
 * objects). Nothing is trusted until it has been validated.
 */
interface RawModelEntry {
  readonly input_cost_per_token?: unknown;
  readonly output_cost_per_token?: unknown;
  readonly input_cost_per_1k_tokens?: unknown;
  readonly output_cost_per_1k_tokens?: unknown;
  readonly input_cost_per_1m_tokens?: unknown;
  readonly output_cost_per_1m_tokens?: unknown;
  readonly litellm_provider?: unknown;
}

/** Non-model keys that LiveLLM's document carries at the top level. */
const RESERVED_KEYS = new Set(['sample_spec', 'keys', 'version']);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Reads a price from whichever unit the upstream field is expressed in,
 * returning a per-token price. Prefers the per-token field and only falls back
 * to the 1K/1M variants when it is missing.
 */
const readPrice = (entry: RawModelEntry, kind: 'input' | 'output'): number | undefined => {
  const candidates: ReadonlyArray<readonly [unknown, PriceUnit]> = [
    [entry[`${kind}_cost_per_token`], 'per_token'],
    [entry[`${kind}_cost_per_1k_tokens`], 'per_1k'],
    [entry[`${kind}_cost_per_1m_tokens`], 'per_1m'],
  ];

  for (const [value, unit] of candidates) {
    const numeric = asFiniteNumber(value);
    if (numeric !== undefined) return toPerToken(numeric, unit);
  }
  return undefined;
};

/**
 * Converts one raw entry, or returns `undefined` when it cannot yield both an
 * input and an output price.
 *
 * Both prices are required deliberately. Filling in a missing side (say,
 * defaulting output to input) would silently invent a number, and this library
 * exists to produce numbers people budget against.
 */
export const normalizeModelEntry = (raw: unknown): ModelPricing | undefined => {
  const record = asRecord(raw);
  if (record === undefined) return undefined;

  const input = readPrice(record as RawModelEntry, 'input');
  const output = readPrice(record as RawModelEntry, 'output');
  if (input === undefined || output === undefined) return undefined;

  const providerValue = record['litellm_provider'];
  const provider = typeof providerValue === 'string' ? providerValue : undefined;

  return provider === undefined ? { input, output } : { input, output, provider };
};

export interface NormalizeOptions {
  readonly source?: string;
  readonly updatedAt?: string;
}

/**
 * Normalizes a whole LiteLLM pricing document into the internal table shape.
 *
 * Malformed input throws: a partially-parsed price list is more dangerous than
 * no price list, because it looks authoritative. Callers treat the throw as a
 * fetch failure and fall back to the bundled snapshot.
 */
export const normalizeLiteLLMPricing = (
  raw: unknown,
  options: NormalizeOptions = {},
): PricingTable => {
  const record = asRecord(raw);
  if (record === undefined) {
    throw new TypeError('LiteLLM pricing payload is not a JSON object');
  }

  const models: Record<string, ModelPricing> = {};
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED_KEYS.has(key)) continue;
    const pricing = normalizeModelEntry(value);
    if (pricing !== undefined) models[key] = pricing;
  }

  return {
    schemaVersion: PRICING_SCHEMA_VERSION,
    models,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
    source: options.source ?? LITELLM_PRICING_URL,
  };
};

export { PRICING_CURRENCY };
