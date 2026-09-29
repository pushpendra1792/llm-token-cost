import { buildModelIndex, modelIdCandidates } from '../model-id';
import { isPriced, type ModelPricing, type PricingTable } from './types';

/**
 * Lowercased key index, memoized per table object. The bundled snapshot holds
 * thousands of models, so a linear scan per lookup is not acceptable; keying on
 * the table object means the index is built once and then collected with it.
 */
const indexCache = new WeakMap<PricingTable, ReadonlyMap<string, string>>();

const indexFor = (table: PricingTable): ReadonlyMap<string, string> => {
  const cached = indexCache.get(table);
  if (cached !== undefined) return cached;
  const built = buildModelIndex(table.models);
  indexCache.set(table, built);
  return built;
};

/**
 * Resolves a user-supplied model id to a pricing entry.
 *
 * Walks `modelIdCandidates` most specific first: the id as given, then the
 * `ft:`-stripped form, then progressively stripped provider prefixes. Within
 * each candidate an exact key match wins over a case-insensitive one, so
 * `GPT-4O` and `azure/gpt-4o` both reach the pricing `gpt-4o` is charged.
 *
 * That order is what keeps a fine-tuned id honest. `ft:gpt-4o-2024-08-06`
 * has its own entry at its own rate, and the exact key is tried before the
 * stripped `gpt-4o-2024-08-06` is considered at all. A fine-tune is only
 * priced as the model it was cut from when the feed has no entry for it.
 */
export const findModelPricing = (
  table: PricingTable,
  model: string,
): ModelPricing | undefined => {
  const index = indexFor(table);

  for (const candidate of modelIdCandidates(model)) {
    const exact = table.models[candidate];
    if (isPriced(exact)) return exact;

    const actualKey = index.get(candidate.toLowerCase());
    if (actualKey !== undefined) {
      const insensitive = table.models[actualKey];
      if (isPriced(insensitive)) return insensitive;
    }
  }

  return undefined;
};
