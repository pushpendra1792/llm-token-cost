import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, parseArgs, USAGE } from '../src/cli-args';
import { formatCost, formatJson, formatTable, toJsonPayload, toSerializedError } from '../src/cli-format';
import type { EstimateCostResult } from '../src/estimate';

const estimate = (overrides: Partial<EstimateCostResult> = {}): EstimateCostResult => ({
  inputTokens: 10,
  outputTokens: 4,
  cost: 0.000095,
  currency: 'USD',
  estimated: false,
  ...overrides,
});

describe('parseArgs: text input', () => {
  it('captures a positional text argument', () => {
    expect(parseArgs(['summarize this']).text).toBe('summarize this');
  });

  it('joins multiple positionals into one string', () => {
    expect(parseArgs(['summarize', 'this', 'article']).text).toBe('summarize this article');
  });

  it('leaves text undefined when absent', () => {
    expect(parseArgs([]).text).toBeUndefined();
    expect(parseArgs(['--model', 'gpt-4o']).text).toBeUndefined();
  });

  it('treats everything after -- as literal text', () => {
    const args = parseArgs(['--json', '--', '--model', 'not-a-flag']);
    expect(args.text).toBe('--model not-a-flag');
    expect(args.json).toBe(true);
  });

  it('ignores a bare - as text', () => {
    expect(parseArgs(['-']).text).toBe('-');
  });
});

describe('parseArgs: models', () => {
  it('defaults to gpt-4o when no model is given', () => {
    const args = parseArgs(['hi']);
    expect(args.models).toEqual([DEFAULT_MODEL]);
    expect(args.compare).toBe(false);
  });

  it('accepts --model and -m', () => {
    expect(parseArgs(['--model', 'gpt-4o']).models).toEqual(['gpt-4o']);
    expect(parseArgs(['-m', 'claude-sonnet-4-5']).models).toEqual(['claude-sonnet-4-5']);
  });

  it('accepts the inline --model= form', () => {
    expect(parseArgs(['--model=gpt-4o-mini']).models).toEqual(['gpt-4o-mini']);
  });

  it('splits a comma-separated list and trims whitespace', () => {
    expect(parseArgs(['--model', ' gpt-4o , gpt-4o-mini ,, claude-sonnet-4-5 ']).models).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
      'claude-sonnet-4-5',
    ]);
  });

  it('accumulates repeated --model flags', () => {
    expect(parseArgs(['-m', 'gpt-4o', '-m', 'gpt-4o-mini']).models).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('deduplicates while preserving order', () => {
    expect(parseArgs(['-m', 'gpt-4o,gpt-4o-mini', '-m', 'gpt-4o']).models).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
  });

  it('reports a missing or empty model value', () => {
    expect(parseArgs(['--model']).errors).toEqual(['--model requires a value']);
    expect(parseArgs(['-m', '--json']).errors).toEqual(['-m requires a value']);
    expect(parseArgs(['--model=']).errors).toEqual(['--model requires a value']);
  });
});

describe('parseArgs: compare', () => {
  it('is false for a single model', () => {
    expect(parseArgs(['hi', '--compare', '-m', 'gpt-4o']).compare).toBe(true);
    expect(parseArgs(['hi', '-m', 'gpt-4o']).compare).toBe(false);
  });

  it('is implied by multiple models even without the flag', () => {
    const args = parseArgs(['hi', '-m', 'gpt-4o,gpt-4o-mini']);
    expect(args.compare).toBe(true);
    expect(args.models).toHaveLength(2);
  });

  it('is set by the flag itself', () => {
    expect(parseArgs(['hi', '--compare']).compare).toBe(true);
  });
});

describe('parseArgs: output text', () => {
  it('accepts --output and -o', () => {
    expect(parseArgs(['hi', '--output', 'a completion']).output).toBe('a completion');
    expect(parseArgs(['hi', '-o', 'a completion']).output).toBe('a completion');
  });

  it('accepts the inline --output= form', () => {
    expect(parseArgs(['hi', '--output=done']).output).toBe('done');
  });

  it('is undefined when not supplied', () => {
    expect(parseArgs(['hi']).output).toBeUndefined();
  });

  it('reports a missing value', () => {
    expect(parseArgs(['hi', '--output']).errors).toEqual(['--output requires a value']);
    expect(parseArgs(['hi', '--output=']).errors).toEqual(['--output requires a value']);
  });
});

describe('parseArgs: flags and errors', () => {
  it('parses --json, --help and --version', () => {
    expect(parseArgs(['hi', '--json']).json).toBe(true);
    expect(parseArgs(['hi', '--help']).help).toBe(true);
    expect(parseArgs(['hi', '-h']).help).toBe(true);
    expect(parseArgs(['hi', '--version']).version).toBe(true);
    expect(parseArgs(['hi', '-V']).version).toBe(true);
  });

  it('defaults every flag to false', () => {
    const args = parseArgs(['hi']);
    expect(args).toMatchObject({ json: false, help: false, version: false, compare: false });
    expect(args.errors).toEqual([]);
  });

  it('reports unknown options', () => {
    expect(parseArgs(['hi', '--nope']).errors).toEqual(['Unknown option: --nope']);
    expect(parseArgs(['hi', '-x']).errors).toEqual(['Unknown option: -x']);
  });

  it('collects every error rather than stopping at the first', () => {
    expect(parseArgs(['hi', '--nope', '--alsobad']).errors).toHaveLength(2);
  });

  it('does not inject a default model when help or version is requested', () => {
    expect(parseArgs(['--help']).models).toEqual([]);
    expect(parseArgs(['--version']).models).toEqual([]);
  });
});

describe('formatCost', () => {
  it('handles zero', () => {
    expect(formatCost(0)).toBe('0');
  });

  it('scales precision to magnitude', () => {
    expect(formatCost(12.3456789)).toBe('12.3457');
    expect(formatCost(0.25)).toBe('0.2500');
    expect(formatCost(0.00025)).toBe('0.000250');
    expect(formatCost(0.000095)).toBe('0.00009500');
  });

  it('falls back to exponential for values fixed decimals cannot show', () => {
    expect(formatCost(1e-12)).toBe('1.00e-12');
  });

  it('passes through non-finite values', () => {
    expect(formatCost(Number.NaN)).toBe('NaN');
  });
});

describe('formatTable', () => {
  it('renders a header and one row per model', () => {
    const table = formatTable(
      [
        { model: 'gpt-4o', estimate: estimate() },
        { model: 'claude-sonnet-4-5', estimate: estimate({ inputTokens: 3, estimated: true }) },
      ],
      { hasOutput: true },
    );

    const lines = table.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('MODEL');
    expect(lines[0]).toContain('INPUT');
    expect(lines[0]).toContain('OUTPUT');
    expect(lines[0]).toContain('COST');
    expect(lines[0]).toContain('CURRENCY');
    expect(lines[0]).toContain('ESTIMATED');
    expect(lines[1]).toContain('gpt-4o');
    expect(lines[2]).toContain('yes');
    expect(table.endsWith('\n')).toBe(true);
  });

  it('omits the OUTPUT column when no completion was provided', () => {
    const table = formatTable([{ model: 'gpt-4o', estimate: estimate() }], { hasOutput: false });
    expect(table).not.toContain('OUTPUT');
  });

  it('right-aligns the cost column so values line up with the header', () => {
    const table = formatTable(
      [
        { model: 'gpt-4o', estimate: estimate() },
        { model: 'a-very-long-model-name', estimate: estimate() },
      ],
      { hasOutput: false },
    );
    const [header, short, long] = table.trimEnd().split('\n');
    const end = (line: string, needle: string): number => line.indexOf(needle) + needle.length;
    expect(header).toBeDefined();
    expect(end(header as string, 'COST')).toBe(end(short as string, '0.00009500'));
    expect(end(header as string, 'COST')).toBe(end(long as string, '0.00009500'));
  });
});

describe('JSON output', () => {
  it('emits the raw result for a single model', () => {
    const rows = [{ model: 'gpt-4o', estimate: estimate() }];
    expect(toJsonPayload(rows, false)).toEqual(estimate());
  });

  it('emits an array keyed by model when comparing', () => {
    const rows = [
      { model: 'gpt-4o', estimate: estimate() },
      { model: 'claude-sonnet-4-5', estimate: estimate({ estimated: true }) },
    ];
    expect(toJsonPayload(rows, true)).toEqual([
      { model: 'gpt-4o', ...estimate() },
      { model: 'claude-sonnet-4-5', ...estimate({ estimated: true }) },
    ]);
  });

  it('serializes as a single compact line', () => {
    const json = formatJson({ a: 1 });
    expect(json).toBe('{"a":1}\n');
    expect(json.trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('toSerializedError', () => {
  it('keeps code and model when present', () => {
    const error = Object.assign(new Error('boom'), { code: 'UNKNOWN_MODEL', model: 'nope' });
    expect(toSerializedError(error)).toEqual({
      name: 'Error',
      code: 'UNKNOWN_MODEL',
      model: 'nope',
      message: 'boom',
    });
  });

  it('omits absent fields instead of emitting undefined', () => {
    expect(toSerializedError(new Error('plain'))).toEqual({ name: 'Error', message: 'plain' });
  });

  it('handles non-Error throwables', () => {
    expect(toSerializedError('a string')).toEqual({ name: 'Error', message: 'a string' });
  });
});

describe('USAGE', () => {
  it('documents the flags, stdin behaviour and exit codes', () => {
    expect(USAGE).toContain('--model');
    expect(USAGE).toContain('--compare');
    expect(USAGE).toContain('--json');
    expect(USAGE).toContain('stdin');
    expect(USAGE).toContain('Exit codes');
    expect(USAGE).toContain(DEFAULT_MODEL);
  });
});
