import { describe, expect, test } from "vitest";
import { chatCompletion, extractSseDeltas, streamChat, withModelFallback } from "../src/llm.js";

describe("withModelFallback", () => {
  test("returns the first successful result", async () => {
    const tried: string[] = [];
    const result = await withModelFallback(["a", "b", "c"], async (model) => {
      tried.push(model);
      return model === "b" ? "answer" : null;
    });
    expect(result).toBe("answer");
    expect(tried).toEqual(["a", "b"]);
  });

  test("returns null when every model fails", async () => {
    expect(await withModelFallback(["a", "b"], async () => null)).toBeNull();
  });

  test("treats a throwing attempt as a failure and moves on", async () => {
    const result = await withModelFallback(["a", "b"], async (model) => {
      if (model === "a") throw new Error("rate limited");
      return "ok";
    });
    expect(result).toBe("ok");
  });
});

describe("chatCompletion onFailure", () => {
  test("reports the HTTP status when the response is not ok", async () => {
    const reasons: string[] = [];
    const fetchImpl = (async () =>
      new Response("model not found", { status: 404 })) as unknown as typeof fetch;
    const result = await chatCompletion({
      baseUrl: "https://example.test",
      model: "m",
      messages: [],
      timeoutMs: 1000,
      fetchImpl,
      onFailure: (reason) => reasons.push(reason),
    });
    expect(result).toBeNull();
    expect(reasons).toEqual(["http_404"]);
  });

  test("reports the error name when the request throws", async () => {
    const reasons: string[] = [];
    const fetchImpl = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const result = await chatCompletion({
      baseUrl: "https://example.test",
      model: "m",
      messages: [],
      timeoutMs: 1000,
      fetchImpl,
      onFailure: (reason) => reasons.push(reason),
    });
    expect(result).toBeNull();
    expect(reasons).toEqual(["TypeError"]);
  });
});

describe("streamChat onFailure", () => {
  test("reports the HTTP status when the response is not ok", async () => {
    const reasons: string[] = [];
    const fetchImpl = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const result = await streamChat(
      { baseUrl: "https://example.test", model: "m", messages: [], timeoutMs: 1000, fetchImpl, onFailure: (r) => reasons.push(r) },
      () => {},
    );
    expect(result).toBeNull();
    expect(reasons).toEqual(["http_429"]);
  });

  test("aborts a stalled stream so the fallback chain can move on", async () => {
    const reasons: string[] = [];
    const encoder = new TextEncoder();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'),
          );
          // Never close and never send again — a stalled model. The abort
          // signal errors the stream the way a real aborted fetch body would.
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          });
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await streamChat(
      {
        baseUrl: "https://example.test",
        model: "m",
        messages: [],
        timeoutMs: 40,
        fetchImpl,
        onFailure: (r) => reasons.push(r),
      },
      (t) => deltas.push(t),
    );
    expect(deltas).toEqual(["par"]);
    expect(result).toBeNull();
    expect(reasons).toEqual(["AbortError"]);
  });
});

describe("extractSseDeltas", () => {
  test("extracts content deltas from complete events", () => {
    const chunk =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n';
    expect(extractSseDeltas(chunk)).toEqual({ deltas: ["Hel", "lo"], rest: "" });
  });

  test("keeps a partial event in the buffer", () => {
    const chunk = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"cho';
    expect(extractSseDeltas(chunk)).toEqual({ deltas: ["a"], rest: 'data: {"cho' });
  });

  test("ignores the done marker and malformed events", () => {
    const chunk = "data: [DONE]\n\ndata: not-json\n\n";
    expect(extractSseDeltas(chunk).deltas).toEqual([]);
  });
});
