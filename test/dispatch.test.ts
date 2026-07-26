import { describe, expect, test } from "vitest";
import { dispatchChat, execSpawnPlan } from "../src/dispatch.js";
import type { ChatBackend, ExecBackend } from "../src/types.js";

const exec: ExecBackend = {
  id: "claude",
  label: "Claude Code",
  kind: "exec",
  categories: ["code"],
  priority: 10,
  enabled: true,
  command: "claude",
  args: ["{model}", "{prompt}"],
  modelFlag: "--model",
  effortFlag: "--effort",
  continueFlag: "-c",
  supportsModelTier: true,
  supportsPlan: true,
  supportsContinue: true,
  modelPricing: {},
};

function chat(over: Partial<ChatBackend> = {}): ChatBackend {
  return {
    id: "or",
    label: "OpenRouter",
    kind: "chat",
    categories: ["deep-qa"],
    priority: 5,
    enabled: true,
    baseUrl: "http://x/v1",
    models: ["m1", "m2"],
    probe: false,
    autoStart: false,
    autoStartCommand: [],
    pricing: { inputPer1M: 2, outputPer1M: 10 },
    ...over,
  };
}

function sseResponse(text: string, promptTokens: number, completionTokens: number): Response {
  const body =
    `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n` +
    `data: {"choices":[],"usage":{"prompt_tokens":${promptTokens},"completion_tokens":${completionTokens}}}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * A response whose body yields one SSE delta and then errors the stream
 * before [DONE] or a usage event — simulating a model that streamed some
 * partial text, then dropped mid-stream. Used to prove per-attempt state
 * (accumulated text, reported usage) does not survive into the next model's
 * attempt.
 */
function droppedMidStreamResponse(partialText: string): Response {
  const encoder = new TextEncoder();
  let pulled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) {
        pulled = true;
        controller.enqueue(
          encoder.encode(
            `data: {"choices":[{"delta":{"content":${JSON.stringify(partialText)}}}]}\n\n`,
          ),
        );
        return;
      }
      controller.error(new Error("connection dropped mid-stream"));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("execSpawnPlan", () => {
  // execSpawnPlan shells out through cmd.exe only on win32 (see
  // src/winShell.ts); off win32 it passes args through untouched. Both
  // branches are asserted here so whichever OS a given CI runner is on, it
  // exercises and pins its own live code path — the win32 branch is never
  // skipped, since windows-latest is the only runner where it actually runs.
  // The synthetic "claude" command does not resolve on a vanilla runner, so
  // isBatchShim is false and the single-caret form below is exactly what
  // both windows-latest CI and this machine produce.
  test("expands the template and reports the command", () => {
    const plan = execSpawnPlan(exec, { prompt: "hi", continueSession: false, model: "opus" });
    expect(plan.command).toBe("claude");
    if (process.platform === "win32") {
      expect(plan.useShell).toBe(true);
      expect(plan.args).toContain('^"--model^"');
      expect(plan.args).toContain('^"opus^"');
      expect(plan.args).toContain('^"hi^"');
    } else {
      expect(plan.useShell).toBe(false);
      expect(plan.args).toContain("--model");
      expect(plan.args).toContain("opus");
      expect(plan.args).toContain("hi");
    }
  });
});

describe("dispatchChat", () => {
  test("returns the answer, the serving model, exact usage, and the cost", async () => {
    const fetchImpl = (async () => sseResponse("hello", 1_000_000, 0)) as unknown as typeof fetch;
    const result = await dispatchChat(chat(), {
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
      onDelta: () => {},
      fetchImpl,
    });

    expect(result?.text).toBe("hello");
    expect(result?.model).toBe("m1");
    expect(result?.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 0, estimated: false });
    expect(result?.spend).toBeCloseTo(2, 10);
  });

  test("falls through to the next model when the first fails", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response("nope", { status: 500 });
      return sseResponse("second", 4, 6);
    }) as unknown as typeof fetch;

    const result = await dispatchChat(chat(), {
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
      onDelta: () => {},
      fetchImpl,
    });

    expect(result?.text).toBe("second");
    expect(result?.model).toBe("m2");
  });

  test("does not leak the failed model's partial text, usage, or name into the successful attempt", async () => {
    // First model streams a chunk of text, then the connection drops before
    // any usage event or [DONE] — a genuine mid-stream failure, not an
    // upfront HTTP error. Second model succeeds but (like the estimate-
    // fallback test) reports no usage, so its cost is estimated from
    // `produced` — the exact place a leaked accumulator would surface.
    const leakedText = "A".repeat(40); // 40 chars => would estimate to 10 tokens if it leaked in
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return droppedMidStreamResponse(leakedText);
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const result = await dispatchChat(chat(), {
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
      onDelta: () => {},
      fetchImpl,
    });

    expect(result?.text).toBe("ok");
    expect(result?.model).toBe("m2");
    // estimateTokens("hi") = 1, estimateTokens("ok") = 1 — if the first
    // model's 40-char leak or its usage survived, either the outputTokens
    // estimate or the reported flag would diverge from this.
    expect(result?.usage).toEqual({ inputTokens: 1, outputTokens: 1, estimated: true });
    expect(result?.spend).toBeCloseTo(0.000012, 10);
  });

  test("returns null when every model fails", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await dispatchChat(chat(), {
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
      onDelta: () => {},
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  test("falls back to an estimate when the provider reports no usage", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"abcd"}}]}\n\ndata: [DONE]\n\n';
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const result = await dispatchChat(chat(), {
      messages: [{ role: "user", content: "12345678" }],
      timeoutMs: 1000,
      onDelta: () => {},
      fetchImpl,
    });

    expect(result?.usage.estimated).toBe(true);
    expect(result?.usage.inputTokens).toBe(2);
    expect(result?.usage.outputTokens).toBe(1);
  });
});
