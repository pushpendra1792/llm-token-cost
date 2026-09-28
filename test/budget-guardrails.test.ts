import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBudget } from '../src/budget/guardrails';
import type { BudgetSpend } from '../src/budget/types';
import { BudgetExceededError, InvalidInputError, LlmTokenCostError } from '../src/errors';
import { estimateCost } from '../src/estimate';
import { resetPricingCache, setPricingFetch } from '../src/pricing/fetch';

const spend = (cost: number, estimated = false, currency = 'USD'): BudgetSpend => ({
  cost,
  currency,
  estimated,
});

const liveFetch = (): void => {
  setPricingFetch(
    vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          'gpt-4o': {
            input_cost_per_token: 0.0000025,
            output_cost_per_token: 0.00001,
            litellm_provider: 'openai',
          },
          'claude-sonnet-4-5': {
            input_cost_per_token: 0.000003,
            output_cost_per_token: 0.000015,
            litellm_provider: 'anthropic',
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch,
  );
};

beforeEach(() => {
  resetPricingCache();
  setPricingFetch(undefined);
});

afterEach(() => {
  resetPricingCache();
  setPricingFetch(undefined);
});

describe('createBudget options', () => {
  it('exposes the limit, scope and mode it was created with', () => {
    const budget = createBudget({ limit: 5, mode: 'hard', scope: 'user-123' });

    expect(budget.limit).toBe(5);
    expect(budget.scope).toBe('user-123');
    expect(budget.mode).toBe('hard');
  });

  it('defaults to soft mode and an unnamed scope', () => {
    const budget = createBudget({ limit: 5 });

    expect(budget.mode).toBe('soft');
    expect(budget.scope).toBe('default');
  });

  it('starts at zero and not exceeded', () => {
    const budget = createBudget({ limit: 5 });

    expect(budget.getTotal()).toBe(0);
    expect(budget.getRemaining()).toBe(5);
    expect(budget.isExceeded()).toBe(false);
  });

  it('rejects a limit that is negative, NaN or not finite', () => {
    expect(() => createBudget({ limit: -1 })).toThrow(InvalidInputError);
    expect(() => createBudget({ limit: Number.NaN })).toThrow(InvalidInputError);
    expect(() => createBudget({ limit: Number.POSITIVE_INFINITY })).toThrow(InvalidInputError);
  });

  it('rejects an unknown mode and a non-function callback', () => {
    expect(() => createBudget({ limit: 1, mode: 'strict' as 'hard' })).toThrow(InvalidInputError);
    expect(() =>
      createBudget({ limit: 1, onBudgetExceeded: 'nope' as unknown as () => void }),
    ).toThrow(InvalidInputError);
  });
});

describe('soft mode', () => {
  it('does not fire the callback while under the limit', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 1, onBudgetExceeded });

    budget.track(spend(0.25));
    budget.track(spend(0.25));

    expect(onBudgetExceeded).not.toHaveBeenCalled();
    expect(budget.getTotal()).toBe(0.5);
    expect(budget.isExceeded()).toBe(false);
  });

  it('records the cost and fires once with the full context on crossing', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 1, scope: 'batch-job', onBudgetExceeded });

    budget.track(spend(0.6));
    budget.track(spend(0.5, true));

    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);
    expect(onBudgetExceeded).toHaveBeenCalledWith({
      limit: 1,
      total: 1.1,
      cost: 0.5,
      scope: 'batch-job',
      estimated: true,
    });
    // Soft mode still charges the cost: the caller was told, not stopped.
    expect(budget.getTotal()).toBeCloseTo(1.1, 12);
    expect(budget.isExceeded()).toBe(true);
    expect(budget.getRemaining()).toBeCloseTo(-0.1, 12);
  });

  it('fires only on the first crossing and keeps accumulating afterwards', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 1, onBudgetExceeded });

    budget.track(spend(1.5));
    budget.track(spend(0.25));
    budget.track(spend(0.25));

    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);
    expect(budget.getTotal()).toBe(2);
  });

  it('works without a callback', () => {
    const budget = createBudget({ limit: 1 });

    expect(() => {
      budget.track(spend(2));
    }).not.toThrow();
    expect(budget.isExceeded()).toBe(true);
  });

  it('keeps the recorded cost when the callback throws', () => {
    const budget = createBudget({
      limit: 1,
      onBudgetExceeded: () => {
        throw new Error('callback exploded');
      },
    });
    budget.track(spend(0.5));

    expect(() => budget.track(spend(0.75))).toThrow('callback exploded');
    // The cost was charged before the callback ran, so the budget and the
    // context it was handed cannot disagree.
    expect(budget.getTotal()).toBe(1.25);
  });
});

describe('hard mode', () => {
  it('throws before the spend is recorded', () => {
    const budget = createBudget({ limit: 0.1, mode: 'hard' });
    budget.track(spend(0.05));

    expect(() => budget.track(spend(0.06))).toThrow(BudgetExceededError);

    // The blocked cost is not charged, so the budget still reflects only what
    // was actually committed.
    expect(budget.getTotal()).toBe(0.05);
    expect(budget.isExceeded()).toBe(false);
    expect(budget.getRemaining()).toBeCloseTo(0.05, 12);
  });

  it('lets a smaller retry through, because the blocked spend was not charged', () => {
    const budget = createBudget({ limit: 0.1, mode: 'hard' });
    budget.track(spend(0.05));

    expect(() => budget.track(spend(0.06))).toThrow(BudgetExceededError);
    expect(() => budget.track(spend(0.05))).not.toThrow();

    expect(budget.getTotal()).toBe(0.1);
  });

  it('keeps throwing on every further attempt, with the total unmoved', () => {
    const budget = createBudget({ limit: 1, mode: 'hard' });
    budget.track(spend(0.75));

    expect(() => budget.track(spend(0.5))).toThrow(BudgetExceededError);
    expect(() => budget.track(spend(0.5))).toThrow(BudgetExceededError);

    expect(budget.getTotal()).toBe(0.75);
    expect(budget.isExceeded()).toBe(false);
  });

  it('reports through the error rather than the callback', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({
      limit: 1,
      mode: 'hard',
      scope: 'user-123',
      onBudgetExceeded,
    });
    budget.track(spend(0.6));

    expect(() => budget.track(spend(0.5, true))).toThrow(BudgetExceededError);
    expect(onBudgetExceeded).not.toHaveBeenCalled();

    try {
      budget.track(spend(0.5, true));
      expect.unreachable('track should have thrown');
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      expect(error).toBeInstanceOf(LlmTokenCostError);
      expect(error.code).toBe('BUDGET_EXCEEDED');
      expect(error.name).toBe('BudgetExceededError');
      expect(error.limit).toBe(1);
      expect(error.total).toBe(1.1);
      expect(error.cost).toBe(0.5);
      expect(error.scope).toBe('user-123');
      expect(error.estimated).toBe(true);
      expect(error.message).toContain('would bring tracked spend to 1.1');
      expect(error.message).toContain('estimated');
    }
  });

  it('omits the approximation note for an exact cost', () => {
    const budget = createBudget({ limit: 0.01, mode: 'hard' });

    try {
      budget.track(spend(0.02, false));
      expect.unreachable('track should have thrown');
    } catch (error) {
      if (!(error instanceof BudgetExceededError)) throw error;
      expect(error.estimated).toBe(false);
      expect(error.message).not.toContain('estimated, so it is approximate');
    }
  });
});

describe('scoped budgets', () => {
  it('keeps each budget total independent', () => {
    const user = createBudget({ limit: 1, scope: 'user-123' });
    const job = createBudget({ limit: 1, scope: 'batch-job' });

    user.track(spend(0.75));
    user.track(spend(0.5));

    expect(user.getTotal()).toBe(1.25);
    expect(user.isExceeded()).toBe(true);
    // The overspend on one budget must not appear on another.
    expect(job.getTotal()).toBe(0);
    expect(job.isExceeded()).toBe(false);
    expect(job.getRemaining()).toBe(1);
  });

  it('reports its own scope to each callback, so one handler can serve many', () => {
    const seen: string[] = [];
    const onBudgetExceeded = vi.fn((context: { scope: string }): void => {
      seen.push(context.scope);
    });
    const user = createBudget({ limit: 0.1, scope: 'user-123', onBudgetExceeded });
    const job = createBudget({ limit: 0.1, scope: 'batch-job', onBudgetExceeded });

    user.track(spend(0.2));
    expect(seen).toEqual(['user-123']);
    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);

    job.track(spend(0.2));
    expect(seen).toEqual(['user-123', 'batch-job']);
    expect(onBudgetExceeded).toHaveBeenCalledTimes(2);
  });

  it('does not share state between budgets that reuse the same scope label', () => {
    const first = createBudget({ limit: 1, scope: 'shared' });
    const second = createBudget({ limit: 1, scope: 'shared' });

    first.track(spend(0.75));
    second.track(spend(0.25));

    expect(first.getTotal()).toBe(0.75);
    expect(second.getTotal()).toBe(0.25);
  });

  it('keeps a hard cap on one budget from blocking another', () => {
    const capped = createBudget({ limit: 0.1, mode: 'hard', scope: 'user-123' });
    const open = createBudget({ limit: 0.1, mode: 'hard', scope: 'batch-job' });

    expect(() => capped.track(spend(0.5))).toThrow(BudgetExceededError);
    expect(() => open.track(spend(0.05))).not.toThrow();

    expect(capped.getTotal()).toBe(0);
    expect(open.getTotal()).toBe(0.05);
  });
});

describe('check', () => {
  it('previews a charge without recording it or calling back', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 1, scope: 'user-123', onBudgetExceeded });

    const result = budget.check(spend(1.5));

    expect(result).toEqual({ projectedTotal: 1.5, wouldExceed: true, remaining: -0.5 });
    expect(budget.getTotal()).toBe(0);
    expect(onBudgetExceeded).not.toHaveBeenCalled();
  });

  it('reports remaining budget after a charge that fits', () => {
    const budget = createBudget({ limit: 1 });
    budget.track(spend(0.4));

    expect(budget.check(spend(0.25))).toEqual({
      projectedTotal: 0.65,
      wouldExceed: false,
      remaining: 0.35,
    });
  });

  it('agrees with track on whether a charge crosses the limit', () => {
    const budget = createBudget({ limit: 1 });
    budget.track(spend(0.6));

    const fits = spend(0.3);
    expect(budget.check(fits).wouldExceed).toBe(false);
    budget.track(fits);
    expect(budget.getTotal()).toBeCloseTo(0.9, 12);
    expect(budget.isExceeded()).toBe(false);

    const oversized = spend(0.2);
    expect(budget.check(oversized).wouldExceed).toBe(true);
    budget.track(oversized);
    expect(budget.isExceeded()).toBe(true);
  });

  it('rejects an invalid cost without mutating the budget', () => {
    const budget = createBudget({ limit: 1 });

    expect(() => budget.check(spend(Number.NaN))).toThrow(InvalidInputError);
    expect(() => budget.check(spend(-1))).toThrow(InvalidInputError);
    expect(budget.getTotal()).toBe(0);
  });
});

describe('edge cases', () => {
  it('treats a zero limit as "nothing may be spent"', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 0, onBudgetExceeded });

    budget.track(spend(0));
    expect(onBudgetExceeded).not.toHaveBeenCalled();
    expect(budget.isExceeded()).toBe(false);

    budget.track(spend(0.01));

    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);
    expect(onBudgetExceeded).toHaveBeenCalledWith({
      limit: 0,
      total: 0.01,
      cost: 0.01,
      scope: 'default',
      estimated: false,
    });
    expect(budget.getTotal()).toBe(0.01);
  });

  it('blocks the very first charge under a hard zero limit', () => {
    const budget = createBudget({ limit: 0, mode: 'hard' });

    expect(() => budget.track(spend(0.01))).toThrow(BudgetExceededError);
    expect(budget.getTotal()).toBe(0);
  });

  it('allows a spend that lands exactly on the limit', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 1, onBudgetExceeded });

    budget.track(spend(0.5));
    budget.track(spend(0.5));

    expect(onBudgetExceeded).not.toHaveBeenCalled();
    expect(budget.getTotal()).toBe(1);
    expect(budget.getRemaining()).toBe(0);
    expect(budget.isExceeded()).toBe(false);
  });

  it('does not let float accumulation cross a limit that was met exactly', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 0.3, onBudgetExceeded });

    // 0.1 + 0.1 + 0.1 is 0.30000000000000004 in binary floating point.
    budget.track(spend(0.1));
    budget.track(spend(0.1));
    budget.track(spend(0.1));

    expect(onBudgetExceeded).not.toHaveBeenCalled();
    expect(budget.getTotal()).toBeCloseTo(0.3, 12);
    expect(budget.isExceeded()).toBe(false);

    budget.track(spend(0.01));

    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);
    expect(budget.isExceeded()).toBe(true);
  });

  it('rejects a negative cost', () => {
    const budget = createBudget({ limit: 1 });

    expect(() => budget.track(spend(-0.5))).toThrow(InvalidInputError);
    expect(budget.getTotal()).toBe(0);
  });

  it('rejects a NaN cost instead of poisoning the total', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 1, onBudgetExceeded });
    budget.track(spend(0.5));

    expect(() => budget.track(spend(Number.NaN))).toThrow(InvalidInputError);
    expect(() => budget.track(spend(Number.POSITIVE_INFINITY))).toThrow(InvalidInputError);

    expect(budget.getTotal()).toBe(0.5);
    expect(onBudgetExceeded).not.toHaveBeenCalled();
  });

  it('rejects a malformed charge', () => {
    const budget = createBudget({ limit: 1 });

    expect(() => budget.track(undefined as unknown as BudgetSpend)).toThrow(InvalidInputError);
    expect(() => budget.track({ cost: 1, currency: '', estimated: false })).toThrow(
      InvalidInputError,
    );
  });

  it('refuses to mix currencies inside one budget', () => {
    const budget = createBudget({ limit: 10, scope: 'user-123' });
    budget.track(spend(1));

    expect(() => budget.track(spend(1, false, 'EUR'))).toThrow(InvalidInputError);
    expect(budget.getTotal()).toBe(1);
  });
});

describe('reset', () => {
  it('clears the total and re-arms the callback', () => {
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 1, onBudgetExceeded });
    budget.track(spend(2));

    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);

    budget.reset();

    expect(budget.getTotal()).toBe(0);
    expect(budget.isExceeded()).toBe(false);
    expect(budget.getRemaining()).toBe(1);

    budget.track(spend(2));
    expect(onBudgetExceeded).toHaveBeenCalledTimes(2);
  });

  it('keeps the limit and mode', () => {
    const budget = createBudget({ limit: 0.1, mode: 'hard' });
    budget.reset();

    expect(budget.limit).toBe(0.1);
    expect(budget.mode).toBe('hard');
    expect(() => budget.track(spend(0.2))).toThrow(BudgetExceededError);
  });
});

describe('integration with estimateCost', () => {
  it('charges a result straight from estimateCost', async () => {
    liveFetch();
    const budget = createBudget({ limit: 1, scope: 'user-123' });

    const result = await estimateCost({
      model: 'gpt-4o',
      inputText: 'Summarize this article.',
      outputText: 'Here is the summary.',
    });

    budget.check(result);
    budget.track(result);

    expect(budget.getTotal()).toBeCloseTo(result.cost, 15);
    expect(budget.isExceeded()).toBe(false);
  });

  it('carries the estimated flag through to the callback', async () => {
    liveFetch();
    const onBudgetExceeded = vi.fn();
    const budget = createBudget({ limit: 0, onBudgetExceeded });

    // Claude is priced from a heuristic token count, so the cost is
    // approximate and the budget says so.
    const result = await estimateCost({ model: 'claude-sonnet-4-5', inputText: 'Hello' });
    expect(result.estimated).toBe(true);

    budget.track(result);

    expect(onBudgetExceeded).toHaveBeenCalledTimes(1);
    expect(onBudgetExceeded).toHaveBeenCalledWith({
      limit: 0,
      total: result.cost,
      cost: result.cost,
      scope: 'default',
      estimated: true,
    });
  });

  it('does not charge a cost that a hard cap refused', async () => {
    liveFetch();
    const budget = createBudget({ limit: 0, mode: 'hard' });

    const result = await estimateCost({ model: 'gpt-4o', inputText: 'Hello' });

    expect(() => budget.track(result)).toThrow(BudgetExceededError);
    expect(budget.getTotal()).toBe(0);
  });

  it('leaves estimateCost itself untouched when no budget is used', async () => {
    liveFetch();

    const result = await estimateCost({ model: 'gpt-4o', inputText: 'Hello' });

    expect(result).toEqual({
      inputTokens: 1,
      outputTokens: 0,
      cost: 0.0000025,
      currency: 'USD',
      estimated: false,
    });
  });
});
