import { describe, expect, test } from "vitest";
import { buildExecArgs } from "../src/execArgs.js";
import type { ExecBackend } from "../src/types.js";

function exec(over: Partial<ExecBackend> = {}): ExecBackend {
  return {
    id: "claude",
    label: "Claude Code",
    kind: "exec",
    categories: ["code"],
    priority: 10,
    enabled: true,
    command: "claude",
    args: ["{model}", "{effort}", "{continue}", "{prompt}"],
    modelFlag: "--model",
    effortFlag: "--effort",
    continueFlag: "-c",
    supportsModelTier: true,
    supportsPlan: true,
    supportsContinue: true,
    modelPricing: {},
    ...over,
  };
}

describe("buildExecArgs", () => {
  test("bare prompt when nothing else is set", () => {
    expect(buildExecArgs(exec(), { prompt: "hi", continueSession: false })).toEqual(["hi"]);
  });

  test("model and effort expand to flag pairs", () => {
    expect(
      buildExecArgs(exec(), {
        prompt: "hi",
        continueSession: false,
        model: "opus",
        effort: "high",
      }),
    ).toEqual(["--model", "opus", "--effort", "high", "hi"]);
  });

  test("continue expands to the configured flag", () => {
    expect(buildExecArgs(exec(), { prompt: "hi", continueSession: true })).toEqual(["-c", "hi"]);
  });

  test("continue is dropped when the backend does not support it", () => {
    const backend = exec({ supportsContinue: false });
    expect(buildExecArgs(backend, { prompt: "hi", continueSession: true })).toEqual(["hi"]);
  });

  test("literal tokens pass through and a prompt with spaces stays one argument", () => {
    const aider = exec({
      id: "aider",
      command: "aider",
      args: ["--message", "{prompt}"],
      supportsModelTier: false,
      supportsPlan: false,
      supportsContinue: false,
    });
    expect(
      buildExecArgs(aider, { prompt: "fix the login bug", continueSession: true, model: "opus" }),
    ).toEqual(["--message", "fix the login bug"]);
  });

  test("custom flag names are honoured", () => {
    const gemini = exec({ id: "gemini", command: "gemini", modelFlag: "-m" });
    expect(
      buildExecArgs(gemini, { prompt: "hi", continueSession: false, model: "pro" }),
    ).toEqual(["-m", "pro", "hi"]);
  });
});
