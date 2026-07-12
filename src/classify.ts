import { configDir } from "./config.js";
import type { RouterConfig } from "./config.js";
import { chatCompletion, withModelFallback } from "./llm.js";
import { appendRoutingLog } from "./log.js";
import type { Category, Classification } from "./types.js";

export const CLASSIFY_SYSTEM_PROMPT = `You are the routing brain of prompt-router, a CLI that optimizes a prompt and routes it to the right AI backend.

Rewrite the user's prompt to be precise and actionable while preserving their intent exactly — do not add features they did not ask for. If the prompt is already specific, keep it unchanged. Write the rewritten prompt in the same language the user used.

Then classify it:
- "code": writing, fixing, refactoring, reviewing, or explaining project code; anything meant for a coding agent.
- "simple-qa": a short factual or everyday question answerable in a few sentences.
- "deep-qa": a broad, open-ended, or multi-part question that needs a long, reasoned answer.

complexity (0 to 1): for "code", how large or architectural the task is (0 = one-line fix, 1 = multi-file production feature). For questions, how much reasoning the answer needs.
confidence (0 to 1): how sure you are about the category.

Respond with ONLY this JSON object — no markdown fence, no commentary:
{"optimized_prompt": "...", "category": "code" | "simple-qa" | "deep-qa", "complexity": 0.0, "confidence": 0.0}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toScore(value: unknown): number | null {
  const num =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (Number.isNaN(num)) return null;
  return Math.min(1, Math.max(0, num));
}

function isCategory(value: unknown): value is Category {
  return value === "code" || value === "simple-qa" || value === "deep-qa";
}

export function parseClassification(raw: string): Classification | null {
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

  const optimizedPrompt =
    typeof data["optimized_prompt"] === "string" ? data["optimized_prompt"].trim() : "";
  const complexity = toScore(data["complexity"]);
  const confidence = toScore(data["confidence"]);
  const category = data["category"];

  if (!optimizedPrompt || complexity === null || confidence === null || !isCategory(category)) {
    return null;
  }

  return { optimizedPrompt, category, complexity, confidence };
}

export async function classify(
  prompt: string,
  config: RouterConfig,
): Promise<Classification | null> {
  if (!config.openrouter.apiKey) return null;
  const failures: { model: string; reason: string }[] = [];
  const result = await withModelFallback(config.openrouter.classifierModels, async (model) => {
    const raw = await chatCompletion({
      baseUrl: config.openrouter.baseUrl,
      apiKey: config.openrouter.apiKey,
      model,
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      maxTokens: 1024,
      timeoutMs: config.timeoutMs,
      onFailure: (reason) => failures.push({ model, reason }),
    });
    if (!raw) return null;
    const parsed = parseClassification(raw);
    if (!parsed) failures.push({ model, reason: "unparseable_response" });
    return parsed;
  });
  if (!result && config.logging.routingLog && failures.length > 0) {
    appendRoutingLog(configDir(), { type: "classify_failed", failures });
  }
  return result;
}
