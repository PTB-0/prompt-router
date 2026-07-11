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
});
