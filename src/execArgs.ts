import type { EffortLevel, ExecBackend } from "./types.js";

export interface ExecArgContext {
  prompt: string;
  continueSession: boolean;
  model?: string;
  effort?: EffortLevel;
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
        out.push(ctx.prompt);
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
