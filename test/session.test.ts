import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import { appendToSession, clearSession, loadSession } from "../src/session.js";

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

describe("session", () => {
  test("loads empty history when no session exists", () => {
    expect(loadSession(tempDir())).toEqual([]);
  });

  test("appends and reloads messages", () => {
    const dir = tempDir();
    appendToSession(
      dir,
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      10,
    );
    expect(loadSession(dir)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("trims oldest messages beyond the limit", () => {
    const dir = tempDir();
    appendToSession(dir, [{ role: "user", content: "1" }], 2);
    appendToSession(dir, [{ role: "assistant", content: "2" }], 2);
    appendToSession(dir, [{ role: "user", content: "3" }], 2);
    expect(loadSession(dir)).toEqual([
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
    ]);
  });

  test("clears the session", () => {
    const dir = tempDir();
    appendToSession(dir, [{ role: "user", content: "hi" }], 10);
    clearSession(dir);
    expect(loadSession(dir)).toEqual([]);
  });

  test("survives a corrupted session file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "session.json"), "{broken", "utf8");
    expect(loadSession(dir)).toEqual([]);
  });
});
