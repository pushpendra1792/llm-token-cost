import { InvalidInputError, UnknownModelError } from './errors';
import { findModelPricing } from './pricing/lookup';
import { getPricing, type GetPricingOptions } from './pricing/fetch';
import { PRICING_CURRENCY } from './pricing/types';
import { resolveTokenizer } from './tokenizers';

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

  if (typeof model !== 'string' || model.trim() === '') {
    throw new InvalidInputError('`model` must be a non-empty string');
  }
  if (typeof inputText !== 'string') {
    throw new InvalidInputError('`inputText` must be a string');
  }

  const pricing = await getPricing(options);
  const modelPricing = findModelPricing(pricing.table, model);
  if (modelPricing === undefined) {
    throw new UnknownModelError(model, pricing.error === undefined ? undefined : { cause: pricing.error });
  }

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
    estimated: tokenizer.kind !== 'tiktoken' || pricing.estimated,
  };
};
