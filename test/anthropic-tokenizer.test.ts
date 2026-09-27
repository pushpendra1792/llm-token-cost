import { getEncoding } from 'js-tiktoken';
import { describe, expect, it } from 'vitest';
import {
  anthropicTokenRatio,
  anthropicTokenizerGeneration,
  estimateTokensAnthropic,
  isAnthropicModel,
  resolveTokenizer,
} from '../src/tokenizers';
import { estimateTokensHeuristic } from '../src/tokenizers/heuristic';
import { getBundledSnapshot } from '../src/pricing/fetch';

const o200k = getEncoding('o200k_base');

describe('isAnthropicModel', () => {
  it('detects canonical Anthropic ids', () => {
    for (const model of [
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-haiku-4-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-fable-5-1',
      'claude-mythos-5',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus',
      'claude-instant-v1',
      'claude-v2:1',
    ]) {
      expect(isAnthropicModel(model), model).toBe(true);
    }
  });

  it('detects every gateway and cloud prefix seen in the bundled snapshot', () => {
    // Provider-based detection would miss these: only 20 of the 329 Claude
    // entries in the snapshot report provider "anthropic".
    for (const model of [
      'us.anthropic.claude-opus-4-5-20251101-v1:0',
      'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'apac.anthropic.claude-opus-5-5',
      'global.anthropic.claude-fable-5-1',
      'us-gov.anthropic.claude-sonnet-5',
      'anthropic.claude-v2:1',
      'vertex_ai/claude-sonnet-4-5@20250929',
      'vertex_ai/claude-opus-5-5@default',
      'azure_ai/claude-fable-5-1',
      'openrouter/anthropic/claude-opus-4.5',
      'databricks/databricks-claude-opus-4-5',
      'replicate/anthropic/claude-4.5-sonnet',
      'gmi/anthropic/claude-opus-4.5',
      'perplexity/anthropic/claude-fable-5',
      'deepinfra/anthropic/claude-4-sonnet',
      'snowflake/claude-3-7-sonnet',
      'vercel_ai_gateway/anthropic/claude-3.5-sonnet',
      'gradient_ai/anthropic-claude-3.5-haiku',
      'aihubmix/claude-opus-4-8-think',
    ]) {
      expect(isAnthropicModel(model), model).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isAnthropicModel('Claude-Sonnet-4-5')).toBe(true);
    expect(isAnthropicModel('ANTHROPIC.CLAUDE-V2:1')).toBe(true);
  });

  it('does not claim non-Anthropic models', () => {
    for (const model of [
      'gpt-4o',
      'gemini-2.5-pro',
      'llama-3.3-70b-versatile',
      'mistral-large-latest',
      'deepseek-chat',
      '',
    ]) {
      expect(isAnthropicModel(model), model).toBe(false);
    }
  });

  it('classifies every Claude entry in the bundled snapshot', () => {
    // The real guard against a naming form being missed: sweep the actual data
    // rather than a hand-picked list that could drift from it.
    const { models } = getBundledSnapshot();
    const claudeKeys = Object.keys(models).filter((key) => /claude/i.test(key));
    expect(claudeKeys.length).toBeGreaterThan(300);

    const missed = claudeKeys.filter((key) => !isAnthropicModel(key));
    expect(missed).toEqual([]);
  });
});

describe('anthropicTokenizerGeneration', () => {
  it('treats everything before Claude Opus 4.7 as the older tokenizer', () => {
    for (const model of [
      'claude-v1',
      'claude-instant-v1',
      'claude-2.1',
      'claude-3-opus',
      'claude-3-5-sonnet-20241022',
      'claude-3-7-sonnet-20250219',
      'claude-sonnet-4-20250514',
      'claude-opus-4',
      'claude-opus-4-1',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-opus-4-5',
      'claude-opus-4-6',
      'us.anthropic.claude-opus-4-6-v1',
      'openrouter/anthropic/claude-opus-4.6',
    ]) {
      expect(anthropicTokenizerGeneration(model), model).toBe('legacy');
    }
  });

  it('treats Claude Opus 4.7 and later as the newer tokenizer', () => {
    for (const model of [
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-mythos-5',
      'claude-mythos-5-1',
      'us.anthropic.claude-opus-4-7',
      'vertex_ai/claude-opus-5-5@default',
    ]) {
      expect(anthropicTokenizerGeneration(model), model).toBe('current');
    }
  });

  it('treats Claude Mythos Preview as the newer tokenizer despite having no version', () => {
    // Anthropic calls Mythos Preview out separately from the "4.7 and later"
    // rule, and it carries no digits, so the numeric boundary cannot see it.
    for (const model of [
      'claude-mythos-preview',
      'us.anthropic.claude-mythos-preview',
      'apac.anthropic.claude-mythos-preview',
    ]) {
      expect(anthropicTokenizerGeneration(model), model).toBe('current');
    }
  });

  it('reads dotted gateway versions the same as canonical dashed ones', () => {
    expect(anthropicTokenizerGeneration('claude-opus-4.5')).toBe(
      anthropicTokenizerGeneration('claude-opus-4-5'),
    );
    expect(anthropicTokenizerGeneration('claude-opus-4.6')).toBe('legacy');
    expect(anthropicTokenizerGeneration('claude-opus-4.7')).toBe('current');
    expect(anthropicTokenizerGeneration('replicate/anthropic/claude-4.5-sonnet')).toBe('legacy');
  });

  it('does not mistake a release date for a minor version', () => {
    // Regression: an unbounded minor group read the 8-digit date as the minor
    // version, so `minor >= 7` fired and these were classified as the newer
    // tokenizer, inflating their counts by ~30%.
    for (const model of [
      'claude-sonnet-4-20250514',
      'anthropic.claude-sonnet-4-20250514-v1:0',
      'us.anthropic.claude-opus-4-20250514-v1:0',
    ]) {
      expect(anthropicTokenizerGeneration(model), model).toBe('legacy');
    }
    // The same shape with a genuine two-digit minor version still upgrades.
    expect(anthropicTokenizerGeneration('claude-opus-4-7-20260416')).toBe('current');
  });

  it('does not let a trailing date or suffix change the generation', () => {
    expect(anthropicTokenizerGeneration('claude-sonnet-4-5-20250929')).toBe('legacy');
    expect(anthropicTokenizerGeneration('claude-sonnet-5-20260101')).toBe('current');
    expect(anthropicTokenizerGeneration('claude-opus-4-6-think')).toBe('legacy');
    expect(anthropicTokenizerGeneration('claude-opus-4-8-think')).toBe('current');
  });

  it('defaults to legacy when no version can be parsed', () => {
    // Under-applying the correction is the safer failure: it under-counts rather
    // than inflating a price for a model that may predate the tokenizer change.
    expect(anthropicTokenizerGeneration('claude')).toBe('legacy');
    expect(anthropicTokenizerGeneration('claude-instant')).toBe('legacy');
    expect(anthropicTokenizerGeneration('claude-next')).toBe('legacy');
  });
});

describe('anthropicTokenRatio', () => {
  it('applies 1.2x to the older tokenizer and 1.56x to the newer one', () => {
    expect(anthropicTokenRatio('claude-sonnet-4-5')).toBeCloseTo(1.2, 5);
    // 1.2 (tiktoken undercount band) * 1.3 (newer tokenizer yields ~30% more)
    expect(anthropicTokenRatio('claude-opus-4-7')).toBeCloseTo(1.56, 5);
  });

  it('is monotonically higher for the newer tokenizer', () => {
    for (const old of ['claude-3-5-sonnet', 'claude-opus-4-5', 'claude-opus-4-6']) {
      for (const current of ['claude-opus-4-7', 'claude-opus-5-5', 'claude-sonnet-5']) {
        expect(anthropicTokenRatio(current), `${old} vs ${current}`).toBeGreaterThan(
          anthropicTokenRatio(old),
        );
      }
    }
  });
});

describe('estimateTokensAnthropic', () => {
  it('returns 0 for empty input, matching tiktoken', () => {
    expect(estimateTokensAnthropic('claude-sonnet-4-5', '')).toBe(0);
  });

  it('is strictly greater than the generic heuristic for the same text', () => {
    // Proves the correction is actually applied rather than the generic path
    // being returned unchanged.
    const text = 'Estimating token cost is deceptively hard for closed models.';
    expect(estimateTokensAnthropic('claude-sonnet-4-5', text)).toBeGreaterThan(
      estimateTokensHeuristic(text),
    );
  });

  it('orders current generation above legacy generation on identical text', () => {
    const text = 'A paragraph of ordinary English prose written for testing purposes. '.repeat(4);
    expect(estimateTokensAnthropic('claude-opus-5-5', text)).toBeGreaterThan(
      estimateTokensAnthropic('claude-opus-4-5', text),
    );
  });

  it('is deterministic', () => {
    const text = 'deterministic output is required for budgeting';
    expect(estimateTokensAnthropic('claude-opus-5-5', text)).toBe(
      estimateTokensAnthropic('claude-opus-5-5', text),
    );
  });

  it('lands near the one published Anthropic ground truth', () => {
    // Anthropic's token-counting docs report input_tokens: 14 for a system
    // prompt "You are a scientist" plus the user message "Hello, Claude" on
    // claude-opus-5-5. That figure also counts message framing and special
    // tokens, which this library does not model, so the content-only estimate
    // should land at or just below it rather than far under it.
    const text = 'You are a scientist\nHello, Claude';
    const estimate = estimateTokensAnthropic('claude-opus-5-5', text);

    expect(estimate).toBeGreaterThanOrEqual(13);
    expect(estimate).toBeLessThanOrEqual(16);
  });

  it('does not claim to be more accurate than tiktoken is on Claude', () => {
    // Guard against a regression that would scale counts without bound: the
    // correction is bounded, so it must stay within a sane band of tiktoken.
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
    const truth = o200k.encode(text).length;
    const legacy = estimateTokensAnthropic('claude-sonnet-4-5', text);
    const current = estimateTokensAnthropic('claude-opus-5-5', text);

    expect(legacy / truth).toBeGreaterThan(0.9);
    expect(legacy / truth).toBeLessThan(2.2);
    expect(current / truth).toBeGreaterThan(legacy / truth);
    expect(current / truth).toBeLessThan(2.6);
  });
});

describe('dispatch wiring', () => {
  it('routes Claude models to the Anthropic path with the right generation', () => {
    for (const [model, generation] of [
      ['claude-sonnet-4-5', 'legacy'],
      ['us.anthropic.claude-opus-4-5-20251101-v1:0', 'legacy'],
      ['claude-opus-4-7', 'current'],
      ['claude-opus-5-5', 'current'],
      ['vertex_ai/claude-sonnet-4-5@20250929', 'legacy'],
    ] as const) {
      const tokenizer = resolveTokenizer(model);
      expect(tokenizer.kind, model).toBe('anthropic-heuristic');
      expect(tokenizer.anthropicGeneration, model).toBe(generation);
    }
  });

  it('counts through the Anthropic path, not the generic fallback', () => {
    // The masking-bug guard: assert the produced count is the Anthropic
    // estimate, so a dispatch that silently returned the generic heuristic
    // would fail here even though `kind` assertions alone might pass.
    const text = 'A paragraph of ordinary English prose written for testing purposes. '.repeat(4);
    for (const model of ['claude-sonnet-4-5', 'claude-opus-4-6', 'claude-opus-5-5']) {
      expect(resolveTokenizer(model).countTokens(text), model).toBe(
        estimateTokensAnthropic(model, text),
      );
      expect(resolveTokenizer(model).countTokens(text), model).not.toBe(
        estimateTokensHeuristic(text),
      );
    }
  });

  it('gives Claude counts that differ from exact OpenAI counts', () => {
    // If these ever matched exactly it would mean the Anthropic correction is
    // not wired in, since the two tokenizers genuinely differ.
    const text = 'A paragraph of ordinary English prose written for testing purposes. '.repeat(4);
    expect(resolveTokenizer('claude-opus-5-5').countTokens(text)).not.toBe(
      o200k.encode(text).length,
    );
  });

  it('classifies every Claude snapshot entry onto the Anthropic path', () => {
    const { models } = getBundledSnapshot();
    const claudeKeys = Object.keys(models).filter((key) => /claude/i.test(key));

    const misrouted = claudeKeys.filter((key) => resolveTokenizer(key).kind !== 'anthropic-heuristic');
    expect(misrouted).toEqual([]);
  });

  it('gives every Claude snapshot entry a parseable generation', () => {
    const { models } = getBundledSnapshot();
    const claudeKeys = Object.keys(models).filter((key) => /claude/i.test(key));

    const unlabelled = claudeKeys.filter(
      (key) => resolveTokenizer(key).anthropicGeneration === undefined,
    );
    expect(unlabelled).toEqual([]);
  });

  it('agrees with an independent implementation of the boundary rule', () => {
    // Sweep real ids and compare against a separately written parser, so a change
    // to the source regex that moves the 4.7 boundary fails here instead of
    // silently re-pricing every affected model.
    const { models } = getBundledSnapshot();
    const claudeKeys = Object.keys(models).filter((key) => /claude/i.test(key));

    const mismatched = claudeKeys.filter((key) => {
      const expected = expectedGeneration(key);
      return expected !== undefined && resolveTokenizer(key).anthropicGeneration !== expected;
    });
    expect(mismatched).toEqual([]);
  });
});

/**
 * Independent restatement of the generation rule, used to cross-check the
 * implementation. Written by scanning characters rather than with the one large
 * pattern under test, so the two can disagree.
 *
 * Scope: this pins current behaviour across every real Claude id so a later
 * edit to the source regex cannot quietly move the boundary without also
 * updating this. It is not a substitute for the hand-written table above, which
 * is what actually caught the date-parsing bug.
 */
function expectedGeneration(model: string): 'legacy' | 'current' | undefined {
  const lower = model.toLowerCase();
  if (lower.includes('mythos-preview') || lower.includes('mythos.preview')) return 'current';

  const claudeAt = lower.indexOf('claude');
  if (claudeAt === -1) return undefined;

  let rest = lower.slice(claudeAt + 'claude'.length);
  if (rest.startsWith('-') || rest.startsWith('.')) rest = rest.slice(1);

  for (const family of ['opus', 'sonnet', 'haiku', 'fable', 'mythos', 'instant']) {
    if (rest.startsWith(family)) {
      rest = rest.slice(family.length);
      if (rest.startsWith('-') || rest.startsWith('.')) rest = rest.slice(1);
      break;
    }
  }
  if (rest.startsWith('v')) rest = rest.slice(1);

  let digits = 0;
  while (digits < rest.length && rest[digits]! >= '0' && rest[digits]! <= '9') digits += 1;
  if (digits === 0) return undefined;

  const major = Number(rest.slice(0, digits));

  // A minor version is one or two digits that are not part of a longer number,
  // which is what keeps an 8-digit release date from reading as the minor.
  let minor = 0;
  const tail = rest.slice(digits);
  const minorMatch = /^[-.](\d{1,2})(\D|$)/.exec(tail);
  if (minorMatch !== null) minor = Number(minorMatch[1]);

  if (major >= 5) return 'current';
  if (major === 4 && minor >= 7) return 'current';
  return 'legacy';
}
