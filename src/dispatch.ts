import { costOf, estimateTokens } from "./cost.js";
import { buildExecArgs, type ExecArgContext } from "./execArgs.js";
import { streamChat, withModelFallback, type ChatMessage } from "./llm.js";
import type { ChatBackend, ExecBackend, TokenUsage } from "./types.js";
import { isBatchShim, quoteForWindowsShell, toShellArgs } from "./winShell.js";

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

/**
 * Everything needed to spawn an exec backend, without performing the spawn.
 * `template` defaults to the interactive `args`; pass `backend.printArgs` to
 * build the non-interactive invocation orchestra mode's review/fix loop uses.
 *
 * The command itself needs the same caret-escaping as every arg: with
 * `shell: true`, Node joins `[command, ...args]` with spaces into one string
 * before handing it to cmd.exe, so an unescaped command containing a space
 * (e.g. `C:\Program Files\nodejs\node.exe`) gets split at that space exactly
 * like an unescaped arg would — cmd.exe then reports `'C:\Program' is not
 * recognized...`. Confirmed empirically: only escaping args left this path
 * broken for any command outside a space-free directory.
 *
 * Unlike args, the command NEVER gets the doubled caret layer: the "second
 * pass" that forces doubling for a `.cmd`/`.bat` target is that shim's own
 * `%*` re-expansion of its *arguments* — the command token is only ever
 * parsed once, by the initial `cmd.exe /c` invocation that locates and
 * launches the file, batch shim or not. Doubling it too was tried and
 * confirmed broken: cmd.exe fails to resolve a batch shim's name at all once
 * its own token carries a second caret layer.
 */
export function execSpawnPlan(
  backend: ExecBackend,
  ctx: ExecArgContext,
  template: string[] = backend.args,
): { command: string; args: string[]; useShell: boolean } {
  const useShell = process.platform === "win32";
  const doubleEscape = useShell && isBatchShim(backend.command);
  const args = toShellArgs(buildExecArgs(backend, ctx, template), useShell, doubleEscape);
  const command = useShell ? quoteForWindowsShell(backend.command, false) : backend.command;
  return { command, args, useShell };
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
