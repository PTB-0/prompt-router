import { describe, expect, test } from "vitest";
import { costOf, estimateTokens, estimateUsage, referencePricing } from "../src/cost.js";
import type { ExecBackend } from "../src/types.js";

const claude: ExecBackend = {
  id: "claude",
  label: "Claude Code",
  kind: "exec",
  categories: ["code"],
  priority: 10,
  enabled: true,
  command: "claude",
  args: ["{prompt}"],
  modelFlag: "--model",
  effortFlag: "--effort",
  continueFlag: "-c",
  supportsModelTier: true,
  supportsPlan: true,
  supportsContinue: true,
  modelPricing: {
    haiku: { inputPer1M: 1, outputPer1M: 5 },
    sonnet: { inputPer1M: 3, outputPer1M: 15 },
    opus: { inputPer1M: 5, outputPer1M: 25 },
  },
};

describe("estimateTokens", () => {
  test("approximates four characters per token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("estimateUsage marks the result as estimated with no output tokens", () => {
    expect(estimateUsage("abcdefgh")).toEqual({
      inputTokens: 2,
      outputTokens: 0,
      estimated: true,
    });
  });
});

describe("costOf", () => {
  test("prices input and output separately", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, estimated: false };
    expect(costOf(usage, { inputPer1M: 3, outputPer1M: 15 })).toBeCloseTo(18, 10);
  });

  test("a free model costs nothing", () => {
    const usage = { inputTokens: 500_000, outputTokens: 500_000, estimated: false };
    expect(costOf(usage, { inputPer1M: 0, outputPer1M: 0 })).toBe(0);
  });

  test("partial millions scale linearly", () => {
    const usage = { inputTokens: 250_000, outputTokens: 0, estimated: false };
    expect(costOf(usage, { inputPer1M: 4, outputPer1M: 0 })).toBeCloseTo(1, 10);
  });
});

describe("referencePricing", () => {
  test("prices a cheap prompt at the haiku tier and a heavy one at opus", () => {
    expect(referencePricing(claude, { model: "haiku", effort: "low" })).toEqual({
      inputPer1M: 1,
      outputPer1M: 5,
    });
    expect(referencePricing(claude, { model: "opus", effort: "high" })).toEqual({
      inputPer1M: 5,
      outputPer1M: 25,
    });
  });

  test("falls back to the sonnet tier when no tier was selected", () => {
    expect(referencePricing(claude, null)).toEqual({ inputPer1M: 3, outputPer1M: 15 });
  });

  test("returns null when the backend has no pricing for the tier", () => {
    const bare: ExecBackend = { ...claude, modelPricing: {} };
    expect(referencePricing(bare, { model: "opus", effort: "high" })).toBeNull();
    expect(referencePricing(null, { model: "opus", effort: "high" })).toBeNull();
  });
});
