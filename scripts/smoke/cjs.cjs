/**
 * Runs the packed tarball's CommonJS entry point from an empty directory.
 *
 * Same assertions as esm.mjs: with LLM_TOKEN_COST_PRICING_URL pointed at an
 * unreachable URL, every result must report pricingSource 'snapshot'.
 */
const assert = require('node:assert/strict');
const {
  estimateCost,
  estimateCostFromTokens,
  estimateCostFromUsage,
} = require('llm-token-cost');

const main = async () => {
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
    console.log(`cjs ${fn}: ${JSON.stringify({ cost: result.cost, pricingSource: result.pricingSource })}`);
    assert.equal(
      result.pricingSource,
      'snapshot',
      `${fn} should price from the bundled snapshot, got ${result.pricingSource}`,
    );
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
