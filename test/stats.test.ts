import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatStats, loadStats, recordDispatch } from "../src/stats.js";
import type { Backend } from "../src/types.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-router-stats-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const backends: Backend[] = [
  {
    id: "claude",
    label: "Claude Code",
    kind: "exec",
    categories: ["code"],
    priority: 10,
    enabled: true,
    command: "claude",
    args: ["{prompt}"],
    modelFlag: "--model",
    effortFlag: "--effort",
    continueFlag: "-c",
    supportsModelTier: true,
    supportsPlan: true,
    supportsContinue: true,
    modelPricing: {},
  },
];

describe("stats v2", () => {
  test("a missing file starts from an empty v2 record", () => {
    const stats = loadStats(dir);
    expect(stats.version).toBe(2);
    expect(stats.backends).toEqual({});
    expect(stats.saved).toEqual({ tokens: 0, usd: 0 });
  });

  test("a corrupt file starts from zero instead of throwing", () => {
    fs.writeFileSync(path.join(dir, "stats.json"), "{not json", "utf8");
    expect(loadStats(dir).version).toBe(2);
  });

  test("a v1 file migrates with its counts preserved and no invented tokens", () => {
    fs.writeFileSync(
      path.join(dir, "stats.json"),
      JSON.stringify({ claude: 3, local: 7, openrouter: 2 }),
      "utf8",
    );
    const stats = loadStats(dir);
    expect(stats.version).toBe(2);
    expect(stats.backends["claude"]).toEqual({ count: 3, inTok: 0, outTok: 0, spend: 0 });
    expect(stats.backends["local"]?.count).toBe(7);
    expect(stats.backends["openrouter"]?.count).toBe(2);
    expect(stats.saved).toEqual({ tokens: 0, usd: 0 });
  });

  test("recordDispatch accumulates per backend, per category, and savings", () => {
    recordDispatch(dir, {
      backendId: "local",
      category: "simple-qa",
      usage: { inputTokens: 100, outputTokens: 200, estimated: false },
      spend: 0,
      savedTokens: 300,
      savedUsd: 0.5,
    });
    recordDispatch(dir, {
      backendId: "local",
      category: "simple-qa",
      usage: { inputTokens: 10, outputTokens: 20, estimated: false },
      spend: 0.25,
      savedTokens: 30,
      savedUsd: 0.1,
    });

    const stats = loadStats(dir);
    expect(stats.backends["local"]).toEqual({
      count: 2,
      inTok: 110,
      outTok: 220,
      spend: 0.25,
    });
    expect(stats.categories["simple-qa"]).toBe(2);
    expect(stats.saved.tokens).toBe(330);
    expect(stats.saved.usd).toBeCloseTo(0.6, 10);
  });

  test("formatStats reports the headline savings and actual spend", () => {
    recordDispatch(dir, {
      backendId: "claude",
      category: "code",
      usage: { inputTokens: 40, outputTokens: 0, estimated: true },
      spend: 0,
      savedTokens: 0,
      savedUsd: 0,
    });
    const output = formatStats(loadStats(dir), backends);
    expect(output).toContain("claude");
    expect(output).toContain("saved");
    expect(output).not.toContain("undefined");
  });
});
