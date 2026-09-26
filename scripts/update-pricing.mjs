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
 */
import { writeFile } from 'node:fs/promises';
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

const formatSnapshot = (models) => {
  const lines = Object.keys(models)
    .sort()
    .map((key) => `    ${JSON.stringify(key)}: ${JSON.stringify(models[key])}`);
  return [
    '{',
    '  "schemaVersion": 1,',
    `  "updatedAt": ${JSON.stringify(new Date().toISOString())},`,
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

  await writeFile(OUTPUT_PATH, formatSnapshot(models), 'utf8');

  const count = Object.keys(models).length;
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`  models: ${count}`);
  console.log(`  skipped (missing input or output price): ${skipped}`);
};

await main();
