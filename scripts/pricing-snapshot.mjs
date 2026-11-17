/**
 * Pure formatting and change-detection helpers for the pricing snapshot.
 *
 * Kept separate from `update-pricing.mjs` so tests can exercise the
 * unchanged-models decision without fetching the network. The refresh script
 * is the only production caller.
 */

export const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const sortedEntries = (models) =>
  Object.keys(models)
    .sort()
    .map((key) => [key, models[key]]);

export const formatSnapshot = (models, updatedAt, generatedAt) =>
  JSON.stringify({
    schemaVersion: 1,
    updatedAt,
    generatedAt,
    source: LITELLM_PRICING_URL,
    currency: 'USD',
    unit: 'per_token',
    models: Object.fromEntries(sortedEntries(models)),
  });

export const formatLimits = (limits) => JSON.stringify(Object.fromEntries(sortedEntries(limits)));

/** Model contents only: metadata timestamps must not make equal data look changed. */
export const snapshotModelsEqual = (left, right) =>
  JSON.stringify(Object.fromEntries(sortedEntries(left))) ===
  JSON.stringify(Object.fromEntries(sortedEntries(right)));

/**
 * Decides whether a refresh writes either file.
 *
 * `generatedAt` tracks the model payload, not the run. It is preserved when
 * only limits change, and when the models are unchanged the previous text is
 * reproduced byte for byte so the weekly workflow sees no diff.
 */
export const planSnapshotUpdate = ({ previous, models, now }) => {
  const modelsChanged = previous === undefined || !snapshotModelsEqual(previous.models, models);
  const updatedAt = modelsChanged ? now.toISOString() : previous.updatedAt;
  // ISO date, e.g. 2026-11-15. Older files may not have generatedAt yet, so
  // derive a stable date from their existing updatedAt instead of using "now".
  const generatedAt = modelsChanged
    ? now.toISOString().slice(0, 10)
    : (previous.generatedAt ?? previous.updatedAt.slice(0, 10));
  const text = formatSnapshot(models, updatedAt, generatedAt);

  return {
    changed: previous === undefined || text !== previous.text,
    modelsChanged,
    text,
    updatedAt,
    generatedAt,
  };
};
