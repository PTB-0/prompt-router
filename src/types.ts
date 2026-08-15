export type Category = "code" | "simple-qa" | "deep-qa";

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

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}

export type BackendKind = "chat" | "exec";

export interface Pricing {
  /** USD per 1M input tokens. 0 = free. */
  inputPer1M: number;
  /** USD per 1M output tokens. 0 = free. */
  outputPer1M: number;
}

interface BackendBase {
  id: string;
  label: string;
  categories: Category[];
  priority: number;
  enabled: boolean;
}

export interface ChatBackend extends BackendBase {
  kind: "chat";
  baseUrl: string;
  /** NAME of the env var holding the key — never the key itself. */
  apiKeyEnv?: string;
  /** Internal model fallback chain. */
  models: string[];
  /** Probe /models before dispatching. False for remote providers. */
  probe: boolean;
  autoStart: boolean;
  /** Command run when the probe fails and autoStart is true. */
  autoStartCommand: string[];
  pricing: Pricing;
}

export interface ExecBackend extends BackendBase {
  kind: "exec";
  command: string;
  /** Template. {prompt} {model} {effort} {continue} expand; other tokens pass through. */
  args: string[];
  modelFlag: string;
  effortFlag: string;
  continueFlag: string;
  supportsModelTier: boolean;
  supportsPlan: boolean;
  supportsContinue: boolean;
  /** Reference prices per model name, used for the counterfactual figure. */
  modelPricing: Record<string, Pricing>;
  /** Free-text description of what this agent is good at — the only input
   *  orchestra mode's agent-selection LLM call gets about this backend. */
  strengths?: string;
  /**
   * Same token expansion as `args`, but for a non-interactive invocation
   * whose stdout is captured instead of handed to the terminal. Orchestra
   * mode's review/fix loop needs a parseable verdict back, which the
   * interactive `args` template's terminal takeover can't provide — a
   * backend missing this is simply never picked as reviewer/fixer.
   */
  printArgs?: string[];
}

export type Backend = ChatBackend | ExecBackend;

/** What the router decides before a backend is picked. */
export interface CategoryDecision {
  category: Category;
  /** Plan-first is eligible; the selected backend must also support it. */
  planFirst: boolean;
  uncertain: boolean;
}

/** A resolved decision: which backend runs, and how. The chain that follows it
 *  travels separately, as the candidate list the caller already holds. */
export interface Dispatch {
  backend: Backend;
  planFirst: boolean;
  uncertain: boolean;
  model?: string;
  effort?: EffortLevel;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** True when the counts came from a char/4 estimate rather than the API. */
  estimated: boolean;
}
