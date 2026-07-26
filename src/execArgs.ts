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
 */
export function buildExecArgs(backend: ExecBackend, ctx: ExecArgContext): string[] {
  const out: string[] = [];
  for (const token of backend.args) {
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
