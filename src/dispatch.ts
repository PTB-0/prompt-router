import { costOf, estimateTokens } from "./cost.js";
import { buildExecArgs, type ExecArgContext } from "./execArgs.js";
import { streamChat, withModelFallback, type ChatMessage } from "./llm.js";
import type { ChatBackend, ExecBackend, TokenUsage } from "./types.js";
import { isBatchShim, toShellArgs } from "./winShell.js";

export interface ChatDispatchOptions {
  messages: ChatMessage[];
  timeoutMs: number;
  onDelta: (text: string) => void;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  /** Called with a content-free note when a model is abandoned mid-stream. */
  onModelSwitch?: () => void;
}

export interface ChatAttempt {
  text: string;
  model: string;
  usage: TokenUsage;
  spend: number;
}

/** Everything needed to spawn an exec backend, without performing the spawn. */
export function execSpawnPlan(
  backend: ExecBackend,
  ctx: ExecArgContext,
): { command: string; args: string[]; useShell: boolean } {
  const useShell = process.platform === "win32";
  const args = toShellArgs(
    buildExecArgs(backend, ctx),
    useShell,
    useShell && isBatchShim(backend.command),
  );
  return { command: backend.command, args, useShell };
}

/**
 * Stream an answer from a chat backend, walking its model chain. Returns null
 * only when every model failed, so the caller can move to the next backend.
 */
export async function dispatchChat(
  backend: ChatBackend,
  opts: ChatDispatchOptions,
): Promise<ChatAttempt | null> {
  let servingModel = "";
  let reported: TokenUsage | null = null;
  let produced = "";

  const text = await withModelFallback(backend.models, async (model) => {
    servingModel = model;
    reported = null;
    produced = "";
    let wrote = false;

    const result = await streamChat(
      {
        baseUrl: backend.baseUrl,
        apiKey: opts.apiKey,
        model,
        messages: opts.messages,
        timeoutMs: opts.timeoutMs,
        fetchImpl: opts.fetchImpl,
        onUsage: (usage) => {
          reported = usage;
        },
      },
      (delta) => {
        wrote = true;
        produced += delta;
        opts.onDelta(delta);
      },
    );
    if (result === null && wrote) opts.onModelSwitch?.();
    return result;
  });

  if (text === null) return null;

  // Exact counts when the provider reports them; otherwise approximate from
  // the characters that actually crossed the wire.
  const usage: TokenUsage =
    reported ??
    {
      inputTokens: estimateTokens(opts.messages.map((m) => m.content).join("\n")),
      outputTokens: estimateTokens(produced),
      estimated: true,
    };

  return { text, model: servingModel, usage, spend: costOf(usage, backend.pricing) };
}
