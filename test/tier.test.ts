import { describe, expect, test } from "vitest";
import { pickModelTier } from "../src/tier.js";

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
