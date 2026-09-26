export const DEFAULT_MODEL = 'gpt-4o';

export interface ParsedCliArgs {
  /** Deduplicated, in the order given. Never empty unless `errors` is set. */
  readonly models: readonly string[];
  /** True when more than one model should be priced. */
  readonly compare: boolean;
  readonly json: boolean;
  readonly help: boolean;
  readonly version: boolean;
  /** Positional text argument, with multiple words joined by spaces. */
  readonly text: string | undefined;
  /** Completion text, when supplied via --output. */
  readonly output: string | undefined;
  readonly errors: readonly string[];
}

const MODEL_FLAGS = new Set(['--model', '-m']);
const OUTPUT_FLAGS = new Set(['--output', '-o']);
const HELP_FLAGS = new Set(['--help', '-h']);
const VERSION_FLAGS = new Set(['--version', '-V']);

/** Splits `a,b , c` into `['a','b','c']`, dropping empty segments. */
const splitModels = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

export const parseArgs = (argv: readonly string[]): ParsedCliArgs => {
  const errors: string[] = [];
  const positionals: string[] = [];
  const models: string[] = [];

  let json = false;
  let compare = false;
  let help = false;
  let version = false;
  let onlyPositionals = false;
  let output: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === undefined) continue;

    // Everything after `--` is literal text, even if it looks like a flag.
    if (onlyPositionals) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositionals = true;
      continue;
    }

    if (HELP_FLAGS.has(token)) {
      help = true;
      continue;
    }
    if (VERSION_FLAGS.has(token)) {
      version = true;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--compare') {
      compare = true;
      continue;
    }

    // `--model=x` inline form.
    if (token.startsWith('--model=')) {
      const value = token.slice('--model='.length);
      if (value.trim() === '') {
        errors.push('--model requires a value');
        continue;
      }
      models.push(...splitModels(value));
      continue;
    }

    if (MODEL_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        errors.push(`${token} requires a value`);
        continue;
      }
      index += 1;
      models.push(...splitModels(value));
      continue;
    }

    if (OUTPUT_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined) {
        errors.push(`${token} requires a value`);
        continue;
      }
      index += 1;
      output = value;
      continue;
    }

    if (token.startsWith('--output=')) {
      const value = token.slice('--output='.length);
      if (value.trim() === '') {
        errors.push('--output requires a value');
        continue;
      }
      output = value;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      errors.push(`Unknown option: ${token}`);
      continue;
    }

    positionals.push(token);
  }

  if (models.length === 0 && !help && !version) {
    models.push(DEFAULT_MODEL);
  }

  const deduped = [...new Set(models)];

  return {
    models: deduped,
    // Several models always means a comparison, even without the flag: erroring
    // on an obvious intent would just be hostile.
    compare: compare || deduped.length > 1,
    json,
    help,
    version,
    text: positionals.length > 0 ? positionals.join(' ') : undefined,
    output,
    errors,
  };
};

export const USAGE = `llm-token-cost - estimate LLM token counts and costs

Usage:
  llm-token-cost [text] [options]
  cat file.txt | llm-token-cost [options]

Options:
  -m, --model <id>      Model to price. Repeatable, or comma-separated.
                        Defaults to ${DEFAULT_MODEL}.
  -o, --output <text>   Completion text to price alongside the prompt.
      --compare         Price the same input across every --model.
                        Implied when more than one --model is given.
      --json            Emit the raw estimate result as JSON.
  -h, --help            Show this help.
  -V, --version         Show the version.

Input:
  Text may be passed as an argument or piped on stdin. If both are given,
  stdin wins and a warning is printed to stderr.

Output (default):
  MODEL            INPUT   OUTPUT   COST         CURRENCY  ESTIMATED

Examples:
  llm-token-cost "summarize this" --model gpt-4o
  cat article.txt | llm-token-cost --model claude-sonnet-4-5 --json
  llm-token-cost "hello" --compare --model gpt-4o,gpt-4o-mini,claude-sonnet-4-5

Exit codes:
  0  success
  1  estimation failed (for example, unknown model)
  2  usage error (no input, or bad options)`;
