import { describe, expect, test, vi } from "vitest";
import { isServerUp, ensureChatBackend } from "../src/local.js";
import type { ChatBackend } from "../src/types.js";

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

function backend(over: Partial<ChatBackend> = {}): ChatBackend {
  return {
    id: "local",
    label: "local model",
    kind: "chat",
    categories: ["simple-qa"],
    priority: 10,
    enabled: true,
    baseUrl: "http://127.0.0.1:1/v1",
    models: ["m"],
    probe: true,
    autoStart: false,
    autoStartCommand: [],
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    ...over,
  };
}

describe("ensureChatBackend", () => {
  test("a disabled backend is never reachable", async () => {
    await expect(ensureChatBackend(backend({ enabled: false }))).resolves.toBe(false);
  });

  test("a backend that does not probe is assumed reachable", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    try {
      await expect(ensureChatBackend(backend({ probe: false }))).resolves.toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("a probing backend with no server and no autostart is unreachable", async () => {
    await expect(ensureChatBackend(backend({ probe: true, autoStart: false }))).resolves.toBe(
      false,
    );
  });

  test("autoStart with an empty command cannot start anything", async () => {
    await expect(
      ensureChatBackend(backend({ probe: true, autoStart: true, autoStartCommand: [] })),
    ).resolves.toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "fails fast when a nonexistent CLI is missing instead of polling for the server",
    async () => {
      const startedAt = Date.now();
      expect(await ensureChatBackend(backend({ probe: true, autoStart: true, autoStartCommand: ["nonexistent-binary-xyz"] }))).toBe(false);
      // Without the fast-fail on ENOENT, this path polls for ~6s waiting on a server
      // that can never start. The error event from spawn should bail out immediately.
      expect(Date.now() - startedAt).toBeLessThan(3000);
    },
  );
});
