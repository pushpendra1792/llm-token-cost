import { InvalidInputError, UnknownModelError } from './errors';
import { findModelPricing } from './pricing/lookup';
import { getPricing, type GetPricingOptions } from './pricing/fetch';
import { PRICING_CURRENCY, type ModelPricing } from './pricing/types';
import { resolveTokenizer } from './tokenizers';

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

export interface EstimateCostFromTokensInput {
  /** Model id, e.g. `gpt-4o`, `azure/gpt-4o`, `claude-sonnet-4-5`. */
  readonly model: string;
  /** Whole number of input tokens, from a tokenizer or a provider's `usage`. */
  readonly inputTokens: number;
  /** Omit to price a prompt with no completion. */
  readonly outputTokens?: number;
}

export interface EstimateCostFromTokensResult {
  /** The counts as supplied. Nothing here is re-counted or corrected. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Total cost in `currency`. */
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
}

/**
 * Costs token counts you already have, without tokenizing anything.
 *
 * This is the counterpart to {@link estimateCost} for the case where the
 * numbers already exist: a provider's `usage` object from the response you
 * just received, or a count from the tokenizer you already depend on. It
 * resolves pricing exactly the same way, so both estimators agree on price and
 * on the errors they throw.
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
  const { model, inputTokens, outputTokens = 0 } = input;

  assertModel(model);
  assertTokenCount(inputTokens, 'inputTokens');
  assertTokenCount(outputTokens, 'outputTokens');

  const { modelPricing, estimated } = await resolveModelPricing(model, options);

  const cost = inputTokens * modelPricing.input + outputTokens * modelPricing.output;

  return {
    inputTokens,
    outputTokens,
    cost,
    currency: PRICING_CURRENCY,
    // Pricing only: the counts are the caller's, and are used as given.
    estimated,
  };
};
