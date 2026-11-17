import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeModelEntry } from '../src/pricing/normalize';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Unit tests for long-context tier extraction in normalizeModelEntry.
 *
 * These use small hand-written fixtures rather than the bundled snapshot so a
 * regression in the parser fails here even if the snapshot was refreshed from
 * an older copy of the code.
 */

describe('normalizeModelEntry: flat above-threshold fields', () => {
  it('parses a gemini-2.5-pro style entry and ignores priority/batches/audio variants', () => {
    const pricing = normalizeModelEntry({
      input_cost_per_token: 1.25e-6,
      output_cost_per_token: 1e-5,
      input_cost_per_token_above_200k_tokens: 2.5e-6,
      output_cost_per_token_above_200k_tokens: 1.5e-5,
      cache_read_input_token_cost_above_200k_tokens: 2.5e-7,
      // Noise: service-tier and audio variants must be ignored.
      input_cost_per_token_above_200k_tokens_priority: 4.5e-6,
      input_cost_per_token_above_200k_tokens_batches: 1.25e-6,
      input_cost_per_audio_token_above_200k_tokens: 3e-7,
    });

    expect(pricing).toBeDefined();
    expect(pricing?.tiers).toHaveLength(1);

    const tier = pricing?.tiers?.[0];
    expect(tier?.aboveInputTokens).toBe(200000);
    expect(tier?.input).toBe(2.5e-6);
    expect(tier?.output).toBe(1.5e-5);
    expect(tier?.cacheReadInput).toBe(2.5e-7);
    // Fields with no above-threshold variant stay undefined.
    expect(tier?.cacheCreationInput).toBeUndefined();
    expect(tier?.outputReasoning).toBeUndefined();
  });
});

describe('normalizeModelEntry: tiered_pricing arrays', () => {
  it('does not emit the range that starts at 0 as a tier', () => {
    const pricing = normalizeModelEntry({
      input_cost_per_token: 3e-6,
      output_cost_per_token: 1.5e-5,
      tiered_pricing: [
        { range: [0, 200000], input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
        { range: [200000, 1000000], input_cost_per_token: 6e-6, output_cost_per_token: 2.25e-5 },
      ],
    });

    expect(pricing?.tiers).toHaveLength(1);
    expect(pricing?.tiers?.[0]?.aboveInputTokens).toBe(200000);
    expect(pricing?.tiers?.[0]?.input).toBe(6e-6);
    expect(pricing?.tiers?.[0]?.output).toBe(2.25e-5);
  });
});

describe('normalizeModelEntry: missing tier sides', () => {
  it('falls back to the model base output price when only input is above a threshold', () => {
    const pricing = normalizeModelEntry({
      input_cost_per_token: 2e-6,
      output_cost_per_token: 8e-6,
      input_cost_per_token_above_200k_tokens: 4e-6,
    });

    expect(pricing?.tiers).toHaveLength(1);
    const tier = pricing?.tiers?.[0];
    expect(tier?.aboveInputTokens).toBe(200000);
    expect(tier?.input).toBe(4e-6);
    // Base output price is used because no output side was provided.
    expect(tier?.output).toBe(8e-6);
  });
});

describe('normalizeModelEntry: no tiers', () => {
  it('omits the tiers key entirely when no tier data exists', () => {
    const pricing = normalizeModelEntry({
      input_cost_per_token: 1e-6,
      output_cost_per_token: 4e-6,
    });

    expect(pricing).toBeDefined();
    expect(pricing && 'tiers' in pricing ? pricing.tiers : undefined).toBeUndefined();
  });
});

describe('normalizeModelEntry: warnings', () => {
  it('never writes to the console and reports fallbacks through onWarn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const fixture = {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 8e-6,
      input_cost_per_token_above_200k_tokens: 4e-6,
    };

    // Without onWarn, normalization is completely silent.
    normalizeModelEntry(fixture);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    // With onWarn, the fallback is reported through the callback instead.
    const messages: string[] = [];
    const pricing = normalizeModelEntry(fixture, (message) => messages.push(message));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('no output price above 200000 tokens');
    expect(pricing?.tiers?.[0]?.output).toBe(8e-6);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
