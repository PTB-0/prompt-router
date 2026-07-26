import type { Category, CategoryDecision, Classification } from "./types.js";

export interface RouteOptions {
  confidenceThreshold: number;
  planComplexityThreshold: number;
}

function resolveCategory(
  cls: Classification | null,
  heuristic: Category | null,
  uncertain: boolean,
): Category {
  // A confident classification is the best signal we have; the regex heuristic
  // only decides when the classifier is missing or unsure.
  if (cls && !uncertain) return cls.category;

  // Among weak signals, a code verdict from either side wins: misrouting a
  // code task to a small chat model is far worse than over-serving a question.
  if (heuristic === "code" || cls?.category === "code") return "code";

  if (cls) return cls.category;
  return heuristic ?? "deep-qa"; // heuristic is non-null here; ?? satisfies the type system
}

export function decideRoute(
  cls: Classification | null,
  heuristic: Category | null,
  opts: RouteOptions,
): CategoryDecision {
  if (!cls && !heuristic) {
    // No signal at all: treat it as a question. Agentic backends are reserved
    // for code; the chat fallback chain still ends at one if every answer
    // backend is unreachable, so nothing is lost.
    return { category: "deep-qa", planFirst: false, uncertain: true };
  }

  const uncertain = cls !== null && cls.confidence < opts.confidenceThreshold;
  const category = resolveCategory(cls, heuristic, uncertain);

  return {
    category,
    planFirst:
      category === "code" && cls !== null && cls.complexity >= opts.planComplexityThreshold,
    uncertain,
  };
}
