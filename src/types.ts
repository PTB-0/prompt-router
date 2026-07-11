export type Category = "code" | "simple-qa" | "deep-qa";

export type RouteTarget = "claude" | "local" | "openrouter";

export interface Classification {
  optimizedPrompt: string;
  category: Category;
  complexity: number;
  confidence: number;
}

export interface RouteDecision {
  target: RouteTarget;
  planFirst: boolean;
  uncertain: boolean;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}
