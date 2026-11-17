#!/usr/bin/env node
/**
 * Regenerates src/pricing/snapshot.json from the LiteLLM pricing feed.
 *
 * Usage: npm run update:pricing   (runs npm run build first)
 *
 * The normalization itself lives in `src/pricing/normalize.ts` and is consumed
 * here from the built `dist/normalize.js`, so the refresh script and the
 * library share exactly one implementation. `tsup.config.ts` has a dedicated
 * entry for it; it is not part of the published package.
 *
 * The output is formatted one model per line on purpose: the scheduled
 * update-pricing workflow opens a pull request, and this layout keeps the diff
 * to only the models that actually changed.
 *
 * The output is byte-stable across runs. Model keys are sorted and prices go
 * through `JSON.stringify`, so the metadata timestamps are the only fields that
 * could otherwise drift. `updatedAt` is written as "when the data last
 * changed" rather than "when this script last ran", and `generatedAt` follows
 * the model payload only. The file is first rendered with the previous
 * metadata, and only if that does not reproduce the committed file byte for
 * byte is a fresh timestamp substituted. Re-running against unchanged upstream
 * data therefore leaves the working tree clean, which is what lets the
 * scheduled workflow exit without opening a no-op pull request.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeModelEntry } from '../dist/normalize.js';
import {
  LITELLM_PRICING_URL,
  formatLimits,
  planSnapshotUpdate,
} from './pricing-snapshot.mjs';

const OUTPUT_PATH = fileURLToPath(new URL('../src/pricing/snapshot.json', import.meta.url));
const LIMITS_OUTPUT_PATH = fileURLToPath(new URL('../src/pricing/limits.json', import.meta.url));

const RESERVED_KEYS = new Set(['sample_spec', 'keys', 'version']);

/** Modes that are chat/completion style and should be included in the snapshot. */
const CHAT_MODES = new Set(['chat', 'completion', 'responses']);

/** Reads a non-negative finite number, or undefined. */
const readNumber = (entry, field) => {
  const value = entry[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
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
    ...(typeof parsed.generatedAt === 'string' ? { generatedAt: parsed.generatedAt } : {}),
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

/** Fails the run rather than committing a malformed table. */
const assertWellFormed = (models) => {
  for (const [key, pricing] of Object.entries(models)) {
    if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing)) {
      throw new Error(`Malformed pricing entry for ${key}: expected an object`);
    }
    for (const field of ['input', 'output']) {
      const value = pricing[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`Malformed pricing for ${key}.${field}: ${String(value)}`);
      }
    }
    if (pricing.tiers !== undefined) {
      if (!Array.isArray(pricing.tiers)) {
        throw new Error(`Malformed tiers for ${key}: expected an array`);
      }
      for (const tier of pricing.tiers) {
        if (typeof tier.aboveInputTokens !== 'number' || tier.aboveInputTokens <= 0) {
          throw new Error(`Malformed tier threshold for ${key}: ${String(tier.aboveInputTokens)}`);
        }
        for (const field of ['input', 'output']) {
          const value = tier[field];
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
            throw new Error(`Malformed tier ${field} for ${key} above ${tier.aboveInputTokens}`);
          }
        }
      }
    }
  }
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
  let tiered = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED_KEYS.has(key)) continue;
    // The snapshot is deliberately limited to chat/completion models so it
    // stays small; audio/image/embedding-only entries are left out.
    if (typeof value?.mode !== 'string' || !CHAT_MODES.has(value.mode)) continue;

    // The one and only normalizer, shared with the library. This script is the
    // one caller that opts into normalization notes so they show up in CI logs.
    const pricing = normalizeModelEntry(value, (message) => console.warn(message));
    if (pricing === undefined) {
      skipped += 1;
      continue;
    }

    // Context limits live in limits.json, not in the bundled snapshot, to keep
    // it small. Split them out before writing the model entry.
    const {
      maxInputTokens: normalizedMaxInput,
      maxOutputTokens: normalizedMaxOutput,
      ...snapshotPricing
    } = pricing;
    models[key] = snapshotPricing;
    if (snapshotPricing.tiers !== undefined && snapshotPricing.tiers.length > 0) tiered += 1;

    const maxInputTokens = normalizedMaxInput ?? readNumber(value, 'max_input_tokens');
    const maxOutputTokens = normalizedMaxOutput ?? readNumber(value, 'max_output_tokens');
    if (maxInputTokens !== undefined || maxOutputTokens !== undefined) {
      const entry = {};
      if (maxInputTokens !== undefined) entry.maxInputTokens = maxInputTokens;
      if (maxOutputTokens !== undefined) entry.maxOutputTokens = maxOutputTokens;
      limits[key] = entry;
    }
  }

  assertWellFormed(models);
  assertLimitsWellFormed(limits);

  const count = Object.keys(models).length;
  const previous = await readPrevious();
  const previousLimitsText = await readPreviousLimits();
  const limitsText = formatLimits(limits);

  // Re-render with the previous metadata first. Matching the committed files
  // byte for byte proves the upstream data is unchanged, so nothing is written
  // and the scheduled workflow has no diff to open a pull request from.
  const plan = planSnapshotUpdate({
    ...(previous === undefined ? {} : { previous }),
    models,
    now: new Date(),
  });
  const limitsChanged = previousLimitsText !== limitsText;

  if (!plan.changed && !limitsChanged) {
    console.log(`Pricing snapshot already up to date (${count} models, ${tiered} tiered) - nothing written`);
    return;
  }

  const { added, removed, repriced } = summarizeChanges(previous?.models ?? {}, models);
  if (plan.changed) await writeFile(OUTPUT_PATH, plan.text, 'utf8');
  if (limitsChanged) await writeFile(LIMITS_OUTPUT_PATH, limitsText, 'utf8');

  if (plan.changed) console.log(`Wrote ${OUTPUT_PATH}`);
  if (limitsChanged) console.log(`Wrote ${LIMITS_OUTPUT_PATH}`);
  console.log(`  models: ${count}`);
  console.log(`  tiered: ${tiered}`);
  console.log(`  skipped (missing input or output price): ${skipped}`);
  console.log(`  changes: ${added} added, ${removed} removed, ${repriced} repriced`);
  console.log(`  generatedAt: ${plan.generatedAt}`);
};

await main();
