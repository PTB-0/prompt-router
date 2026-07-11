import { describe, expect, test } from "vitest";
import { isServerUp } from "../src/local.js";

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
