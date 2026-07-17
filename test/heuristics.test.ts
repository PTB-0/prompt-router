import { describe, expect, test } from "vitest";
import { estimateComplexity, heuristicCategory } from "../src/heuristics.js";

const inProject = { inCodeProject: true };
const noProject = { inCodeProject: false };

describe("heuristicCategory", () => {
  test("code verb plus file reference routes to code", () => {
    expect(heuristicCategory("fix the login bug in auth.ts", noProject)).toBe("code");
  });

  test("strong code verb inside a code project routes to code", () => {
    expect(heuristicCategory("implement a dark mode toggle", inProject)).toBe("code");
    expect(heuristicCategory("refactoring the session store", inProject)).toBe("code");
  });

  test("turkish code verb plus artifact routes to code", () => {
    expect(heuristicCategory("login sayfasındaki hatayı düzelt", inProject)).toBe("code");
    expect(heuristicCategory("bana bir fonksiyon yaz", noProject)).toBe("code");
  });

  test("code verb without file reference outside a project stays undecided", () => {
    expect(heuristicCategory("implement a dark mode toggle", noProject)).toBeNull();
  });

  test("everyday verbs inside a code project do not become code tasks", () => {
    expect(heuristicCategory("write a poem about the sea", inProject)).toBeNull();
    expect(heuristicCategory("add milk to the shopping list", inProject)).toBeNull();
    expect(heuristicCategory("create a birthday message for my mom", inProject)).toBeNull();
    expect(heuristicCategory("bana kısa bir hikaye oluştur", inProject)).toBeNull();
  });

  test("turkish substrings inside unrelated words are not verbs", () => {
    expect(heuristicCategory("kurabiye tarifi öner", inProject)).toBeNull();
    expect(heuristicCategory("liderler zirvesini özetle", inProject)).toBeNull();
  });

  test("abbreviations, domains, and emails are not file references", () => {
    expect(heuristicCategory("write an essay about the U.S. economy", noProject)).toBeNull();
    expect(heuristicCategory("add example.com to my bookmarks", noProject)).toBeNull();
    expect(heuristicCategory("write about the war on terror", inProject)).toBeNull();
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

describe("estimateComplexity", () => {
  test("small contained edits estimate low", () => {
    expect(estimateComplexity("fix typo in readme")).toBeLessThan(0.35);
    expect(estimateComplexity("readme'deki küçük yazım hatasını düzelt")).toBeLessThan(0.35);
  });

  test("system-wide work estimates high", () => {
    expect(estimateComplexity("migrate the whole billing system to postgres")).toBeGreaterThanOrEqual(
      0.7,
    );
    expect(estimateComplexity("tüm oturum yönetimini baştan tasarla")).toBeGreaterThanOrEqual(0.7);
  });

  test("very long prompts estimate high", () => {
    const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(" ");
    expect(estimateComplexity(long)).toBeGreaterThanOrEqual(0.7);
  });

  test("everything else lands in the middle tier", () => {
    const mid = estimateComplexity("add a logout button to the settings page");
    expect(mid).toBeGreaterThanOrEqual(0.35);
    expect(mid).toBeLessThan(0.7);
  });
});
