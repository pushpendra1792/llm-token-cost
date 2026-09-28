# llm-token-cost

[![CI](https://github.com/pushpendra1792/llm-token-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/pushpendra1792/llm-token-cost/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/llm-token-cost.svg)](https://www.npmjs.com/package/llm-token-cost)

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

`js-tiktoken`'s compiled-in table stops at `gpt-5`, so this package adds a
prefix table mirroring OpenAI's own `MODEL_PREFIX_TO_ENCODING` (the same
approach upstream uses so that "prefix matching avoids needing library updates
for every model version release"). That recovers exact counts for 242 models
LiteLLM lists, including the whole `gpt-5.1`+ line — `gpt-5.1` was added
upstream in openai/tiktoken#468 and shipped in Python `tiktoken` 0.14, but was
never backported to the JS port. Models with no published encoding (`gpt-6-*`,
`gpt-oss-*`) are deliberately left on the heuristic rather than guessed at, since
claiming `estimated: false` for a model we cannot count is the one failure worth
avoiding.

### Anthropic and Google

Anthropic and Google do not publish their tokenizers, so those models are
estimated and always report `estimated: true`.

`@anthropic-ai/tokenizer` was evaluated and **rejected**. It is installable and
would look like the obvious answer, but:

- it was last published **2023-07-05** at `0.0.4` and never again, so it
  predates Claude 3 and its vocabulary cannot describe any currently sold model;
- its own README says "As of the Claude 3 models, this algorithm is no longer
  accurate, but can be used as a very rough approximation";
- Anthropic has said client-side counting is not coming back — asked directly,
  the answer was that it is "no longer possible to provide ahead-of-time
  client-side accurate token counts", and to "use heuristic estimates and give
  yourself a buffer";
- it depends on `tiktoken@^1`, the stale CJS line this package exists to replace.

The only exact option is the `count_tokens` API, which needs an API key and a
network round trip. That is a different product: this library answers the
question asked *before* the request, with no credentials and no latency.

So Claude gets a **provider-corrected** estimate instead of the generic blend,
using two published facts rather than a fitted corpus:

| Correction | Factor | Source |
| --- | --- | --- |
| base | 1.0x | blend calibrated against OpenAI BPE |
| `tiktoken` undercounts Claude by ~15-20% | 1.2x | [Anthropic's guidance](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/token-counting.md) |
| Claude 4.7+ ships a newer tokenizer, ~30% more tokens | 1.3x | [Claude token-counting docs](https://platform.claude.com/docs/en/build-with-claude/token-counting) |

Anthropic's wording on the first row is worth quoting, because it is a warning
against exactly this kind of arithmetic: **"Do not use `tiktoken`. It's OpenAI's
tokenizer. It undercounts Claude tokens by ~15-20% on typical text, and by much
more on code or non-English input."**

The 1.2 sits mid-band and is **deliberately biased high**. The `tiktoken` gap is
consistently one-sided — it errs low, never high — so for a pre-flight check an
estimate that rounds down would under-report cost, while one that rounds up only
reserves more budget than needed. `1.2` yields 1.18x at the 15% end and 1.25x at
the 20% end.

A flat multiplier is still a blunt instrument, and this is the approach's main
weakness. The 15-20% is a *typical text* figure; reported drift runs from ~9% on
English prose to ~24% on code diffs and ~38% on serialized JSON, because two BPEs
diverge most on the inputs neither was optimized for. One ratio cannot capture
that spread, and the real fix is `count_tokens`, not a better constant.

The 4.7 boundary is detected from the version in the model id. Anthropic's docs
confirm the same tokenizer covers `claude-fable-5-1`, `claude-mythos-5-1`,
`claude-fable-5` and `claude-mythos-5` alongside 4.7+, all of which this picks up
via the major version, and note a prompt "counts the same on all four". Mythos
Preview is handled separately: it carries no version number at all, so the numeric
rule cannot see it, and matching the name is the only option.

These are aggregate corrections. Aggregate cost lands close; individual documents
still vary.

The one public ground truth available is Anthropic's own example: a system prompt
`"You are a scientist"` plus the user message `"Hello, Claude"` on
`claude-opus-5-5` returns `input_tokens: 14`. The current-generation estimate
returns **13** for that same content. The residual token is not error — Anthropic
notes that counts "may include tokens added automatically by Anthropic for system
optimizations" and that "you are not billed for system-added tokens", so 13
content tokens against a 14-token response that includes unbilled framing is
effectively exact on the number that is actually charged.

Two caveats on that. The correction factors are *documented ratios*, not
measurements taken here, and Anthropic's docs say the exact 30% increase "depends
on the content and workload shape". This library models prompt and completion
text only: it does not model tool definitions, which are billed input tokens and
are typically large.

Google's Gemini models use the generic blend, uncorrected.

### Generic heuristic

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
│   ├── index.ts             picks tiktoken / Anthropic / heuristic per model
│   ├── openai.ts            exact tiktoken counts + prefix table
│   ├── anthropic.ts         Claude generation detection + correction
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

## Automation

Three GitHub Actions workflows cover the work that should not depend on anyone
remembering to do it by hand.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| [`ci.yml`](./.github/workflows/ci.yml) | Every pull request, every push to `main` | `typecheck`, `test` and `build` on Node 18 and 22, then asserts the publish tarball contains no sources or tests |
| [`update-pricing.yml`](./.github/workflows/update-pricing.yml) | Weekly (Mondays 06:17 UTC) or manual | Regenerates the pricing snapshot and opens a pull request, but only if a price actually changed |
| [`publish.yml`](./.github/workflows/publish.yml) | Push a `v*` tag | Typechecks, tests and builds, then publishes to npm with provenance and creates a GitHub release |

### Pricing refreshes

`npm run update:pricing` is byte-stable. Model keys are sorted and `updatedAt`
records when the *data* last changed, not when the script last ran, so a week
with no upstream price movement rewrites an identical file. The workflow finds no
diff and exits without opening a pull request. When something did change, the new
snapshot is schema-checked, put through the full test suite, and sent for review.
Pricing never lands on `main` unattended.

### Releasing

npm publishing uses **trusted publishing** (OIDC) rather than a long-lived
token: the registry mints a short-lived credential per run, so **no `NPM_TOKEN`
secret has to be set on this repository**.

The first release cannot use that flow, because a package must already exist on
npm before it can be registered as a trusted publisher. Bootstrap it by hand once:

```bash
npm version 0.1.0 --no-git-tag-version   # no tag: a v* tag would fire publish.yml
npm install
npm run prepublishOnly                   # typecheck + test + build
npm publish --access public              # prompts to log in
```

Then commit and push that version bump, and on npmjs.com add a trusted publisher
under the package's settings:

| Field | Value |
| --- | --- |
| Organization or user account | your npm account |
| Repository | `pushpendra1792/llm-token-cost` |
| Workflow filename | `publish.yml` |
| Environment | leave blank |

Every release after that is a single command:

```bash
npm version 0.1.1        # bumps package.json, tags v0.1.1, pushes the tag
```

That tag runs `publish.yml`, which refuses to continue if the tag disagrees with
the `package.json` version, if any check fails, or if the version is already on
npm. The GitHub release is created by a follow-on job that only runs once the
publish has succeeded.

## Roadmap

| Phase | Contents | Status |
| --- | --- | --- |
| 0 | Repo, tooling, dual-build, CI, packaging | Done |
| 1 | Tokenizers + pricing + `estimateCost` | Done |
| 2 | CLI | Done |
| 2b | Budget guardrails | Next |
| 2c | Provider-aware tokenizers (Anthropic + OpenAI prefix table) | Done |
| 4 | Automation: CI, scheduled pricing PRs, tag-gated npm publish | Done |
| 3 | Stable release, docs site | Planned |

The MAPE and p95 figures in [Tokenizer accuracy](#tokenizer-accuracy) are
**offline measurements from a 90-sample corpus**, not a build-time gate: that
corpus is not checked into the repo, so the test suite does not re-derive them.
The Anthropic correction factors and the 4.7 boundary *are* pinned by tests, and
the blend has unit tests, but a regression in aggregate accuracy would not fail
the build. Treat the table as a one-time measurement and re-run the calibration
if the blend changes.

## License

[MIT](./LICENSE)
