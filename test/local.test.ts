import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config.js";
import { ensureLocalServer, isServerUp } from "../src/local.js";

describe("isServerUp", () => {
  test("reports up when the models endpoint answers", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await isServerUp("http://localhost:1234/v1", 100, fetchImpl)).toBe(true);
  });

  test("reports down when the endpoint errors", async () => {
    const fetchImpl = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await isServerUp("http://localhost:1234/v1", 100, fetchImpl)).toBe(false);
  });

  test("reports down when the request throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await isServerUp("http://localhost:1234/v1", 100, fetchImpl)).toBe(false);
  });
});

describe("ensureLocalServer", () => {
  // On win32 the spawn goes through cmd.exe, which "succeeds" even when the
  // lms binary is missing, so the fast-fail only applies to POSIX.
  test.skipIf(process.platform === "win32")(
    "fails fast when the lms CLI is missing instead of polling for the server",
    async () => {
      const config = resolveConfig({ local: { baseUrl: "http://127.0.0.1:59993/v1" } }, {});
      const startedAt = Date.now();
      expect(await ensureLocalServer(config)).toBe(false);
      // Without the fast-fail this path polls for ~6s waiting on a server
      // that can never start.
      expect(Date.now() - startedAt).toBeLessThan(3000);
    },
  );
});
