import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config.js";
import type { ChatBackend, ExecBackend } from "../src/types.js";

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

function chat(cfg: ReturnType<typeof resolveConfig>, id: string): ChatBackend {
  const found = cfg.backends.find((b) => b.id === id);
  if (!found || found.kind !== "chat") throw new Error(`no chat backend ${id}`);
  return found;
}

function exec(cfg: ReturnType<typeof resolveConfig>, id: string): ExecBackend {
  const found = cfg.backends.find((b) => b.id === id);
  if (!found || found.kind !== "exec") throw new Error(`no exec backend ${id}`);
  return found;
}

describe("backend registry config", () => {
  test("an empty config yields the three default backends", () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.backends.map((b) => b.id)).toEqual(["claude", "local", "openrouter"]);
    expect(exec(cfg, "claude").supportsPlan).toBe(true);
    expect(chat(cfg, "local").categories).toEqual(["simple-qa"]);
    expect(chat(cfg, "openrouter").categories).toEqual(["simple-qa", "deep-qa"]);
  });

  test("claude carries reference pricing for every tier", () => {
    const pricing = exec(resolveConfig({}, {}), "claude").modelPricing;
    expect(pricing["haiku"]).toEqual({ inputPer1M: 1, outputPer1M: 5 });
    expect(pricing["sonnet"]).toEqual({ inputPer1M: 3, outputPer1M: 15 });
    expect(pricing["opus"]).toEqual({ inputPer1M: 5, outputPer1M: 25 });
  });

  test("legacy local block is derived into the local backend", () => {
    const cfg = resolveConfig(
      { local: { baseUrl: "http://x:1/v1", model: "m", enabled: false, autoStart: false } },
      {},
    );
    const local = chat(cfg, "local");
    expect(local.baseUrl).toBe("http://x:1/v1");
    expect(local.models).toEqual(["m"]);
    expect(local.enabled).toBe(false);
    expect(local.autoStart).toBe(false);
  });

  test("legacy answerModels become the openrouter backend chain", () => {
    const cfg = resolveConfig({ openrouter: { answerModels: ["a", "b"] } }, {});
    expect(chat(cfg, "openrouter").models).toEqual(["a", "b"]);
  });

  test("an explicit backends array replaces the defaults", () => {
    const cfg = resolveConfig(
      {
        backends: [
          { id: "aider", kind: "exec", command: "aider", args: ["--message", "{prompt}"] },
        ],
      },
      {},
    );
    expect(cfg.backends.map((b) => b.id)).toEqual(["aider"]);
    const aider = exec(cfg, "aider");
    expect(aider.args).toEqual(["--message", "{prompt}"]);
    expect(aider.supportsPlan).toBe(false);
    expect(aider.supportsModelTier).toBe(false);
    expect(aider.enabled).toBe(true);
  });

  test("an invalid backend entry is skipped, the rest survive", () => {
    const cfg = resolveConfig(
      {
        backends: [
          { id: "", kind: "exec", command: "x", args: [] },
          { id: "nokind", command: "x", args: [] },
          { id: "ok", kind: "exec", command: "ok", args: ["{prompt}"] },
        ],
      },
      {},
    );
    expect(cfg.backends.map((b) => b.id)).toEqual(["ok"]);
  });

  test("env overrides apply to the local backend derived from a legacy config", () => {
    const cfg = resolveConfig(
      {},
      { PROMPT_ROUTER_LOCAL_URL: "http://env:9/v1", PROMPT_ROUTER_LOCAL_MODEL: "envmodel" },
    );
    const local = chat(cfg, "local");
    expect(local.baseUrl).toBe("http://env:9/v1");
    expect(local.models).toEqual(["envmodel"]);
  });

  test("env overrides apply to a local backend the config declares", () => {
    // The test above only covers the legacy derivation, which reads cfg.local
    // (where the env overrides land). A declared `backends` array skips that
    // path entirely — and since the setup wizard now writes one, this is the
    // shape most configs will have, so the two documented env vars have to
    // keep working here too.
    const cfg = resolveConfig(
      {
        backends: [
          {
            id: "local",
            kind: "chat",
            label: "local model",
            baseUrl: "http://localhost:1234/v1",
            models: ["from-file"],
            categories: ["simple-qa"],
            priority: 10,
          },
        ],
      },
      { PROMPT_ROUTER_LOCAL_URL: "http://env:9/v1", PROMPT_ROUTER_LOCAL_MODEL: "envmodel" },
    );
    const local = chat(cfg, "local");
    expect(local.baseUrl).toBe("http://env:9/v1");
    expect(local.models).toEqual(["envmodel"]);
  });

  test("the local env overrides leave other chat backends alone", () => {
    const cfg = resolveConfig(
      {},
      { PROMPT_ROUTER_LOCAL_URL: "http://env:9/v1", PROMPT_ROUTER_LOCAL_MODEL: "envmodel" },
    );
    expect(chat(cfg, "openrouter").baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(chat(cfg, "openrouter").models).not.toContain("envmodel");
  });
});
