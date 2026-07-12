import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { appendRoutingLog } from "../src/log.js";

describe("appendRoutingLog", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("appends a timestamped JSON line to routing-log.jsonl", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-router-log-"));
    appendRoutingLog(dir, { type: "classify_failed", failures: [{ model: "m", reason: "http_404" }] });

    const lines = fs
      .readFileSync(path.join(dir, "routing-log.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry.type).toBe("classify_failed");
    expect(entry.failures).toEqual([{ model: "m", reason: "http_404" }]);
    expect(typeof entry.ts).toBe("string");
  });

  test("never throws when the directory cannot be created", () => {
    expect(() => appendRoutingLog("\0invalid", { type: "x" })).not.toThrow();
  });
});
