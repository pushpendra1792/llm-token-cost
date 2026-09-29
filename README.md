# llm-token-cost

[![CI](https://github.com/pushpendra1792/llm-token-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/pushpendra1792/llm-token-cost/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/llm-token-cost.svg)](https://www.npmjs.com/package/llm-token-cost)
[![License: MIT](https://img.shields.io/npm/l/llm-token-cost.svg)](https://github.com/pushpendra1792/llm-token-cost/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue.svg)](https://www.typescriptlang.org)

Estimate LLM token counts and costs from raw prompt and completion text, with live pricing, a CLI, and budget guardrails that run before the request is sent.

## Why

Token spend is easy to measure after the fact and awkward to bound in advance. This package answers the earlier question — what will this request cost — from the prompt and completion text alone, against pricing for 3,588 bundled models that a live feed can refresh. Every result carries an `estimated` flag, so an approximation is never presented as a measurement, and a budget can refuse a request before it leaves the process rather than reporting the overrun afterwards.

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

const { cost, estimated } = await estimateCost({
  model: 'gpt-4o',
  inputText: 'Summarize this article in three bullet points.',
});

cost;      // 0.000025
estimated; // false
```

`estimateCost` is async because it prefers live pricing. It resolves against the feed first, then a fresh cache, then the bundled snapshot, and sets `estimated: true` whenever either the token count or the price is approximate.

Adding a budget makes the estimate actionable. Both budget calls happen before the request goes out, which is the only point at which a limit can still stop it:

```ts
import { createBudget, estimateCost } from 'llm-token-cost';

const budget = createBudget({ limit: 0.001, mode: 'hard', scope: 'user-123' });

const estimate = await estimateCost({ model: 'gpt-4o', inputText, outputText });

const preview = budget.check(estimate); // { wouldExceed: false, projectedTotal, remaining }
if (preview.wouldExceed) return useCheaperModel();

budget.track(estimate); // commits the cost; in hard mode this throws instead

const completion = await callTheModel({ model: 'gpt-4o', inputText, outputText });
```

## API

### `estimateCost`

```ts
function estimateCost(
  input: {
    model: string;
    inputText: string;
    outputText?: string;
  },
  options?: GetPricingOptions,
): Promise<{
  inputTokens: number;
  outputTokens: number;
  cost: number;
  currency: string;
  estimated: boolean;
}>;
```

Prices a prompt, and a completion when `outputText` is given.

```ts
import { estimateCost } from 'llm-token-cost';

const result = await estimateCost({
  model: 'gpt-4o',
  inputText: 'Summarize this article in three bullet points.',
  outputText: 'Here is the summary you requested.',
});

result.inputTokens;  // 10
result.outputTokens; // 7
result.cost;         // 0.000095
result.currency;     // 'USD'
result.estimated;    // false
```

`estimated` is `true` whenever the answer is not fully exact:

| Source of the number | `estimated` |
| --- | --- |
| live LiteLLM feed | `false` |
| fresh in-memory cache (under the 6 h TTL) | `false` |
| expired cache, fetch failed | `true` |
| bundled offline snapshot | `true` |
| heuristic tokenizer (any provider that does not publish one) | `true` |

> `estimated` is the accuracy flag: it reports a heuristic token count as clearly as it reports a stale price. A budget fed an estimated cost is a guardrail, not an exact ceiling.

Model ids are forgiving. Lookups are case-insensitive and provider prefixes are stripped as a fallback, so `gpt-4o`, `GPT-4O` and `azure/gpt-4o` all resolve to the same pricing. An exact match always wins over a stripped one, so `ft:gpt-4o-2024-08-06` prices as the fine-tuned model when the feed carries it, at its own rate.

### `estimateCostFromTokens`

```ts
function estimateCostFromTokens(
  input: {
    model: string;
    inputTokens: number;
    outputTokens?: number;
  },
  options?: GetPricingOptions,
): Promise<{
  inputTokens: number;
  outputTokens: number;
  cost: number;
  currency: string;
  estimated: boolean;
}>;
```

Prices counts that already exist, without tokenizing anything.

```ts
import { estimateCostFromTokens } from 'llm-token-cost';

const result = await estimateCostFromTokens({
  model: 'claude-sonnet-4-5',
  inputTokens: response.usage.input_tokens,  // 1200
  outputTokens: response.usage.output_tokens, // 340
});

result.cost;      // 0.0087
result.estimated; // false
```

Use this when a provider's `usage` object is already in hand, or when a tokenizer the caller depends on has already counted the text. Pricing resolves exactly as in `estimateCost` — live feed, fresh cache, then bundled snapshot — and an unpriceable model throws the same `UnknownModelError`. Counts are used verbatim: nothing is rounded, scaled or corrected, so a count from any source costs the same. Negative, fractional and non-finite counts are rejected with `InvalidInputError` rather than priced.

> Here `estimated` reports the **pricing only**, and is `false` for a Claude model with live prices where `estimateCost` on the same model reports `true`. No tokenizer is in the path, so the flag has nothing to say about the counts — only the caller knows whether they are exact.

The result is a `BudgetSpend`, so it feeds a budget exactly as an `estimateCost` result does.

### `createBudget`

```ts
function createBudget(options: {
  limit: number;
  mode?: 'soft' | 'hard';
  scope?: string;
  onBudgetExceeded?: (context: BudgetExceededContext) => void;
}): Budget;
```

Tracks a spending limit in memory and reports or enforces it against a cost.

```ts
import { createBudget, estimateCost } from 'llm-token-cost';

const budget = createBudget({
  limit: 5,          // USD
  mode: 'hard',      // stop the call; the default only reports
  scope: 'user-123', // a label, reported to the callback and errors
});

const estimate = await estimateCost({ model: 'gpt-4o', inputText, outputText });
budget.track(estimate); // throws BudgetExceededError here, so nothing is sent
const completion = await callTheModel({ model: 'gpt-4o', inputText, outputText });
```

`mode` decides what happens when a tracked cost would cross the limit:

| `mode` | On crossing | Cost recorded? |
| --- | --- | --- |
| `soft` (default) | fires `onBudgetExceeded` once, then carries on | yes |
| `hard` | throws `BudgetExceededError`, so the call can be abandoned | no |

Hard mode is the one that stops work. The cost is rejected *before* it is charged, so the budget still reports only what it committed and a smaller retry can still go through.

`onBudgetExceeded` receives the limit, the total *including* the cost that crossed it, that cost, the scope, and whether the cost was estimated. It fires once, on the first crossing — never before the limit is crossed, and never again for later overspends. A spend that lands exactly on the limit does not count as crossed. Hard mode reports by throwing rather than calling back, and the error carries the same fields, so the same context is available from a `catch`.

```ts
const budget = createBudget({
  limit: 1,
  mode: 'hard',
  onBudgetExceeded: ({ limit, total, cost, scope, estimated }) => {
    logger.warn({ limit, total, cost, scope, estimated }, 'budget exceeded');
  },
});
```

`check` and `track` are separate steps and both belong before the request leaves. `check` is a preview that never records and never calls back; `track` is the commit.

```ts
const estimate = await estimateCost({ model, inputText, outputText });

const preview = budget.check(estimate);   // 1. preview: affordable at all?
if (preview.wouldExceed) return useCheaperModel();

budget.track(estimate);                    // 2. commit; hard mode throws here
const completion = await callTheModel({ model, inputText, outputText }); // 3. spend
```

> A hard cap is not an absolute ceiling. It stops the *next* request and cannot recall ones already in flight, so concurrent calls can all be approved before the total crosses the limit; and it is enforced against `estimate.cost`, not the provider's real charge. `check` is advice rather than a reservation — it reads the total as it stands at that instant, so an `await` between `check` and `track` leaves the decision resting on a stale number.

A budget is one object with one total, so separate scopes are separate instances and nothing leaks between them. `scope` is a label for the callback and the error, nothing more. Totals live in memory and die with the process: there is no database, file or network call anywhere in this module, so a budget only ever knows about spend made in the current process. Persist running totals separately if they need to survive a restart.

| Member | Description |
| --- | --- |
| `createBudget(options)` | `{ limit, mode?, scope?, onBudgetExceeded? }` |
| `budget.track(spend)` | Charges a cost. Fires the callback in soft mode, throws in hard mode |
| `budget.check(spend)` | Previews a cost. Never records and never calls back |
| `budget.getTotal()` | Everything charged so far; can exceed `limit` in soft mode |
| `budget.getRemaining()` | `limit - getTotal()`, negative once exceeded |
| `budget.isExceeded()` | Whether the tracked total is past the limit |
| `budget.reset()` | Clears the total and re-arms the callback; keeps limit and mode |
| `BudgetExceededError` | `code: 'BUDGET_EXCEEDED'`, plus `limit`, `total`, `cost`, `scope`, `estimated` |

`track` and `check` take an `estimateCost` result directly, or any `{ cost, currency, estimated }`. A negative or non-finite `cost` is rejected with `InvalidInputError` rather than quietly corrupting a total, and one budget will not mix currencies.

### CLI

```bash
llm-token-cost "summarize this article" --model gpt-4o
```

```
MODEL   INPUT        COST  CURRENCY  ESTIMATED
gpt-4o      5  0.00001250       USD         no
```

Text can be piped in, which is the natural shape for other tools. `--output` prices a completion alongside the prompt, which adds a column:

```bash
cat article.txt | llm-token-cost --model gpt-4o --output "the summary"
```

```
MODEL   INPUT  OUTPUT        COST  CURRENCY  ESTIMATED
gpt-4o     11       2  0.00004750       USD         no
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

`--json` prints the raw estimate result and nothing else on stdout, so it can be piped into `jq` or any JSON consumer:

```bash
llm-token-cost "summarize this" -m gpt-4o --json
```

```json
{"inputTokens":4,"outputTokens":0,"cost":0.00001,"currency":"USD","estimated":false}
```

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

An unknown model is a hard failure. In `--json` mode the error is a structured object, so it is safe to parse:

```json
{"error":{"name":"UnknownModelError","code":"UNKNOWN_MODEL","model":"nope","message":"..."}}
```

### Errors

An unrecognized model throws a typed error rather than returning a guess.

```ts
import { estimateCost, UnknownModelError } from 'llm-token-cost';

try {
  await estimateCost({ model: 'not-a-real-model', inputText: 'hi' });
} catch (error) {
  if (error instanceof UnknownModelError) {
    error.code;  // 'UNKNOWN_MODEL'
    error.model; // 'not-a-real-model'
  }
}
```

`estimateCost` never rejects for pricing-fetch reasons. A network failure degrades to the bundled snapshot, so it returns an approximation instead of throwing. The snapshot bundles ~3,600 models, so offline use still prices real models accurately.

| Error | `code` | Raised when |
| --- | --- | --- |
| `UnknownModelError` | `UNKNOWN_MODEL` | No pricing entry in any source |
| `InvalidInputError` | `INVALID_INPUT` | Empty model id, negative or fractional counts, invalid budget options |
| `BudgetExceededError` | `BUDGET_EXCEEDED` | A `hard` budget was asked to track a cost that crosses the limit |
| `PricingFetchError` | `PRICING_FETCH_FAILED` | Only from `getPricing`; the estimators degrade instead of throwing |

### Pricing

Pricing comes from [LiteLLM's public feed](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), normalized to a per-token USD shape and bundled as an offline snapshot that is inlined into the build.

Both `estimateCost` and `estimateCostFromTokens` take an options object: `url` overrides the feed, `ttlMs` the cache freshness window (default 6 h), `timeoutMs` the per-request timeout (default 10 s), and `forceRefresh` skips the freshness check. The `LLM_TOKEN_COST_PRICING_URL` environment variable sets the same override as `url`, which is useful behind a proxy, in an air-gapped setup, or for pinning a known-good payload.

`npm run update:pricing` regenerates the snapshot. The script is byte-stable — model keys are sorted and `updatedAt` records when the data last changed rather than when the script ran — so a week with no upstream price movement rewrites an identical file.

## Accuracy

Token counts are exact for OpenAI models, which are resolved to a real `js-tiktoken` encoding through the same prefix-matching approach OpenAI uses upstream, covering 242 models LiteLLM lists including the whole `gpt-5.1`+ line. Models with no published encoding are left on the heuristic rather than guessed at. Anthropic and Google do not publish tokenizers, so those models get a provider-corrected estimate and always report `estimated: true`; Anthropic's published figures put the correction at 1.2x for the `tiktoken` undercount and 1.3x for the newer Claude 4.7+ tokenizer, both deliberately biased high for pre-flight checks.

For the heuristic blend, measured against `o200k_base` over a 90-sample corpus of prose, code, JSON, markdown and non-Latin scripts, aggregate bias is **-0.2%** with a **24%** MAPE, a **43%** p95 and a **44%** worst case. Read that honestly: aggregate cost lands in the right place, individual documents do not, and any single estimate can be off by up to ~40% in either direction. It is the right tool for the question asked before a request, not for exact accounting — for that, read the `usage` object the provider returns. Full numbers, baselines, known weak spots and how to re-derive them: [docs/BENCHMARK.md](./docs/BENCHMARK.md).

## Comparison with `llm-cost`

Checked on 2026-09-28 against the npm registry, the PyPI JSON API and each project's public source. A cell reading "unverified" was not confirmed and is not claimed either way.

| | **llm-token-cost** | **llm-cost** | **tiktoken** (PyPI) | **litellm** (PyPI) |
| --- | --- | --- | --- | --- |
| Last release | 2026-09-28 | 2024-07-19 | 2026-08-17 | 2026-09-27 |
| License | MIT | MIT | MIT | MIT |
| Runtime | Node >= 20 | Node, no `engines` field | Python >= 3.9 | Python >= 3.10, < 3.15 |
| Module format | ESM + CJS | CommonJS only | — | — |
| Cost from raw text | yes | yes | no | no |
| Cost from raw token counts | yes | yes | no | yes |
| Anthropic / Google token counts | estimated, flagged | wrong tokenizer, unflagged | no | unverified |
| Models priceable | 3,588 bundled, live-refreshable | 466, frozen since 2024-07 | none | own `model_prices` map |
| Flags approximate results | yes, `estimated` | no | — | unverified |
| Budget / spend API | yes, soft and hard cap | none | none | proxy-level spend tracking |
| Direct dependencies | 1 | 1 | 2 | ~20, incl. `openai`, `boto3` |

The row that decides most comparisons is **Anthropic / Google token counts**. `tiktoken` is OpenAI's tokenizer, and Anthropic's documentation says it undercounts Claude by ~15-20% on typical text, so something has to correct for that. `llm-cost` does not: it applies a provider correction to the token count in some paths, and says nothing at all in others. `llm-cost` also falls back to the `gpt-3.5-turbo` encoder for any model missing from its three-entry tokenizer table, and its price table is a LiteLLM snapshot frozen at the 2024-07 publish, so `gpt-5`, `gpt-5.1` and `claude-sonnet-4-5` are absent and its exact-match lookup returns `cost: undefined` for them.

Both "cost from" rows are supported, and they are different jobs. `estimateCost` takes text, because counting tokens is the part that has to be right. When the counts already exist, `estimateCostFromTokens` prices them without tokenizing anything.

## Roadmap

- Stable `1.0` release. The API is not frozen, so expect breaking changes before `1.0`.
- A documentation site.

## Contributing

Requires **Node 20.19+** (or 22.12+) for development. That floor comes from the native bindings behind `vitest`, which declare `^20.19.0 || >=22.12.0`. The published package itself supports Node 20 and newer, and CI runs the suite against Node 20 and 22.

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
| [`ci.yml`](./.github/workflows/ci.yml) | Every pull request, every push to `main` | `typecheck`, `test` and `build` on Node 20 and 22, then asserts the publish tarball contains no sources or tests |
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
