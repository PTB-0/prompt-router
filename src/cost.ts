import type { ExecBackend, ModelTier, Pricing, TokenUsage } from "./types.js";

const CHARS_PER_TOKEN = 4;
/** The tier a prompt is valued at when no tier was selected. */
const DEFAULT_REFERENCE_MODEL = "sonnet";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Fallback for exec backends and providers that report no usage: the input is
 * approximated from its length, and output is unobservable once the terminal
 * is handed over, so it counts as zero rather than as a guess.
 */
export function estimateUsage(prompt: string): TokenUsage {
  return { inputTokens: estimateTokens(prompt), outputTokens: 0, estimated: true };
}

export function costOf(usage: TokenUsage, pricing: Pricing): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

/**
 * The price the counterfactual is valued at: whatever tier this prompt would
 * have run on. Pricing a trivial question at the top tier would inflate the
 * savings figure, so the tier the router actually picked is used.
 */
export function referencePricing(
  backend: ExecBackend | null,
  tier: ModelTier | null,
): Pricing | null {
  if (!backend) return null;
  const model = tier?.model ?? DEFAULT_REFERENCE_MODEL;
  return backend.modelPricing[model] ?? null;
}
