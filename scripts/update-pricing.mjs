#!/usr/bin/env node
/**
 * Regenerates src/pricing/snapshot.json from the LiteLLM pricing feed.
 *
 * Usage: npm run update:pricing
 *
 * The extraction below intentionally mirrors `src/pricing/normalize.ts` rather
 * than importing it: this script is plain .mjs so it can run without a build
 * step, and Node's type stripping cannot resolve this project's extensionless
 * imports. `test/pricing.test.ts` asserts the generated snapshot matches the
 * normalizer's contract, so the two cannot silently drift apart. The one
 * deliberate difference is the chat/completion mode filter: the snapshot is
 * kept small by omitting audio/image/embedding-only entries, while the live
 * normalizer keeps accepting any entry that carries both token prices.
 *
 * The output is formatted one model per line on purpose: the scheduled
 * update-pricing workflow opens a pull request, and this layout keeps that diff
 * to only the models that actually changed.
 *
 * The output is also byte-stable across runs. Model keys are sorted and prices
 * go through `JSON.stringify`, so `updatedAt` is the only field that could
 * otherwise drift. It is therefore written as "when the data last changed"
 * rather than "when this script last ran": the file is first rendered with the
 * previous `updatedAt`, and only if that does not reproduce the committed file
 * byte for byte is a fresh timestamp substituted. Re-running against unchanged
 * upstream data therefore leaves the working tree clean, which is what lets the
 * scheduled workflow exit without opening a no-op pull request.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const OUTPUT_PATH = fileURLToPath(new URL('../src/pricing/snapshot.json', import.meta.url));
const LIMITS_OUTPUT_PATH = fileURLToPath(new URL('../src/pricing/limits.json', import.meta.url));

const RESERVED_KEYS = new Set(['sample_spec', 'keys', 'version']);
const TOKENS_PER_UNIT = { per_token: 1, per_1k: 1_000, per_1m: 1_000_000 };

/** Modes that are chat/completion style and should be included in the snapshot. */
const CHAT_MODES = new Set(['chat', 'completion', 'responses']);

const readPrice = (entry, kind) => {
  for (const [field, unit] of [
    [`${kind}_cost_per_token`, 'per_token'],
    [`${kind}_cost_per_1k_tokens`, 'per_1k'],
    [`${kind}_cost_per_1m_tokens`, 'per_1m'],
  ]) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value / TOKENS_PER_UNIT[unit];
    }
  }
  return undefined;
};

const readSimplePrice = (entry, field) => {
  const value = entry[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
};

const normalizeEntry = (raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  // Only include chat/completion-style models
  const mode = raw.mode;
  if (typeof mode !== 'string' || !CHAT_MODES.has(mode)) return undefined;

  const input = readPrice(raw, 'input');
  const output = readPrice(raw, 'output');
  if (input === undefined || output === undefined) return undefined;

  const provider = typeof raw.litellm_provider === 'string' ? raw.litellm_provider : undefined;

  // Cache pricing
  const cacheReadInput = readSimplePrice(raw, 'cache_read_input_token_cost');
  const cacheCreationInput = readSimplePrice(raw, 'cache_creation_input_token_cost');
  const cacheCreationInputAbove1hr = readSimplePrice(raw, 'cache_creation_input_token_cost_above_1hr');

  // Service tier pricing
  const inputBatch = readSimplePrice(raw, 'input_cost_per_token_batches');
  const outputBatch = readSimplePrice(raw, 'output_cost_per_token_batches');
  const inputFlex = readSimplePrice(raw, 'input_cost_per_token_flex');
  const outputFlex = readSimplePrice(raw, 'output_cost_per_token_flex');
  const inputPriority = readSimplePrice(raw, 'input_cost_per_token_priority');
  const outputPriority = readSimplePrice(raw, 'output_cost_per_token_priority');

  // Reasoning pricing
  const outputReasoning = readSimplePrice(raw, 'output_cost_per_reasoning_token');

  const pricing = {
    input,
    output,
    cacheReadInput,
    cacheCreationInput,
    cacheCreationInputAbove1hr,
    inputBatch,
    outputBatch,
    inputFlex,
    outputFlex,
    inputPriority,
    outputPriority,
    outputReasoning,
  };

  if (provider !== undefined) {
    pricing.provider = provider;
  }

  // Context limits live in a separate file so the main snapshot stays small.
  const maxInputTokens = readSimplePrice(raw, 'max_input_tokens');
  const maxOutputTokens = readSimplePrice(raw, 'max_output_tokens');
  const limits = {};
  if (maxInputTokens !== undefined) limits.maxInputTokens = maxInputTokens;
  if (maxOutputTokens !== undefined) limits.maxOutputTokens = maxOutputTokens;

  return {
    pricing,
    limits: Object.keys(limits).length > 0 ? limits : undefined,
  };
};

/** Every numeric field the snapshot may carry. Missing fields are allowed. */
const NUMERIC_FIELDS = [
  'input',
  'output',
  'cacheReadInput',
  'cacheCreationInput',
  'cacheCreationInputAbove1hr',
  'inputBatch',
  'outputBatch',
  'inputFlex',
  'outputFlex',
  'inputPriority',
  'outputPriority',
  'outputReasoning',
  'maxInputTokens',
  'maxOutputTokens',
];

/**
 * Verifies the generated table before it is written. A malformed snapshot is
 * worse than a stale one, so this fails the run rather than committing it.
 */
const assertWellFormed = (models) => {
  for (const [key, pricing] of Object.entries(models)) {
    if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing)) {
      throw new Error(`Malformed pricing entry for ${key}: expected an object`);
    }
    for (const field of NUMERIC_FIELDS) {
      const value = pricing[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`Malformed pricing for ${key}.${field}: ${String(value)}`);
      }
    }
    if ('provider' in pricing && typeof pricing.provider !== 'string') {
      throw new Error(`Malformed provider for ${key}: expected a string`);
    }
  }
};

const formatSnapshot = (models, updatedAt) => {
  // Compact JSON: no indentation or extra whitespace. Keys are sorted so the
  // file stays byte-stable and diffs only reflect real pricing changes.
  const sortedModels = Object.fromEntries(
    Object.keys(models)
      .sort()
      .map((key) => [key, models[key]]),
  );
  return JSON.stringify({
    schemaVersion: 1,
    updatedAt,
    source: LITELLM_PRICING_URL,
    currency: 'USD',
    unit: 'per_token',
    models: sortedModels,
  });
};

const formatLimits = (limits) => {
  const sortedLimits = Object.fromEntries(
    Object.keys(limits)
      .sort()
      .map((key) => [key, limits[key]]),
  );
  return JSON.stringify(sortedLimits);
};

const assertLimitsWellFormed = (limits) => {
  for (const [key, entry] of Object.entries(limits)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`Malformed limits entry for ${key}: expected an object`);
    }
    for (const field of ['maxInputTokens', 'maxOutputTokens']) {
      const value = entry[field];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`Malformed limits for ${key}.${field}: ${String(value)}`);
      }
    }
  }
};

/** The committed snapshot's raw text plus its metadata, or undefined if unusable. */
const readPrevious = async () => {
  let text;
  try {
    text = await readFile(OUTPUT_PATH, 'utf8');
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed?.updatedAt !== 'string') return undefined;
  const models = parsed?.models;
  return {
    text,
    updatedAt: parsed.updatedAt,
    models: typeof models === 'object' && models !== null ? models : {},
  };
};

/** Raw text of the committed limits file, or undefined if it does not exist. */
const readPreviousLimits = async () => {
  try {
    return await readFile(LIMITS_OUTPUT_PATH, 'utf8');
  } catch {
    return undefined;
  }
};

/** Model-level counts for the pull request summary, so reviewers see scope in the log. */
const summarizeChanges = (previousModels, nextModels) => {
  let added = 0;
  let repriced = 0;
  for (const [key, next] of Object.entries(nextModels)) {
    const before = previousModels[key];
    if (before === undefined) {
      added += 1;
      continue;
    }
    if (before.input !== next.input || before.output !== next.output || before.provider !== next.provider) {
      repriced += 1;
    }
  }
  const removed = Object.keys(previousModels).filter((key) => !Object.hasOwn(nextModels, key)).length;
  return { added, removed, repriced };
};

const main = async () => {
  const response = await fetch(LITELLM_PRICING_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Pricing fetch failed: HTTP ${response.status} ${response.statusText}`);
  }

  const raw = await response.json();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('LiteLLM pricing payload is not a JSON object');
  }

  const models = {};
  const limits = {};
  let skipped = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED_KEYS.has(key)) continue;
    const normalized = normalizeEntry(value);
    if (normalized === undefined) {
      skipped += 1;
      continue;
    }
    models[key] = normalized.pricing;
    if (normalized.limits !== undefined) limits[key] = normalized.limits;
  }

  assertWellFormed(models);
  assertLimitsWellFormed(limits);

  const count = Object.keys(models).length;
  const previous = await readPrevious();
  const previousLimitsText = await readPreviousLimits();
  const limitsText = formatLimits(limits);

  // Render with the previous timestamp first. Matching the committed files byte
  // for byte proves the upstream data is unchanged, so nothing is written and
  // the scheduled workflow has no diff to open a pull request from.
  const snapshotWithPreviousTimestamp =
    previous === undefined ? undefined : formatSnapshot(models, previous.updatedAt);

  if (
    previous !== undefined &&
    snapshotWithPreviousTimestamp === previous.text &&
    previousLimitsText === limitsText
  ) {
    console.log(`Pricing snapshot already up to date (${count} models) - nothing written`);
    return;
  }

  const updatedAt =
    previous !== undefined && snapshotWithPreviousTimestamp === previous.text
      ? previous.updatedAt
      : new Date().toISOString();

  const { added, removed, repriced } = summarizeChanges(previous?.models ?? {}, models);
  await writeFile(OUTPUT_PATH, formatSnapshot(models, updatedAt), 'utf8');
  await writeFile(LIMITS_OUTPUT_PATH, limitsText, 'utf8');

  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Wrote ${LIMITS_OUTPUT_PATH}`);
  console.log(`  models: ${count}`);
  console.log(`  skipped (missing input or output price): ${skipped}`);
  console.log(`  changes: ${added} added, ${removed} removed, ${repriced} repriced`);
};

await main();
