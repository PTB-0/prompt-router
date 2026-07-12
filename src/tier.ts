import type { ModelTier } from "./types.js";

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
