import type { Category, Classification, RouteDecision } from "./types.js";

export interface RouteOptions {
  confidenceThreshold: number;
  planComplexityThreshold: number;
  localAvailable: boolean;
}

export function decideRoute(
  cls: Classification | null,
  heuristic: Category | null,
  opts: RouteOptions,
): RouteDecision {
  if (!cls && !heuristic) {
    // No signal at all: send it to the strongest backend rather than risk a weak answer.
    return { target: "claude", planFirst: false, uncertain: true };
  }

  // Misrouting a code task to a small model is far worse than over-serving a
  // question, so a code verdict from either signal wins.
  const category: Category =
    heuristic === "code" || cls?.category === "code"
      ? "code"
      : (cls?.category ?? heuristic ?? "code");
  const uncertain = cls !== null && cls.confidence < opts.confidenceThreshold;

  if (category === "code") {
    return {
      target: "claude",
      planFirst: cls !== null && cls.complexity >= opts.planComplexityThreshold,
      uncertain,
    };
  }
  if (category === "simple-qa" && opts.localAvailable) {
    return { target: "local", planFirst: false, uncertain };
  }
  return { target: "openrouter", planFirst: false, uncertain };
}
