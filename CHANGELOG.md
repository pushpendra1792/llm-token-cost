# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
semantic versioning.

## 0.3.0 - unreleased

### Added

- Itemized costs in `estimateCostFromTokens`: `cacheReadInputTokens`,
  `cacheCreationInputTokens`, `reasoningOutputTokens`, `serviceTier` and
  `cacheTtl`, with a `breakdown` of one cost per category and `warnings` when a
  requested price is missing.
- `cacheCreation1hInputTokens` for a request that mixes 1-hour and 5-minute
  cache writes.
- `estimateCostFromUsage` for OpenAI chat, OpenAI Responses, Anthropic and
  Gemini usage objects, accepting either the usage object or a whole response.
- Long-context tier pricing from the LiteLLM feed, with the applied tier
  returned as `pricingTier`.
- `pricingSource` and `pricingUpdatedAt` on estimate results.
- A warning when bundled pricing is older than 90 days, configurable with
  `staleAfterDays`, and `DEFAULT_STALE_AFTER_DAYS`.
- A `pricing: snapshot (YYYY-MM-DD)` line in CLI table output when every row is
  priced from the bundled snapshot.

### Changed

- Packed size reduced from 376.4 kB to 158.2 kB (11 files to 9). The three
  sourcemaps are no longer in `files`, which is most of the difference; the
  bundles, type declarations and CLI are unchanged.
- Sourcemaps are no longer shipped in the tarball. They are still written to
  `dist/` for local debugging.
- The pricing normalizer is silent unless an `onWarn` callback is passed.
- CLI `--json` output includes `pricingSource` and `pricingUpdatedAt`.
- The pricing refresh writes `snapshot.json` and `limits.json` only when their
  content changed, and `generatedAt` records the date of the last model-content
  change.

### Fixed

- The scheduled pricing refresh now includes `limits.json` in its pull request
  alongside `snapshot.json`, and builds from the shared normalizer so tier
  fields are written into the snapshot.
- The refresh workflow's verification step accepts models that report only one
  context limit. 149 entries in the current snapshot have no `maxOutputTokens`.
- The refresh log printed `undefined` for the model count; it now prints the
  actual count.
- A 1-hour cache write in a long-context tier now uses the tier's 1-hour price
  rather than its 5-minute price.

### Upgrade notes

- Estimate results now include `pricingSource` and `pricingUpdatedAt` keys.
  Assertions that compare whole result objects, or JSON consumers that expect a
  fixed key set, need to account for them.
- Table output adds the `pricing: snapshot (YYYY-MM-DD)` line when every row is
  priced from the bundled snapshot. The line is absent for live and cached
  pricing.
- `estimated` keeps its meaning: `true` when either the token count or the
  price is approximate.
