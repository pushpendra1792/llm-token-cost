export const PRICING_CURRENCY = 'USD';

export interface ModelPricing {
  /** Price per single input token, in `PRICING_CURRENCY`. */
  readonly input: number;
  /** Price per single output token, in `PRICING_CURRENCY`. */
  readonly output: number;
  /** Upstream provider identifier, when the source reported one. */
  readonly provider?: string;
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
