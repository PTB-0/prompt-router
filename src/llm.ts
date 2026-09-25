import * as sharedClient from "openrouter-chat-client";
import type { ChatMessage, TokenUsage } from "openrouter-chat-client";

export type { ChatMessage, TokenUsage } from "openrouter-chat-client";
export { extractSseDeltas, withModelFallback } from "openrouter-chat-client";

// The shared client's HTTP-Referer / X-Title are per-app so OpenRouter can
// tell prompt-router's traffic apart from prompt-op's or anyone else's —
// baked in here so every call site below stays exactly as it was before the
// client moved into its own package.
const APP_REFERER = "https://github.com/PTB-0/prompt-router";
const APP_TITLE = "prompt-router";

export interface ChatRequest {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  /** Called with a content-free reason (e.g. "http_404", "AbortError") when the request fails. */
  onFailure?: (reason: string) => void;
  /** Called with exact token counts when the provider reports them. */
  onUsage?: (usage: TokenUsage) => void;
}

function withAppIdentity(req: ChatRequest): sharedClient.ChatRequest {
  return { ...req, appReferer: APP_REFERER, appTitle: APP_TITLE };
}

export function chatCompletion(req: ChatRequest): Promise<string | null> {
  return sharedClient.chatCompletion(withAppIdentity(req));
}

export function streamChat(
  req: ChatRequest,
  onDelta: (text: string) => void,
): Promise<string | null> {
  return sharedClient.streamChat(withAppIdentity(req), onDelta);
}
