import { describe, expect, test } from "vitest";
import { chatCompletion, extractSseDeltas, streamChat, withModelFallback } from "../src/llm.js";
import type { TokenUsage } from "../src/types.js";

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
    expect(extractSseDeltas(chunk)).toEqual({ deltas: ["Hel", "lo"], usage: null, rest: "" });
  });

  test("keeps a partial event in the buffer", () => {
    const chunk = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"cho';
    expect(extractSseDeltas(chunk)).toEqual({
      deltas: ["a"],
      usage: null,
      rest: 'data: {"cho',
    });
  });

  test("ignores the done marker and malformed events", () => {
    const chunk = "data: [DONE]\n\ndata: not-json\n\n";
    expect(extractSseDeltas(chunk).deltas).toEqual([]);
  });
});

describe("usage capture", () => {
  test("extractSseDeltas surfaces a trailing usage event", () => {
    const buffer =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n';
    const { deltas, usage } = extractSseDeltas(buffer);
    expect(deltas).toEqual(["hi"]);
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 34, estimated: false });
  });

  test("extractSseDeltas reports null usage when the stream omits it", () => {
    const { usage } = extractSseDeltas('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    expect(usage).toBeNull();
  });

  test("chatCompletion reports usage from the response body", async () => {
    const seen: TokenUsage[] = [];
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const text = await chatCompletion({
      baseUrl: "http://x/v1",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
      fetchImpl,
      onUsage: (usage) => seen.push(usage),
    });

    expect(text).toBe("ok");
    expect(seen).toEqual([{ inputTokens: 5, outputTokens: 7, estimated: false }]);
  });

  test("streamChat reports usage captured from the stream", async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n' +
      "data: [DONE]\n\n";
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const seen: TokenUsage[] = [];
    const text = await streamChat(
      {
        baseUrl: "http://x/v1",
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 1000,
        fetchImpl,
        onUsage: (usage) => seen.push(usage),
      },
      () => {},
    );

    expect(text).toBe("hi");
    expect(seen).toEqual([{ inputTokens: 3, outputTokens: 4, estimated: false }]);
  });
});
