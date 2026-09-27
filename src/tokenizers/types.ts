export type TokenizerKind = 'tiktoken' | 'anthropic-heuristic' | 'heuristic';

/**
 * Which Anthropic tokenizer generation a model uses. See
 * `tokenizers/anthropic.ts` for why the two are treated differently.
 */
export type AnthropicTokenizerGeneration = 'legacy' | 'current';

export interface Tokenizer {
  readonly kind: TokenizerKind;
  /** Encoding name (e.g. `o200k_base`) for exact tokenizers; undefined otherwise. */
  readonly encoding: string | undefined;
  /** Set only for Anthropic models, so callers can see which correction applied. */
  readonly anthropicGeneration?: AnthropicTokenizerGeneration;
  countTokens: (text: string) => number;
}
