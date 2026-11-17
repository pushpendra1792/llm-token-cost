import { InvalidInputError, UnknownModelError } from './errors';
import { findModelPricing } from './pricing/lookup';
import { getPricing, type GetPricingOptions } from './pricing/fetch';
import {
  PRICING_CURRENCY,
  type CacheTtl,
  type ModelPricing,
  type PricingTier,
  type ServiceTier,
} from './pricing/types';
import { resolveTokenizer } from './tokenizers';

const SERVICE_TIERS: ReadonlyArray<ServiceTier> = ['standard', 'batch', 'flex', 'priority'];
const CACHE_TTLS: ReadonlyArray<CacheTtl> = ['5m', '1h'];

/**
 * Validates a model id before any pricing lookup happens.
 *
 * Kept separate from the lookup because it is synchronous and cheap: callers
 * reject bad input before spending a network round trip, and both public
 * estimators report the same message.
 */
const assertModel = (model: string): void => {
  if (typeof model !== 'string' || model.trim() === '') {
    throw new InvalidInputError('`model` must be a non-empty string');
  }
};

/**
 * Resolves a validated model to its pricing entry through the same source
 * ladder the public estimators use: live feed, then fresh cache, then bundled
 * snapshot.
 *
 * Shared so the two public estimators cannot drift apart on pricing, on the
 * errors they throw, or on what counts as an approximate price. The returned
 * `estimated` describes the pricing only; callers combine it with whatever
 * else they know about their own numbers.
 */
const resolveModelPricing = async (
  model: string,
  options: GetPricingOptions,
): Promise<{ readonly modelPricing: ModelPricing; readonly estimated: boolean }> => {
  const pricing = await getPricing(options);
  const modelPricing = findModelPricing(pricing.table, model);
  if (modelPricing === undefined) {
    throw new UnknownModelError(model, pricing.error === undefined ? undefined : { cause: pricing.error });
  }

  return { modelPricing, estimated: pricing.estimated };
};

/** Rejects counts that cannot be a real token total, with a message per cause. */
const assertTokenCount = (value: number, field: string): void => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidInputError(`\`${field}\` must be a finite number`);
  }
  if (!Number.isInteger(value)) {
    throw new InvalidInputError(`\`${field}\` must be a whole number of tokens`);
  }
  if (value < 0) {
    throw new InvalidInputError(`\`${field}\` must not be negative`);
  }
};

export interface EstimateCostInput {
  /** Model id, e.g. `gpt-4o`, `azure/gpt-4o`, `claude-sonnet-4-5`. */
  readonly model: string;
  readonly inputText: string;
  /** Omit to estimate the cost of a prompt with no completion. */
  readonly outputText?: string;
}

export interface EstimateCostResult {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Total cost in `currency`. */
  readonly cost: number;
  readonly currency: string;
  /**
   * True when either input is approximated: a heuristic token count for a model
   * whose real tokenizer is unavailable, or pricing that came from the bundled
   * snapshot or an expired cache rather than live data.
   *
   * False only when the token count is exact (tiktoken) *and* pricing is live.
   */
  readonly estimated: boolean;
}

/**
 * Estimates the token counts and total cost of a prompt/completion pair.
 *
 * Throws {@link UnknownModelError} when the model has no pricing entry in any
 * source. Everything else degrades gracefully: an unknown *tokenizer* only
 * affects accuracy, never whether a result is produced.
 */
export const estimateCost = async (
  input: EstimateCostInput,
  options: GetPricingOptions = {},
): Promise<EstimateCostResult> => {
  const { model, inputText, outputText = '' } = input;

  assertModel(model);
  if (typeof inputText !== 'string') {
    throw new InvalidInputError('`inputText` must be a string');
  }

  const { modelPricing, estimated: pricingEstimated } = await resolveModelPricing(model, options);

  const tokenizer = resolveTokenizer(model);
  const inputTokens = tokenizer.countTokens(inputText);
  const outputTokens = outputText === '' ? 0 : tokenizer.countTokens(outputText);

  const cost = inputTokens * modelPricing.input + outputTokens * modelPricing.output;

  return {
    inputTokens,
    outputTokens,
    cost,
    currency: PRICING_CURRENCY,
    // Fail-safe on purpose: only `tiktoken` is exact, so this must be written
    // as "not the exact tokenizer" rather than "is the generic heuristic".
    // A new tokenizer kind added later then reports `estimated: true` by
    // default instead of silently claiming an exact count it cannot deliver.
    estimated: tokenizer.kind !== 'tiktoken' || pricingEstimated,
  };
};

/** Per-category cost in `currency`, always summing to `cost`. */
export interface EstimateCostBreakdown {
  /** Cost of regular (uncached) input tokens. */
  readonly input: number;
  /** Cost of cache-read input tokens. */
  readonly cacheRead: number;
  /** Cost of cache-creation (write) input tokens. */
  readonly cacheCreation: number;
  /** Cost of regular (non-reasoning) output tokens. */
  readonly output: number;
  /** Cost of reasoning/thinking output tokens. */
  readonly reasoning: number;
}

export interface EstimateCostFromTokensInput {
  /** Model id, e.g. `gpt-4o`, `azure/gpt-4o`, `claude-sonnet-4-5`. */
  readonly model: string;
  /**
   * Whole number of input tokens, from a tokenizer or a provider's `usage`.
   * This is the *total*, including any cached tokens reported separately.
   */
  readonly inputTokens: number;
  /** Omit to price a prompt with no completion. */
  readonly outputTokens?: number;
  /** Subset of `inputTokens` served from a prompt cache. */
  readonly cacheReadInputTokens?: number;
  /** Subset of `inputTokens` written to a prompt cache. */
  readonly cacheCreationInputTokens?: number;
  /** Subset of `outputTokens` spent on reasoning/thinking. */
  readonly reasoningOutputTokens?: number;
  /** Billing tier for the whole request. Defaults to `standard`. */
  readonly serviceTier?: ServiceTier;
  /** Cache TTL used to select the cache-write price. Defaults to `5m`. */
  readonly cacheTtl?: CacheTtl;
}

export interface EstimateCostFromTokensResult {
  /** The counts as supplied. Nothing here is re-counted or corrected. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Total cost in `currency`. Equals the sum of `breakdown` when present. */
  readonly cost: number;
  readonly currency: string;
  /**
   * True when the price came from a fallback rather than live data: an expired
   * cache entry or the bundled snapshot.
   *
   * Token counts are taken as given, so unlike {@link EstimateCostResult} this
   * says nothing about the counts themselves. `false` means the per-token
   * prices were live; the caller is the only one who knows how exact the
   * counts are, since a provider's `usage` is exact and a hand-rolled count
   * is not.
   */
  readonly estimated: boolean;
  /**
   * Per-category costs. Present only when at least one breakdown input
   * (`cacheReadInputTokens`, `cacheCreationInputTokens`, or
   * `reasoningOutputTokens`) was supplied.
   */
  readonly breakdown?: EstimateCostBreakdown;
  /**
   * Human-readable notes about prices that fell back to another rate because
   * the model does not publish the requested price. Absent when every price
   * used was the one requested.
   */
  readonly warnings?: string[];
  /**
   * Long-context tier applied to this estimate, if any. Absent when the input
   * count did not cross a tier threshold, the model has no tiers, or a
   * non-standard service tier was requested.
   */
  readonly pricingTier?: PricingTier;
}

const assertOptionalTokenCount = (value: number | undefined, field: string): void => {
  if (value !== undefined) assertTokenCount(value, field);
};

function assertServiceTier(value: unknown): asserts value is ServiceTier {
  if (!SERVICE_TIERS.includes(value as ServiceTier)) {
    throw new InvalidInputError(`\`serviceTier\` must be one of: ${SERVICE_TIERS.join(', ')}`);
  }
}

function assertCacheTtl(value: unknown): asserts value is CacheTtl {
  if (!CACHE_TTLS.includes(value as CacheTtl)) {
    throw new InvalidInputError(`\`cacheTtl\` must be one of: ${CACHE_TTLS.join(', ')}`);
  }
}

interface ResolvedTier {
  readonly input: number;
  readonly output: number;
  readonly warnings: string[];
}

/**
 * Selects the input/output prices for the requested service tier, falling back
 * to the standard price per side when the model has no price for that tier.
 */
const resolveTierPricing = (
  model: string,
  pricing: ModelPricing,
  tier: ServiceTier,
): ResolvedTier => {
  if (tier === 'standard') {
    return { input: pricing.input, output: pricing.output, warnings: [] };
  }

  const tierInput =
    tier === 'batch' ? pricing.inputBatch : tier === 'flex' ? pricing.inputFlex : pricing.inputPriority;
  const tierOutput =
    tier === 'batch' ? pricing.outputBatch : tier === 'flex' ? pricing.outputFlex : pricing.outputPriority;

  const warnings: string[] = [];
  let input = pricing.input;
  let output = pricing.output;

  if (tierInput !== undefined) {
    input = tierInput;
  } else {
    warnings.push(`No ${tier} input price for ${model}; using the standard input price.`);
  }

  if (tierOutput !== undefined) {
    output = tierOutput;
  } else {
    warnings.push(`No ${tier} output price for ${model}; using the standard output price.`);
  }

  return { input, output, warnings };
};

interface LongContextSelection {
  readonly tier: PricingTier | undefined;
  readonly warnings: string[];
}

/**
 * Finds the highest long-context tier whose threshold is strictly below the
 * input count. Tiers only apply to the standard service tier: batch, flex and
 * priority requests already carry their own prices, and combining them with a
 * long-context surcharge would double-apply a discount.
 */
const resolveLongContextTier = (
  model: string,
  pricing: ModelPricing,
  inputTokens: number,
  serviceTier: ServiceTier,
): LongContextSelection => {
  const tiers = pricing.tiers;
  if (tiers === undefined || tiers.length === 0) {
    return { tier: undefined, warnings: [] };
  }

  let matched: PricingTier | undefined;
  for (const candidate of tiers) {
    if (inputTokens > candidate.aboveInputTokens) matched = candidate;
  }

  if (matched === undefined) {
    return { tier: undefined, warnings: [] };
  }

  if (serviceTier !== 'standard') {
    return {
      tier: undefined,
      warnings: [
        `Long-context tier above ${matched.aboveInputTokens} tokens is not applied to the ${serviceTier} service tier for ${model}.`,
      ],
    };
  }

  return { tier: matched, warnings: [] };
};

/**
 * Costs token counts you already have, without tokenizing anything.
 *
 * This is the counterpart to {@link estimateCost} for the case where the
 * numbers already exist: a provider's `usage` object from the response you
 * just received, or a count from the tokenizer you already depend on. It
 * resolves pricing exactly the same way, so both estimators agree on price and
 * on the errors they throw.
 *
 * `inputTokens` and `outputTokens` are totals. Cache and reasoning counts are
 * optional *subsets* of those totals: cached input is billed at its own rate,
 * reasoning output at its own rate, and the remainder at the normal rates. A
 * subset larger than its total is rejected rather than clamped.
 *
 * Counts are used verbatim. Nothing is rounded, scaled or corrected, so a
 * count from any source costs the same here. Non-finite, fractional and
 * negative counts are rejected with {@link InvalidInputError}, and an unknown
 * model with {@link UnknownModelError}, matching `estimateCost`.
 */
export const estimateCostFromTokens = async (
  input: EstimateCostFromTokensInput,
  options: GetPricingOptions = {},
): Promise<EstimateCostFromTokensResult> => {
  const {
    model,
    inputTokens,
    outputTokens = 0,
    cacheReadInputTokens = 0,
    cacheCreationInputTokens = 0,
    reasoningOutputTokens = 0,
    serviceTier = 'standard',
    cacheTtl = '5m',
  } = input;

  assertModel(model);
  assertTokenCount(inputTokens, 'inputTokens');
  assertTokenCount(outputTokens, 'outputTokens');
  assertOptionalTokenCount(input.cacheReadInputTokens, 'cacheReadInputTokens');
  assertOptionalTokenCount(input.cacheCreationInputTokens, 'cacheCreationInputTokens');
  assertOptionalTokenCount(input.reasoningOutputTokens, 'reasoningOutputTokens');
  assertServiceTier(serviceTier);
  assertCacheTtl(cacheTtl);

  if (cacheReadInputTokens + cacheCreationInputTokens > inputTokens) {
    throw new InvalidInputError(
      '`cacheReadInputTokens` + `cacheCreationInputTokens` must not exceed `inputTokens`',
    );
  }
  if (reasoningOutputTokens > outputTokens) {
    throw new InvalidInputError('`reasoningOutputTokens` must not exceed `outputTokens`');
  }

  const { modelPricing, estimated } = await resolveModelPricing(model, options);

  const servicePricing = resolveTierPricing(model, modelPricing, serviceTier);
  const longContext = resolveLongContextTier(model, modelPricing, inputTokens, serviceTier);
  const appliedTier = longContext.tier;
  const warnings = [...servicePricing.warnings, ...longContext.warnings];

  const effectiveInput = appliedTier?.input ?? servicePricing.input;
  const effectiveOutput = appliedTier?.output ?? servicePricing.output;

  // Cache reads: a tier may set its own rate; otherwise fall back to the
  // model's base cache-read rate, then to the normal input rate.
  let cacheReadPrice: number;
  if (appliedTier !== undefined) {
    if (appliedTier.cacheReadInput !== undefined) {
      cacheReadPrice = appliedTier.cacheReadInput;
    } else if (modelPricing.cacheReadInput !== undefined) {
      cacheReadPrice = modelPricing.cacheReadInput;
      if (cacheReadInputTokens > 0) {
        warnings.push(
          `No cache read price in the tier above ${appliedTier.aboveInputTokens} tokens for ${model}; using the model's base cache read price.`,
        );
      }
    } else {
      // No tier cache-read price and no base cache-read price: use the model's
      // base input price, not the tier input price, so the fallback stays the
      // documented "base input" rate.
      cacheReadPrice = modelPricing.input;
      if (cacheReadInputTokens > 0) {
        warnings.push(`No cache read price for ${model}; using the normal input price.`);
      }
    }
  } else {
    cacheReadPrice = modelPricing.cacheReadInput ?? servicePricing.input;
    if (modelPricing.cacheReadInput === undefined && cacheReadInputTokens > 0) {
      warnings.push(`No cache read price for ${model}; using the normal input price.`);
    }
  }

  // Cache writes: TTL selects the price; a missing 1h price falls back to 5m.
  const fiveMinuteCacheCreationPrice =
    appliedTier?.cacheCreationInput ?? modelPricing.cacheCreationInput;
  let cacheCreationPrice: number;
  if (cacheTtl === '1h') {
    const oneHourCacheCreationPrice =
      appliedTier?.cacheCreationInputAbove1hr ?? modelPricing.cacheCreationInputAbove1hr;

    if (oneHourCacheCreationPrice !== undefined) {
      cacheCreationPrice = oneHourCacheCreationPrice;
    } else if (fiveMinuteCacheCreationPrice !== undefined) {
      cacheCreationPrice = fiveMinuteCacheCreationPrice;
      if (cacheCreationInputTokens > 0) {
        warnings.push(
          `No 1-hour cache creation price for ${model}; using the 5-minute cache write price.`,
        );
      }
    } else {
      cacheCreationPrice = effectiveInput;
      if (cacheCreationInputTokens > 0) {
        warnings.push(`No cache creation price for ${model}; using the normal input price.`);
      }
    }
  } else if (fiveMinuteCacheCreationPrice !== undefined) {
    cacheCreationPrice = fiveMinuteCacheCreationPrice;
  } else {
    cacheCreationPrice = effectiveInput;
    if (cacheCreationInputTokens > 0) {
      warnings.push(`No cache creation price for ${model}; using the normal input price.`);
    }
  }

  // Reasoning: use the published reasoning price, else the normal output rate.
  const reasoningPrice =
    appliedTier?.outputReasoning ?? modelPricing.outputReasoning ?? effectiveOutput;
  if (
    appliedTier?.outputReasoning === undefined &&
    modelPricing.outputReasoning === undefined &&
    reasoningOutputTokens > 0
  ) {
    warnings.push(`No reasoning price for ${model}; using the normal output price.`);
  }

  const regularInputTokens = inputTokens - cacheReadInputTokens - cacheCreationInputTokens;
  const regularOutputTokens = outputTokens - reasoningOutputTokens;

  const breakdown: EstimateCostBreakdown = {
    input: regularInputTokens * effectiveInput,
    cacheRead: cacheReadInputTokens * cacheReadPrice,
    cacheCreation: cacheCreationInputTokens * cacheCreationPrice,
    output: regularOutputTokens * effectiveOutput,
    reasoning: reasoningOutputTokens * reasoningPrice,
  };

  const cost =
    breakdown.input +
    breakdown.cacheRead +
    breakdown.cacheCreation +
    breakdown.output +
    breakdown.reasoning;

  const wantsBreakdown =
    input.cacheReadInputTokens !== undefined ||
    input.cacheCreationInputTokens !== undefined ||
    input.reasoningOutputTokens !== undefined;

  return {
    inputTokens,
    outputTokens,
    cost,
    currency: PRICING_CURRENCY,
    // Pricing only: the counts are the caller's, and are used as given.
    estimated,
    ...(wantsBreakdown ? { breakdown } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(appliedTier !== undefined ? { pricingTier: appliedTier } : {}),
  };
};
