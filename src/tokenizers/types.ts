export type TokenizerKind = 'tiktoken' | 'heuristic';

export interface Tokenizer {
  readonly kind: TokenizerKind;
  /** Encoding name (e.g. `o200k_base`) for exact tokenizers; undefined otherwise. */
  readonly encoding: string | undefined;
  countTokens: (text: string) => number;
}
