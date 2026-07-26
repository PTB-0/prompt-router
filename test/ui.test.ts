import { describe, expect, test } from "vitest";
import { overrideKeyMap } from "../src/ui.js";
import type { Backend, ChatBackend } from "../src/types.js";

function chat(id: string): ChatBackend {
  return {
    id,
    label: id,
    kind: "chat",
    categories: ["simple-qa"],
    priority: 0,
    enabled: true,
    baseUrl: "http://x/v1",
    models: ["m"],
    probe: false,
    autoStart: false,
    autoStartCommand: [],
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  };
}

describe("overrideKeyMap", () => {
  test("binds the first three candidates to 1, 2, and 3", () => {
    const candidates: Backend[] = [chat("a"), chat("b"), chat("c"), chat("d")];
    const keys = overrideKeyMap(candidates);
    expect(keys.get("1")).toBe("a");
    expect(keys.get("2")).toBe("b");
    expect(keys.get("3")).toBe("c");
    expect(keys.has("4")).toBe(false);
  });

  test("keeps the legacy c/l/o letters bound to their backends", () => {
    const candidates: Backend[] = [chat("local"), chat("openrouter"), chat("claude")];
    const keys = overrideKeyMap(candidates);
    expect(keys.get("c")).toBe("claude");
    expect(keys.get("l")).toBe("local");
    expect(keys.get("o")).toBe("openrouter");
  });

  test("a legacy letter is not bound when its backend is absent", () => {
    expect(overrideKeyMap([chat("aider")]).has("c")).toBe(false);
  });
});
