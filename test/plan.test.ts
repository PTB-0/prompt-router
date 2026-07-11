import { describe, expect, test } from "vitest";
import { attachPlan } from "../src/plan.js";

describe("attachPlan", () => {
  test("attaches the plan below the prompt with a clear marker", () => {
    const out = attachPlan("Build a todo app", "1. scaffold\n2. tests");
    expect(out).toContain("Build a todo app");
    expect(out).toContain("1. scaffold");
    expect(out.toUpperCase()).toContain("PLAN");
    expect(out.indexOf("Build a todo app")).toBeLessThan(out.indexOf("1. scaffold"));
  });
});
