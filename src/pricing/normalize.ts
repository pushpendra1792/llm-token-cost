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

  // Long-context tiered pricing (from LiteLLM tiered_pricing arrays)
  readonly tiered_pricing?: unknown[];
}

/** Non-model keys that LiveLLM's document carries at the top level. */
const RESERVED_KEYS = new Set(['sample_spec', 'keys', 'version']);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Receives non-fatal normalization notes. Defaults to silence at call sites. */
type Warn = (message: string) => void;

/**
 * Parses LiteLLM's tiered_pricing array into the internal tiers format.
 *
 * LiteLLM's tiered_pricing contains entries like:
 *   { input_cost_per_token: 5e-8, output_cost_per_token: 4e-7, range: [0, 256000] }
 * Each entry defines a tier that applies when inputTokens > range[0].
 * Entries are sorted ascending by range[0] in the source; we keep that order.
 * - If range[0] === 0, the tier applies when inputTokens > 0 (i.e. always, after any
 *   lower-threshold tier). This is the "default" tier for the long-context surcharge.
 * - If range[0] > 0, the tier applies when inputTokens > range[0].
 * - Entries with range[0] < 0 or non-numeric are ignored.
 * - Duplicate thresholds are collapsed: only the last entry with a given threshold is kept.
 * - Missing price fields inside a tier fall back to the model's base price;
 *   this is handled by the caller (estimateCostFromTokens) and a note is sent to
 *   `onWarn` only when the relevant token count is > 0.
 */
function parseTieredPricing(
  raw: unknown,
  baseInput: number,
  baseOutput: number,
  onWarn: Warn,
): ModelPricing['tiers'] {
  if (!Array.isArray(raw)) return undefined;

  const entries = raw.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );

  // Build a map from threshold -> tier pricing, last-wins for duplicates
  const thresholdMap = new Map<number, {
    input: number | undefined;
    output: number | undefined;
    cacheReadInput: number | undefined;
    cacheCreationInput: number | undefined;
    cacheCreationInputAbove1hr: number | undefined;
    outputReasoning: number | undefined;
  }>();

  for (const entry of entries) {
    const range = entry['range'];
    if (!Array.isArray(range) || range.length < 2) continue;
    const above = asFiniteNumber(range[0]);
    if (above === undefined || above < 0) continue; // only non-negative thresholds

    // Extract prices (per-token, no unit conversion needed here – already normalized
    // by the per-token readers above, but we re-read simple prices for safety):
    const input = asFiniteNumber(entry['input_cost_per_token']);
    const output = asFiniteNumber(entry['output_cost_per_token']);
    const cacheRead = asFiniteNumber(entry['cache_read_input_token_cost']);
    const cacheCreation = asFiniteNumber(entry['cache_creation_input_token_cost']);
    const cacheCreationAbove1hr = asFiniteNumber(entry['cache_creation_input_token_cost_above_1hr']);
    const outputReasoning = asFiniteNumber(entry['output_cost_per_reasoning_token']);

    // Only add if at least one price is present; otherwise this entry is useless.
    if (input === undefined && output === undefined && cacheRead === undefined &&
        cacheCreation === undefined && cacheCreationAbove1hr === undefined && outputReasoning === undefined) {
      continue;
    }

    // If range[0] === 0, this entry represents the model's base price.
    // Do NOT emit it as a tier. If its prices differ from the model's base price,
    // surface a note through onWarn but still skip it.
    if (above === 0) {
      if (input !== undefined && input !== baseInput) {
        onWarn(`Tiered pricing: model input price at threshold 0 differs from base (${input} vs ${baseInput})`);
      }
      if (output !== undefined && output !== baseOutput) {
        onWarn(`Tiered pricing: model output price at threshold 0 differs from base (${output} vs ${baseOutput})`);
      }
      continue; // skip this entry entirely
    }

    // If this threshold already exists, overwrite (last-wins)
    thresholdMap.set(above, {
      input,
      output,
      cacheReadInput: cacheRead,
      cacheCreationInput: cacheCreation,
      cacheCreationInputAbove1hr: cacheCreationAbove1hr,
      outputReasoning,
    });
  }

  // Sort thresholds ascending and build the tiers array
  const sortedThresholds = Array.from(thresholdMap.keys()).sort((a, b) => a - b);
  return sortedThresholds.map((above) => {
    const tier = thresholdMap.get(above)!;
    return {
      aboveInputTokens: above,
      input: tier.input ?? undefined,
      output: tier.output ?? undefined,
      cacheReadInput: tier.cacheReadInput ?? undefined,
      cacheCreationInput: tier.cacheCreationInput ?? undefined,
      cacheCreationInputAbove1hr: tier.cacheCreationInputAbove1hr ?? undefined,
      outputReasoning: tier.outputReasoning ?? undefined,
    };
  });
}

/** The five bases that may carry a flat <base>_above_<N>k_tokens field. */
const ABOVE_THRESHOLD_FIELD =
  /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost_above_1hr|cache_creation_input_token_cost|output_cost_per_reasoning_token)_above_(\d+)k_tokens$/;

/**
 * Parses flat <base>_above_<N>k_tokens fields into tiers.
 *
 * The regex is anchored at both ends on purpose, so service-tier variants
 * (`..._priority`, `..._batches`, `..._flex`) and unrelated bases (for example
 * audio) never match.
 *
 * A tier applies when inputTokens > N * 1000. Each threshold groups the five
 * bases. A tier needs an input and an output price; when only the input side is
 * present the model's base output price is used (and vice versa), with a
 * warning so the fallback is visible. Cache/reasoning fields stay undefined
 * when absent and fall back at estimate time.
 */
function parseFlatAboveThresholdFields(
  entry: RawModelEntry,
  baseInput: number,
  baseOutput: number,
  onWarn: Warn,
): ModelPricing['tiers'] {
  type TierFields = {
    input: number | undefined;
    output: number | undefined;
    cacheReadInput: number | undefined;
    cacheCreationInput: number | undefined;
    cacheCreationInputAbove1hr: number | undefined;
    outputReasoning: number | undefined;
  };

  const byThreshold = new Map<number, TierFields>();

  for (const [key, rawValue] of Object.entries(entry as Record<string, unknown>)) {
    const match = ABOVE_THRESHOLD_FIELD.exec(key);
    if (match === null) continue;
    const threshold = Number(match[2]) * 1000;
    if (!Number.isFinite(threshold) || threshold <= 0) continue;
    const value = asFiniteNumber(rawValue);
    if (value === undefined) continue;

    const fields = byThreshold.get(threshold) ?? {
      input: undefined,
      output: undefined,
      cacheReadInput: undefined,
      cacheCreationInput: undefined,
      cacheCreationInputAbove1hr: undefined,
      outputReasoning: undefined,
    };

    switch (match[1]) {
      case 'input_cost_per_token':
        fields.input = value;
        break;
      case 'output_cost_per_token':
        fields.output = value;
        break;
      case 'cache_read_input_token_cost':
        fields.cacheReadInput = value;
        break;
      case 'cache_creation_input_token_cost':
        fields.cacheCreationInput = value;
        break;
      case 'cache_creation_input_token_cost_above_1hr':
        fields.cacheCreationInputAbove1hr = value;
        break;
      case 'output_cost_per_reasoning_token':
        fields.outputReasoning = value;
        break;
    }

    byThreshold.set(threshold, fields);
  }

  const thresholds = Array.from(byThreshold.keys()).sort((a, b) => a - b);
  return thresholds.map((aboveInputTokens) => {
    const fields = byThreshold.get(aboveInputTokens)!;
    if (fields.input === undefined) {
      onWarn(
        `Tiered pricing: no input price above ${aboveInputTokens} tokens; falling back to base input (${baseInput})`,
      );
    }
    if (fields.output === undefined) {
      onWarn(
        `Tiered pricing: no output price above ${aboveInputTokens} tokens; falling back to base output (${baseOutput})`,
      );
    }
    return {
      aboveInputTokens,
      input: fields.input ?? baseInput,
      output: fields.output ?? baseOutput,
      cacheReadInput: fields.cacheReadInput,
      cacheCreationInput: fields.cacheCreationInput,
      cacheCreationInputAbove1hr: fields.cacheCreationInputAbove1hr,
      outputReasoning: fields.outputReasoning,
    };
  });
}

/**
 * Merges tiers from tiered_pricing arrays and flat above-threshold fields.
 * Array tiers win on a duplicate threshold; the result is sorted ascending.
 */
function mergeTiers(
  arrayTiers: ModelPricing['tiers'],
  flatTiers: ModelPricing['tiers'],
): NonNullable<ModelPricing['tiers']> {
  const byThreshold = new Map<number, NonNullable<ModelPricing['tiers']>[number]>();
  for (const tier of arrayTiers ?? []) byThreshold.set(tier.aboveInputTokens, tier);
  for (const tier of flatTiers ?? []) {
    if (!byThreshold.has(tier.aboveInputTokens)) byThreshold.set(tier.aboveInputTokens, tier);
  }
  return Array.from(byThreshold.keys())
    .sort((a, b) => a - b)
    .map((threshold) => byThreshold.get(threshold)!);
}

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
export const normalizeModelEntry = (
  raw: unknown,
  onWarn: Warn = () => {},
): ModelPricing | undefined => {
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

  // Base prices for tier threshold comparisons
  const baseInput = input;
  const baseOutput = output;

  // --- Long-context tiered pricing (from LiteLLM) ---
  const arrayTiers = parseTieredPricing(entry.tiered_pricing, baseInput, baseOutput, onWarn);
  const flatTiers = parseFlatAboveThresholdFields(entry, baseInput, baseOutput, onWarn);
  const mergedTiers = mergeTiers(arrayTiers, flatTiers);
  const tiers = mergedTiers.length > 0 ? mergedTiers : undefined;

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
    ...(tiers !== undefined ? { tiers } : {}),
  };

  return pricing;
};

export interface NormalizeOptions {
  readonly source?: string;
  readonly updatedAt?: string;
  /** Receives non-fatal notes; omitted means normalization stays silent. */
  readonly onWarn?: Warn;
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
    const pricing = normalizeModelEntry(value, options.onWarn);
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
