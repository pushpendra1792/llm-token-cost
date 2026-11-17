export declare const LITELLM_PRICING_URL: string;

export declare function formatSnapshot(
  models: Record<string, unknown>,
  updatedAt: string,
  generatedAt: string,
): string;

export declare function formatLimits(limits: Record<string, unknown>): string;

export declare function snapshotModelsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean;

export interface PreviousSnapshot {
  readonly text: string;
  readonly updatedAt: string;
  readonly generatedAt?: string;
  readonly models: Record<string, unknown>;
}

export interface SnapshotUpdatePlan {
  readonly changed: boolean;
  readonly modelsChanged: boolean;
  readonly text: string;
  readonly updatedAt: string;
  readonly generatedAt: string;
}

export declare function planSnapshotUpdate(input: {
  previous?: PreviousSnapshot;
  models: Record<string, unknown>;
  now: Date;
}): SnapshotUpdatePlan;
