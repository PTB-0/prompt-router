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
  test("no signal at all falls back to the chat route, not Claude Code", () => {
    expect(decideRoute(null, null, opts)).toEqual({
      target: "openrouter",
      planFirst: false,
      uncertain: true,
    });
  });

  test("a confident non-code classification beats a heuristic code verdict", () => {
    expect(decideRoute(cls({ category: "simple-qa", confidence: 0.9 }), "code", opts).target).toBe(
      "local",
    );
    expect(decideRoute(cls({ category: "deep-qa", confidence: 0.8 }), "code", opts).target).toBe(
      "openrouter",
    );
  });

  test("heuristic code verdict wins when the classifier is unsure", () => {
    const decision = decideRoute(cls({ category: "simple-qa", confidence: 0.4 }), "code", opts);
    expect(decision.target).toBe("claude");
    expect(decision.uncertain).toBe(true);
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

  test("heuristic-only simple question goes local when the classifier is down", () => {
    expect(decideRoute(null, "simple-qa", opts)).toEqual({
      target: "local",
      planFirst: false,
      uncertain: false,
    });
  });
});
