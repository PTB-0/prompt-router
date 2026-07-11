import type { RouterConfig } from "./config.js";
import { chatCompletion, withModelFallback } from "./llm.js";

const PLAN_SYSTEM_PROMPT = `You are a senior software architect. The user's prompt will be executed by Claude Code, an agentic coding assistant. Write a concise implementation plan it can follow.

Rules:
- Output ONLY the plan, as a numbered list of concrete steps.
- Name the files, modules, and commands involved when they can be inferred.
- Include a final verification step (tests, typecheck, or a manual check).
- Stay within the user's intent — do not invent extra features.
- Write the plan in the same language the user used.`;

const PLAN_TIMEOUT_FLOOR_MS = 20_000;

export async function generatePlan(prompt: string, config: RouterConfig): Promise<string | null> {
  if (!config.openrouter.apiKey) return null;
  return withModelFallback(config.openrouter.planModels, (model) =>
    chatCompletion({
      baseUrl: config.openrouter.baseUrl,
      apiKey: config.openrouter.apiKey,
      model,
      messages: [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      maxTokens: 2048,
      timeoutMs: Math.max(config.timeoutMs, PLAN_TIMEOUT_FLOOR_MS),
    }),
  );
}

export function attachPlan(prompt: string, plan: string): string {
  return `${prompt}\n\n## PLAN (prepared by prompt-router, approved by the user)\nFollow this plan unless the code contradicts it:\n\n${plan}`;
}
