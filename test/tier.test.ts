import { describe, expect, test } from "vitest";
import { pickModelTier, tierForBackend } from "../src/tier.js";
import type { ChatBackend, ExecBackend } from "../src/types.js";

const opts = { lowThreshold: 0.35, highThreshold: 0.7 };

describe("pickModelTier", () => {
  test("no complexity signal returns null", () => {
    expect(pickModelTier(null, false, opts)).toBeNull();
    expect(pickModelTier(null, true, opts)).toBeNull();
  });

  test("low complexity picks haiku/low", () => {
    expect(pickModelTier(0.1, false, opts)).toEqual({ model: "haiku", effort: "low" });
    expect(pickModelTier(0.34, false, opts)).toEqual({ model: "haiku", effort: "low" });
  });

  test("mid complexity picks sonnet/medium", () => {
    expect(pickModelTier(0.35, false, opts)).toEqual({ model: "sonnet", effort: "medium" });
    expect(pickModelTier(0.5, false, opts)).toEqual({ model: "sonnet", effort: "medium" });
    expect(pickModelTier(0.69, false, opts)).toEqual({ model: "sonnet", effort: "medium" });
  });

  test("high complexity picks opus/high", () => {
    expect(pickModelTier(0.7, false, opts)).toEqual({ model: "opus", effort: "high" });
    expect(pickModelTier(0.95, false, opts)).toEqual({ model: "opus", effort: "high" });
  });

  test("uncertain classification escalates one tier", () => {
    expect(pickModelTier(0.1, true, opts)).toEqual({ model: "sonnet", effort: "medium" });
    expect(pickModelTier(0.5, true, opts)).toEqual({ model: "opus", effort: "high" });
  });

  test("uncertain escalation caps at the top tier", () => {
    expect(pickModelTier(0.9, true, opts)).toEqual({ model: "opus", effort: "high" });
  });
});

const execBackend: ExecBackend = {
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
  modelPricing: {},
};

const chatBackend: ChatBackend = {
  id: "local",
  label: "local model",
  kind: "chat",
  categories: ["simple-qa"],
  priority: 10,
  enabled: true,
  baseUrl: "http://localhost:1234/v1",
  models: ["m"],
  probe: true,
  autoStart: false,
  autoStartCommand: [],
  pricing: { inputPer1M: 0, outputPer1M: 0 },
};

describe("tierForBackend", () => {
  const tierOpts = { ...opts, enabled: true };

  test("a chat backend never gets a tier — model tiers are an exec-only concept", () => {
    expect(tierForBackend(chatBackend, 0.9, false, tierOpts)).toBeNull();
  });

  test("an exec backend that does not support model tiers gets null", () => {
    const fixedModel: ExecBackend = { ...execBackend, supportsModelTier: false };
    expect(tierForBackend(fixedModel, 0.9, false, tierOpts)).toBeNull();
  });

  test("model selection disabled globally overrides an otherwise-eligible backend", () => {
    expect(tierForBackend(execBackend, 0.9, false, { ...opts, enabled: false })).toBeNull();
  });

  test("an eligible exec backend with selection enabled gets the tier its complexity picks", () => {
    expect(tierForBackend(execBackend, 0.1, false, tierOpts)).toEqual({
      model: "haiku",
      effort: "low",
    });
    expect(tierForBackend(execBackend, 0.9, false, tierOpts)).toEqual({
      model: "opus",
      effort: "high",
    });
  });
});
