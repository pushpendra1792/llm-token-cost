/**
 * Ordered list of identifiers to try when resolving a user-supplied model name
 * against pricing keys and tokenizer encodings.
 *
 * Providers and gateways prefix the same underlying model in several ways, so a
 * single exact lookup is not enough:
 *
 * - `ft:gpt-4o-2024-08-06`  fine-tuned OpenAI deployments
 * - `azure/gpt-4o`          provider-routed names
 * - `openrouter/openai/gpt-4o`
 *
 * Most specific first, so an exact match always wins over a stripped one.
 */
export const modelIdCandidates = (model: string): string[] => {
  const trimmed = model.trim();
  if (trimmed === '') return [];

  const candidates: string[] = [];
  const push = (value: string): void => {
    if (value !== '' && !candidates.includes(value)) candidates.push(value);
  };

  push(trimmed);

  const withoutFineTunePrefix = trimmed.startsWith('ft:') ? trimmed.slice(3) : trimmed;
  push(withoutFineTunePrefix);

  for (const base of [trimmed, withoutFineTunePrefix]) {
    const segments = base.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      push(segments.slice(index).join('/'));
    }
  }

  return candidates;
};

/**
 * Builds a case-insensitive view of a pricing table for fallback lookups.
 * Building it once per table keeps `lookupModel` O(1) instead of scanning keys.
 */
export const buildModelIndex = (
  models: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string> => {
  const index = new Map<string, string>();
  for (const key of Object.keys(models)) {
    const lower = key.toLowerCase();
    if (!index.has(lower)) index.set(lower, key);
  }
  return index;
};
