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

  // Cache pricing
  readonly cache_read_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost?: unknown;
  readonly cache_creation_input_token_cost_above_1hr?: unknown;

  // Service tier pricing
  readonly input_cost_per_token_batches?: unknown;
  readonly output_cost_per_token_batches?: unknown;
  readonly input_cost_per_token_flex?: unknown;
  readonly output_cost_per_token_flex?: unknown;
  readonly input_cost_per_token_priority?: unknown;
  readonly output_cost_per_token_priority?: unknown;

  // Reasoning pricing
  readonly output_cost_per_reasoning_token?: unknown;

  // Context limits
  readonly max_input_tokens?: unknown;
  readonly max_output_tokens?: unknown;
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
 * Reads a simple per-token price field (no unit variants) from the raw entry.
 * Returns undefined if the field is missing, not a number, or negative.
 */
const readSimplePrice = (entry: RawModelEntry, field: keyof RawModelEntry): number | undefined => {
  const value = entry[field];
  return asFiniteNumber(value);
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

  const entry = record as RawModelEntry;

  const input = readPrice(entry, 'input');
  const output = readPrice(entry, 'output');
  if (input === undefined || output === undefined) return undefined;

  const providerValue = record['litellm_provider'];
  const provider = typeof providerValue === 'string' ? providerValue : undefined;

  // Cache pricing
  const cacheReadInput = readSimplePrice(entry, 'cache_read_input_token_cost');
  const cacheCreationInput = readSimplePrice(entry, 'cache_creation_input_token_cost');
  const cacheCreationInputAbove1hr = readSimplePrice(entry, 'cache_creation_input_token_cost_above_1hr');

  // Service tier pricing
  const inputBatch = readSimplePrice(entry, 'input_cost_per_token_batches');
  const outputBatch = readSimplePrice(entry, 'output_cost_per_token_batches');
  const inputFlex = readSimplePrice(entry, 'input_cost_per_token_flex');
  const outputFlex = readSimplePrice(entry, 'output_cost_per_token_flex');
  const inputPriority = readSimplePrice(entry, 'input_cost_per_token_priority');
  const outputPriority = readSimplePrice(entry, 'output_cost_per_token_priority');

  // Reasoning pricing
  const outputReasoning = readSimplePrice(entry, 'output_cost_per_reasoning_token');

  // Context limits
  const maxInputTokens = asFiniteNumber(entry.max_input_tokens);
  const maxOutputTokens = asFiniteNumber(entry.max_output_tokens);

  const pricing: ModelPricing = {
    input,
    output,
    ...(provider !== undefined ? { provider } : {}),
    ...(cacheReadInput !== undefined ? { cacheReadInput } : {}),
    ...(cacheCreationInput !== undefined ? { cacheCreationInput } : {}),
    ...(cacheCreationInputAbove1hr !== undefined ? { cacheCreationInputAbove1hr } : {}),
    ...(inputBatch !== undefined ? { inputBatch } : {}),
    ...(outputBatch !== undefined ? { outputBatch } : {}),
    ...(inputFlex !== undefined ? { inputFlex } : {}),
    ...(outputFlex !== undefined ? { outputFlex } : {}),
    ...(inputPriority !== undefined ? { inputPriority } : {}),
    ...(outputPriority !== undefined ? { outputPriority } : {}),
    ...(outputReasoning !== undefined ? { outputReasoning } : {}),
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };

  return pricing;
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
