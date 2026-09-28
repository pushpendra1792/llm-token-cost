# Tokenizer benchmark

How accurate is the heuristic tokenizer, honestly stated, and how to re-derive
the numbers.

**Scope: this document covers the heuristic tokenizer only.** It compares the
blend in `src/tokenizers/heuristic.ts` against exact `o200k_base` counts, plus
the two naive baselines it replaces. It does **not** compare against real
provider-reported usage; that comparison is measured separately by the
maintainer and is not included here. No provider API is called to produce
anything in this document.

## What is being measured

`estimateCost` needs a token count before the request is sent. For OpenAI models
it gets an exact one from `js-tiktoken`. For every other provider it falls back
to a character/word/CJK blend, and that blend is what this document is about.

The blend is calibrated against `o200k_base` as a stand-in for "a real BPE
tokenizer". That is a deliberate proxy: Anthropic and Google do not publish
their tokenizers, so there is no ground truth for them to calibrate against. See
[Known weak spots](#known-weak-spots) for what that costs you.

## Corpus

A 90-sample corpus, roughly 4.4k tokens in total:

| Category | Notes |
| --- | --- |
| Long prose | Multi-paragraph English text |
| Short sentences | One-line inputs |
| Short-word prose | Dense word-per-character English |
| TypeScript | Source with identifiers and punctuation |
| Python | Source with indentation |
| JSON | Serialized objects, nested |
| Markdown | Headings, lists, emphasis |
| CJK | Han, kana, Hangul |
| Cyrillic | Non-Latin European script |
| Arabic | Right-to-left script |
| Emoji | Multi-codepoint sequences |

Ground truth is the exact `o200k_base` count for each sample.

## Results

Percentage error against `o200k_base`. Bias is signed; MAPE, p95 and worst are
magnitudes, so they are the same in both directions.

| Metric | Blend | `chars / 4` | `words × 1.3` |
| --- | --- | --- | --- |
| Aggregate bias | **-0.2%** | +4.8% | -23.5% |
| MAPE | **24%** | 20% | 41% |
| p95 | **43%** | 63% | 92% |
| Worst case | **44%** | not recorded | not recorded |

Metric definitions:

- **Aggregate bias** — `(sum(estimated) - sum(actual)) / sum(actual)`. Errors
  that cancel across the corpus are visible here and nowhere else.
- **MAPE** — mean absolute percentage error, `mean(|est - actual| / actual)`.
- **p95** — the 95th percentile of the per-sample absolute percentage error.
- **Worst case** — the maximum per-sample absolute percentage error. Recorded
  for the blend only; the baselines were not run to their extremes.

Read the table this way: **aggregate cost is accurate, individual documents are
not.** A single estimate can be off by up to ~44%, in either direction. The
blend's job is to make a total land in the right place, not to make every
document land within a few percent.

Note that `chars / 4` has a *slightly better* MAPE (20% vs 24%) and much worse
p95 (63% vs 43%). That is the trade the blend makes deliberately: a flatter
distribution of smaller errors beats a lower average error with a long tail. If
your use case punishes large single-document misses more than it rewards
occasional small ones, the folklore rule is defensible and this is the wrong
library for you.

## Known weak spots

**Short inputs skew high, always.** This is the blend's main weakness. A 64
character sentence of ordinary English is 10 `o200k_base` tokens, while
`chars / 4` returns 16. Short-input behaviour is the reason p95 sits at 43% even
though aggregate bias is -0.2%.

**`chars / 4` collapses on CJK.** Each ideograph is one JS character but costs
roughly one token or more, so dividing the character count by four undercounts
CJK by 4x or worse. The blend adds an explicit per-CJK-character term
(`TOKENS_PER_CJK_CHAR = 0.6`, in addition to the base character ratio) rather
than relying on a global constant.

**Word-ratio scaling collapses on code.** `words × 1.3` runs -23.5% aggregate
bias and up to 92% error, because code, JSON and URLs pack far more tokens per
word than prose does. This is why the word signal is a stabilizer weighted at
0.25, not the primary estimator.

**Residual bias is slightly negative.** The blend undercounts by ~0.2% in
aggregate. For budget guardrails this matters in the wrong direction: apply your
own safety margin rather than trusting this to fail safe.

**Calibration target is OpenAI's BPE.** Real error on Anthropic and Google models
is unmeasured and plausibly worse. Anthropic publishes guidance that `tiktoken`
undercounts Claude by ~15-20% on typical text; the Anthropic path in this
package applies a provider-level correction factor on top of this blend, which
is a documented ratio rather than a measurement taken here.

**Provider framing is not modelled.** This library models prompt and completion
text only. Tool definitions, which providers bill as input tokens and which are
often large, are not counted.

## Why these constants

A grid search over 500 combinations of the four constants
(`CHARS_PER_TOKEN = 4`, `TOKENS_PER_CJK_CHAR = 0.6`, `TOKENS_PER_WORD = 1.3`,
`CHAR_WEIGHT = 0.75`) found nothing meaningfully better. The best alternative
reached MAPE 23% — one point better — but only by letting aggregate bias drift
to -4.5%. For a library people budget against, a 4.5% systematic undercount is a
bad trade for a 1% MAPE improvement, so the near-zero-bias blend was kept.

## Reproducing the numbers

**The corpus is not checked into this repository.** That is a deliberate gap,
not an oversight: it is a private calibration set, and the pinned part of this
harness is the estimator, not the samples. The figures above come from one run
against that corpus and are not re-derived by CI. Rebuilding the corpus will
give you the same shape of result, not the same digits.

To measure the blend yourself, assemble a corpus in the categories listed above
and run this against it. Everything used here is public API.

```ts
import {
  estimateTokensHeuristic,
  getTiktokenEncoder,
  resolveTiktokenEncoding,
} from 'llm-token-cost';

// Ground truth: exact counts for any model that resolves to a real encoding.
const encoding = resolveTiktokenEncoding('gpt-4o'); // 'o200k_base'
if (encoding === undefined) throw new Error('expected gpt-4o to resolve');
const encoder = getTiktokenEncoder('gpt-4o');
if (encoder === undefined) throw new Error('expected a tiktoken encoder');

const charsPer4 = (text: string): number => Math.ceil(text.length / 4);
const wordsTimes13 = (text: string): number => text.split(/\s+/u).filter(Boolean).length * 1.3;

type Sample = { readonly name: string; readonly text: string };

export const report = (corpus: readonly Sample[]): void => {
  const estimators = {
    blend: (text: string): number => estimateTokensHeuristic(text),
    'chars / 4': charsPer4,
    'words x 1.3': wordsTimes13,
  };

  const results = new Map<string, { err: number[]; est: number; real: number }>(
    Object.keys(estimators).map((name) => [name, { err: [], est: 0, real: 0 }]),
  );

  for (const sample of corpus) {
    const real = encoder.encode(sample.text).length;
    for (const [name, estimate] of Object.entries(estimators)) {
      const est = estimate(sample.text);
      const row = results.get(name)!;
      row.err.push(Math.abs(est - real) / real);
      row.est += est;
      row.real += real;
    }
  }

  for (const [name, { err, est, real }] of results) {
    const sorted = [...err].sort((a, b) => a - b);
    const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    console.log(
      [
        name.padEnd(12),
        `bias ${pct((est - real) / real)}`.padEnd(14),
        `MAPE ${pct(err.reduce((a, b) => a + b, 0) / err.length)}`.padEnd(12),
        `p95 ${pct(at(0.95))}`.padEnd(10),
        `worst ${pct(sorted[sorted.length - 1])}`,
      ].join('  '),
    );
  }
};
```

Two things to watch when you run it:

- Compare in the same units the table uses. `estimateTokensHeuristic` returns an
  integer (`Math.ceil`), the baselines above do not, and the p95 is sensitive to
  that on short samples.
- Exclude empty strings. The blend returns 0 for empty input, which makes
  percentage error undefined.

`estimateTokensHeuristic(text)` is the blend with no provider scaling. The
Anthropic path calls `estimateTokensHeuristicScaled(text, 1.2)` or `(text, 1.3)`;
those numbers are provider corrections documented by Anthropic, not results
measured here, so they are deliberately absent from the table above.

## Related

- [README: Tokenizer accuracy](../README.md#tokenizer-accuracy) — which models
  get exact counts and which get the blend
- `src/tokenizers/heuristic.ts` — the constants and their rationale, as source
  comments
