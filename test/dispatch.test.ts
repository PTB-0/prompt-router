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

describe("execSpawnPlan", () => {
  // On win32, execSpawnPlan always shells out through cmd.exe (see
  // src/winShell.ts), so args are caret-quoted for the shell and no longer
  // equal the plain tokens asserted below. Same pattern as the win32 skip in
  // test/local.test.ts.
  test.skipIf(process.platform === "win32")(
    "expands the template and reports the command",
    () => {
      const plan = execSpawnPlan(exec, { prompt: "hi", continueSession: false, model: "opus" });
      expect(plan.command).toBe("claude");
      expect(plan.args).toContain("--model");
      expect(plan.args).toContain("opus");
      expect(plan.args).toContain("hi");
    },
  );
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
