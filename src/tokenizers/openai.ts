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
 * Encodings for model families that `js-tiktoken`'s compiled-in table predates.
 *
 * This mirrors OpenAI's own `MODEL_PREFIX_TO_ENCODING` in
 * `openai/tiktoken`'s `model.py`, which the project introduced precisely so that
 * "prefix matching avoids needing library updates for every model version
 * release". The motivation applies here too: `js-tiktoken` is the current
 * release (1.0.21) and its table stops at `gpt-5`, so every `gpt-5.1` and later
 * id — which LiteLLM lists and people actually call — was silently falling
 * through to the heuristic even though the exact encoding was known.
 *
 * The clearest case is `gpt-5.1`, added upstream in openai/tiktoken#468 and
 * shipped in Python `tiktoken` 0.14, but never backported to the JS port. Before
 * this table, `estimateCost({ model: 'gpt-5.1' })` reported `estimated: true`
 * and a ~24% MAPE guess for a model whose counts are exactly computable.
 *
 * Entries are tried only after `js-tiktoken`'s table throws, so a model the
 * library knows about is never re-decided here. As upstream notes, prefix
 * matching can match on a model that does not exist; the exposure is identical
 * to the table this mirrors, and bounded to the same families.
 *
 * `gpt-6-*` is deliberately absent. No encoding has been published for it, and
 * guessing would turn an honest estimate into a false claim of exactness.
 * `gpt-oss-*` is absent because it needs `o200k_harmony`, which `js-tiktoken`
 * does not bundle.
 */
const TIKTOKEN_PREFIX_ENCODINGS: ReadonlyArray<readonly [string, TiktokenEncoding]> = [
  // OpenAI tiktoken's reasoning and chat prefixes, verbatim.
  ['o1-', 'o200k_base'],
  ['o3-', 'o200k_base'],
  ['o4-mini-', 'o200k_base'],
  ['gpt-4.1-', 'o200k_base'],
  ['gpt-4.5-', 'o200k_base'],
  ['gpt-4o-', 'o200k_base'],
  ['chatgpt-4o-', 'o200k_base'],
  ['gpt-4-', 'cl100k_base'],
  ['gpt-3.5-turbo-', 'cl100k_base'],
  ['gpt-35-turbo-', 'cl100k_base'],
  ['ft:gpt-4o', 'o200k_base'],
  // Dotted and dashed minor versions of the 5.x line. Upstream lists `gpt-5-`
  // and adds `gpt-5.1` individually; the dotted form is generalised to the
  // whole 5.x path, which is what upstream's own maintainer asked for when
  // 5.2 through 5.4 started landing.
  ['gpt-5-', 'o200k_base'],
  ['gpt-5.', 'o200k_base'],
];

const resolveByPrefix = (name: string): TiktokenEncoding | undefined => {
  const lower = name.toLowerCase();
  for (const [prefix, encoding] of TIKTOKEN_PREFIX_ENCODINGS) {
    if (lower.startsWith(prefix)) return encoding;
  }
  return undefined;
};

/**
 * Resolves the exact tiktoken encoding for a model, or `undefined` when neither
 * `js-tiktoken` nor the prefix table knows it.
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
        // Not in js-tiktoken's table; fall through to the prefix table below.
      }
    }

    const byPrefix = resolveByPrefix(candidate);
    if (byPrefix !== undefined) return byPrefix;
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
