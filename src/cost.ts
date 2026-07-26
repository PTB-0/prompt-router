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

export interface Savings {
  /** Tokens that did not go to the agentic backend. */
  savedTokens: number;
  /** Counterfactual USD those tokens would have cost there. */
  savedUsd: number;
}

/**
 * What a dispatch saved relative to the counterfactual of running on the
 * handoff backend at the given tier. Zero when there is no handoff backend to
 * compare against, or it has no pricing for that tier — nothing was actually
 * diverted from, so nothing was saved.
 */
export function savingsFor(
  usage: TokenUsage,
  handoff: ExecBackend | null,
  tier: ModelTier | null,
): Savings {
  const pricing = referencePricing(handoff, tier);
  if (!pricing) return { savedTokens: 0, savedUsd: 0 };
  return {
    savedTokens: usage.inputTokens + usage.outputTokens,
    savedUsd: costOf(usage, pricing),
  };
}
