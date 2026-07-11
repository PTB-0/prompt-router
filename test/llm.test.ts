import { describe, expect, test } from "vitest";
import { extractSseDeltas, withModelFallback } from "../src/llm.js";

describe("withModelFallback", () => {
  test("returns the first successful result", async () => {
    const tried: string[] = [];
    const result = await withModelFallback(["a", "b", "c"], async (model) => {
      tried.push(model);
      return model === "b" ? "answer" : null;
    });
    expect(result).toBe("answer");
    expect(tried).toEqual(["a", "b"]);
  });

  test("returns null when every model fails", async () => {
    expect(await withModelFallback(["a", "b"], async () => null)).toBeNull();
  });

  test("treats a throwing attempt as a failure and moves on", async () => {
    const result = await withModelFallback(["a", "b"], async (model) => {
      if (model === "a") throw new Error("rate limited");
      return "ok";
    });
    expect(result).toBe("ok");
  });
});

describe("extractSseDeltas", () => {
  test("extracts content deltas from complete events", () => {
    const chunk =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n';
    expect(extractSseDeltas(chunk)).toEqual({ deltas: ["Hel", "lo"], rest: "" });
  });

  test("keeps a partial event in the buffer", () => {
    const chunk = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"cho';
    expect(extractSseDeltas(chunk)).toEqual({ deltas: ["a"], rest: 'data: {"cho' });
  });

  test("ignores the done marker and malformed events", () => {
    const chunk = "data: [DONE]\n\ndata: not-json\n\n";
    expect(extractSseDeltas(chunk).deltas).toEqual([]);
  });
});
