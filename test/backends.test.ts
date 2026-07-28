import { describe, expect, test } from "vitest";
import {
  findHandoffBackend,
  findPricingReferenceBackend,
  remainingChatBackends,
  selectCandidates,
} from "../src/backends.js";
import type { Backend, ChatBackend, ExecBackend } from "../src/types.js";

function chat(over: Partial<ChatBackend> & { id: string }): ChatBackend {
  return {
    label: over.id,
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
    ...over,
  };
}

function exec(over: Partial<ExecBackend> & { id: string }): ExecBackend {
  return {
    label: over.id,
    kind: "exec",
    categories: ["code"],
    priority: 0,
    enabled: true,
    command: over.id,
    args: ["{prompt}"],
    modelFlag: "--model",
    effortFlag: "--effort",
    continueFlag: "-c",
    supportsModelTier: false,
    supportsPlan: false,
    supportsContinue: false,
    modelPricing: {},
    ...over,
  };
}

describe("selectCandidates", () => {
  test("orders matching backends by descending priority", () => {
    const backends: Backend[] = [
      chat({ id: "low", priority: 1 }),
      chat({ id: "high", priority: 10 }),
      chat({ id: "mid", priority: 5 }),
    ];
    expect(selectCandidates("simple-qa", backends).map((b) => b.id)).toEqual([
      "high",
      "mid",
      "low",
    ]);
  });

  test("drops backends that do not serve the category", () => {
    const backends: Backend[] = [chat({ id: "a" }), exec({ id: "b", categories: ["code"] })];
    expect(selectCandidates("simple-qa", backends).map((b) => b.id)).toEqual(["a"]);
  });

  test("drops disabled backends so the next candidate serves", () => {
    const backends: Backend[] = [
      chat({ id: "local", priority: 10, enabled: false }),
      chat({ id: "openrouter", priority: 5 }),
    ];
    expect(selectCandidates("simple-qa", backends).map((b) => b.id)).toEqual(["openrouter"]);
  });

  test("equal priorities keep config order", () => {
    const backends: Backend[] = [
      chat({ id: "first", priority: 5 }),
      chat({ id: "second", priority: 5 }),
    ];
    expect(selectCandidates("simple-qa", backends).map((b) => b.id)).toEqual([
      "first",
      "second",
    ]);
  });

  test("no candidate yields an empty list", () => {
    expect(selectCandidates("code", [chat({ id: "a" })])).toEqual([]);
  });
});

describe("remainingChatBackends", () => {
  test("returns enabled chat backends outside the tried set, by descending priority", () => {
    const backends: Backend[] = [
      chat({ id: "low", priority: 1 }),
      chat({ id: "high", priority: 10 }),
      chat({ id: "tried", priority: 20 }),
    ];
    expect(remainingChatBackends(backends, new Set(["tried"])).map((b) => b.id)).toEqual([
      "high",
      "low",
    ]);
  });

  test("ignores the category entirely — that is the point of the sweep", () => {
    // The local backend only declares "simple-qa"; a keyless run resolves
    // every unclaimed prompt to "deep-qa". It must still be reachable.
    const backends: Backend[] = [chat({ id: "local", categories: ["simple-qa"] })];
    expect(remainingChatBackends(backends, new Set()).map((b) => b.id)).toEqual(["local"]);
  });

  test("skips disabled chat backends and every exec backend", () => {
    const backends: Backend[] = [
      chat({ id: "off", enabled: false }),
      exec({ id: "claude", priority: 10 }),
      chat({ id: "on" }),
    ];
    expect(remainingChatBackends(backends, new Set()).map((b) => b.id)).toEqual(["on"]);
  });

  test("equal priorities keep config order", () => {
    const backends: Backend[] = [
      chat({ id: "first", priority: 5 }),
      chat({ id: "second", priority: 5 }),
    ];
    expect(remainingChatBackends(backends, new Set()).map((b) => b.id)).toEqual([
      "first",
      "second",
    ]);
  });
});

describe("findHandoffBackend", () => {
  test("returns the highest-priority enabled exec backend", () => {
    const backends: Backend[] = [
      chat({ id: "local" }),
      exec({ id: "aider", priority: 1 }),
      exec({ id: "claude", priority: 10 }),
    ];
    expect(findHandoffBackend(backends)?.id).toBe("claude");
  });

  test("ignores disabled exec backends", () => {
    const backends: Backend[] = [exec({ id: "claude", priority: 10, enabled: false })];
    expect(findHandoffBackend(backends)).toBeNull();
  });

  test("returns null when there is no exec backend at all", () => {
    expect(findHandoffBackend([chat({ id: "local" })])).toBeNull();
  });
});

describe("findPricingReferenceBackend", () => {
  const priced = { haiku: { inputPer1M: 1, outputPer1M: 5 } };

  test("skips a higher-priority exec backend that declares no pricing", () => {
    // The plan's headline use case: adding a coding agent is a config edit.
    // Declaring `aider` above Claude Code must not zero the counterfactual —
    // where a failure hands off and what the saving is priced against are
    // two different questions.
    const backends: Backend[] = [
      exec({ id: "aider", priority: 20, modelPricing: {} }),
      exec({ id: "claude", priority: 10, modelPricing: priced }),
    ];
    expect(findHandoffBackend(backends)?.id).toBe("aider");
    expect(findPricingReferenceBackend(backends)?.id).toBe("claude");
  });

  test("prefers the highest-priority priced exec backend", () => {
    const backends: Backend[] = [
      exec({ id: "cheap", priority: 1, modelPricing: priced }),
      exec({ id: "strong", priority: 10, modelPricing: priced }),
    ];
    expect(findPricingReferenceBackend(backends)?.id).toBe("strong");
  });

  test("ignores disabled and chat backends", () => {
    const backends: Backend[] = [
      chat({ id: "local" }),
      exec({ id: "off", priority: 50, modelPricing: priced, enabled: false }),
      exec({ id: "claude", priority: 10, modelPricing: priced }),
    ];
    expect(findPricingReferenceBackend(backends)?.id).toBe("claude");
  });

  test("falls back to the handoff backend when nothing declares pricing", () => {
    // Keeps the old behaviour — savingsFor then yields zero, which is honest:
    // there is no price to compare against.
    const backends: Backend[] = [
      exec({ id: "aider", priority: 20, modelPricing: {} }),
      exec({ id: "codex", priority: 5, modelPricing: {} }),
    ];
    expect(findPricingReferenceBackend(backends)?.id).toBe("aider");
  });

  test("returns null when there is no exec backend at all", () => {
    expect(findPricingReferenceBackend([chat({ id: "local" })])).toBeNull();
  });
});
