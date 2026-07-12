import { describe, expect, test } from "vitest";
import { mergeEnvKey } from "../src/init.js";

describe("mergeEnvKey", () => {
  test("appends the key when the file is empty", () => {
    expect(mergeEnvKey("", "sk-or-v1-abc")).toBe("OPENROUTER_API_KEY=sk-or-v1-abc\n");
  });

  test("appends the key when the file has other vars but no key", () => {
    expect(mergeEnvKey("SOME_OTHER=1\n", "sk-or-v1-abc")).toBe(
      "SOME_OTHER=1\nOPENROUTER_API_KEY=sk-or-v1-abc\n",
    );
  });

  test("replaces an existing key in place, preserving surrounding lines", () => {
    const before = "SOME_OTHER=1\nOPENROUTER_API_KEY=old-key\nANOTHER=2\n";
    expect(mergeEnvKey(before, "new-key")).toBe(
      "SOME_OTHER=1\nOPENROUTER_API_KEY=new-key\nANOTHER=2\n",
    );
  });
});
