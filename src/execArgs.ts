import type { EffortLevel, ExecBackend } from "./types.js";

export interface ExecArgContext {
  prompt: string;
  continueSession: boolean;
  model?: string;
  effort?: EffortLevel;
}

/**
 * The prompt is usually an LLM rewrite (or plan/review text), not something
 * the user typed verbatim, and it lands in argv as one element. An element
 * starting with "-" is parsed as an option by the agent's CLI — confirmed
 * with Claude Code: `claude "--version"` prints the version instead of
 * starting a session — so a prompt like `--settings={"hooks":...}` or
 * `--dangerously-skip-permissions` would reconfigure the agent instead of
 * being read by it, and the confirmation bar auto-accepts on timeout or a
 * non-TTY stdin. A leading space keeps it positional for any CLI parser
 * without a per-backend `--` convention, and is meaningless to the model.
 */
function asPositional(prompt: string): string {
  return prompt.startsWith("-") ? ` ${prompt}` : prompt;
}

/**
 * Expands a backend's argument template. A placeholder with nothing to say
 * expands to zero arguments, so an unset model never leaves a dangling flag.
 *
 * `template` defaults to the backend's interactive `args`; orchestra mode's
 * review/fix loop passes `printArgs` instead to build the non-interactive
 * invocation, reusing the same token expansion.
 */
export function buildExecArgs(
  backend: ExecBackend,
  ctx: ExecArgContext,
  template: string[] = backend.args,
): string[] {
  const out: string[] = [];
  for (const token of template) {
    switch (token) {
      case "{prompt}":
        out.push(asPositional(ctx.prompt));
        break;
      case "{model}":
        if (ctx.model) out.push(backend.modelFlag, ctx.model);
        break;
      case "{effort}":
        if (ctx.effort) out.push(backend.effortFlag, ctx.effort);
        break;
      case "{continue}":
        if (ctx.continueSession && backend.supportsContinue) out.push(backend.continueFlag);
        break;
      default:
        out.push(token);
    }
  }
  return out;
}
