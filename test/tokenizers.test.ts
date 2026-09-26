import { getEncoding } from 'js-tiktoken';
import { describe, expect, it } from 'vitest';
import {
  estimateTokensHeuristic,
  isTiktokenModel,
  resolveTiktokenEncoding,
  resolveTokenizer,
} from '../src/tokenizers';

const o200k = getEncoding('o200k_base');
const cl100k = getEncoding('cl100k_base');

describe('tiktoken encoding resolution', () => {
  it('maps modern OpenAI models to o200k_base', () => {
    expect(resolveTiktokenEncoding('gpt-4o')).toBe('o200k_base');
    expect(resolveTiktokenEncoding('gpt-4.1')).toBe('o200k_base');
    expect(resolveTiktokenEncoding('o3-mini')).toBe('o200k_base');
    expect(resolveTiktokenEncoding('gpt-5')).toBe('o200k_base');
  });

  it('maps older OpenAI models to cl100k_base', () => {
    expect(resolveTiktokenEncoding('gpt-4')).toBe('cl100k_base');
    expect(resolveTiktokenEncoding('gpt-3.5-turbo')).toBe('cl100k_base');
    expect(resolveTiktokenEncoding('text-embedding-3-small')).toBe('cl100k_base');
  });

  it('recognises provider-prefixed and fine-tuned ids', () => {
    expect(resolveTiktokenEncoding('azure/gpt-4o')).toBe('o200k_base');
    expect(resolveTiktokenEncoding('openai/gpt-4o-mini')).toBe('o200k_base');
    expect(resolveTiktokenEncoding('openrouter/openai/gpt-4o')).toBe('o200k_base');
    expect(resolveTiktokenEncoding('ft:gpt-4o-2024-08-06')).toBe('o200k_base');
  });

  it('returns undefined for models whose tokenizer is not published', () => {
    for (const model of [
      'claude-sonnet-4-5',
      'claude-3-5-haiku-20241022',
      'gemini-2.5-pro',
      'llama-3.3-70b-versatile',
      'mistral-large-latest',
      'totally-made-up-model',
      '',
    ]) {
      expect(resolveTiktokenEncoding(model), model).toBeUndefined();
    }
  });
});

describe('resolveTokenizer', () => {
  it('selects the exact tokenizer for OpenAI models', () => {
    const tokenizer = resolveTokenizer('gpt-4o');
    expect(tokenizer.kind).toBe('tiktoken');
    expect(tokenizer.encoding).toBe('o200k_base');
  });

  it('falls back to the heuristic for everything else', () => {
    const tokenizer = resolveTokenizer('claude-sonnet-4-5');
    expect(tokenizer.kind).toBe('heuristic');
    expect(tokenizer.encoding).toBeUndefined();
  });

  it('counts exactly like tiktoken on the exact path', () => {
    for (const text of ['', ' ', 'hello', 'Hello world', 'tokenization is hard', 'x'.repeat(100)]) {
      expect(resolveTokenizer('gpt-4o').countTokens(text), JSON.stringify(text)).toBe(
        o200k.encode(text).length,
      );
    }
  });

  it('agrees with isTiktokenModel', () => {
    expect(isTiktokenModel('gpt-4o')).toBe(true);
    expect(isTiktokenModel('claude-sonnet-4-5')).toBe(false);
  });
});

describe('estimateTokensHeuristic', () => {
  it('returns 0 for empty input, matching tiktoken', () => {
    expect(estimateTokensHeuristic('')).toBe(0);
  });

  it('never returns less than 1 for non-empty input', () => {
    for (const text of [' ', 'a', 'ok', '\n', '  \t  ']) {
      expect(estimateTokensHeuristic(text), JSON.stringify(text)).toBeGreaterThanOrEqual(1);
    }
  });

  it('is monotonic in text length', () => {
    const base = 'The quick brown fox jumps over the lazy dog. ';
    let previous = 0;
    for (let i = 1; i <= 10; i += 1) {
      const count = estimateTokensHeuristic(base.repeat(i));
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });

  it('stays close to tiktoken on short inputs, where the blend is weakest', () => {
    // Exact agreement is not the goal: the blend intentionally leans high on
    // short text. Assert it stays within one token of the exact count.
    for (const text of ['hello', 'Hello world', 'ok', 'a', ' ']) {
      const truth = o200k.encode(text).length;
      expect(Math.abs(estimateTokensHeuristic(text) - truth), JSON.stringify(text)).toBeLessThanOrEqual(1);
    }
  });

  it('corrects for CJK, which chars/4 badly undercounts', () => {
    const chinese = '人工智能正在改变世界。我们需要估算令牌的 Token 成本。';
    const truth = o200k.encode(chinese).length;

    expect(estimateTokensHeuristic(chinese)).toBeGreaterThan(Math.ceil(chinese.length / 4));
    expect(Math.abs(estimateTokensHeuristic(chinese) - truth) / truth).toBeLessThan(0.35);
  });

  it('stays within documented tolerance on realistic prose', () => {
    const prose =
      'Estimating token cost is deceptively hard. Tokenizers are not interchangeable: ' +
      'OpenAI uses byte pair encoding over a ranked vocabulary, Anthropic uses its own ' +
      'tokenizer, and Google uses SentencePiece. The honest approach is to know which ' +
      'estimator produced a number and expose that provenance to the caller.';

    const truth = o200k.encode(prose).length;
    const estimate = estimateTokensHeuristic(prose);
    expect(Math.abs(estimate - truth) / truth).toBeLessThan(0.3);
  });

  it('overestimates short word-dense English, as documented', () => {
    // Known weak spot: 64 characters but only 10 tokens, so the character ratio
    // overestimates. Pinned so a future retune does not silently regress here.
    const text = 'A paragraph of ordinary English prose written for testing purposes. '.repeat(4);
    const truth = o200k.encode(text).length;

    expect(truth).toBe(45);
    expect(estimateTokensHeuristic(text)).toBeGreaterThan(truth);
    expect(Math.abs(estimateTokensHeuristic(text) - truth) / truth).toBeLessThan(0.45);
  });

  it('regression-guard: aggregate error stays under 20% across a mixed corpus', () => {
    const corpus = [
      'Estimating token cost is deceptively hard, and a library that claims a single ' +
        'universal rule will be wrong somewhere without admitting it.',
      'export const estimateCost = ({ model, inputText }: Input): Result => ({ model, inputText });',
      '{"model":"gpt-4o","messages":[{"role":"user","content":"Summarize this."}],"temperature":0.7}',
      '# Title\n\nSome **bold** text.\n\n- one\n- two\n\n[link](https://example.com)',
      '人工智能正在改变世界。我们需要估算令牌的 Token 成本。',
      'Быстрая лиса перепрыгивает через ленивую собаку.',
      'Ship it 🚀🎉 done ✅ 100% complete ✨',
    ];

    let totalTruth = 0;
    let totalEstimate = 0;
    for (const text of corpus) {
      totalTruth += o200k.encode(text).length;
      totalEstimate += estimateTokensHeuristic(text);
    }

    expect(Math.abs(totalEstimate - totalTruth) / totalTruth).toBeLessThan(0.2);
  });

  it('produces identical counts across calls', () => {
    const text = 'deterministic output is required for budgeting';
    expect(estimateTokensHeuristic(text)).toBe(estimateTokensHeuristic(text));
  });
});

describe('heuristic vs exact across encodings', () => {
  it('tracks cl100k_base as well as o200k_base', () => {
    const text = 'A paragraph of ordinary English prose written for testing purposes. '.repeat(4);
    for (const [name, encoder] of [
      ['o200k_base', o200k],
      ['cl100k_base', cl100k],
    ] as const) {
      const truth = encoder.encode(text).length;
      const error = Math.abs(estimateTokensHeuristic(text) - truth) / truth;
      // Short word-dense text is the documented weak spot (~40% error).
      expect(error, name).toBeLessThan(0.5);
    }
  });
});
