export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  baseUrl: string;
  apiKey?: string | undefined;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/PTB-0/prompt-router",
    "X-Title": "prompt-router",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function messageContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const choices = (data as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  return typeof content === "string" ? content.trim() : null;
}

function deltaContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const choices = (data as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const delta = (first as Record<string, unknown>)["delta"];
  if (typeof delta !== "object" || delta === null) return null;
  const content = (delta as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : null;
}

export async function withModelFallback<T>(
  models: readonly string[],
  attempt: (model: string) => Promise<T | null>,
): Promise<T | null> {
  for (const model of models) {
    try {
      const result = await attempt(model);
      if (result !== null) return result;
    } catch {
      // failed model — try the next one
    }
  }
  return null;
}

export function extractSseDeltas(buffer: string): { deltas: string[]; rest: string } {
  const deltas: string[] = [];
  let rest = buffer;
  for (;;) {
    const separator = rest.indexOf("\n\n");
    if (separator === -1) break;
    const event = rest.slice(0, separator);
    rest = rest.slice(separator + 2);
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = deltaContent(parsed);
      if (delta) deltas.push(delta);
    }
  }
  return { deltas, rest };
}

export async function chatCompletion(req: ChatRequest): Promise<string | null> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const response = await fetchImpl(`${req.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 1024,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return messageContent(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function streamChat(
  req: ChatRequest,
  onDelta: (text: string) => void,
): Promise<string | null> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const response = await fetchImpl(`${req.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(req.apiKey),
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 4096,
        stream: true,
      }),
      signal: controller.signal,
    });
    // The timeout guards the connection; once headers arrive the stream may run long.
    clearTimeout(timer);
    if (!response.ok || !response.body) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { deltas, rest } = extractSseDeltas(buffer);
      buffer = rest;
      for (const delta of deltas) {
        full += delta;
        onDelta(delta);
      }
    }
    return full || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
