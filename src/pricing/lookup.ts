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
 * Tries exact candidates first (preserving any provider prefix), then falls
 * back to a case-insensitive match, so `GPT-4O`, `azure/gpt-4o` and
 * `ft:gpt-4o-2024-08-06` all resolve to the same underlying pricing.
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
