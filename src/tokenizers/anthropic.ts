/**
 * Anthropic model handling.
 *
 * ## Why there is no Anthropic tokenizer here
 *
 * `@anthropic-ai/tokenizer` exists and is installable, and it is tempting: it
 * would give a "real" BPE count instead of an estimate. It was evaluated and
 * rejected, for reasons that are not going to change on their own:
 *
 * - **Abandoned.** Last published 2023-07-05 at version `0.0.4`, and never
 *   released again. It predates Claude 3 (2024-03), so its vocabulary cannot
 *   describe any currently sold model.
 * - **Its own README disclaims it.** "This package can be used to count tokens
 *   for Anthropic's older models. As of the Claude 3 models, this algorithm is
 *   no longer accurate, but can be used as a very rough approximation."
 * - **Anthropic says client-side counting is not coming back.** Asked directly
 *   in anthropic-sdk-typescript#360, the answer was that it is "no longer
 *   possible to provide ahead-of-time client-side accurate token counts", and to
 *   "use heuristic estimates and give yourself a buffer".
 * - **It drags in the dependency this package exists to avoid.** It depends on
 *   `tiktoken@^1`, the stale CJS line that `llm-token-cost` replaced with
 *   `js-tiktoken`, and it ships CJS-only.
 *
 * The one remaining exact option is the `count_tokens` API, which needs an
 * Anthropic API key and a network round trip. That is a different product: this
 * library is for the question asked *before* the request, with no credentials
 * and no latency. So the answer is a tuned heuristic, and `estimated` is
 * reported as `true` for every Anthropic model.
 *
 * ## What the correction factors are, and are not
 *
 * The base blend in `heuristic.ts` is calibrated against OpenAI's BPE
 * tokenizers. Two published facts let it be corrected for Claude. Both are
 * documented statements, not measurements taken here:
 *
 * 1. Anthropic's own guidance (`anthropics/skills`,
 *    `skills/claude-api/shared/token-counting.md`) is blunt about it: "Do not
 *    use `tiktoken`. It's OpenAI's tokenizer. It undercounts Claude tokens by
 *    ~15-20% on typical text, and by much more on code or non-English input."
 *    If tiktoken returns 0.85x the true count, the true count is `tiktoken / 0.85`
 *    = 1.18x; at 20% it is 1.25x. {@link CLAUDE_TIKTOKEN_RATIO} takes 1.2, near
 *    the middle of that band and deliberately biased high. Biasing high is the
 *    safe direction for a pre-flight check: the tiktoken gap is consistently one
 *   -sided, so an estimate that errs low would under-report cost, while one that
 *    errs high only reserves more budget than needed.
 * 2. Claude 4.7 and later, plus the Claude Fable and Claude Mythos families,
 *    ship a **newer tokenizer** that "produces approximately 30 percent more
 *    tokens than on earlier models"
 *    (platform.claude.com/docs/en/build-with-claude/token-counting). That
 *    applies on top of (1), so current-generation models get 1.2 * 1.3 = 1.56x.
 *
 * These factors are the honest ceiling of what is knowable offline, and the
 * largest known weakness is that a flat multiplier is a blunt instrument: the
 * 15-20% is a *typical text* figure, and reported drift runs from ~9% on English
 * prose to ~24% on code diffs and ~38% on serialized JSON, because the two BPEs
 * diverge most on the inputs neither was optimized for. A single ratio cannot
 * capture that spread, and Anthropic's guidance is effectively "do not
 * multiply at all, call `count_tokens`". This is a documented approximation, and
 * the tests pin the behaviour rather than the accuracy.
 *
 * Validated against the one public ground truth available: Anthropic's docs
 * report `input_tokens: 14` for system `"You are a scientist"` plus the user
 * message `"Hello, Claude"` on `claude-opus-5-5`, and the current-generation
 * estimate returns 13 for that content. The residual token is not error —
 * Anthropic notes counts "may include tokens added automatically by Anthropic
 * for system optimizations" and that "you are not billed for system-added
 * tokens" — so on the number actually charged, 13 against 14 is effectively
 * exact for that sample.
 */

import { estimateTokensHeuristicScaled } from './heuristic';
import type { AnthropicTokenizerGeneration } from './types';

/**
 * Correction for `tiktoken`-calibrated counts on Claude 3 through Claude Opus
 * 4.6, from Anthropic's published "~15-20% on typical text" undercount band.
 * See the module comment for why this is biased high.
 */
const CLAUDE_TIKTOKEN_RATIO = 1.2;

/**
 * Additional factor for the tokenizer introduced with Claude Opus 4.7, which
 * yields "~30 percent more tokens" for the same text.
 */
const CLAUDE_CURRENT_TOKENIZER_RATIO = 1.3;

/**
 * Matches the family and version of a Claude model id, tolerating every
 * separator style the ecosystem uses:
 *
 * - `claude-sonnet-4-5`, `claude-opus-4-5`        canonical, dashed
 * - `claude-opus-4.5`                              gateway, dotted
 * - `claude-3-5-sonnet-20241022`                   dated
 * - `us.anthropic.claude-opus-4-5-20251101-v1:0`   Bedrock, region-prefixed
 * - `vertex_ai/claude-sonnet-4-5@20250929`         Vertex, `@`-suffixed
 * - `claude-v1`, `claude-v2:1`, `claude-instant-v1` legacy
 *
 * Capture groups are the major and minor version; the minor group is absent for
 * ids like `claude-3-opus` and `claude-sonnet-5`.
 *
 * The minor group is capped at two digits and must not be followed by another
 * digit. Without that guard, the release date in `claude-sonnet-4-20250514` is
 * read as minor version 20250514, which is `>= 7` and so silently reclassifies
 * a pre-4.7 model onto the newer tokenizer and inflates its count by ~30%.
 */
const CLAUDE_VERSION_PATTERN =
  /claude[-.]?(?:opus|sonnet|haiku|fable|mythos|instant)?[-.]?v?(\d+)(?:[-.](\d{1,2})(?!\d))?/i;

/**
 * Claude Mythos Preview carries no version number but ships the newer
 * tokenizer, and Anthropic calls it out separately from the "4.7 and later"
 * rule, so it cannot be left to the numeric boundary below.
 */
const CLAUDE_MYTHOS_PREVIEW_PATTERN = /mythos[-.]?preview/i;

/** First model generation on the newer tokenizer, as `4.7`. */
const NEW_TOKENIZER_MINOR = 7;
/** Major version at which every release is on the newer tokenizer. */
const NEW_TOKENIZER_MAJOR = 5;

/**
 * True when the id names a Claude model under any provider prefix.
 *
 * Matching on the name rather than the pricing `provider` field is deliberate:
 * across the bundled snapshot only 20 of 329 Claude entries report
 * `provider: "anthropic"`, the rest being gateways such as `bedrock`,
 * `openrouter`, `vertex_ai-anthropic_models` and `databricks`. A provider-based
 * test would miss 94% of them. Every one of those ids contains `claude`, so the
 * name test covers all 329.
 */
export const isAnthropicModel = (model: string): boolean => /claude/i.test(model);

/**
 * Which Anthropic tokenizer generation a model uses.
 *
 * The boundary is `Claude Opus 4.7`: at and after it, and for the whole Claude
 * Fable / Claude Mythos line, the newer tokenizer applies. Everything before,
 * including Claude 3.x and the Claude Opus 4 through 4.6 releases, uses the
 * older one. Ids with no parseable version default to `legacy`, which is the
 * safer default: it under-applies the correction rather than inflating counts
 * for a model that may predate the change.
 */
export const anthropicTokenizerGeneration = (model: string): AnthropicTokenizerGeneration => {
  if (CLAUDE_MYTHOS_PREVIEW_PATTERN.test(model)) return 'current';

  const match = CLAUDE_VERSION_PATTERN.exec(model);
  if (match === null) return 'legacy';

  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);

  if (major >= NEW_TOKENIZER_MAJOR) return 'current';
  if (major === 4 && minor >= NEW_TOKENIZER_MINOR) return 'current';
  return 'legacy';
};

/**
 * Scale to apply to the OpenAI-calibrated blend for a given model, exposed so
 * the correction is inspectable and testable rather than buried in arithmetic.
 */
export const anthropicTokenRatio = (model: string): number =>
  anthropicTokenizerGeneration(model) === 'current'
    ? CLAUDE_TIKTOKEN_RATIO * CLAUDE_CURRENT_TOKENIZER_RATIO
    : CLAUDE_TIKTOKEN_RATIO;

/**
 * Estimates Claude token counts. Always an approximation, never exact: see the
 * module comment for why no client-side exact path exists.
 */
export const estimateTokensAnthropic = (model: string, text: string): number =>
  estimateTokensHeuristicScaled(text, anthropicTokenRatio(model));
