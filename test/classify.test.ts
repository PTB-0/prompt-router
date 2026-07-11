import { describe, expect, test } from "vitest";
import { parseClassification } from "../src/classify.js";

const valid = JSON.stringify({
  optimized_prompt: "Fix the login bug in src/auth.ts",
  category: "code",
  complexity: 0.8,
  confidence: 0.9,
});

describe("parseClassification", () => {
  test("parses a plain JSON response", () => {
    expect(parseClassification(valid)).toEqual({
      optimizedPrompt: "Fix the login bug in src/auth.ts",
      category: "code",
      complexity: 0.8,
      confidence: 0.9,
    });
  });

  test("parses JSON wrapped in a code fence", () => {
    const fenced = "```json\n" + valid + "\n```";
    expect(parseClassification(fenced)?.category).toBe("code");
  });

  test("extracts JSON surrounded by prose", () => {
    const noisy = "Here is the result:\n" + valid + "\nHope that helps!";
    expect(parseClassification(noisy)?.optimizedPrompt).toContain("login bug");
  });

  test("rejects an unknown category", () => {
    const raw = valid.replace('"code"', '"poetry"');
    expect(parseClassification(raw)).toBeNull();
  });

  test("rejects a missing optimized prompt", () => {
    expect(
      parseClassification(JSON.stringify({ category: "code", complexity: 0.5, confidence: 0.5 })),
    ).toBeNull();
  });

  test("clamps out-of-range scores", () => {
    const raw = JSON.stringify({
      optimized_prompt: "p",
      category: "deep-qa",
      complexity: 1.7,
      confidence: -0.2,
    });
    expect(parseClassification(raw)).toEqual({
      optimizedPrompt: "p",
      category: "deep-qa",
      complexity: 1,
      confidence: 0,
    });
  });

  test("returns null for garbage", () => {
    expect(parseClassification("sorry I cannot help with that")).toBeNull();
  });
});
