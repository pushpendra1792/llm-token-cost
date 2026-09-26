export type LlmTokenCostErrorCode =
  | 'UNKNOWN_MODEL'
  | 'PRICING_UNAVAILABLE'
  | 'PRICING_FETCH_FAILED'
  | 'INVALID_INPUT';

export class LlmTokenCostError extends Error {
  readonly code: LlmTokenCostErrorCode;

  constructor(code: LlmTokenCostErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

const UNKNOWN_MODEL_HELP =
  'Pass a model id that exists in the LiteLLM pricing feed. Ids are OpenAI-style ' +
  '(for example gpt-4o) or provider-prefixed (for example azure/gpt-4o).';

/**
 * Thrown when a model has no usable pricing entry anywhere: not in the live
 * feed, not in the cache, and not in the bundled snapshot.
 */
export class UnknownModelError extends LlmTokenCostError {
  readonly model: string;

  constructor(model: string, options?: ErrorOptions) {
    super('UNKNOWN_MODEL', `No pricing found for model "${model}". ${UNKNOWN_MODEL_HELP}`, options);
    this.model = model;
  }
}

export class PricingFetchError extends LlmTokenCostError {
  readonly url: string;
  readonly status: number | undefined;

  constructor(message: string, url: string, status?: number, options?: ErrorOptions) {
    super('PRICING_FETCH_FAILED', message, options);
    this.url = url;
    this.status = status;
  }
}

export class InvalidInputError extends LlmTokenCostError {
  constructor(message: string) {
    super('INVALID_INPUT', message);
  }
}
