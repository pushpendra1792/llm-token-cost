import { getTiktokenEncoder, resolveTiktokenEncoding } from './openai';
import { estimateTokensHeuristic } from './heuristic';
import type { Tokenizer } from './types';

export type { Tokenizer, TokenizerKind } from './types';
export { estimateTokensHeuristic } from './heuristic';
export { getTiktokenEncoder, isTiktokenModel, resolveTiktokenEncoding } from './openai';

/**
 * Picks the best available tokenizer for a model.
 *
 * Exact tiktoken tokenization when the model belongs to a family tiktoken
 * knows; otherwise the heuristic estimator. Never throws: an unrecognized
 * model still gets a usable (approximate) token count, because token count and
 * pricing lookup are independent concerns.
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

  return {
    kind: 'heuristic',
    encoding: undefined,
    countTokens: estimateTokensHeuristic,
  };
};
