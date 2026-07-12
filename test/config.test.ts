import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  test("applies defaults when nothing is provided", () => {
    const cfg = resolveConfig(undefined, {});
    expect(cfg.local.baseUrl).toBe("http://localhost:1234/v1");
    expect(cfg.local.enabled).toBe(true);
    expect(cfg.thresholds.planComplexity).toBe(0.7);
    expect(cfg.openrouter.classifierModels.length).toBeGreaterThan(0);
    expect(cfg.openrouter.apiKey).toBeUndefined();
    expect(cfg.logging.routingLog).toBe(false);
    expect(cfg.modelSelection.enabled).toBe(true);
    expect(cfg.thresholds.modelTierLow).toBe(0.35);
    expect(cfg.thresholds.modelTierHigh).toBe(0.7);
  });

  test("config file values override defaults without wiping siblings", () => {
    const cfg = resolveConfig({ local: { model: "qwen2.5-7b-instruct" } }, {});
    expect(cfg.local.model).toBe("qwen2.5-7b-instruct");
    expect(cfg.local.baseUrl).toBe("http://localhost:1234/v1");
  });

  test("environment variables override the file", () => {
    const cfg = resolveConfig(
      { timeoutMs: 5000 },
      { OPENROUTER_API_KEY: "sk-test", PROMPT_ROUTER_TIMEOUT: "12000" },
    );
    expect(cfg.openrouter.apiKey).toBe("sk-test");
    expect(cfg.timeoutMs).toBe(12000);
  });

  test("invalid timeout falls back to the default", () => {
    expect(resolveConfig({ timeoutMs: -5 }, {}).timeoutMs).toBe(8000);
    expect(resolveConfig(undefined, { PROMPT_ROUTER_TIMEOUT: "abc" }).timeoutMs).toBe(8000);
  });

  test("ignores a malformed config file", () => {
    expect(resolveConfig("not an object", {}).local.enabled).toBe(true);
  });

  test("modelSelection.enabled can be disabled via config file", () => {
    expect(resolveConfig({ modelSelection: { enabled: false } }, {}).modelSelection.enabled).toBe(
      false,
    );
  });

  test("model tier thresholds can be overridden without wiping siblings", () => {
    const cfg = resolveConfig({ thresholds: { modelTierLow: 0.2 } }, {});
    expect(cfg.thresholds.modelTierLow).toBe(0.2);
    expect(cfg.thresholds.modelTierHigh).toBe(0.7);
  });

  test("out-of-range model tier threshold falls back to the default", () => {
    expect(resolveConfig({ thresholds: { modelTierLow: 5 } }, {}).thresholds.modelTierLow).toBe(
      0.35,
    );
  });
});
