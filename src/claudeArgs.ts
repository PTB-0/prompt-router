import type { EffortLevel } from "./types.js";

export function buildClaudeArgs(
  text: string,
  continueSession: boolean,
  model?: string,
  effort?: EffortLevel,
): string[] {
  const flags: string[] = [];
  if (model) flags.push("--model", model);
  if (effort) flags.push("--effort", effort);
  const promptArgs = continueSession ? ["-c", text] : [text];
  return [...flags, ...promptArgs];
}
