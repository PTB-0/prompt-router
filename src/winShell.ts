/**
 * Node's spawnSync no longer auto-quotes array args when `shell: true` is used
 * (see DEP0190) — it just concatenates them with spaces. On Windows we still
 * need `shell: true` to run .cmd/.bat shims, so we quote args ourselves before
 * handing them to the shell.
 */
export function quoteForWindowsShell(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function toShellArgs(args: string[], useShell: boolean): string[] {
  return useShell ? args.map(quoteForWindowsShell) : args;
}
