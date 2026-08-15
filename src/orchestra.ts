import { spawnSync } from "child_process";
import type { RouterConfig } from "./config.js";
import { execSpawnPlan } from "./dispatch.js";
import type { ExecArgContext } from "./execArgs.js";
import { chatCompletion, withModelFallback } from "./llm.js";
import type { ExecBackend } from "./types.js";

export interface AgentCandidate {
  id: string;
  label: string;
  strengths?: string | undefined;
}

export const ORCHESTRA_SELECT_SYSTEM_PROMPT = `You are the conductor of prompt-router's orchestra mode. You are given a coding task and a roster of coding agents, each with a short description of what it is good at.

Pick the single agent best suited to this specific task. If none stands out, pick the first one listed.

Respond with ONLY this JSON object — no markdown fence, no commentary:
{"backend_id": "..."}`;

const SELECT_TIMEOUT_FLOOR_MS = 15_000;
const SELECT_MAX_TOKENS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSelection(raw: string, candidateIds: readonly string[]): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  const id = data["backend_id"];
  return typeof id === "string" && candidateIds.includes(id) ? id : null;
}

/**
 * Picks the candidate best suited to `task`. Trivial (no LLM call) when there
 * is nothing to choose between; falls back to null — never a guess — when the
 * classifier is unavailable, so the caller's own priority order decides.
 */
export async function selectAgent(
  task: string,
  candidates: readonly AgentCandidate[],
  config: RouterConfig,
): Promise<string | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.id;
  if (!config.openrouter.apiKey) return null;

  const roster = candidates
    .map((c) => `- ${c.id} (${c.label}): ${c.strengths ?? "general-purpose"}`)
    .join("\n");
  const ids = candidates.map((c) => c.id);

  return withModelFallback(config.openrouter.classifierModels, async (model) => {
    const raw = await chatCompletion({
      baseUrl: config.openrouter.baseUrl,
      apiKey: config.openrouter.apiKey,
      model,
      messages: [
        { role: "system", content: ORCHESTRA_SELECT_SYSTEM_PROMPT },
        { role: "user", content: `TASK:\n${task}\n\nAVAILABLE AGENTS:\n${roster}` },
      ],
      maxTokens: SELECT_MAX_TOKENS,
      timeoutMs: Math.max(config.timeoutMs, SELECT_TIMEOUT_FLOOR_MS),
    });
    if (!raw) return null;
    return parseSelection(raw, ids);
  });
}

export const ORCHESTRA_DECOMPOSE_SYSTEM_PROMPT = `You are the conductor of prompt-router's orchestra mode. You are given a coding task and a roster of coding agents, each with a short description of what it is good at.

Break the task into an ordered list of concrete steps, and assign each step to whichever listed agent is best suited for it.

Rules:
- Use as few steps as the task genuinely needs — a simple task can be a single step.
- Steps run in this order, in the same repository: each later step sees the changes every earlier step already made.
- Every step's "backend_id" must be one of the listed agent ids.

Respond with ONLY this JSON object — no markdown fence, no commentary:
{"steps": [{"instruction": "...", "backend_id": "..."}]}`;

const DECOMPOSE_TIMEOUT_FLOOR_MS = 20_000;
const DECOMPOSE_MAX_TOKENS = 1024;

export interface OrchestraStep {
  instruction: string;
  backendId: string;
}

export function parseDecomposition(raw: string, candidateIds: readonly string[]): OrchestraStep[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  const steps = data["steps"];
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const parsed: OrchestraStep[] = [];
  for (const entry of steps) {
    if (!isRecord(entry)) return null;
    const instruction = entry["instruction"];
    const backendId = entry["backend_id"];
    if (typeof instruction !== "string" || !instruction.trim()) return null;
    if (typeof backendId !== "string" || !candidateIds.includes(backendId)) return null;
    parsed.push({ instruction: instruction.trim(), backendId });
  }
  return parsed;
}

/**
 * Splits `task` into an assigned-agent step list. Null means "don't
 * decompose" — too few agents to make it meaningful, no classifier
 * available, or the model didn't return a valid plan — and the caller falls
 * back to handing the whole task to a single selected agent.
 */
export async function decomposeTask(
  task: string,
  candidates: readonly AgentCandidate[],
  config: RouterConfig,
): Promise<OrchestraStep[] | null> {
  if (candidates.length <= 1) return null;
  if (!config.openrouter.apiKey) return null;

  const roster = candidates
    .map((c) => `- ${c.id} (${c.label}): ${c.strengths ?? "general-purpose"}`)
    .join("\n");
  const ids = candidates.map((c) => c.id);

  return withModelFallback(config.openrouter.planModels, async (model) => {
    const raw = await chatCompletion({
      baseUrl: config.openrouter.baseUrl,
      apiKey: config.openrouter.apiKey,
      model,
      messages: [
        { role: "system", content: ORCHESTRA_DECOMPOSE_SYSTEM_PROMPT },
        { role: "user", content: `TASK:\n${task}\n\nAVAILABLE AGENTS:\n${roster}` },
      ],
      maxTokens: DECOMPOSE_MAX_TOKENS,
      timeoutMs: Math.max(config.timeoutMs, DECOMPOSE_TIMEOUT_FLOOR_MS),
    });
    if (!raw) return null;
    return parseDecomposition(raw, ids);
  });
}

/** The per-agent prompt for one step of a decomposed task — the whole plan
 *  for context, but an explicit instruction to do only this step. */
export function buildStepPrompt(originalTask: string, steps: readonly OrchestraStep[], index: number): string {
  const planList = steps.map((s, i) => `${i + 1}. [${s.backendId}] ${s.instruction}`).join("\n");
  const current = steps[index];
  if (!current) throw new Error(`buildStepPrompt: index ${index} is out of range for ${steps.length} step(s)`);

  return `You are one agent in a multi-agent orchestra working on this task:

ORIGINAL TASK:
${originalTask}

FULL PLAN (steps run in this order, in this same repository — earlier steps' changes are already applied):
${planList}

YOUR STEP (step ${index + 1} of ${steps.length}):
${current.instruction}

Do only this step. Do not attempt the other steps.`;
}

const VERDICT_MARKER = /ORCHESTRA_VERDICT:\s*(CLEAN|ISSUES)\b/gi;

export type VerdictStatus = "clean" | "issues" | "unknown";

export interface ReviewVerdict {
  status: VerdictStatus;
  /** The reviewer's response with the verdict line stripped, trimmed. */
  notes: string;
  raw: string;
}

/**
 * The last marker in the text wins — guards against the model echoing the
 * instruction text (which contains both marker forms) earlier in its answer.
 * No marker at all means the reviewer didn't follow the format: "unknown",
 * never a guessed clean/issues, since the caller stops the auto-fix loop
 * rather than act on an unreadable verdict.
 */
export function parseVerdict(raw: string): ReviewVerdict {
  const matches = [...raw.matchAll(VERDICT_MARKER)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) return { status: "unknown", notes: raw.trim(), raw };

  const status: VerdictStatus = last[1]!.toUpperCase() === "CLEAN" ? "clean" : "issues";
  const notes = (raw.slice(0, last.index) + raw.slice(last.index + last[0].length)).trim();
  return { status, notes, raw };
}

export function buildReviewPrompt(task: string, diff: string): string {
  return `You are reviewing a code change made by another AI coding agent. Do NOT modify any files — this is a read-only review.

ORIGINAL TASK:
${task}

CHANGE (git diff):
${diff}

Check whether the change correctly and completely addresses the task, and look for bugs, regressions, or edge cases it misses. If you find problems, list them concisely as a bullet list.

End your response with exactly one line, and nothing after it:
ORCHESTRA_VERDICT: CLEAN
— if there are no problems, or —
ORCHESTRA_VERDICT: ISSUES
— if there are.`;
}

export function buildFixPrompt(task: string, issues: string): string {
  return `Another AI agent reviewed your previous change against this task and found problems. Fix them.

ORIGINAL TASK:
${task}

ISSUES FOUND BY THE REVIEWER:
${issues}`;
}

const GIT_MAX_BUFFER = 20 * 1024 * 1024;

/**
 * The uncommitted change orchestra mode reviews. `null` means "not inside a
 * git work tree" (review is skipped entirely); `""` means a repo with nothing
 * pending (review is skipped because there is nothing to look at).
 */
export function captureDiff(cwd: string = process.cwd()): string | null {
  const isRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
  if (isRepo.status !== 0) return null;

  const tracked = spawnSync("git", ["diff", "HEAD"], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (tracked.status === 0) return tracked.stdout;

  // No HEAD yet (a brand-new repo before its first commit) — diff against the
  // index instead, which still works on an unborn branch.
  const staged = spawnSync("git", ["diff"], { cwd, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER });
  return staged.status === 0 ? staged.stdout : "";
}

export interface PrintResult {
  /** null when the backend has no printArgs, or the process failed to spawn. */
  text: string | null;
  status: number | null;
}

/**
 * Runs an exec backend's non-interactive invocation and captures its stdout —
 * the only way orchestra mode's review step can read a verdict back, since
 * the interactive `args` template hands the whole terminal over instead.
 */
export function runPrintTask(backend: ExecBackend, ctx: ExecArgContext): PrintResult {
  if (!backend.printArgs || backend.printArgs.length === 0) return { text: null, status: null };
  const plan = execSpawnPlan(backend, ctx, backend.printArgs);
  const result = spawnSync(plan.command, plan.args, {
    encoding: "utf8",
    shell: plan.useShell,
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.error) return { text: null, status: null };
  return { text: (result.stdout ?? "").trim(), status: result.status };
}
