import { InvalidInputError } from './errors';
import {
  estimateCostFromTokens,
  type EstimateCostFromTokensInput,
  type EstimateCostFromTokensResult,
} from './estimate';
import type { CacheTtl, ServiceTier } from './pricing/types';

/** Usage-object dialect recognized by {@link estimateCostFromUsage}. */
export type UsageFormat =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic'
  | 'google'
  | 'generic';

/**
 * A provider usage object, a whole provider response containing one, or a
 * provider-agnostic shape. See {@link estimateCostFromUsage}.
 */
export interface EstimateCostFromUsageInput {
  /** Model id used for pricing lookup. */
  readonly model: string;
  /** Usage object itself, or a whole response with `.usage`/`.usageMetadata`. */
  readonly usage: unknown;
  /**
   * Forces a usage dialect instead of detecting one. Accepts `openai`,
   * `openai-chat`, `openai-responses`, `anthropic`, `google`, or `generic`
   * (case-insensitive).
   */
  readonly provider?: string;
  /** Explicit service tier. Wins over `usage.service_tier`. */
  readonly serviceTier?: ServiceTier;
}

export interface EstimateCostFromUsageResult extends EstimateCostFromTokensResult {
  /** Dialect that was used to read the usage object. */
  readonly usageFormat: UsageFormat;
}

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;

const ACCEPTED_SHAPES =
  'Expected OpenAI chat (`prompt_tokens`), OpenAI Responses (`input_tokens` with ' +
  '`input_tokens_details`), Anthropic (`input_tokens` with cache fields), Google ' +
  '(`promptTokenCount`/`usageMetadata`), or generic (`inputTokens`/`outputTokens`, ' +
  '`promptTokens`/`completionTokens`, or `input_tokens`/`output_tokens`).';

const readCount = (record: UnknownRecord, key: string, label: string): number => {
  const value = record[key];
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new InvalidInputError(`\`${label}\` must be a whole, finite number of tokens`);
  }
  if (value < 0) {
    throw new InvalidInputError(`\`${label}\` must not be negative`);
  }
  return value;
};

const readNestedCount = (
  record: UnknownRecord,
  parentKey: string,
  childKey: string,
  label: string,
): number => {
  const parent = asRecord(record[parentKey]);
  if (parent === undefined) return 0;
  return readCount(parent, childKey, label);
};

const readFirstCount = (
  record: UnknownRecord,
  keys: ReadonlyArray<string>,
  label: string,
): number => {
  for (const key of keys) {
    if (record[key] !== undefined) return readCount(record, key, `${label} (${key})`);
  }
  return 0;
};

const hasAnyKey = (record: UnknownRecord, keys: ReadonlyArray<string>): boolean =>
  keys.some((key) => record[key] !== undefined);

/** A whole response carries the usage object under one of these keys. */
const unwrapUsage = (value: unknown): unknown => {
  const record = asRecord(value);
  if (record === undefined) return value;

  const metadata = asRecord(record['usageMetadata']);
  if (metadata !== undefined) return metadata;

  const usage = asRecord(record['usage']);
  if (usage !== undefined) return usage;

  return record;
};

const detectFormat = (usage: UnknownRecord): UsageFormat | undefined => {
  if ('usageMetadata' in usage || 'promptTokenCount' in usage) return 'google';
  if (
    'cache_read_input_tokens' in usage ||
    'cache_creation_input_tokens' in usage ||
    'cache_creation' in usage
  ) {
    return 'anthropic';
  }
  if ('prompt_tokens' in usage) return 'openai-chat';
  if ('input_tokens_details' in usage || 'output_tokens_details' in usage) {
    return 'openai-responses';
  }
  if (hasAnyKey(usage, ['inputTokens', 'promptTokens', 'input_tokens'])) return 'generic';
  return undefined;
};

const resolveFormat = (usage: UnknownRecord, provider: string | undefined): UsageFormat => {
  if (provider !== undefined) {
    const normalized = provider.trim().toLowerCase();
    switch (normalized) {
      case 'openai-chat':
      case 'openai_chat':
      case 'openai.chat':
        return 'openai-chat';
      case 'openai-responses':
      case 'openai_responses':
      case 'openai.responses':
      case 'responses':
        return 'openai-responses';
      case 'openai':
        return 'prompt_tokens' in usage || !('input_tokens' in usage)
          ? 'openai-chat'
          : 'openai-responses';
      case 'anthropic':
      case 'claude':
        return 'anthropic';
      case 'google':
      case 'gemini':
      case 'vertex':
      case 'vertex-ai':
      case 'vertex_ai':
        return 'google';
      case 'generic':
      case 'vercel':
      case 'ai-sdk':
      case 'ai_sdk':
        return 'generic';
      default:
        throw new InvalidInputError(
          `Unknown usage provider "${provider}". Expected one of: openai, openai-chat, ` +
            'openai-responses, anthropic, google, generic.',
        );
    }
  }

  const detected = detectFormat(usage);
  if (detected !== undefined) return detected;
  throw new InvalidInputError(`Unrecognized usage object. ${ACCEPTED_SHAPES}`);
};

const resolveServiceTier = (
  usage: UnknownRecord,
  explicit: ServiceTier | undefined,
): ServiceTier => {
  if (explicit !== undefined) return explicit;

  const raw = usage['service_tier'];
  if (typeof raw !== 'string') return 'standard';

  switch (raw.toLowerCase()) {
    case 'flex':
      return 'flex';
    case 'priority':
      return 'priority';
    case 'batch':
      return 'batch';
    // OpenAI's default/auto/scale and Anthropic's standard all mean standard.
    default:
      return 'standard';
  }
};

interface NormalizedUsage {
  readonly format: UsageFormat;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheCreation1hInputTokens: number | undefined;
  readonly reasoningOutputTokens: number;
  readonly serviceTier: ServiceTier;
  readonly cacheTtl: CacheTtl | undefined;
}

const openAiChatUsage = (
  usage: UnknownRecord,
  serviceTier: ServiceTier,
): NormalizedUsage => ({
  format: 'openai-chat',
  // prompt_tokens already includes cached tokens; completion_tokens already
  // includes reasoning tokens.
  inputTokens: readCount(usage, 'prompt_tokens', 'usage.prompt_tokens'),
  outputTokens: readCount(usage, 'completion_tokens', 'usage.completion_tokens'),
  cacheReadInputTokens: readNestedCount(
    usage,
    'prompt_tokens_details',
    'cached_tokens',
    'usage.prompt_tokens_details.cached_tokens',
  ),
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: undefined,
  reasoningOutputTokens: readNestedCount(
    usage,
    'completion_tokens_details',
    'reasoning_tokens',
    'usage.completion_tokens_details.reasoning_tokens',
  ),
  serviceTier,
  cacheTtl: undefined,
});

const openAiResponsesUsage = (
  usage: UnknownRecord,
  serviceTier: ServiceTier,
): NormalizedUsage => ({
  format: 'openai-responses',
  // input_tokens already includes cached tokens; output_tokens already includes
  // reasoning tokens.
  inputTokens: readCount(usage, 'input_tokens', 'usage.input_tokens'),
  outputTokens: readCount(usage, 'output_tokens', 'usage.output_tokens'),
  cacheReadInputTokens: readNestedCount(
    usage,
    'input_tokens_details',
    'cached_tokens',
    'usage.input_tokens_details.cached_tokens',
  ),
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: undefined,
  reasoningOutputTokens: readNestedCount(
    usage,
    'output_tokens_details',
    'reasoning_tokens',
    'usage.output_tokens_details.reasoning_tokens',
  ),
  serviceTier,
  cacheTtl: undefined,
});

const anthropicUsage = (
  usage: UnknownRecord,
  serviceTier: ServiceTier,
): NormalizedUsage => {
  const inputTokens = readCount(usage, 'input_tokens', 'usage.input_tokens');
  const cacheReadInputTokens = readCount(
    usage,
    'cache_read_input_tokens',
    'usage.cache_read_input_tokens',
  );

  const cacheCreationRecord = asRecord(usage['cache_creation']);
  const reportedCacheCreation =
    usage['cache_creation_input_tokens'] === undefined
      ? undefined
      : readCount(usage, 'cache_creation_input_tokens', 'usage.cache_creation_input_tokens');

  const fiveMinuteWriteTokens =
    cacheCreationRecord === undefined
      ? 0
      : readCount(
          cacheCreationRecord,
          'ephemeral_5m_input_tokens',
          'usage.cache_creation.ephemeral_5m_input_tokens',
        );
  const oneHourWriteTokens =
    cacheCreationRecord === undefined
      ? 0
      : readCount(
          cacheCreationRecord,
          'ephemeral_1h_input_tokens',
          'usage.cache_creation.ephemeral_1h_input_tokens',
        );

  // Prefer the provider's total; if it omitted it, the TTL breakdown is the
  // only source for the write-token total.
  const cacheCreationInputTokens =
    reportedCacheCreation ?? fiveMinuteWriteTokens + oneHourWriteTokens;

  let cacheTtl: CacheTtl | undefined;
  let cacheCreation1hInputTokens: number | undefined;
  if (oneHourWriteTokens > 0) {
    if (oneHourWriteTokens === cacheCreationInputTokens) {
      cacheTtl = '1h';
    } else {
      cacheCreation1hInputTokens = oneHourWriteTokens;
    }
  }

  return {
    format: 'anthropic',
    // Anthropic reports input_tokens without cache reads or cache writes.
    inputTokens: inputTokens + cacheReadInputTokens + cacheCreationInputTokens,
    outputTokens: readCount(usage, 'output_tokens', 'usage.output_tokens'),
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cacheCreation1hInputTokens,
    reasoningOutputTokens: 0,
    serviceTier,
    cacheTtl,
  };
};

const googleUsage = (
  usage: UnknownRecord,
  serviceTier: ServiceTier,
): NormalizedUsage => {
  const thoughtTokens =
    usage['thoughtsTokenCount'] === undefined
      ? readCount(usage, 'thoughtTokenCount', 'usage.thoughtTokenCount')
      : readCount(usage, 'thoughtsTokenCount', 'usage.thoughtsTokenCount');
  const candidateTokens = readCount(
    usage,
    'candidatesTokenCount',
    'usage.candidatesTokenCount',
  );

  return {
    format: 'google',
    // promptTokenCount includes cached content; thinking tokens are billed as
    // output but reported separately.
    inputTokens: readCount(usage, 'promptTokenCount', 'usage.promptTokenCount'),
    outputTokens: candidateTokens + thoughtTokens,
    cacheReadInputTokens: readCount(
      usage,
      'cachedContentTokenCount',
      'usage.cachedContentTokenCount',
    ),
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: undefined,
    reasoningOutputTokens: thoughtTokens,
    serviceTier,
    cacheTtl: undefined,
  };
};

const GENERIC_INPUT_KEYS = ['inputTokens', 'promptTokens', 'input_tokens', 'prompt_tokens'];
const GENERIC_OUTPUT_KEYS = [
  'outputTokens',
  'completionTokens',
  'output_tokens',
  'completion_tokens',
];

const genericUsage = (usage: UnknownRecord, serviceTier: ServiceTier): NormalizedUsage => {
  if (
    !hasAnyKey(usage, GENERIC_INPUT_KEYS) &&
    !hasAnyKey(usage, GENERIC_OUTPUT_KEYS)
  ) {
    throw new InvalidInputError(`Unrecognized usage object. ${ACCEPTED_SHAPES}`);
  }

  return {
    format: 'generic',
    inputTokens: readFirstCount(usage, GENERIC_INPUT_KEYS, 'usage.inputTokens'),
    outputTokens: readFirstCount(usage, GENERIC_OUTPUT_KEYS, 'usage.outputTokens'),
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: undefined,
    reasoningOutputTokens: 0,
    serviceTier,
    cacheTtl: undefined,
  };
};

/**
 * Prices a provider usage object without re-tokenizing and without calling a
 * provider API. Pricing resolution still follows the library's normal
 * live/cache/snapshot ladder.
 *
 * `inputTokens` is always the total input, including cached and cache-write
 * tokens, and `outputTokens` is always the total output, including reasoning.
 */
export const estimateCostFromUsage = async (
  input: EstimateCostFromUsageInput,
): Promise<EstimateCostFromUsageResult> => {
  const usage = asRecord(unwrapUsage(input.usage));
  if (usage === undefined) {
    throw new InvalidInputError(`Unrecognized usage object. ${ACCEPTED_SHAPES}`);
  }

  const format = resolveFormat(usage, input.provider);
  const serviceTier = resolveServiceTier(usage, input.serviceTier);

  let normalized: NormalizedUsage;
  switch (format) {
    case 'openai-chat':
      normalized = openAiChatUsage(usage, serviceTier);
      break;
    case 'openai-responses':
      normalized = openAiResponsesUsage(usage, serviceTier);
      break;
    case 'anthropic':
      normalized = anthropicUsage(usage, serviceTier);
      break;
    case 'google':
      normalized = googleUsage(usage, serviceTier);
      break;
    case 'generic':
      normalized = genericUsage(usage, serviceTier);
      break;
  }

  const estimateInput: EstimateCostFromTokensInput = {
    model: input.model,
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    cacheReadInputTokens: normalized.cacheReadInputTokens,
    cacheCreationInputTokens: normalized.cacheCreationInputTokens,
    reasoningOutputTokens: normalized.reasoningOutputTokens,
    serviceTier: normalized.serviceTier,
    ...(normalized.cacheTtl !== undefined ? { cacheTtl: normalized.cacheTtl } : {}),
    ...(normalized.cacheCreation1hInputTokens !== undefined
      ? { cacheCreation1hInputTokens: normalized.cacheCreation1hInputTokens }
      : {}),
  };

  const result = await estimateCostFromTokens(estimateInput);
  return { ...result, usageFormat: format };
};
