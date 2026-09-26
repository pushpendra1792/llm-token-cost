import { parseArgs, USAGE } from './cli-args';
import { formatJson, formatTable, toJsonPayload, toSerializedError } from './cli-format';
import type { ModelEstimate } from './cli-format';
import { estimateCost } from './estimate';
import pkg from '../package.json';

const EXIT_OK = 0;
const EXIT_ESTIMATE_FAILED = 1;
const EXIT_USAGE = 2;

const write = (stream: NodeJS.WriteStream, text: string): void => {
  stream.write(text);
};

const readStdin = async (stream: NodeJS.ReadStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

const isFilled = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    write(process.stdout, `${USAGE}\n`);
    return EXIT_OK;
  }
  if (args.version) {
    write(process.stdout, `${pkg.version}\n`);
    return EXIT_OK;
  }

  if (args.errors.length > 0) {
    for (const message of args.errors) write(process.stderr, `error: ${message}\n`);
    write(process.stderr, `\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  // Only touch stdin when it is not a terminal; otherwise this would block
  // waiting for a human to type EOF.
  const piped = process.stdin.isTTY === true ? '' : await readStdin(process.stdin);
  const hasPiped = piped.trim() !== '';
  const hasPositional = isFilled(args.text);

  if (hasPiped && hasPositional) {
    write(process.stderr, 'warning: ignoring the text argument, reading from stdin\n');
  }

  const inputText = hasPiped ? piped : args.text;
  if (!isFilled(inputText)) {
    write(process.stderr, `error: no input provided\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  const outputText = isFilled(args.output) ? args.output : undefined;
  const hasOutput = outputText !== undefined;

  const rows: ModelEstimate[] = [];
  const failures: unknown[] = [];

  for (const model of args.models) {
    try {
      const estimate = await estimateCost({
        model,
        inputText,
        ...(outputText === undefined ? {} : { outputText }),
      });
      rows.push({ model, estimate });
    } catch (error) {
      failures.push(error);
      if (!args.compare) {
        reportFatal(args.json, error);
        return EXIT_ESTIMATE_FAILED;
      }
    }
  }

  // In compare mode a single bad model id should not discard the models that
  // did resolve, so the failures are reported and the exit code still flags them.
  for (const failure of failures) reportFailure(args.json, failure);

  write(process.stdout, args.json ? formatJson(toJsonPayload(rows, args.compare)) : formatTable(rows, { hasOutput }));

  return failures.length > 0 ? EXIT_ESTIMATE_FAILED : EXIT_OK;
};

const reportFailure = (json: boolean, error: unknown): void => {
  const serialized = toSerializedError(error);
  if (json) {
    write(process.stderr, formatJson({ error: serialized }));
    return;
  }
  write(process.stderr, `error: ${serialized.message}\n`);
};

const reportFatal = (json: boolean, error: unknown): void => {
  if (json) {
    write(process.stdout, formatJson({ error: toSerializedError(error) }));
    return;
  }
  write(process.stderr, `error: ${toSerializedError(error).message}\n`);
};

// Set `exitCode` instead of calling `process.exit()`: exiting directly can
// truncate a pending stdout write when stdout is a pipe. Letting the event loop
// drain guarantees the table or JSON is flushed before the process ends.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    write(process.stderr, `error: ${toSerializedError(error).message}\n`);
    process.exitCode = EXIT_ESTIMATE_FAILED;
  },
);
