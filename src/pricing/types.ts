export const PRICING_CURRENCY = 'USD';

/** Service tier for batch/flex/priority pricing programs. */
export type ServiceTier = 'standard' | 'batch' | 'flex' | 'priority';

/** Cache TTL tier for cache creation pricing. */
export type CacheTtl = '5m' | '1h';

export interface ModelPricing {
  /** Price per single input token, in `PRICING_CURRENCY`. */
  readonly input: number;
  /** Price per single output token, in `PRICING_CURRENCY`. */
  readonly output: number;
  /** Upstream provider identifier, when the source reported one. */
  readonly provider?: string;

  // --- Cache pricing (per token) ---
  /** Price per cached input token (cache read). */
  readonly cacheReadInput?: number;
  /** Price per cache write token (cache creation, TTL ≤ 5 minutes). */
  readonly cacheCreationInput?: number;
  /** Price per cache write token (cache creation, TTL > 1 hour). */
  readonly cacheCreationInputAbove1hr?: number;

  // --- Service tier pricing (per token) ---
  /** Batch API input price. */
  readonly inputBatch?: number;
  /** Batch API output price. */
  readonly outputBatch?: number;
  /** Flex processing input price. */
  readonly inputFlex?: number;
  /** Flex processing output price. */
  readonly outputFlex?: number;
  /** Priority processing input price. */
  readonly inputPriority?: number;
  /** Priority processing output price. */
  readonly outputPriority?: number;

  // --- Reasoning / thinking tokens ---
  /** Price per reasoning/thinking output token. */
  readonly outputReasoning?: number;

  // --- Context limits (informational) ---
  /** Maximum input tokens (context window). */
  readonly maxInputTokens?: number;
  /** Maximum output tokens per request. */
  readonly maxOutputTokens?: number;
}

export interface PricingTable {
  readonly schemaVersion: 1;
  readonly models: Readonly<Record<string, ModelPricing>>;
  /** ISO-8601 timestamp of when this table was produced. */
  readonly updatedAt: string;
  /** Where the data came from. */
  readonly source: string;
}

export type PricingSource = 'remote' | 'cache' | 'stale-cache' | 'snapshot';

export interface ResolvedPricing {
  readonly table: PricingTable;
  readonly source: PricingSource;
  /**
   * True when the table is a fallback approximation rather than live data:
   * either a stale cache entry or the bundled snapshot.
   */
  readonly estimated: boolean;
  /** Populated when a live fetch was attempted and failed. */
  readonly error?: Error;
}

export const isPriced = (pricing: ModelPricing | undefined): pricing is ModelPricing =>
  pricing !== undefined &&
  Number.isFinite(pricing.input) &&
  Number.isFinite(pricing.output);
