import { describe, expect, it } from "vitest";
import { quoteForWindowsShell, toShellArgs } from "../src/winShell.js";

describe("quoteForWindowsShell", () => {
  it("caret-escapes every cmd metacharacter so the shell keeps one literal token", () => {
    expect(quoteForWindowsShell("buna neler katabiliriz")).toBe(
      '^^^"buna^^^ neler^^^ katabiliriz^^^"',
    );
  });

  it("escapes embedded double quotes for the argv parser and for cmd", () => {
    expect(quoteForWindowsShell('say "hi"')).toBe('^^^"say^^^ \\^^^"hi\\^^^"^^^"');
  });

  it("leaves no bare quote or metacharacter for cmd to interpret", () => {
    const quoted = quoteForWindowsShell('fix this " && del /q *.txt');
    // Every character cmd could act on must be caret-escaped — a bare `"`
    // would toggle quoting off and let the `&&` execute the `del`.
    for (const match of quoted.matchAll(/["&|<>%!`]/g)) {
      expect(quoted[(match.index ?? 0) - 1]).toBe("^");
    }
    expect(quoted).toContain("^^^&^^^&");
  });

  it("doubles backslash runs before quotes so the argv parser keeps them literal", () => {
    expect(quoteForWindowsShell('path \\" end')).toContain('\\\\\\^^^"');
  });
});

describe("toShellArgs", () => {
  it("quotes every arg when a shell will interpret them", () => {
    expect(toShellArgs(["-c", "buna neler katabiliriz"], true)).toEqual([
      '^^^"-c^^^"',
      '^^^"buna^^^ neler^^^ katabiliriz^^^"',
    ]);
  });

  it("leaves args untouched when no shell is involved", () => {
    expect(toShellArgs(["-c", "buna neler katabiliriz"], false)).toEqual([
      "-c",
      "buna neler katabiliriz",
    ]);
  });
});
