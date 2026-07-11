import { describe, expect, test } from "vitest";
import { decideRoute } from "../src/route.js";
import type { Classification } from "../src/types.js";

const opts = { confidenceThreshold: 0.6, planComplexityThreshold: 0.7, localAvailable: true };

function cls(partial: Partial<Classification>): Classification {
  return {
    optimizedPrompt: "p",
    category: "simple-qa",
    complexity: 0.2,
    confidence: 0.9,
    ...partial,
  };
}

describe("decideRoute", () => {
  test("classifier outage falls back to claude and flags uncertainty", () => {
    expect(decideRoute(null, null, opts)).toEqual({
      target: "claude",
      planFirst: false,
      uncertain: true,
    });
  });

  test("heuristic code verdict goes to claude even if classifier disagrees", () => {
    expect(decideRoute(cls({ category: "simple-qa" }), "code", opts).target).toBe("claude");
  });

  test("complex code task gets the plan-first pipeline", () => {
    expect(decideRoute(cls({ category: "code", complexity: 0.9 }), null, opts)).toEqual({
      target: "claude",
      planFirst: true,
      uncertain: false,
    });
  });

  test("trivial code task goes straight to claude", () => {
    expect(decideRoute(cls({ category: "code", complexity: 0.3 }), "code", opts)).toEqual({
      target: "claude",
      planFirst: false,
      uncertain: false,
    });
  });

  test("confident simple question goes local", () => {
    expect(decideRoute(cls({}), "simple-qa", opts).target).toBe("local");
  });

  test("simple question without a local backend goes to openrouter", () => {
    expect(decideRoute(cls({}), null, { ...opts, localAvailable: false }).target).toBe(
      "openrouter",
    );
  });

  test("deep question goes to openrouter", () => {
    expect(decideRoute(cls({ category: "deep-qa", complexity: 0.8 }), null, opts).target).toBe(
      "openrouter",
    );
  });

  test("low classifier confidence is flagged uncertain", () => {
    expect(decideRoute(cls({ confidence: 0.4 }), null, opts).uncertain).toBe(true);
  });

  test("heuristic-only code decision is not uncertain", () => {
    expect(decideRoute(null, "code", opts)).toEqual({
      target: "claude",
      planFirst: false,
      uncertain: false,
    });
  });
});
