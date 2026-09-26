export type PriceUnit = 'per_token' | 'per_1k' | 'per_1m';

export const TOKENS_PER_UNIT: Readonly<Record<PriceUnit, number>> = {
  per_token: 1,
  per_1k: 1_000,
  per_1m: 1_000_000,
};

/**
 * Normalizes a price expressed in `unit` to a price per single token.
 *
 * LiteLLM currently reports core token prices per token, but it also carries
 * ancillary fields priced per 1K/1M, and upstream schemas have changed before.
 * Normalizing at the edge keeps every downstream calculation unit-agnostic.
 */
export const toPerToken = (value: number, unit: PriceUnit): number =>
  value / TOKENS_PER_UNIT[unit];
