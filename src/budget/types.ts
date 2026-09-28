/**
 * What a budget does when a tracked cost would push the total past its limit.
 *
 * - `soft` (default) records the cost and fires `onBudgetExceeded`. Nothing is
 *   stopped; the caller decides what to do next.
 * - `hard` throws a `BudgetExceededError` *without* recording the cost, so a
 *   request can be abandoned before it is sent. `onBudgetExceeded` is not
 *   called in this mode: the error already carries the same context, and a
 *   caller about to catch it should not also have to handle a callback.
 */
export type BudgetMode = 'soft' | 'hard';

/**
 * A single cost to charge against a budget.
 *
 * The result of `estimateCost` satisfies this shape, so an estimate can be
 * passed straight to {@link Budget.track} without repacking it.
 */
export interface BudgetSpend {
  /** Cost in `currency`. Must be finite and non-negative. */
  readonly cost: number;
  readonly currency: string;
  /**
   * True when `cost` is approximate, as reported by `estimateCost`.
   *
   * A budget check on an estimated cost is only as good as that estimate: the
   * real charge can land on either side of the limit, so a hard cap can miss a
   * small overrun. Treat `estimated` results as a guardrail, not an exact cap.
   */
  readonly estimated: boolean;
}

/** What an exceeded budget reports, to a callback or through an error. */
export interface BudgetExceededContext {
  /** The budget's configured ceiling. */
  readonly limit: number;
  /** Tracked total *including* the cost that crossed the limit. */
  readonly total: number;
  /** The single cost that pushed the total past `limit`. */
  readonly cost: number;
  /** The budget's scope, so one callback can serve several budgets. */
  readonly scope: string;
  /** True when the crossing cost came from an approximate estimate. */
  readonly estimated: boolean;
}

/** The outcome of inspecting a cost without recording it. */
export interface BudgetCheck {
  /** Tracked total if the cost were charged. */
  readonly projectedTotal: number;
  /** True when charging this cost would cross the limit. */
  readonly wouldExceed: boolean;
  /** Budget left after charging this cost. Negative when `wouldExceed`. */
  readonly remaining: number;
}

export interface BudgetOptions {
  /** Spending ceiling. Must be finite and non-negative; `0` allows nothing. */
  readonly limit: number;
  /** Defaults to `soft`. */
  readonly mode?: BudgetMode;
  /**
   * Called once, the first time a tracked cost crosses the limit.
   *
   * Not called while the budget is under its limit, and not called again once
   * it has fired. Only used in `soft` mode. An exception thrown here propagates
   * to the caller of `track`, after the cost has already been recorded.
   */
  readonly onBudgetExceeded?: (context: BudgetExceededContext) => void;
  /**
   * Label for this budget, e.g. a session id or job tag. Reported to the
   * callback and on errors. Defaults to `default`.
   *
   * A scope is a label only. Budgets never share state: separate budgets are
   * separate objects with independent totals, so a scope cannot leak spend into
   * another budget.
   */
  readonly scope?: string;
}

/**
 * A spending limit tracked in memory.
 *
 * Every total lives in this object and nowhere else: no persistence, no shared
 * registry, no network. State lasts as long as the object, so separate budgets
 * for separate sessions or tags are just separate instances.
 */
export interface Budget {
  readonly limit: number;
  readonly scope: string;
  readonly mode: BudgetMode;
  /** Everything charged so far. In `soft` mode this can exceed the limit. */
  getTotal(): number;
  /** `limit - getTotal()`. Negative once the budget has been exceeded. */
  getRemaining(): number;
  /** Whether the tracked total is past the limit. */
  isExceeded(): boolean;
  /**
   * Inspect a cost without charging it.
   *
   * Never records and never calls back, so it is safe to use as a preview or
   * to gate a decision on its own.
   */
  check(spend: BudgetSpend): BudgetCheck;
  /**
   * Charges a cost against the budget.
   *
   * In `soft` mode the cost is always recorded, and the first crossing fires
   * `onBudgetExceeded`. In `hard` mode a crossing throws `BudgetExceededError`
   * and records nothing, leaving the total where it was so a smaller request
   * can still go ahead.
   *
   * Throws `InvalidInputError` for a non-finite, negative or non-USD cost.
   */
  track(spend: BudgetSpend): void;
  /** Clears the tracked total and the already-fired flag. Keeps limit and mode. */
  reset(): void;
}
