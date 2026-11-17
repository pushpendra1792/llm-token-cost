# llm-token-cost

[![CI](https://github.com/pushpendra1792/llm-token-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/pushpendra1792/llm-token-cost/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/llm-token-cost.svg)](https://www.npmjs.com/package/llm-token-cost)
[![License: MIT](https://img.shields.io/npm/l/llm-token-cost.svg)](https://github.com/pushpendra1792/llm-token-cost/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue.svg)](https://www.typescriptlang.org)

Estimate LLM token counts and costs from raw prompt and completion text, with live pricing, a CLI, and budget guardrails that run before the request is sent.

## Why

Token spend is easy to measure after the fact and awkward to bound in advance. This package answers the earlier question — what will this request cost — from the prompt and completion text alone, against pricing for 3,687 bundled models that a live feed can refresh. Every result carries an `estimated` flag, so an approximation is never presented as a measurement, and a budget can refuse a request before it leaves the process rather than reporting the overrun afterwards.

## Install

```bash
npm install llm-token-cost
```

Requires Node 20 or newer. The CLI ships inside the package, so nothing else needs installing:

```bash
npx llm-token-cost "summarize this article" --model gpt-4o
```

## Quick start

```ts
import { estimateCost } from 'llm-token-cost';

const { inputTokens, cost, estimated } = await estimateCost({
  model: 'gpt-4o',
  inputText: 'Summarize this article in three bullet points.',
});

inputTokens; // 10
cost;        // 0.000025
estimated;   // false
```

`estimateCost` is async because it prefers live pricing. It resolves against the feed first, then a fresh cache, then the bundled snapshot. `estimated` is `true` whenever either the token count or the price is approximate, and `pricingSource` reports which source was used.

A budget can stop the request before it goes out:

```ts
import { BudgetExceededError, createBudget, estimateCost } from 'llm-token-cost';

const inputText = 'Summarize this article in three bullet points.';
const budget = createBudget({ limit: 0.00001, mode: 'hard', scope: 'user-123' });

const estimate = await estimateCost({ model: 'gpt-4o', inputText });

const preview = budget.check(estimate);
console.log('preview:', JSON.stringify(preview));

try {
  budget.track(estimate); // throws, so nothing is sent
} catch (error) {
  if (error instanceof BudgetExceededError) {
    console.log('threw:', error.code, 'limit', error.limit, 'total', error.total);
  }
}

console.log('remaining:', budget.getRemaining());
```

```
preview: {"projectedTotal":0.000025,"wouldExceed":true,"remaining":-0.000015}
threw: BUDGET_EXCEEDED limit 0.00001 total 0.000025
remaining: 0.00001
```

## API

### `estimateCost`

Prices a prompt, and a completion when `outputText` is given.

```ts
import { estimateCost } from 'llm-token-cost';

const result = await estimateCost({
  model: 'gpt-4o',
  inputText: 'Summarize this article in three bullet points.',
  outputText: 'Here is the summary you requested.',
});

console.log(JSON.stringify(result, null, 2));
```

```
{
  "inputTokens": 10,
  "outputTokens": 7,
  "cost": 0.000095,
  "currency": "USD",
  "estimated": false,
  "pricingSource": "live",
  "pricingUpdatedAt": "2026-11-17T09:13:43.867Z"
}
```

`pricingUpdatedAt` in the example is the time the price was fetched, so it changes on every run. See [Pricing source](#pricing-source) for the snapshot and stale cases.

`estimated` is `true` whenever the answer is not fully exact:

| Source of the number | `estimated` |
| --- | --- |
| live LiteLLM feed | `false` |
| fresh in-memory cache (under the 6 h TTL) | `false` |
| expired cache, fetch failed | `true` |
| bundled offline snapshot | `true` |
| heuristic tokenizer (any provider that does not publish one) | `true` |

`estimated` is the accuracy flag: it reports a heuristic token count as clearly as it reports a stale price. A budget fed an estimated cost is a guardrail, not an exact ceiling.

Model ids are case-insensitive, and provider prefixes are stripped as a fallback, so `gpt-4o`, `GPT-4O` and `azure/gpt-4o` all resolve to the same pricing. An exact match wins over a stripped one, so `ft:gpt-4o-2024-08-06` prices as the fine-tuned model when the feed carries it, at its own rate.

### Itemized costs

`estimateCostFromTokens` prices counts that already exist, with no tokenizer in the path. Each optional count is a subset of a total, and each is billed at its own rate when the model publishes one:

| Option | Meaning |
| --- | --- |
| `inputTokens`, `outputTokens` | Totals. |
| `cacheReadInputTokens` | Subset of `inputTokens` read from a prompt cache. |
| `cacheCreationInputTokens` | Subset of `inputTokens` written to a prompt cache. |
| `cacheCreation1hInputTokens` | Subset of `cacheCreationInputTokens` written with a 1-hour TTL. |
| `reasoningOutputTokens` | Subset of `outputTokens` spent on reasoning. |
| `serviceTier` | `'standard'` (default), `'batch'`, `'flex'` or `'priority'`. |
| `cacheTtl` | `'5m'` (default) or `'1h'`, the write price when no 1-hour subset is given. |

Three rules hold throughout: `inputTokens` is the total, including cached and cache-write tokens; the cache counts are subsets of it; `reasoningOutputTokens` is a subset of `outputTokens`. A subset larger than its total is rejected rather than clamped.

```ts
import { estimateCostFromTokens } from 'llm-token-cost';

const result = await estimateCostFromTokens({
  model: 'claude-sonnet-4-5',
  inputTokens: 3000,
  outputTokens: 500,
  cacheReadInputTokens: 1000,
  cacheCreationInputTokens: 1000,
  cacheCreation1hInputTokens: 600,
  reasoningOutputTokens: 200,
});

const round = (value) => Number(value.toPrecision(6));
console.log(
  JSON.stringify(
    {
      cost: round(result.cost),
      breakdown: Object.fromEntries(
        Object.entries(result.breakdown).map(([key, value]) => [key, round(value)]),
      ),
      warnings: result.warnings,
    },
    null,
    2,
  ),
);
```

```
{
  "cost": 0.0159,
  "breakdown": {
    "input": 0.003,
    "cacheRead": 0.0003,
    "cacheCreation": 0.0051,
    "output": 0.0045,
    "reasoning": 0.003
  },
  "warnings": [
    "No reasoning price for claude-sonnet-4-5; using the normal output price."
  ]
}
```

`breakdown` is present when any cache or reasoning count is supplied; its five values sum to `cost`. A missing cache, reasoning or tier price falls back to the base price for that side and adds a warning, as above. `warnings` is absent when every requested price existed.

`serviceTier` prices the whole request at the named tier. For example, `gpt-4o` with 20,000 input and 4,000 output tokens at `'batch'` returns `{"cost":0.045}`.

### Usage objects

`estimateCostFromUsage` prices a provider usage object without re-tokenizing and without calling a provider API. Pass the usage object itself, or the whole response with `usage` or `usageMetadata` on it. The dialect is detected from the keys, and `provider` (`'openai'`, `'openai-chat'`, `'openai-responses'`, `'anthropic'`, `'google'`, `'generic'`) forces one when detection is not enough. A `service_tier` field in the usage object is honoured, and an explicit `serviceTier` wins over it.

OpenAI chat:

```ts
import { estimateCostFromUsage } from 'llm-token-cost';

const result = await estimateCostFromUsage({
  model: 'gpt-4o',
  usage: {
    prompt_tokens: 1200,
    completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 400 },
    completion_tokens_details: { reasoning_tokens: 100 },
  },
});
```

```
{"usageFormat":"openai-chat","inputTokens":1200,"outputTokens":300,"cost":0.0055,"breakdown":{"input":0.002,"cacheRead":0.0005,"cacheCreation":0,"output":0.002,"reasoning":0.001}}
```

OpenAI Responses, passing the whole response:

```ts
import { estimateCostFromUsage } from 'llm-token-cost';

const response = {
  id: 'resp_123',
  usage: {
    input_tokens: 1200,
    output_tokens: 300,
    input_tokens_details: { cached_tokens: 400 },
    output_tokens_details: { reasoning_tokens: 100 },
  },
};

const result = await estimateCostFromUsage({ model: 'gpt-4o', usage: response });
```

```
{"usageFormat":"openai-responses","inputTokens":1200,"outputTokens":300,"cost":0.0055,"breakdown":{"input":0.002,"cacheRead":0.0005,"cacheCreation":0,"output":0.002,"reasoning":0.001}}
```

Anthropic. Here `input_tokens` excludes cache reads and cache writes; the library adds both back to get the total of 1,200:

```ts
import { estimateCostFromUsage } from 'llm-token-cost';

const result = await estimateCostFromUsage({
  model: 'claude-sonnet-4-5',
  usage: {
    input_tokens: 600,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 200,
    output_tokens: 300,
  },
});
```

```
{"usageFormat":"anthropic","inputTokens":1200,"outputTokens":300,"cost":0.00717,"breakdown":{"input":0.0018,"cacheRead":0.00012,"cacheCreation":0.00075,"output":0.0045,"reasoning":0}}
```

Gemini, passing the whole response. Thinking tokens are reported separately but billed as output, so they are added to `outputTokens` and priced at the output rate:

```ts
import { estimateCostFromUsage } from 'llm-token-cost';

const response = {
  usageMetadata: {
    promptTokenCount: 1200,
    candidatesTokenCount: 200,
    thoughtsTokenCount: 100,
    cachedContentTokenCount: 400,
  },
};

const result = await estimateCostFromUsage({ model: 'gemini-2.5-flash', usage: response });
```

```
{"usageFormat":"google","inputTokens":1200,"outputTokens":300,"cost":0.001002,"breakdown":{"input":0.00024,"cacheRead":0.000012,"cacheCreation":0,"output":0.0005,"reasoning":0.00025}}
```

The result has the same fields as `estimateCostFromTokens`, plus `usageFormat`. Pricing resolves through the same live, cache, snapshot ladder, and an unrecognized usage object throws `InvalidInputError` listing the accepted shapes.

### Long-context pricing

Some models price long prompts at a higher rate. A tier applies when the total input tokens are strictly greater than the tier threshold, and the whole request is then priced at the tier rate, not only the tokens above the threshold.

```ts
import { estimateCostFromTokens } from 'llm-token-cost';

const atThreshold = await estimateCostFromTokens({
  model: 'claude-sonnet-4-5-20250929-v1:0',
  inputTokens: 200000,
  outputTokens: 1000,
});

const overThreshold = await estimateCostFromTokens({
  model: 'claude-sonnet-4-5-20250929-v1:0',
  inputTokens: 200001,
  outputTokens: 1000,
});

console.log('at 200000:', JSON.stringify({ cost: atThreshold.cost, pricingTier: atThreshold.pricingTier }));
console.log('at 200001:', JSON.stringify({ cost: overThreshold.cost, pricingTier: overThreshold.pricingTier }));
```

```
at 200000: {"cost":0.615}
at 200001: {"cost":1.222506,"pricingTier":{"aboveInputTokens":200000,"input":0.000006,"output":0.0000225,"cacheReadInput":6e-7,"cacheCreationInput":0.0000075,"cacheCreationInputAbove1hr":0.000012}}
```

Tiers do not apply to `batch`, `flex` or `priority`, which carry their own prices. When a long prompt would have crossed a tier on one of those, the base price is used and a warning is added. Models without tier fields in the feed are priced at the base rate at any size:

```ts
import { estimateCostFromTokens } from 'llm-token-cost';

const standard = await estimateCostFromTokens({
  model: 'gpt-4o',
  inputTokens: 250000,
  outputTokens: 1000,
});

const batch = await estimateCostFromTokens({
  model: 'claude-sonnet-4-5-20250929-v1:0',
  inputTokens: 250000,
  outputTokens: 1000,
  serviceTier: 'batch',
});

const noTiers = await estimateCostFromTokens({
  model: 'claude-sonnet-4-5',
  inputTokens: 250000,
  outputTokens: 1000,
});

console.log('gpt-4o:', JSON.stringify({ cost: standard.cost, pricingTier: standard.pricingTier, warnings: standard.warnings }));
console.log('bedrock batch:', JSON.stringify({ cost: batch.cost, pricingTier: batch.pricingTier, warnings: batch.warnings }));
console.log('direct anthropic:', JSON.stringify({ cost: noTiers.cost, pricingTier: noTiers.pricingTier, warnings: noTiers.warnings }));
```

```
gpt-4o: {"cost":0.635}
bedrock batch: {"cost":0.3825,"warnings":["Long-context tier above 200000 tokens is not applied to the batch service tier for claude-sonnet-4-5-20250929-v1:0."]}
direct anthropic: {"cost":0.765}
```

Known limitation: tiers come from the LiteLLM feed, so a model without tier fields there is priced at its base rate at any prompt size. The direct Anthropic entries `claude-sonnet-4-5` and `claude-sonnet-4-5-20250929` currently carry no tiers. The Bedrock entry `claude-sonnet-4-5-20250929-v1:0` is the Claude entry in the current snapshot with a tier above 200,000 tokens.

### Pricing source

Every estimate result includes `pricingSource` and `pricingUpdatedAt`. `pricingSource` is one of `'live'`, `'cache'`, `'snapshot'` or `'custom'`:

| `pricingSource` | Meaning | `pricingUpdatedAt` |
| --- | --- | --- |
| `live` | Fetched from the LiteLLM feed for this call. | Fetch time. |
| `cache` | Fresh in-memory table, under the 6 h TTL. | Time the table was fetched. |
| `snapshot` | Bundled snapshot, used when the fetch fails. | The snapshot's `generatedAt` date. |
| `custom` | Reserved for caller-supplied pricing. Not produced by this version. | n/a |

For pricing, `estimated` is `true` for `snapshot` and for an expired cache, and `false` for `live` and a fresh `cache`; with `estimateCost`, a heuristic token count also sets it.

If the feed is unreachable, the bundled snapshot is used and the result says so:

```ts
import { estimateCostFromTokens } from 'llm-token-cost';

const result = await estimateCostFromTokens(
  { model: 'gpt-4o', inputTokens: 1000 },
  { url: 'http://127.0.0.1:9/pricing.json' },
);
```

```
{
  "inputTokens": 1000,
  "outputTokens": 0,
  "cost": 0.0025,
  "currency": "USD",
  "estimated": true,
  "pricingSource": "snapshot",
  "pricingUpdatedAt": "2026-11-17"
}
```

Bundled pricing older than 90 days adds a warning. `staleAfterDays` changes the threshold, and `now` sets the clock used for the age check:

```ts
import { estimateCostFromTokens } from 'llm-token-cost';

const result = await estimateCostFromTokens(
  { model: 'gpt-4o', inputTokens: 1000 },
  { url: 'http://127.0.0.1:9/pricing.json', now: new Date('2027-03-01T00:00:00.000Z') },
);
```

```
{
  "inputTokens": 1000,
  "outputTokens": 0,
  "cost": 0.0025,
  "currency": "USD",
  "estimated": true,
  "pricingSource": "snapshot",
  "pricingUpdatedAt": "2026-11-17",
  "warnings": [
    "Bundled pricing is 104 days old (generated 2026-11-17); updating the package or enabling live pricing may give newer prices."
  ]
}
```

The CLI reports the same information. `--json` includes both fields:

```bash
llm-token-cost "summarize this" -m gpt-4o --json
```

```json
{"inputTokens":4,"outputTokens":0,"cost":0.00001,"currency":"USD","estimated":false,"pricingSource":"live","pricingUpdatedAt":"2026-11-17T09:20:14.694Z"}
```

With the feed unreachable, the same command falls back:

```json
{"inputTokens":4,"outputTokens":0,"cost":0.00001,"currency":"USD","estimated":true,"pricingSource":"snapshot","pricingUpdatedAt":"2026-11-17"}
```

The table prints a metadata line when every row used the bundled snapshot, and no such line otherwise:

```bash
LLM_TOKEN_COST_PRICING_URL=http://127.0.0.1:9/pricing.json llm-token-cost "summarize this article" -m gpt-4o
```

```
MODEL   INPUT        COST  CURRENCY  ESTIMATED
gpt-4o      5  0.00001250       USD        yes
pricing: snapshot (2026-11-17)
```

### `createBudget`

Tracks a spending limit in memory and reports or enforces it against a cost.

```ts
import { createBudget } from 'llm-token-cost';

const budget = createBudget({
  limit: 0.00001,
  scope: 'user-123',
  onBudgetExceeded: ({ limit, total, cost, scope, estimated }) => {
    console.log('over:', limit, total, cost, scope, estimated);
  },
});

budget.track({ cost: 0.000025, currency: 'USD', estimated: false });
```

```
over: 0.00001 0.000025 0.000025 user-123 false
```

`mode` decides what happens when a tracked cost would cross the limit:

| `mode` | On crossing | Cost recorded? |
| --- | --- | --- |
| `soft` (default) | fires `onBudgetExceeded` once, then carries on | yes |
| `hard` | throws `BudgetExceededError`, so the call can be abandoned | no |

Hard mode is the one that stops work. The cost is rejected before it is charged, so the budget still reports only what it committed and a smaller retry can still go through.

`onBudgetExceeded` receives the limit, the total including the cost that crossed it, that cost, the scope, and whether the cost was estimated. It fires once, on the first crossing. A spend that lands exactly on the limit does not count as crossed. Hard mode reports by throwing rather than calling back, and the error carries the same fields.

`check` and `track` are separate steps and both belong before the request leaves. `check` is a preview that never records and never calls back; `track` is the commit.

| Member | Description |
| --- | --- |
| `createBudget(options)` | `{ limit, mode?, scope?, onBudgetExceeded? }` |
| `budget.track(spend)` | Charges a cost. Calls the callback in soft mode, throws in hard mode |
| `budget.check(spend)` | Previews a cost. Never records and never calls back |
| `budget.getTotal()` | Everything charged so far; can exceed `limit` in soft mode |
| `budget.getRemaining()` | `limit - getTotal()`, negative once exceeded |
| `budget.isExceeded()` | Whether the tracked total is past the limit |
| `budget.reset()` | Clears the total and re-arms the callback; keeps limit and mode |
| `BudgetExceededError` | `code: 'BUDGET_EXCEEDED'`, plus `limit`, `total`, `cost`, `scope`, `estimated` |

A hard cap is not an absolute ceiling. It stops the next request and cannot recall ones already in flight, so concurrent calls can all be approved before the total crosses the limit. It is enforced against `estimate.cost`, not the provider's real charge. `check` is advice rather than a reservation, so an `await` between `check` and `track` leaves the decision resting on a stale number.

A budget is one object with one total, so separate scopes are separate instances and nothing leaks between them. `scope` is a label for the callback and the error, nothing more. Totals live in memory and die with the process: there is no database, file or network call anywhere in this module. Persist running totals separately if they need to survive a restart.

`track` and `check` take an `estimateCost` result directly, or any `{ cost, currency, estimated }`. A negative or non-finite `cost` is rejected with `InvalidInputError`, and one budget will not mix currencies.

### CLI

```bash
llm-token-cost "summarize this article" --model gpt-4o
```

```
MODEL   INPUT        COST  CURRENCY  ESTIMATED
gpt-4o      5  0.00001250       USD         no
```

Text can be piped in. `--output` prices a completion alongside the prompt, which adds a column:

```bash
echo "Token pricing is hard to predict before a request." | llm-token-cost --model gpt-4o --output "Here is the summary."
```

```
MODEL   INPUT  OUTPUT        COST  CURRENCY  ESTIMATED
gpt-4o     10       5  0.00007500       USD         no
```

If both piped text and a positional argument are given, stdin wins and the CLI warns on stderr.

| Flag | Meaning |
| --- | --- |
| `-m, --model <id>` | Model to price. Repeatable, or comma-separated. Defaults to `gpt-4o`. |
| `-o, --output <text>` | Completion text to price alongside the prompt. |
| `--compare` | Price the same input across every `--model`. Implied when more than one is given. |
| `--json` | Emit the raw estimate result as JSON. |
| `-h, --help` | Show help. |
| `-V, --version` | Show the version. |

`--json` prints the raw estimate result and nothing else on stdout, so it can be piped into `jq` or any JSON consumer. See [Pricing source](#pricing-source) for the two fields it adds.

Pass several models to price the same input across all of them:

```bash
llm-token-cost "summarize this" --compare -m gpt-4o,gpt-4o-mini,claude-sonnet-4-5
```

When comparing, models that do resolve are still printed; only the failures are reported on stderr, and the exit code is `1`.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Estimation failed, for example an unknown model id. |
| `2` | Usage error, for example no input or an unknown flag. |

An unknown model is a hard failure. In `--json` mode the error is a structured object on stdout:

```json
{"error":{"name":"UnknownModelError","code":"UNKNOWN_MODEL","model":"nope","message":"No pricing found for model \"nope\". Pass a model id that exists in the LiteLLM pricing feed. Ids are OpenAI-style (for example gpt-4o) or provider-prefixed (for example azure/gpt-4o)."}}
```

### Errors

An unrecognized model throws a typed error rather than returning a guess.

```ts
import { estimateCost, UnknownModelError } from 'llm-token-cost';

try {
  await estimateCost({ model: 'not-a-real-model', inputText: 'hi' });
} catch (error) {
  if (error instanceof UnknownModelError) {
    console.log(error.code, error.model);
  }
}
```

```
UNKNOWN_MODEL not-a-real-model
```

`estimateCost` never rejects for pricing-fetch reasons. A network failure degrades to the bundled snapshot, so it returns an approximation instead of throwing. The snapshot bundles 3,687 models, so offline use still prices real models.

| Error | `code` | Raised when |
| --- | --- | --- |
| `UnknownModelError` | `UNKNOWN_MODEL` | No pricing entry in any source |
| `InvalidInputError` | `INVALID_INPUT` | Empty model id, negative or fractional counts, invalid budget options, unrecognized usage object |
| `BudgetExceededError` | `BUDGET_EXCEEDED` | A `hard` budget was asked to track a cost that crosses the limit |
| `PricingFetchError` | `PRICING_FETCH_FAILED` | Only from `getPricing`; the estimators degrade instead of throwing |

### Pricing feed and refresh

Pricing comes from [LiteLLM's public feed](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), normalized to a per-token USD shape and bundled as an offline snapshot that is inlined into the build.

`estimateCost`, `estimateCostFromTokens` and `estimateCostFromUsage` take the same pricing options:

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | `LLM_TOKEN_COST_PRICING_URL`, then LiteLLM | Feed to fetch. |
| `ttlMs` | 6 h | How long a fetched table stays fresh in memory. |
| `timeoutMs` | 10 s | Per-request timeout. |
| `forceRefresh` | `false` | Skip the freshness check and refetch. |
| `staleAfterDays` | 90 | Age at which bundled pricing produces a warning. |
| `now` | `Date.now` | Clock for cache age and the staleness check; a function or a `Date`. |

The `LLM_TOKEN_COST_PRICING_URL` environment variable sets the same override as `url`, which is useful behind a proxy, in an air-gapped setup, or for pinning a known-good payload.

`npm run update:pricing` regenerates the snapshot. The script is byte-stable — model keys are sorted, `updatedAt` records when the data last changed rather than when the script ran, and `generatedAt` is the date of the last model-content change — so a week with no upstream price movement rewrites an identical file.

## Accuracy

Token counts are exact for OpenAI models whose ids map to a published `js-tiktoken` encoding. A prefix table fills the `gpt-5.x` gaps that `js-tiktoken`'s compiled-in list misses, covering the whole `gpt-5.1` and later line. In the current snapshot, 408 of the 3,687 keys resolve to a tiktoken encoding. Models with no published encoding stay on the heuristic rather than being guessed at.

Anthropic and Google do not publish tokenizers, so those models get a corrected estimate and always report `estimated: true`. The correction is 1.2x for the `tiktoken` undercount of Claude (Anthropic states ~15-20%), plus a further 1.3x for the tokenizer introduced with Claude 4.7 and later, for 1.56x combined. Both factors are biased high on purpose for pre-flight checks.

For the heuristic blend, measured against `o200k_base` over a 90-sample corpus of prose, code, JSON, markdown and non-Latin scripts, aggregate bias is **-0.2%** with a **24%** MAPE, a **43%** p95 and a **44%** worst case. Aggregate cost lands in the right place; individual documents do not, and any single estimate can be off by up to ~40% in either direction. It is the right tool for the question asked before a request, not for exact accounting — for that, read the `usage` object the provider returns. Full numbers, baselines, known weak spots and how to re-derive them: [docs/BENCHMARK.md](./docs/BENCHMARK.md).

## Comparison

This package is built around three choices: text in, cost out; a bundled snapshot with live refresh; and an accuracy flag on every result. The table lists what it does, so those claims can be checked against another implementation's own documentation.

| Capability | llm-token-cost |
| --- | --- |
| Cost from raw text | `estimateCost` |
| Cost from token counts | `estimateCostFromTokens` |
| Cost from provider usage objects | `estimateCostFromUsage` (OpenAI, Anthropic, Gemini) |
| Live pricing with offline fallback | LiteLLM feed, 6 h cache, bundled snapshot |
| Flags approximate results | `estimated`, `pricingSource`, `warnings` |
| Budget API | soft and hard caps, in memory |
| Module format | ESM + CJS |
| Runtime | Node >= 20 |
| Direct dependencies | 1 (`js-tiktoken`) |

The npm package `llm-cost` targets a similar problem. This README does not characterize its behaviour; check that project's own documentation before choosing.

## Roadmap

- Stable `1.0` release. The API is not frozen, so expect breaking changes before `1.0`.
- A documentation site.

## Contributing

Requires Node 22.12 or newer (or 24, or 26+) for development. That floor comes from `vitest` 5, whose `engines` field is `^22.12.0 || ^24.0.0 || >=26.0.0`. The published package itself supports Node 20 and newer.

```bash
npm install
npm run typecheck      # tsc --noEmit, strict
npm run test           # vitest
npm run build          # tsup -> dist/ (ESM + CJS + types)
npm run update:pricing # refresh the bundled snapshot from LiteLLM
npm run size           # inspect what would be published
```

The MAPE and p95 figures in [Accuracy](#accuracy) and in [docs/BENCHMARK.md](./docs/BENCHMARK.md) are offline measurements from a 90-sample corpus that is not checked into this repository, so the test suite does not re-derive them. The Anthropic correction factors and the 4.7 boundary are pinned by tests, and the blend has unit tests, but a regression in aggregate accuracy would not fail the build. Treat the numbers as a one-time measurement and re-run the calibration if the blend changes.

### Automation

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`ci.yml`](./.github/workflows/ci.yml) | Every pull request, every push to `main` | Typechecks, tests and builds on Node 22 and 24, asserts the publish tarball contains no sources or tests, and installs the packed tarball on Node 20 to smoke-test the ESM, CJS and CLI entry points against the bundled snapshot |
| [`update-pricing.yml`](./.github/workflows/update-pricing.yml) | Weekly (Mondays 06:17 UTC) or manual | Regenerates the pricing snapshot and opens a pull request, but only if a price actually changed |
| [`publish.yml`](./.github/workflows/publish.yml) | Push a `v*` tag | Typechecks, tests and builds, then publishes to npm with provenance and creates a GitHub release |

The pricing workflow reuses the byte-stable behaviour of `npm run update:pricing`: when nothing upstream moved, the snapshot is unchanged, the workflow finds no diff, and no pull request is opened. When something did change, the new snapshot is schema-checked, put through the full test suite, and sent for review. Pricing never lands on `main` unattended.

### Releasing

Publishing uses trusted publishing (OIDC) rather than a long-lived token: the registry mints a short-lived credential per run, so no `NPM_TOKEN` secret is needed. Trusted publishing requires npm 11.5.1 or newer, which is why the workflow upgrades npm before anything else.

A release is a tag. Bump the version, which commits the change and creates the tag, then push the tag:

```bash
npm version <x.y.z>        # bumps package.json, commits, tags v<x.y.z>
git push --follow-tags     # the tag is what triggers the publish
```

The tag runs `publish.yml`, which refuses to continue if the tag disagrees with the `package.json` version, if any check fails, or if the version is already on npm. The GitHub release is created by a follow-on job that only runs once the publish has succeeded.

## License

[MIT](./LICENSE)
