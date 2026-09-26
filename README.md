# llm-token-cost

> **Status: scaffolding (Phase 0).** The public API is not implemented yet — see
> [Roadmap](#roadmap). Do not install this for production use.

Estimate LLM token counts and costs from raw prompt/completion text. A modern,
maintained successor to the stale [`llm-cost`](https://www.npmjs.com/package/llm-cost)
package (last published 2024, pinned to `tiktoken@^1`).

## Why

`llm-cost` is effectively unmaintained: its last release was over a year ago, it
hard-depends on `tiktoken@^1`, and it has no Anthropic/Google pricing, no typed
API, and no ESM build. `llm-token-cost` aims to fix each of those.

## Goals

- **Zero runtime dependencies.** Vendor tokenizers are loaded lazily and
  optionally; the core estimator works out of the box.
- **Provider-aware.** Per-provider tokenization (OpenAI BPE, Anthropic
  heuristic, generic fallback) with explicit accuracy tiers.
- **Fresh pricing.** A versioned, cacheable pricing snapshot refreshed on a
  schedule, not a hardcoded table frozen at publish time.
- **Budget guardrails.** Helpers to cap spend per call, per run, and per
  request before you hit the API.
- **Modern packaging.** Dual ESM/CJS, bundled types, Node 18.18+.

## Install

```bash
npm install llm-token-cost
```

## Usage

```ts
// TODO: Phase 1
```

## CLI

```bash
npx llm-token-cost --help
```

## Roadmap

| Phase | Contents | Status |
| --- | --- | --- |
| 0 | Repo, tooling, dual-build, CI, packaging | Done |
| 1 | Tokenizers (OpenAI / Anthropic / heuristic) + pricing snapshot | Next |
| 2 | Budget guardrails + CLI | Planned |
| 3 | First stable release, docs site | Planned |

## Architecture

```
src/
├── index.ts                 public entrypoint
├── tokenizers/
│   ├── openai.ts            BPE-based tokenization for OpenAI models
│   ├── anthropic.ts         Anthropic tokenization
│   └── heuristic.ts         provider-agnostic fallback estimator
├── pricing/
│   ├── fetch.ts             pricing loader (live + cached snapshot)
│   └── snapshot.json        versioned bundled pricing data
├── budget/
│   └── guardrails.ts        spend caps and preflight checks
└── cli.ts                   `llm-token-cost` binary
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit, strict
npm run test        # vitest
npm run build       # tsup -> dist/ (ESM + CJS + types)
npm run size        # inspect what would be published
```

## Releasing

```bash
npm version minor     # or patch / major
git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/publish.yml`, which typechecks,
tests, builds, publishes to npm with provenance, and creates a GitHub release.

## License

[MIT](./LICENSE)
