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
  const hadNoDefaultCwd = "NoDefaultCurrentDirectoryInExePath" in process.env;
  const savedNoDefaultCwd = process.env.NoDefaultCurrentDirectoryInExePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-resolve-"));
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    process.env.PATHEXT = savedPathext;
    if (hadNoDefaultCwd) process.env.NoDefaultCurrentDirectoryInExePath = savedNoDefaultCwd;
    else delete process.env.NoDefaultCurrentDirectoryInExePath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The candidate path is built from PATHEXT, so keep the test's PATHEXT case
  // matching the on-disk files. That makes the resolver deterministic on both a
  // case-sensitive FS (Linux CI) and a case-insensitive one (Windows). The
  // real code only ever runs on Windows, where case never matters.
  const PATHEXT = ".com;.exe;.bat;.cmd";

  it("prefers a native .exe over a sibling .cmd, matching PATHEXT order", () => {
    fs.writeFileSync(path.join(dir, "claude.exe"), "");
    fs.writeFileSync(path.join(dir, "claude.cmd"), "");
    process.env.PATH = dir;
    process.env.PATHEXT = PATHEXT;
    expect(resolveWindowsCommand("claude")).toBe(path.join(dir, "claude.exe"));
  });

  it("finds a .cmd shim when that is the only match", () => {
    fs.writeFileSync(path.join(dir, "claude.cmd"), "");
    process.env.PATH = dir;
    process.env.PATHEXT = PATHEXT;
    expect(resolveWindowsCommand("claude")).toBe(path.join(dir, "claude.cmd"));
  });

  it("returns null when nothing on PATH matches", () => {
    process.env.PATH = dir;
    process.env.PATHEXT = PATHEXT;
    expect(resolveWindowsCommand("claude")).toBeNull();
  });

  it("resolves a bare command via the current directory when it is absent from PATH", () => {
    // cmd.exe checks cwd before PATH for a bare name — a script sitting in a
    // project directory "just runs" with no ./ prefix. PATH is deliberately
    // empty here so a match can only come from the cwd fallback. The opt-out
    // variable is explicitly cleared so this test exercises cwd-search
    // regardless of whether the machine running it happens to have that
    // variable set (see the next test — it can and does, on at least one
    // real machine this suite ran on).
    fs.writeFileSync(path.join(dir, "claude.exe"), "");
    process.env.PATH = "";
    process.env.PATHEXT = PATHEXT;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(resolveWindowsCommand("claude")).toBe(path.join(dir, "claude.exe"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("honours NoDefaultCurrentDirectoryInExePath and skips the cwd search when it is set", () => {
    // Windows' documented opt-out: cmd.exe's own resolution (not just
    // CreateProcess's module search) skips the implicit current-directory
    // check when this variable exists in the process environment, regardless
    // of its value. Verified empirically against a real cmd.exe /c
    // invocation on Windows: with this variable set, a bare command sitting
    // in cwd (and absent from PATH) is genuinely "not recognized"; clearing
    // it, the same invocation finds it. Ignoring this here would make the
    // resolver a false positive on a hardened machine.
    fs.writeFileSync(path.join(dir, "claude.exe"), "");
    process.env.PATH = "";
    process.env.PATHEXT = PATHEXT;
    process.env.NoDefaultCurrentDirectoryInExePath = "1";
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(resolveWindowsCommand("claude")).toBeNull();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not give a path-qualified command a cwd fallback", () => {
    // A same-named file sits directly in `dir`, but the command names an
    // explicit (nonexistent) subdirectory of it. An explicit path must mean
    // exactly that path — it must not fall back to searching cwd generally,
    // which is exactly the behaviour the bare-name case above gained.
    fs.writeFileSync(path.join(dir, "claude.exe"), "");
    process.env.PATH = dir;
    process.env.PATHEXT = PATHEXT;
    const missingPath = path.join(dir, "nonexistent-subdir", "claude.exe");
    expect(resolveWindowsCommand(missingPath)).toBeNull();
  });
});
