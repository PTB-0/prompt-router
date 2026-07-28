import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatStats, loadStats, recordDispatch } from "../src/stats.js";
import type { Backend, ExecBackend } from "../src/types.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-router-stats-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const claude: ExecBackend = {
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
  modelPricing: {
    haiku: { inputPer1M: 1, outputPer1M: 5 },
    sonnet: { inputPer1M: 3, outputPer1M: 15 },
    opus: { inputPer1M: 5, outputPer1M: 25 },
  },
};

const backends: Backend[] = [claude];

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

  test("the savings comparison is labelled with the backend it was priced against", () => {
    // "all-Claude" was hardcoded. The counterfactual is priced against
    // whichever exec backend actually carries modelPricing, so the label has
    // to name that backend or the headline number claims a comparison it
    // never made.
    recordDispatch(dir, {
      backendId: "local",
      category: "simple-qa",
      usage: { inputTokens: 100, outputTokens: 200, estimated: false },
      spend: 0,
      savedTokens: 300,
      savedUsd: 1.25,
    });
    const renamed: Backend[] = [{ ...claude, id: "agent", label: "Some Agent" }];
    const output = formatStats(loadStats(dir), renamed);
    expect(output).toContain("$1.25 saved vs. all-Some Agent");
    expect(output).not.toContain("all-Claude");
  });

  test("with no priced exec backend, the savings line says so instead of claiming a comparison", () => {
    // A registry whose only agent declares no modelPricing can never
    // accumulate savings. Printing "$0.00 saved vs. all-Claude" there would
    // assert a comparison against a backend that isn't even configured.
    recordDispatch(dir, {
      backendId: "local",
      category: "simple-qa",
      usage: { inputTokens: 100, outputTokens: 200, estimated: false },
      spend: 0.4,
      savedTokens: 0,
      savedUsd: 0,
    });
    const unpriced: Backend[] = [{ ...claude, modelPricing: {} }];
    const output = formatStats(loadStats(dir), unpriced);
    expect(output).not.toContain("saved vs.");
    expect(output).toContain("actual spend: $0.40");
    expect(output).toContain("no priced agentic backend");
  });

  test("formatStats renders an exec backend's tokens as input-only, never a combined total", () => {
    // outputTokens is nonzero on purpose: if the renderer ever merged
    // inTok + outTok for an exec backend, this would render "140" instead of
    // "40(in)", and the money cell would show a dollar figure instead of "—".
    recordDispatch(dir, {
      backendId: "claude",
      category: "code",
      usage: { inputTokens: 40, outputTokens: 100, estimated: false },
      spend: 0,
      savedTokens: 0,
      savedUsd: 0,
    });
    const output = formatStats(loadStats(dir), backends);
    expect(output).toContain("40(in)");
    expect(output).toContain("—");
    expect(output).not.toContain("140");
  });

  test("formatStats renders cleanly on entirely empty stats", () => {
    const output = formatStats(loadStats(dir), backends);
    expect(output).not.toContain("undefined");
    expect(output).not.toContain("NaN");
  });

  test("formatStats renders cleanly for a backend id absent from the passed backends list", () => {
    // Simulates a user removing a backend from config after prior dispatches
    // were recorded against it — the stats file still has the id, but the
    // `backends` argument no longer does.
    recordDispatch(dir, {
      backendId: "retired-backend",
      category: "deep-qa",
      usage: { inputTokens: 5, outputTokens: 5, estimated: false },
      spend: 0.01,
      savedTokens: 0,
      savedUsd: 0,
    });
    const output = formatStats(loadStats(dir), backends);
    expect(output).not.toContain("undefined");
    expect(output).not.toContain("NaN");
  });
});
