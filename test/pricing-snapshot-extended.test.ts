import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getBundledSnapshot } from '../src/pricing/fetch';

/**
 * The committed snapshot carries optional cache, service-tier and reasoning
 * prices; max input/output limits are split into limits.json to keep the main
 * snapshot small. These checks extend the pre-existing "well-formed per-token
 * entries" test without modifying it: every optional field must be a finite,
 * non-negative number when present, and no audio/image-only field may have
 * leaked into the snapshot.
 */

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
] as const;

const ALLOWED_KEYS = new Set<string>([...NUMERIC_FIELDS, 'provider']);

interface ModelLimits {
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

const limits = JSON.parse(
  readFileSync(new URL('../src/pricing/limits.json', import.meta.url), 'utf8'),
) as Record<string, ModelLimits>;

describe('bundled snapshot extended fields', () => {
  const snapshot = getBundledSnapshot();

  it('has only the supported keys on each model (no audio/image variants)', () => {
    for (const [key, pricing] of Object.entries(snapshot.models)) {
      for (const field of Object.keys(pricing)) {
        expect(ALLOWED_KEYS.has(field), `${key}.${field}`).toBe(true);
      }
      // Context limits live in limits.json, not in the bundled snapshot.
      expect(pricing.maxInputTokens, `${key}.maxInputTokens`).toBeUndefined();
      expect(pricing.maxOutputTokens, `${key}.maxOutputTokens`).toBeUndefined();
    }
  });

  it('stores every present numeric field as a finite, non-negative number', () => {
    for (const [key, pricing] of Object.entries(snapshot.models)) {
      for (const field of NUMERIC_FIELDS) {
        const value = pricing[field];
        if (value === undefined) continue;
        expect(Number.isFinite(value), `${key}.${field}`).toBe(true);
        expect(value, `${key}.${field}`).toBeGreaterThanOrEqual(0);
      }
    }

    for (const [key, entry] of Object.entries(limits)) {
      for (const field of ['maxInputTokens', 'maxOutputTokens'] as const) {
        const value = entry[field];
        if (value === undefined) continue;
        expect(Number.isFinite(value), `${key}.${field}`).toBe(true);
        expect(value, `${key}.${field}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('carries the new prices for well-known models', () => {
    const gpt4o = snapshot.models['gpt-4o'];
    expect(gpt4o?.cacheReadInput).toBe(0.00000125);
    expect(gpt4o?.inputBatch).toBe(0.00000125);
    expect(limits['gpt-4o']?.maxInputTokens).toBe(128000);
    expect(limits['gpt-4o']?.maxOutputTokens).toBe(16384);

    const claude = snapshot.models['claude-sonnet-4-5'];
    expect(claude?.cacheReadInput).toBe(3e-7);
    expect(claude?.cacheCreationInput).toBe(0.00000375);
    expect(claude?.cacheCreationInputAbove1hr).toBe(0.000006);

    const gemini = snapshot.models['gemini-2.5-flash'];
    expect(gemini?.outputReasoning).toBe(0.0000025);
  });
});
