import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isBatchExt,
  quoteForWindowsShell,
  resolveWindowsCommand,
  toShellArgs,
} from "../src/winShell.js";

describe("quoteForWindowsShell — double-escaped (.cmd/.bat shim)", () => {
  it("caret-escapes every cmd metacharacter twice so the shim's %* re-parse keeps one literal token", () => {
    expect(quoteForWindowsShell("buna neler katabiliriz", true)).toBe(
      '^^^"buna^^^ neler^^^ katabiliriz^^^"',
    );
  });

  it("escapes embedded double quotes for the argv parser and for both cmd passes", () => {
    expect(quoteForWindowsShell('say "hi"', true)).toBe('^^^"say^^^ \\^^^"hi\\^^^"^^^"');
  });

  it("leaves no bare quote or metacharacter for cmd to interpret", () => {
    const quoted = quoteForWindowsShell('fix this " && del /q *.txt', true);
    // Every character cmd could act on must be caret-escaped — a bare `"`
    // would toggle quoting off and let the `&&` execute the `del`.
    for (const match of quoted.matchAll(/["&|<>%!`]/g)) {
      expect(quoted[(match.index ?? 0) - 1]).toBe("^");
    }
    expect(quoted).toContain("^^^&^^^&");
  });

  it("doubles backslash runs before quotes so the argv parser keeps them literal", () => {
    expect(quoteForWindowsShell('path \\" end', true)).toContain('\\\\\\^^^"');
  });
});

describe("quoteForWindowsShell — single-escaped (native .exe)", () => {
  // A native exe is reached through exactly ONE cmd parse pass (no `%*`
  // re-expansion), so it must get exactly ONE caret layer. A second layer
  // survives into the program's argv as literal carets — turning `--model`
  // into `^--model^`.
  it("caret-escapes every cmd metacharacter exactly once", () => {
    expect(quoteForWindowsShell("--model", false)).toBe('^"--model^"');
    expect(quoteForWindowsShell("buna neler katabiliriz", false)).toBe(
      '^"buna^ neler^ katabiliriz^"',
    );
  });

  it("still neutralizes injection metacharacters in a single pass", () => {
    const quoted = quoteForWindowsShell('fix this " && del /q *.txt', false);
    for (const match of quoted.matchAll(/["&|<>%!`]/g)) {
      expect(quoted[(match.index ?? 0) - 1]).toBe("^");
    }
    // no double carets when single-escaping
    expect(quoted).not.toContain("^^");
  });
});

describe("toShellArgs", () => {
  it("double-escapes every arg for a batch shim", () => {
    expect(toShellArgs(["-c", "buna neler katabiliriz"], true, true)).toEqual([
      '^^^"-c^^^"',
      '^^^"buna^^^ neler^^^ katabiliriz^^^"',
    ]);
  });

  it("single-escapes every arg for a native exe", () => {
    expect(toShellArgs(["--model", "opus"], true, false)).toEqual([
      '^"--model^"',
      '^"opus^"',
    ]);
  });

  it("leaves args untouched when no shell is involved", () => {
    expect(toShellArgs(["-c", "buna neler katabiliriz"], false, true)).toEqual([
      "-c",
      "buna neler katabiliriz",
    ]);
  });
});

describe("isBatchExt", () => {
  it("classifies .cmd and .bat as batch shims", () => {
    expect(isBatchExt("C:\\path\\claude.cmd")).toBe(true);
    expect(isBatchExt("C:\\path\\claude.bat")).toBe(true);
    expect(isBatchExt("claude.CMD")).toBe(true);
  });

  it("classifies native executables and everything else as not-batch", () => {
    expect(isBatchExt("C:\\Users\\u\\.local\\bin\\claude.exe")).toBe(false);
    expect(isBatchExt("claude")).toBe(false);
    expect(isBatchExt("/usr/bin/claude")).toBe(false);
  });
});

describe("resolveWindowsCommand", () => {
  let dir: string;
  const savedPath = process.env.PATH;
  const savedPathext = process.env.PATHEXT;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-resolve-"));
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    process.env.PATHEXT = savedPathext;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prefers a native .exe over a sibling .cmd, matching PATHEXT order", () => {
    fs.writeFileSync(path.join(dir, "claude.exe"), "");
    fs.writeFileSync(path.join(dir, "claude.cmd"), "");
    process.env.PATH = dir;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    // Extension case comes from PATHEXT, not the on-disk file (Windows FS is
    // case-insensitive), so compare case-insensitively — isBatchExt does too.
    expect(resolveWindowsCommand("claude")?.toLowerCase()).toBe(
      path.join(dir, "claude.exe").toLowerCase(),
    );
  });

  it("finds a .cmd shim when that is the only match", () => {
    fs.writeFileSync(path.join(dir, "claude.cmd"), "");
    process.env.PATH = dir;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    expect(resolveWindowsCommand("claude")?.toLowerCase()).toBe(
      path.join(dir, "claude.cmd").toLowerCase(),
    );
  });

  it("returns null when nothing on PATH matches", () => {
    process.env.PATH = dir;
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    expect(resolveWindowsCommand("claude")).toBeNull();
  });
});
