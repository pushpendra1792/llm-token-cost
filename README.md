# llm-token-cost

> **Status: v1 core (Phase 1) + CLI (Phase 2) shipped, API unstable.** The budget
> guardrails are not implemented yet. See [Roadmap](#roadmap).

Estimate LLM token counts and costs from raw prompt/completion text. A modern,
maintained successor to the stale [`llm-cost`](https://www.npmjs.com/package/llm-cost)
package (last published 2024, pinned to `tiktoken@^1`).

## Why

`llm-cost` is effectively unmaintained: its last release was over a year ago, it
hard-depends on `tiktoken@^1`, and it has no Anthropic or Google pricing, no
typed API, and no ESM build. `llm-token-cost` aims to fix each of those.

## Install

```bash
npm install llm-token-cost
```

## CLI

```bash
llm-token-cost "summarize this article" --model gpt-4o
```

```
MODEL   INPUT        COST  CURRENCY  ESTIMATED
gpt-4o      5  0.00001250       USD         no
```

Text can also be piped in, which is the natural shape for other tools. Add
`--output` to price a completion alongside the prompt, which adds a column:

```bash
cat article.txt | llm-token-cost --model gpt-4o --output "the summary"
```

```
MODEL   INPUT  OUTPUT        COST  CURRENCY  ESTIMATED
gpt-4o     11       2  0.00004750       USD         no
```

If you pass both piped text and a positional argument, stdin wins and the CLI
warns on stderr.

### Machine-readable output

`--json` prints the raw estimate result and nothing else on stdout, so it can be
piped into `jq` or any JSON consumer:

```bash
llm-token-cost "summarize this" -m gpt-4o --json
```

```json
{"inputTokens":4,"outputTokens":0,"cost":0.00001,"currency":"USD","estimated":false}
```

### Comparing models

Pass several models — repeated flags or a comma-separated list — to price the
same input across all of them. `--compare` is implied automatically:

```bash
llm-token-cost "summarize this" --compare -m gpt-4o,gpt-4o-mini,claude-sonnet-4-5
```

| Flag | Meaning |
| --- | --- |
| `-m, --model <id>` | Model to price. Repeatable, or comma-separated. Defaults to `gpt-4o`. |
| `-o, --output <text>` | Completion text to price alongside the prompt. |
| `--compare` | Price the same input across every `--model`. |
| `--json` | Emit the raw estimate result as JSON. |
| `-h, --help` | Show help. |
| `-V, --version` | Show the version. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Estimation failed, for example an unknown model id. |
| `2` | Usage error, for example no input or an unknown flag. |

An unknown model is a hard failure. In `--json` mode the error is a structured
object, so it is safe to parse:

```json
{"error":{"name":"UnknownModelError","code":"UNKNOWN_MODEL","model":"nope","message":"..."}}
```

When comparing, models that do resolve are still printed; only the failures are
reported on stderr, and the exit code is `1`.

## Usage

```ts
import { estimateCost, UnknownModelError } from 'llm-token-cost';

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

`estimateCost` is **async** because it prefers live pricing. It resolves in this
order, and `estimated` is `true` whenever the result is not fully exact:

| Pricing source | `estimated` |
| --- | --- |
| live LiteLLM feed | `false` |
| fresh in-memory cache (< 6 h TTL) | `false` |
| expired cache (fetch failed) | `true` |
| bundled offline snapshot | `true` |

`estimated` is also `true` whenever the tokenizer is the heuristic, because
Anthropic and Google do not publish their tokenizers:

```ts
await estimateCost({ model: 'claude-sonnet-4-5', inputText: 'Hello' });
// estimated: true  <- heuristic token count
```

Model ids are forgiving. `gpt-4o`, `GPT-4O`, `azure/gpt-4o` and
`ft:gpt-4o-2024-08-06` all resolve to the same pricing.

### Errors

An unrecognized model throws a typed error rather than returning a guess:

```ts
try {
  await estimateCost({ model: 'not-a-real-model', inputText: 'hi' });
} catch (error) {
  if (error instanceof UnknownModelError) {
    error.code;  // 'UNKNOWN_MODEL'
    error.model; // 'not-a-real-model'
  }
}
```

`estimateCost` never rejects for pricing-fetch reasons. A network failure
degrades to the bundled snapshot, so it returns an approximation instead of
throwing. The snapshot bundles ~3,600 models, so offline use still prices real
models accurately.

## Tokenizer accuracy

`js-tiktoken` gives **exact** counts for OpenAI models (`gpt-4o`, `gpt-5`,
`o3-mini`, ... resolve to `o200k_base`; `gpt-4`, `gpt-3.5-turbo` to
`cl100k_base`).

Everything else uses a character/word/CJK blend. Measured against `o200k_base`
over a 90-sample corpus (prose, short sentences, code, JSON, markdown, CJK,
Cyrillic, Arabic, emoji; ~4.4k tokens):

| Metric | Blend | `chars / 4` | `words × 1.3` |
| --- | --- | --- | --- |
| aggregate bias | **-0.2%** | +4.8% | -23.5% |
| MAPE | **24%** | 20% | 41% |
| p95 | **43%** | 63% | 92% |

Read that honestly: **aggregate cost is accurate, individual documents are
not.** Expect any single estimate to be off by up to ~40%, in either direction.
`chars / 4` has a similar MAPE but no CJK handling and a much worse tail, and
pure word-ratio scaling is bad enough to reject outright.

If you need exact numbers, read the `usage` object the provider returns. This
library is for the question that comes *before* the request: should this be
allowed to run at all?

## Architecture

```
src/
├── index.ts                 public API
├── estimate.ts              estimateCost
├── errors.ts                typed error classes
├── model-id.ts              shared model-id normalization
├── tokenizers/
│   ├── index.ts             picks tiktoken vs heuristic per model
│   ├── openai.ts            exact tiktoken counts
│   └── heuristic.ts         character/word/CJK blend
├── pricing/
│   ├── fetch.ts             live fetch + TTL cache + snapshot fallback
│   ├── normalize.ts         LiteLLM payload -> internal shape
│   ├── lookup.ts            model-id -> pricing entry
│   ├── units.ts             per-token / per-1K / per-1M normalization
│   └── snapshot.json        bundled offline pricing (~3.6k models)
├── budget/guardrails.ts     reserved; not implemented yet
├── cli.ts                   bin entry: I/O, exit codes
├── cli-args.ts              pure argument parsing
└── cli-format.ts            pure table / JSON formatting
```

The CLI is split so that everything except the I/O in `cli.ts` is a pure
function, which is what makes the parser and formatter unit-testable without
spawning a process.

Pricing comes from
[LiteLLM's public feed](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json),
normalized to a per-token USD shape and bundled as a fallback snapshot.

Set `LLM_TOKEN_COST_PRICING_URL` to point at a mirror of that feed — useful
behind a proxy, in an air-gapped setup, or for pinning a known-good payload. The
`getPricing` `url` option takes precedence over the env var.

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit, strict
npm run test           # vitest
npm run build          # tsup -> dist/ (ESM + CJS + types)
npm run update:pricing # refresh the bundled snapshot from LiteLLM
npm run size           # inspect what would be published
```

## Roadmap

| Phase | Contents | Status |
| --- | --- | --- |
| 0 | Repo, tooling, dual-build, CI, packaging | Done |
| 1 | Tokenizers + pricing + `estimateCost` | Done |
| 2 | CLI | Done |
| 2b | Budget guardrails | Next |
| 3 | Stable release, docs site | Planned |

## License

[MIT](./LICENSE)
