import { execFile, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRICING_URL_ENV } from '../src/pricing/fetch';

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/**
 * Minimal pricing fixture. Small on purpose: every CLI invocation is a fresh
 * process, so pointing them at the real 3 MB LiteLLM document would make the
 * suite slow and network-dependent.
 */
const FIXTURE = {
  'gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    litellm_provider: 'openai',
  },
  'gpt-4o-mini': {
    input_cost_per_token: 1.5e-7,
    output_cost_per_token: 6e-7,
    litellm_provider: 'openai',
  },
  'claude-sonnet-4-5': {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    litellm_provider: 'anthropic',
  },
};

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let server: Server;
let pricingUrl: string;

/**
 * Must be async, not `spawnSync`: the fixture server lives in this process, and
 * a blocking spawn would stall the event loop that has to answer the CLI's
 * pricing request. With `spawnSync` the CLI only recovers via its 10s fetch
 * timeout and the bundled-snapshot fallback, which quietly hides the breakage.
 */
const runCli = (args: readonly string[], stdin?: string): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, [PRICING_URL_ENV]: pricingUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    // A spawn-level failure (missing binary, resource exhaustion) must not look
    // like an ordinary non-zero exit, or the assertions below mislead.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI invocation timed out: node ${args.join(' ')}`));
    }, 30_000);

    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn CLI: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) {
        reject(new Error(`CLI terminated by signal ${signal}`));
        return;
      }
      // Non-zero exits are an expected outcome for the error-path tests, so they
      // resolve rather than reject.
      resolve({ code: code ?? 1, stdout, stderr });
    });

    // An empty string keeps stdin a closed pipe, which is what the CLI sees when
    // it is run without a redirect.
    child.stdin.end(stdin ?? '');
  });

/** Each assertion spawns at least one Node process, so allow generous time. */
const cliIt = (name: string, fn: () => Promise<void>): void => {
  it(name, fn, 60_000);
};

beforeAll(async () => {
  // CI runs tests before the build step, so the binary may not exist yet.
  if (!existsSync(CLI_PATH)) {
    // On Windows `npm` is a .cmd shim, which spawn cannot execute on its own.
    const isWindows = process.platform === 'win32';
    await execFileAsync(isWindows ? 'npm.cmd' : 'npm', ['run', 'build'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      timeout: 300_000,
      shell: isWindows,
    });
  }

  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(FIXTURE));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind fixture server');
  pricingUrl = `http://127.0.0.1:${address.port}/pricing.json`;
}, 300_000);

afterAll(() => {
  server?.close();
});

describe('cli: table output', () => {
  cliIt('prints a table with a header and one row', async () => {
    const { code, stdout } = await runCli(['summarize this article', '--model', 'gpt-4o']);

    expect(code).toBe(0);
    const lines = stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('MODEL');
    expect(lines[0]).toContain('INPUT');
    expect(lines[0]).toContain('COST');
    expect(lines[0]).toContain('CURRENCY');
    expect(lines[0]).toContain('ESTIMATED');
    expect(lines[1]).toContain('gpt-4o');
  });

  cliIt('includes the OUTPUT column only when a completion is supplied', async () => {
    const withoutOutput = await runCli(['hi', '-m', 'gpt-4o']);
    const withOutput = await runCli(['hi', '-m', 'gpt-4o', '-o', 'a completion']);

    expect(withoutOutput.stdout).not.toContain('OUTPUT');
    expect(withOutput.stdout).toContain('OUTPUT');
  });

  cliIt('marks heuristic-tokenized models as estimated', async () => {
    const { stdout } = await runCli(['hello world', '--model', 'claude-sonnet-4-5']);
    expect(stdout).toMatch(/yes\s*$/m);
  });

  cliIt('renders one row per model with --compare', async () => {
    const { code, stdout } = await runCli([
      'hello world',
      '--compare',
      '--model',
      'gpt-4o,gpt-4o-mini,claude-sonnet-4-5',
    ]);

    expect(code).toBe(0);
    expect(stdout.trimEnd().split('\n')).toHaveLength(4);
    expect(stdout).toContain('gpt-4o-mini');
    expect(stdout).toContain('claude-sonnet-4-5');
  });

  cliIt('implies compare when several models are passed', async () => {
    const { stdout } = await runCli(['hello world', '-m', 'gpt-4o,claude-sonnet-4-5']);
    expect(stdout.trimEnd().split('\n')).toHaveLength(3);
  });
});

describe('cli: json output', () => {
  cliIt('emits the raw result object and nothing else', async () => {
    const { code, stdout } = await runCli(['summarize this article', '-m', 'gpt-4o', '--json']);

    expect(code).toBe(0);
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      'cost',
      'currency',
      'estimated',
      'inputTokens',
      'outputTokens',
    ]);
    expect(parsed['currency']).toBe('USD');
    // false proves the live fetch actually reached the fixture rather than
    // silently falling back to the bundled snapshot, which reports true.
    expect(parsed['estimated']).toBe(false);
    expect(typeof parsed['cost']).toBe('number');
  });

  cliIt('emits an array keyed by model when comparing', async () => {
    const { code, stdout } = await runCli([
      'hi',
      '--compare',
      '-m',
      'gpt-4o,claude-sonnet-4-5',
      '--json',
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.['model']).toBe('gpt-4o');
    expect(parsed[0]?.['estimated']).toBe(false);
    expect(parsed[1]?.['model']).toBe('claude-sonnet-4-5');
    expect(parsed[1]?.['estimated']).toBe(true);
  });

  cliIt('prices the supplied completion text', async () => {
    const { stdout } = await runCli(['hi', '-m', 'gpt-4o', '-o', 'a much longer completion', '--json']);
    const parsed = JSON.parse(stdout) as { outputTokens: number };
    expect(parsed.outputTokens).toBeGreaterThan(0);
  });

  cliIt('keeps stdout free of warnings in json mode', async () => {
    const { stdout } = await runCli(['ignored argument', '-m', 'gpt-4o', '--json'], 'piped text');
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
  });
});

describe('cli: stdin handling', () => {
  cliIt('reads piped text when no argument is given', async () => {
    const { code, stdout } = await runCli(['-m', 'gpt-4o', '--json'], 'piped text from stdin');
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { inputTokens: number }).inputTokens).toBeGreaterThan(0);
  });

  cliIt('prefers stdin over a positional argument', async () => {
    const piped = await runCli(['-m', 'gpt-4o', '--json'], 'the same text either way');
    const positional = await runCli(['the same text either way', '-m', 'gpt-4o', '--json']);
    expect(piped.stdout).toBe(positional.stdout);
  });

  cliIt('warns when both stdin and a positional argument are given', async () => {
    const { stderr } = await runCli(['from the argument', '-m', 'gpt-4o'], 'from stdin');
    expect(stderr).toContain('warning');
    expect(stderr).toContain('stdin');
  });

  cliIt('does not warn when only one input source is used', async () => {
    const positional = await runCli(['only the argument', '-m', 'gpt-4o']);
    const piped = await runCli(['-m', 'gpt-4o'], 'only stdin');
    expect(positional.stderr).toBe('');
    expect(piped.stderr).toBe('');
  });
});

describe('cli: errors and exit codes', () => {
  cliIt('exits 1 with a readable stderr message for an unknown model', async () => {
    const { code, stdout, stderr } = await runCli(['hi', '--model', 'not-a-real-model']);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('No pricing found');
    expect(stderr).toContain('not-a-real-model');
  });

  cliIt('exits 1 with a structured error object in json mode', async () => {
    const { code, stdout } = await runCli(['hi', '-m', 'not-a-real-model', '--json']);

    expect(code).toBe(1);
    const parsed = JSON.parse(stdout) as { error: Record<string, unknown> };
    expect(parsed.error['name']).toBe('UnknownModelError');
    expect(parsed.error['code']).toBe('UNKNOWN_MODEL');
    expect(parsed.error['model']).toBe('not-a-real-model');
    expect(typeof parsed.error['message']).toBe('string');
  });

  cliIt('exits 2 and prints usage when there is no input at all', async () => {
    const { code, stderr } = await runCli(['-m', 'gpt-4o']);

    expect(code).toBe(2);
    expect(stderr).toContain('no input provided');
    expect(stderr).toContain('Usage:');
  });

  cliIt('exits 2 for an unknown option', async () => {
    const { code, stderr } = await runCli(['hi', '--nope']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown option: --nope');
  });

  cliIt('exits 2 when --model has no value', async () => {
    const { code, stderr } = await runCli(['hi', '--model']);
    expect(code).toBe(2);
    expect(stderr).toContain('requires a value');
  });

  cliIt('keeps working models and exits 1 when one compared model is unknown', async () => {
    const { code, stdout, stderr } = await runCli([
      'hi',
      '--compare',
      '-m',
      'gpt-4o,not-a-real-model',
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain('gpt-4o');
    expect(stderr).toContain('not-a-real-model');
  });
});

describe('cli: help and version', () => {
  cliIt('prints help to stdout and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--compare');
  });

  cliIt('prints the package version and exits 0', async () => {
    const { code, stdout } = await runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
