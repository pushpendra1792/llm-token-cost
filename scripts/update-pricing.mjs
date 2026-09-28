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
 * normalizer's contract, so the two cannot silently drift apart.
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

const RESERVED_KEYS = new Set(['sample_spec', 'keys', 'version']);
const TOKENS_PER_UNIT = { per_token: 1, per_1k: 1_000, per_1m: 1_000_000 };

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

const normalizeEntry = (raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const input = readPrice(raw, 'input');
  const output = readPrice(raw, 'output');
  if (input === undefined || output === undefined) return undefined;
  const provider = typeof raw.litellm_provider === 'string' ? raw.litellm_provider : undefined;
  return provider === undefined ? { input, output } : { input, output, provider };
};

const formatSnapshot = (models, updatedAt) => {
  const lines = Object.keys(models)
    .sort()
    .map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(models[key])}`);
  return [
    '{',
    '  "schemaVersion": 1,',
    `  "updatedAt": ${JSON.stringify(updatedAt)},`,
    `  "source": ${JSON.stringify(LITELLM_PRICING_URL)},`,
    '  "currency": "USD",',
    '  "unit": "per_token",',
    '  "models": {',
    lines.join(',\n'),
    '  }',
    '}',
    '',
  ].join('\n');
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
  let skipped = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED_KEYS.has(key)) continue;
    const pricing = normalizeEntry(value);
    if (pricing === undefined) {
      skipped += 1;
      continue;
    }
    models[key] = pricing;
  }

  const count = Object.keys(models).length;
  const previous = await readPrevious();

  // Render with the previous timestamp first. Matching the committed file byte
  // for byte proves the upstream data is unchanged, so nothing is written and
  // the scheduled workflow has no diff to open a pull request from.
  if (previous && formatSnapshot(models, previous.updatedAt) === previous.text) {
    console.log(`Pricing snapshot already up to date (${count} models) - nothing written`);
    return;
  }

  const { added, removed, repriced } = summarizeChanges(previous?.models ?? {}, models);
  await writeFile(OUTPUT_PATH, formatSnapshot(models, new Date().toISOString()), 'utf8');

  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`  models: ${count}`);
  console.log(`  skipped (missing input or output price): ${skipped}`);
  console.log(`  changes: ${added} added, ${removed} removed, ${repriced} repriced`);
};

await main();
