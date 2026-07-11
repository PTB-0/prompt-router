import { describe, expect, test } from "vitest";
import { heuristicCategory } from "../src/heuristics.js";

const inProject = { inCodeProject: true };
const noProject = { inCodeProject: false };

describe("heuristicCategory", () => {
  test("code verb plus file reference routes to code", () => {
    expect(heuristicCategory("fix the login bug in auth.ts", noProject)).toBe("code");
  });

  test("code verb inside a code project routes to code", () => {
    expect(heuristicCategory("implement a dark mode toggle", inProject)).toBe("code");
  });

  test("turkish code verb inside a code project routes to code", () => {
    expect(heuristicCategory("login sayfasındaki hatayı düzelt", inProject)).toBe("code");
  });

  test("code verb without file reference outside a project stays undecided", () => {
    expect(heuristicCategory("implement a dark mode toggle", noProject)).toBeNull();
  });

  test("short factual question routes to simple-qa", () => {
    expect(heuristicCategory("What is the capital of France?", noProject)).toBe("simple-qa");
  });

  test("turkish short question routes to simple-qa", () => {
    expect(heuristicCategory("Türkiye'nin başkenti neresi?", noProject)).toBe("simple-qa");
  });

  test("question mentioning an error stays undecided", () => {
    expect(
      heuristicCategory("what does this mean: TypeError: x is undefined?", noProject),
    ).toBeNull();
  });

  test("long open-ended prompt stays undecided", () => {
    expect(
      heuristicCategory(
        "Explain in depth how transformer attention works and compare it with recurrent networks for long documents",
        noProject,
      ),
    ).toBeNull();
  });

  test("empty prompt stays undecided", () => {
    expect(heuristicCategory("   ", noProject)).toBeNull();
  });
});
