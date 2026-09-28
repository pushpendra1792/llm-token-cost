export type LlmTokenCostErrorCode =
  | 'UNKNOWN_MODEL'
  | 'PRICING_UNAVAILABLE'
  | 'PRICING_FETCH_FAILED'
  | 'BUDGET_EXCEEDED'
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

/** The cost that a hard-cap budget refused, with the totals around it. */
export interface BudgetExceededInfo {
  /** The budget's configured ceiling. */
  readonly limit: number;
  /**
   * Total the budget *would* reach if this cost were charged, i.e. the
   * tracked total plus `cost`. The budget's own recorded total is unchanged.
   */
  readonly total: number;
  /** The single cost that would have crossed the limit. */
  readonly cost: number;
  /** The budget's scope, defaulting to `default`. */
  readonly scope: string;
  /** True when `cost` came from an approximate estimate. */
  readonly estimated: boolean;
}

/**
 * Thrown by a `hard`-mode budget to stop a request before it is sent.
 *
 * Carries the same facts the `onBudgetExceeded` callback would have received,
 * because a hard cap reports by throwing instead of calling back.
 */
export class BudgetExceededError extends LlmTokenCostError {
  readonly limit: number;
  readonly total: number;
  readonly cost: number;
  readonly scope: string;
  readonly estimated: boolean;

  constructor(info: BudgetExceededInfo) {
    const { limit, total, cost, scope, estimated } = info;
    // `would` rather than `did`: nothing was charged, so this is the total the
    // budget would have reached had the call gone ahead.
    const approximation = estimated
      ? ' The cost was estimated, so it is approximate.'
      : '';
    super(
      'BUDGET_EXCEEDED',
      `Budget "${scope}" exceeded: cost ${cost} would bring tracked spend to ` +
        `${total}, past the limit of ${limit}.${approximation}`,
    );
    this.limit = limit;
    this.total = total;
    this.cost = cost;
    this.scope = scope;
    this.estimated = estimated;
  }
}
