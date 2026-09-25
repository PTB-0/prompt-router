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
  // Owner-only: this is the full text of the conversation.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = sessionFile(dir);
  fs.writeFileSync(file, JSON.stringify(history, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function clearSession(dir: string): void {
  fs.rmSync(sessionFile(dir), { force: true });
}
