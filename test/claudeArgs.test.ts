import { describe, expect, test } from "vitest";
import { buildClaudeArgs } from "../src/claudeArgs.js";

describe("buildClaudeArgs", () => {
  test("plain prompt, no continue, no model/effort", () => {
    expect(buildClaudeArgs("fix the bug", false)).toEqual(["fix the bug"]);
  });

  test("continue flag precedes the prompt", () => {
    expect(buildClaudeArgs("and now?", true)).toEqual(["-c", "and now?"]);
  });

  test("model flag is prepended before the prompt args", () => {
    expect(buildClaudeArgs("fix the bug", false, "sonnet")).toEqual([
      "--model",
      "sonnet",
      "fix the bug",
    ]);
  });

  test("effort flag is prepended before the prompt args", () => {
    expect(buildClaudeArgs("fix the bug", false, undefined, "high")).toEqual([
      "--effort",
      "high",
      "fix the bug",
    ]);
  });

  test("model and effort both prepended, continue flag stays with the prompt", () => {
    expect(buildClaudeArgs("and now?", true, "opus", "max")).toEqual([
      "--model",
      "opus",
      "--effort",
      "max",
      "-c",
      "and now?",
    ]);
  });
});
