import * as fs from "fs";
import * as path from "path";
import type { SessionMessage } from "./types.js";

function sessionFile(dir: string): string {
  return path.join(dir, "session.json");
}

function isMessage(value: unknown): value is SessionMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record["role"] === "user" || record["role"] === "assistant") &&
    typeof record["content"] === "string"
  );
}

export function loadSession(dir: string): SessionMessage[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(sessionFile(dir), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMessage);
  } catch {
    return [];
  }
}

export function appendToSession(dir: string, messages: SessionMessage[], max: number): void {
  const history = [...loadSession(dir), ...messages].slice(-max);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFile(dir), JSON.stringify(history, null, 2), "utf8");
}

export function clearSession(dir: string): void {
  fs.rmSync(sessionFile(dir), { force: true });
}
