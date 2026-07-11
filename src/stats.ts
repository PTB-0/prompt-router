import * as fs from "fs";
import * as path from "path";
import type { RouteTarget } from "./types.js";

export type Stats = Record<RouteTarget, number>;

function statsFile(dir: string): string {
  return path.join(dir, "stats.json");
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function loadStats(dir: string): Stats {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statsFile(dir), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { claude: 0, local: 0, openrouter: 0 };
    }
    const record = parsed as Record<string, unknown>;
    return {
      claude: toCount(record["claude"]),
      local: toCount(record["local"]),
      openrouter: toCount(record["openrouter"]),
    };
  } catch {
    return { claude: 0, local: 0, openrouter: 0 };
  }
}

export function recordRoute(dir: string, target: RouteTarget): void {
  const stats = loadStats(dir);
  stats[target] += 1;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statsFile(dir), JSON.stringify(stats, null, 2), "utf8");
}

export function formatStats(stats: Stats): string {
  const diverted = stats.local + stats.openrouter;
  const total = diverted + stats.claude;
  return [
    "prompt-router stats",
    `  claude:      ${stats.claude}`,
    `  local:       ${stats.local}`,
    `  openrouter:  ${stats.openrouter}`,
    `  diverted from claude: ${diverted} of ${total} prompts`,
  ].join("\n");
}
