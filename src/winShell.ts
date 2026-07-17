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
 * 2. caret-escape every cmd metacharacter so cmd never interprets any of it —
 *    twice, because the .cmd shim's `%*` re-expansion runs the line through
 *    cmd's parser a second time.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

export function quoteForWindowsShell(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META, "^$1");
  return escaped.replace(CMD_META, "^$1");
}

export function toShellArgs(args: string[], useShell: boolean): string[] {
  return useShell ? args.map(quoteForWindowsShell) : args;
}
