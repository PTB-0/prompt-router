import type { Backend, ModelTier } from "./types.js";

export interface TierOptions {
  lowThreshold: number;
  highThreshold: number;
}

export function pickModelTier(
  complexity: number | null,
  uncertain: boolean,
  opts: TierOptions,
): ModelTier | null {
  if (complexity === null) return null;

  const level = complexity >= opts.highThreshold ? 2 : complexity >= opts.lowThreshold ? 1 : 0;
  const escalated = uncertain ? Math.min(level + 1, 2) : level;

  if (escalated === 0) return { model: "haiku", effort: "low" };
  if (escalated === 1) return { model: "sonnet", effort: "medium" };
  return { model: "opus", effort: "high" };
}

export interface TierForBackendOptions extends TierOptions {
  /** Global model-selection kill switch (config.modelSelection.enabled). */
  enabled: boolean;
}

/**
 * The capability gate: only exec backends that opt into model-tier selection
 * (`supportsModelTier`) get a tier, and only when tier selection is enabled
 * globally — chat backends and backends with a fixed model must never
 * receive a tier override.
 */
export function tierForBackend(
  backend: Backend,
  complexity: number,
  uncertain: boolean,
  opts: TierForBackendOptions,
): ModelTier | null {
  if (backend.kind !== "exec" || !backend.supportsModelTier) return null;
  if (!opts.enabled) return null;
  return pickModelTier(complexity, uncertain, opts);
}
