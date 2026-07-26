import { describe, expect, test } from "vitest";
import { decideRoute } from "../src/route.js";
import type { Classification } from "../src/types.js";

const opts = { confidenceThreshold: 0.6, planComplexityThreshold: 0.7 };

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
  test("no signal at all falls back to a question, not a code task", () => {
    expect(decideRoute(null, null, opts)).toEqual({
      category: "deep-qa",
      planFirst: false,
      uncertain: true,
    });
  });

  test("a confident non-code classification beats a heuristic code verdict", () => {
    expect(decideRoute(cls({ category: "simple-qa", confidence: 0.9 }), "code", opts).category).toBe(
      "simple-qa",
    );
    expect(decideRoute(cls({ category: "deep-qa", confidence: 0.8 }), "code", opts).category).toBe(
      "deep-qa",
    );
  });

  test("heuristic code verdict wins when the classifier is unsure", () => {
    const decision = decideRoute(cls({ category: "simple-qa", confidence: 0.4 }), "code", opts);
    expect(decision.category).toBe("code");
    expect(decision.uncertain).toBe(true);
  });

  test("an unsure code classification still wins over a non-code heuristic", () => {
    expect(
      decideRoute(cls({ category: "code", confidence: 0.3 }), "simple-qa", opts).category,
    ).toBe("code");
  });

  test("complex code task is eligible for the plan-first pipeline", () => {
    expect(decideRoute(cls({ category: "code", complexity: 0.9 }), null, opts)).toEqual({
      category: "code",
      planFirst: true,
      uncertain: false,
    });
  });

  test("trivial code task skips the plan", () => {
    expect(decideRoute(cls({ category: "code", complexity: 0.3 }), "code", opts)).toEqual({
      category: "code",
      planFirst: false,
      uncertain: false,
    });
  });

  test("a complex question is never plan-first", () => {
    expect(decideRoute(cls({ category: "deep-qa", complexity: 0.9 }), null, opts).planFirst).toBe(
      false,
    );
  });

  test("confident simple question stays simple-qa", () => {
    expect(decideRoute(cls({}), "simple-qa", opts).category).toBe("simple-qa");
  });

  test("low classifier confidence is flagged uncertain", () => {
    expect(decideRoute(cls({ confidence: 0.4 }), null, opts).uncertain).toBe(true);
  });

  test("heuristic-only code decision is not uncertain", () => {
    expect(decideRoute(null, "code", opts)).toEqual({
      category: "code",
      planFirst: false,
      uncertain: false,
    });
  });

  test("heuristic-only simple question when the classifier is down", () => {
    expect(decideRoute(null, "simple-qa", opts)).toEqual({
      category: "simple-qa",
      planFirst: false,
      uncertain: false,
    });
  });
});
