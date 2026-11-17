/**
 * Runs the packed tarball's ESM entry point from an empty directory.
 *
 * The CI job sets LLM_TOKEN_COST_PRICING_URL to an unreachable URL, so every
 * result must come from the bundled snapshot. Any other pricingSource means the
 * smoke test is not exercising the offline path, so the job fails.
 */
import assert from 'node:assert/strict';
import {
  estimateCost,
  estimateCostFromTokens,
  estimateCostFromUsage,
} from 'llm-token-cost';

const results = {
  estimateCost: await estimateCost({
    model: 'gpt-4o',
    inputText: 'Summarize this article in three bullet points.',
    outputText: 'Here is the summary you requested.',
  }),
  estimateCostFromTokens: await estimateCostFromTokens({
    model: 'claude-sonnet-4-5',
    inputTokens: 1200,
    outputTokens: 300,
  }),
  estimateCostFromUsage: await estimateCostFromUsage({
    model: 'gemini-2.5-flash',
    usage: { promptTokenCount: 1200, candidatesTokenCount: 300 },
  }),
};

for (const [fn, result] of Object.entries(results)) {
  console.log(`esm ${fn}: ${JSON.stringify({ cost: result.cost, pricingSource: result.pricingSource })}`);
  assert.equal(
    result.pricingSource,
    'snapshot',
    `${fn} should price from the bundled snapshot, got ${result.pricingSource}`,
  );
}
