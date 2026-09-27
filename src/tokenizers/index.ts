import { getTiktokenEncoder, resolveTiktokenEncoding } from './openai';
import {
  anthropicTokenizerGeneration,
  estimateTokensAnthropic,
  isAnthropicModel,
} from './anthropic';
import { estimateTokensHeuristic } from './heuristic';
import type { Tokenizer } from './types';

export type { AnthropicTokenizerGeneration, Tokenizer, TokenizerKind } from './types';
export {
  anthropicTokenRatio,
  anthropicTokenizerGeneration,
  estimateTokensAnthropic,
  isAnthropicModel,
} from './anthropic';
export { estimateTokensHeuristic, estimateTokensHeuristicScaled } from './heuristic';
export { getTiktokenEncoder, isTiktokenModel, resolveTiktokenEncoding } from './openai';

/**
 * Picks the best available tokenizer for a model.
 *
 * Three tiers, most accurate first:
 *
 * 1. tiktoken, for OpenAI families whose exact encoding is known.
 * 2. The Anthropic correction, for Claude models. Still an estimate, but a
 *    provider-corrected one rather than a generic guess.
 * 3. The generic blend, for everything else.
 *
 * Never throws: an unrecognized model still gets a usable token count, because
 * token count and pricing lookup are independent concerns.
 *
 * Order matters. Anthropic is checked after tiktoken so that a model id which
 * happens to appear in both tables still gets the exact count.
 */
export const resolveTokenizer = (model: string): Tokenizer => {
  const encoder = getTiktokenEncoder(model);
  if (encoder !== undefined) {
    return {
      kind: 'tiktoken',
      encoding: resolveTiktokenEncoding(model),
      countTokens: (text: string): number => encoder.encode(text).length,
    };
  }

  if (isAnthropicModel(model)) {
    return {
      kind: 'anthropic-heuristic',
      encoding: undefined,
      anthropicGeneration: anthropicTokenizerGeneration(model),
      countTokens: (text: string): number => estimateTokensAnthropic(model, text),
    };
  }

  return {
    kind: 'heuristic',
    encoding: undefined,
    countTokens: estimateTokensHeuristic,
  };
};
