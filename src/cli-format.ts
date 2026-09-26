import type { EstimateCostResult } from './estimate';

export interface ModelEstimate {
  readonly model: string;
  readonly estimate: EstimateCostResult;
}

/**
 * Costs span many orders of magnitude (a single short prompt can be sub-cent,
 * a long batch can be hundreds of dollars), so precision is chosen per value
 * rather than fixed. Below 1e-8 a fixed-decimal format would print all zeros,
 * so those fall back to exponential notation.
 */
export const formatCost = (cost: number): string => {
  if (!Number.isFinite(cost)) return String(cost);
  if (cost === 0) return '0';

  const magnitude = Math.abs(cost);
  if (magnitude >= 0.01) return cost.toFixed(4);
  if (magnitude >= 0.0001) return cost.toFixed(6);
  if (magnitude >= 1e-8) return cost.toFixed(8);
  return cost.toExponential(2);
};

const pad = (value: string, width: number, align: 'left' | 'right'): string =>
  align === 'left' ? value.padEnd(width) : value.padStart(width);

/**
 * Renders a plain aligned table. Deliberately not a box-drawing table: aligned
 * columns stay readable in CI logs and survive copy-paste into a spreadsheet.
 */
export const formatTable = (
  rows: readonly ModelEstimate[],
  options: { readonly hasOutput: boolean },
): string => {
  const headers = ['MODEL', 'INPUT'];
  if (options.hasOutput) headers.push('OUTPUT');
  headers.push('COST', 'CURRENCY', 'ESTIMATED');

  const body = rows.map(({ model, estimate }): string[] => {
    const cells = [model, String(estimate.inputTokens)];
    if (options.hasOutput) cells.push(String(estimate.outputTokens));
    cells.push(formatCost(estimate.cost), estimate.currency, estimate.estimated ? 'yes' : 'no');
    return cells;
  });

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...body.map((cells) => (cells[column] ?? '').length)),
  );

  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => pad(cell, widths[column] ?? 0, column === 0 ? 'left' : 'right'))
      .join('  ')
      .trimEnd();

  const lines = [renderRow(headers), ...body.map(renderRow)];
  return `${lines.join('\n')}\n`;
};

/** Compact, single-line JSON: valid for piping into `jq` without post-processing. */
export const formatJson = (value: unknown): string => `${JSON.stringify(value)}\n`;

export interface SerializedError {
  readonly name: string;
  readonly code?: string;
  readonly model?: string;
  readonly message: string;
}

export const toSerializedError = (error: unknown): SerializedError => {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const model = 'model' in error && typeof error.model === 'string' ? error.model : undefined;
    return {
      name: error.name,
      ...(code === undefined ? {} : { code }),
      ...(model === undefined ? {} : { model }),
      message: error.message,
    };
  }
  return { name: 'Error', message: String(error) };
};

/**
 * Single-model JSON output is the raw `estimateCost()` result, unmodified.
 * Comparison output is an array with the model id folded in, since the result
 * itself does not carry one.
 */
export const toJsonPayload = (rows: readonly ModelEstimate[], compare: boolean): unknown =>
  compare ? rows.map(({ model, estimate }) => ({ model, ...estimate })) : rows[0]?.estimate;
