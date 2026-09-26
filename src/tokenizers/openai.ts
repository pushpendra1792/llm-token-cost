import { getEncoding, getEncodingNameForModel } from 'js-tiktoken';
import type { Tiktoken, TiktokenEncoding, TiktokenModel } from 'js-tiktoken';
import { modelIdCandidates } from '../model-id';

/**
 * Encoders are expensive to construct (each deserializes a large rank table) and
 * a process typically only ever touches one or two. Cache by encoding name
 * rather than by model, so `gpt-4o` and `gpt-4o-mini` share one instance.
 */
const encoderCache = new Map<TiktokenEncoding, Tiktoken>();

/**
 * Resolves the exact tiktoken encoding for a model, or `undefined` when tiktoken
 * does not know it.
 *
 * `js-tiktoken` only covers OpenAI's published families. Anthropic, Google and
 * most other providers do not expose their tokenizers, and OpenAI's own list is
 * a compiled-in table, so a newly announced model falls back to the heuristic
 * until the dependency catches up. Either way the caller gets a token count.
 */
export const resolveTiktokenEncoding = (model: string): TiktokenEncoding | undefined => {
  for (const candidate of modelIdCandidates(model)) {
    for (const name of [candidate, candidate.toLowerCase()]) {
      try {
        // The parameter is a literal union of model ids, but the function
        // validates against its own table at runtime and throws for anything
        // else, which is exactly the signal we want here.
        return getEncodingNameForModel(name as TiktokenModel);
      } catch {
        // Not a known model; try the next candidate.
      }
    }
  }
  return undefined;
};

export const getTiktokenEncoder = (model: string): Tiktoken | undefined => {
  const encoding = resolveTiktokenEncoding(model);
  if (encoding === undefined) return undefined;

  const cached = encoderCache.get(encoding);
  if (cached !== undefined) return cached;

  const encoder = getEncoding(encoding);
  encoderCache.set(encoding, encoder);
  return encoder;
};

export const isTiktokenModel = (model: string): boolean =>
  resolveTiktokenEncoding(model) !== undefined;
