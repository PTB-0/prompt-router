import { describe, expect, it } from "vitest";
import { quoteForWindowsShell, toShellArgs } from "../src/winShell.js";

describe("quoteForWindowsShell", () => {
  it("wraps a multi-word argument in quotes so the shell keeps it as one token", () => {
    expect(quoteForWindowsShell("buna neler katabiliriz")).toBe('"buna neler katabiliriz"');
  });

  it("escapes embedded double quotes", () => {
    expect(quoteForWindowsShell('say "hi"')).toBe('"say \\"hi\\""');
  });
});

describe("toShellArgs", () => {
  it("quotes every arg when a shell will interpret them", () => {
    expect(toShellArgs(["-c", "buna neler katabiliriz"], true)).toEqual([
      '"-c"',
      '"buna neler katabiliriz"',
    ]);
  });

  it("leaves args untouched when no shell is involved", () => {
    expect(toShellArgs(["-c", "buna neler katabiliriz"], false)).toEqual([
      "-c",
      "buna neler katabiliriz",
    ]);
  });
});
