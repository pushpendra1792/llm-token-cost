import { BudgetExceededError, InvalidInputError } from '../errors';
import type { Budget, BudgetCheck, BudgetOptions, BudgetSpend } from './types';

const DEFAULT_SCOPE = 'default';

const MODES = ['soft', 'hard'];

/**
 * Slack, relative to the limit, for the "past the limit" comparison.
 *
 * Costs accumulate as binary floats, so three charges of `0.1` sum to
 * `0.30000000000000004` and would cross a `0.3` limit that was in fact met
 * exactly. Scaling the tolerance to the limit keeps that noise from firing
 * while still leaving very small limits (down to sub-cent) strict, where a
 * fixed epsilon would swallow real overruns.
 */
const LIMIT_TOLERANCE = 1e-9;

const isExceededTotal = (total: number, limit: number): boolean =>
  total - limit > Math.abs(limit) * LIMIT_TOLERANCE;

/**
 * Creates a budget with a spending limit and its own in-memory total.
 *
 * Nothing is shared between instances, which is what makes scoping trivial:
 * one budget per session or tag, each tracking its own total. State is lost
 * when the process exits, which is the intended trade for a guardrail that
 * needs no storage.
 *
 * The typical shape is estimate, then charge, then send:
 *
 * ```ts
 * const budget = createBudget({ limit: 1, scope: 'user-123' });
 * const estimate = await estimateCost({ model: 'gpt-4o', inputText, outputText });
 * budget.track(estimate); // throws in hard mode, before the request goes out
 * const completion = await callModel({ model: 'gpt-4o', inputText, outputText });
 * ```
 */
export const createBudget = (options: BudgetOptions): Budget => {
  if (options === null || typeof options !== 'object') {
    throw new InvalidInputError('createBudget requires an options object with a `limit`');
  }

  const { limit, mode = 'soft', onBudgetExceeded, scope = DEFAULT_SCOPE } = options;

  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new InvalidInputError('`limit` must be a finite number');
  }
  if (limit < 0) {
    throw new InvalidInputError('`limit` must not be negative');
  }
  if (!MODES.includes(mode)) {
    throw new InvalidInputError(`\`mode\` must be "soft" or "hard", received "${mode}"`);
  }
  if (onBudgetExceeded !== undefined && typeof onBudgetExceeded !== 'function') {
    throw new InvalidInputError('`onBudgetExceeded` must be a function');
  }
  if (typeof scope !== 'string') {
    throw new InvalidInputError('`scope` must be a string');
  }

  let total = 0;
  /** Currency the limit is denominated in, fixed by the first charge. */
  let currency: string | undefined;
  let notified = false;

  const assertChargeable = (spend: BudgetSpend): void => {
    if (spend === null || typeof spend !== 'object') {
      throw new InvalidInputError('a budget charge must be an object with a `cost`');
    }
    if (typeof spend.cost !== 'number' || !Number.isFinite(spend.cost)) {
      throw new InvalidInputError('`cost` must be a finite number');
    }
    if (spend.cost < 0) {
      throw new InvalidInputError(
        '`cost` must not be negative; a refund cannot be charged against a budget',
      );
    }
    if (typeof spend.currency !== 'string' || spend.currency === '') {
      throw new InvalidInputError('`currency` must be a non-empty string');
    }
    // Comparing a limit against costs in another currency would silently
    // produce a meaningless total, so refuse rather than add them up.
    if (currency !== undefined && spend.currency !== currency) {
      throw new InvalidInputError(
        `budget "${scope}" tracks ${currency} but was charged ${spend.currency}; ` +
          `a single budget cannot mix currencies`,
      );
    }
  };

  return {
    limit,
    scope,
    mode,

    getTotal: (): number => total,

    getRemaining: (): number => limit - total,

    isExceeded: (): boolean => isExceededTotal(total, limit),

    check: (spend: BudgetSpend): BudgetCheck => {
      assertChargeable(spend);
      const projectedTotal = total + spend.cost;
      return {
        projectedTotal,
        wouldExceed: isExceededTotal(projectedTotal, limit),
        remaining: limit - projectedTotal,
      };
    },

    track: (spend: BudgetSpend): void => {
      assertChargeable(spend);
      currency ??= spend.currency;

      const projectedTotal = total + spend.cost;
      if (!isExceededTotal(projectedTotal, limit)) {
        total = projectedTotal;
        return;
      }

      const context = {
        limit,
        total: projectedTotal,
        cost: spend.cost,
        scope,
        estimated: spend.estimated,
      };

      if (mode === 'hard') {
        // Thrown before `total` is touched: the blocked spend is not charged,
        // so the budget still reports what it has actually committed and a
        // cheaper retry can go ahead.
        throw new BudgetExceededError(context);
      }

      // Recorded before the callback runs, so a throwing callback cannot leave
      // the total disagreeing with the context it was just handed.
      total = projectedTotal;
      if (!notified) {
        notified = true;
        onBudgetExceeded?.(context);
      }
    },

    reset: (): void => {
      total = 0;
      currency = undefined;
      notified = false;
    },
  };
};
