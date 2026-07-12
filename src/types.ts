export type Category = "code" | "simple-qa" | "deep-qa";

export type RouteTarget = "claude" | "local" | "openrouter";

export type ClaudeModel = "haiku" | "sonnet" | "opus";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelTier {
  model: ClaudeModel;
  effort: EffortLevel;
}

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
  model?: string;
  effort?: EffortLevel;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}
