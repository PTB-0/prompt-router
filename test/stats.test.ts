import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { formatStats, loadStats, recordRoute } from "../src/stats.js";

let dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prompt-router-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("stats", () => {
  test("starts at zero", () => {
    expect(loadStats(tempDir())).toEqual({ claude: 0, local: 0, openrouter: 0 });
  });

  test("counts recorded routes", () => {
    const dir = tempDir();
    recordRoute(dir, "local");
    recordRoute(dir, "local");
    recordRoute(dir, "claude");
    expect(loadStats(dir)).toEqual({ claude: 1, local: 2, openrouter: 0 });
  });

  test("reports how many prompts were diverted away from claude", () => {
    expect(formatStats({ claude: 3, local: 5, openrouter: 2 })).toContain("7");
  });
});
