/**
 * Node's spawnSync no longer auto-quotes array args when `shell: true` is used
 * (see DEP0190) — it just concatenates them with spaces. On Windows we still
 * need `shell: true` to run the claude .cmd shim, so we escape args ourselves.
 *
 * cmd.exe gives backslash no escaping meaning and treats every `"` as a quote
 * toggle, so a naive `\"` still toggles cmd out of the quoted region — text
 * after it is live shell syntax, and a prompt like `fix this " && del *.txt`
 * would execute the `del`. The fix (same algorithm as cross-spawn):
 * 1. escape for the target program's argv parser: double backslash runs
 *    before quotes and at the end, escape quotes as `\"`, wrap in quotes;
 * 2. caret-escape every cmd metacharacter so cmd never interprets any of it.
 *
 * The caret layer is consumed by cmd's parse pass. A `.cmd`/`.bat` shim adds a
 * SECOND pass — its `%*` re-expansion runs the line through cmd again — so a
 * shim target needs the carets doubled. A native `.exe` is reached through a
 * single pass, so it must get exactly one caret layer; a second layer survives
 * into the program's argv as literal carets (turning `--model` into
 * `^--model^`). `isBatchShim` picks the right depth per resolved target.
 */
import * as fs from "fs";
import * as path from "path";

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function quoteForWindowsShell(arg: string, doubleEscape: boolean): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META, "^$1");
  if (doubleEscape) escaped = escaped.replace(CMD_META, "^$1");
  return escaped;
}

export function toShellArgs(
  args: string[],
  useShell: boolean,
  doubleEscape: boolean,
): string[] {
  return useShell ? args.map((a) => quoteForWindowsShell(a, doubleEscape)) : args;
}

export function isBatchExt(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

/**
 * Resolve a bare command name to the file cmd.exe would actually run, following
 * the same search cmd does: for a bare name (no directory separator), the
 * current directory first, then PATH, then PATHEXT (first matching directory
 * × extension wins) — cmd.exe checks cwd before PATH, which is why a bare-name
 * script sitting in a project directory "just runs" with no `./` prefix.
 *
 * That cwd check is itself conditional: Windows' documented opt-out is the
 * `NoDefaultCurrentDirectoryInExePath` environment variable — if it exists in
 * the process's environment (its value doesn't matter, only its presence),
 * the implicit current-directory search is skipped, by cmd.exe as much as by
 * CreateProcess's own module search. Verified empirically: with that variable
 * set, `cmd.exe /d /s /c "aBareCwdOnlyCommand"` genuinely fails to find a
 * command sitting right there in cwd; clearing it, the same invocation finds
 * it. Ignoring that variable here would make this resolver a false positive
 * on a hardened machine — it would say "this will run" for a command the
 * real cmd.exe then refuses, exactly the failure mode this function exists
 * to prevent.
 *
 * Returns null if nothing matches. An explicit path or extension is used as-is,
 * with no cwd fallback — a path-qualified command means exactly that path.
 */
export function resolveWindowsCommand(command: string): string | null {
  const hasDir = command.includes("/") || command.includes("\\");
  const hasExt = path.extname(command) !== "";
  const base = hasDir ? path.basename(command) : command;
  const searchCwd = !hasDir && !("NoDefaultCurrentDirectoryInExePath" in process.env);
  const dirs = hasDir
    ? [path.dirname(command)]
    : [
        ...(searchCwd ? [process.cwd()] : []),
        ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
      ];
  const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const exts = hasExt ? [""] : pathext;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, base + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not in this directory — keep looking
      }
    }
  }
  return null;
}

/**
 * True when `command` resolves to a `.cmd`/`.bat` shim on Windows — the only
 * case that needs the caret layer doubled. A native `.exe` (or anything not
 * found) gets single-escaped. No-op off Windows, where we never use a shell.
 */
export function isBatchShim(command: string): boolean {
  if (process.platform !== "win32") return false;
  const resolved = resolveWindowsCommand(command);
  return resolved !== null && isBatchExt(resolved);
}
