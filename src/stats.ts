import * as fs from "fs";
import * as path from "path";
import type { Backend, Category, TokenUsage } from "./types.js";

export interface BackendStats {
  count: number;
  inTok: number;
  outTok: number;
  spend: number;
}

export interface Stats {
  version: 2;
  backends: Record<string, BackendStats>;
  categories: Record<string, number>;
  saved: { tokens: number; usd: number };
}

export interface DispatchRecord {
  backendId: string;
  category: Category;
  usage: TokenUsage;
  /** Actual USD paid to this backend for this prompt. */
  spend: number;
  /** Tokens that did not go to the agentic backend. 0 when it served. */
  savedTokens: number;
  /** Counterfactual USD those tokens would have cost there. */
  savedUsd: number;
}

const V1_KEYS = ["claude", "local", "openrouter"] as const;

function statsFile(dir: string): string {
  return path.join(dir, "stats.json");
}

function emptyStats(): Stats {
  return { version: 2, backends: {}, categories: {}, saved: { tokens: 0, usd: 0 } };
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBackendStats(value: unknown): BackendStats {
  if (!isRecord(value)) return { count: 0, inTok: 0, outTok: 0, spend: 0 };
  return {
    count: toCount(value["count"]),
    inTok: toCount(value["inTok"]),
    outTok: toCount(value["outTok"]),
    spend: toCount(value["spend"]),
  };
}

/**
 * A v1 file holds three counters and nothing else. Its counts carry over; the
 * token and spend fields start at zero rather than being back-filled with
 * numbers that were never measured.
 */
function migrateV1(record: Record<string, unknown>): Stats {
  const stats = emptyStats();
  for (const key of V1_KEYS) {
    const count = toCount(record[key]);
    if (count > 0) stats.backends[key] = { count, inTok: 0, outTok: 0, spend: 0 };
  }
  return stats;
}

export function loadStats(dir: string): Stats {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statsFile(dir), "utf8"));
  } catch {
    return emptyStats();
  }
  if (!isRecord(parsed)) return emptyStats();
  if (parsed["version"] !== 2) return migrateV1(parsed);

  const stats = emptyStats();
  const backends = parsed["backends"];
  if (isRecord(backends)) {
    for (const [id, value] of Object.entries(backends)) {
      stats.backends[id] = parseBackendStats(value);
    }
  }
  const categories = parsed["categories"];
  if (isRecord(categories)) {
    for (const [name, value] of Object.entries(categories)) {
      stats.categories[name] = toCount(value);
    }
  }
  const saved = parsed["saved"];
  if (isRecord(saved)) {
    stats.saved = { tokens: toCount(saved["tokens"]), usd: toCount(saved["usd"]) };
  }
  return stats;
}

export function recordDispatch(dir: string, record: DispatchRecord): void {
  const stats = loadStats(dir);
  const current = stats.backends[record.backendId] ?? {
    count: 0,
    inTok: 0,
    outTok: 0,
    spend: 0,
  };
  stats.backends[record.backendId] = {
    count: current.count + 1,
    inTok: current.inTok + record.usage.inputTokens,
    outTok: current.outTok + record.usage.outputTokens,
    spend: current.spend + record.spend,
  };
  stats.categories[record.category] = (stats.categories[record.category] ?? 0) + 1;
  stats.saved = {
    tokens: stats.saved.tokens + record.savedTokens,
    usd: stats.saved.usd + record.savedUsd,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statsFile(dir), JSON.stringify(stats, null, 2), "utf8");
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

export function formatStats(stats: Stats, backends: readonly Backend[]): string {
  const execIds = new Set(backends.filter((b) => b.kind === "exec").map((b) => b.id));
  const ids = Object.keys(stats.backends);
  const lines = ["prompt-router stats", "", `  ${pad("backend", 13)}${padStart("prompts", 8)}${padStart("tokens", 11)}${padStart("spend", 10)}`];

  let total = 0;
  let diverted = 0;
  let spend = 0;
  for (const id of ids) {
    const entry = stats.backends[id];
    if (!entry) continue;
    total += entry.count;
    spend += entry.spend;
    const isExec = execIds.has(id);
    if (!isExec) diverted += entry.count;
    // Exec backends hand over the terminal, so their output is unobservable —
    // the token column shows input only, and says so.
    const tokens = isExec
      ? `${formatTokens(entry.inTok)}(in)`
      : formatTokens(entry.inTok + entry.outTok);
    const money = isExec ? "—" : `$${entry.spend.toFixed(2)}`;
    lines.push(`  ${pad(id, 13)}${padStart(String(entry.count), 8)}${padStart(tokens, 11)}${padStart(money, 10)}`);
  }

  const categories = Object.entries(stats.categories)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
  lines.push("");
  if (categories) lines.push(`  categories   ${categories}`);
  lines.push(`  diverted     ${diverted} of ${total} prompts`);
  lines.push(
    `  ≈ $${stats.saved.usd.toFixed(2)} saved vs. all-Claude    (actual spend: $${spend.toFixed(2)})`,
  );
  return lines.join("\n");
}
