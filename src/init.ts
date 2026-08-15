import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import pc from "picocolors";
import { configDir, defaultBackends, resolveConfig, type RouterConfig } from "./config.js";
import { isServerUp } from "./local.js";
import type { Backend, ChatBackend } from "./types.js";

const KEY_VALIDATE_TIMEOUT_MS = 3000;
const LOCAL_PROBE_TIMEOUT_MS = 1500;

function readEnvKey(dir: string): string {
  try {
    const text = fs.readFileSync(path.join(dir, ".env"), "utf8");
    const match = /^OPENROUTER_API_KEY=(.*)$/m.exec(text);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function readFileConfig(dir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** Updates OPENROUTER_API_KEY in the existing .env text, preserving every other line. */
export function mergeEnvKey(existingText: string, apiKey: string): string {
  const lines = existingText.split(/\r?\n/).filter((line, i, arr) => line !== "" || i < arr.length - 1);
  const idx = lines.findIndex((line) => /^OPENROUTER_API_KEY=/.test(line));
  const entry = `OPENROUTER_API_KEY=${apiKey}`;
  if (idx >= 0) lines[idx] = entry;
  else lines.push(entry);
  return lines.join("\n") + "\n";
}

/** The local-model answers — the only part of the wizard that branches. */
export interface InitAnswers {
  /** null when the user declined a local model. */
  localBaseUrl: string | null;
  localModel: string | null;
  localAutoStart: boolean;
}

/**
 * Builds the `backends` section of the config the wizard writes. Pure, and
 * separated from the prompting so it can be asserted on directly.
 *
 * `existing` is the registry already in effect — the declared one, or the
 * defaults derived from a legacy config. Patching it rather than rebuilding
 * from `defaultBackends()` matters once the registry is user-editable: the
 * wizard only ever asks about the local model, so re-running setup must not
 * silently drop a backend someone added by hand.
 */
export function buildInitConfig(
  answers: InitAnswers,
  existing: Backend[],
): { backends: Backend[] } {
  const wantsLocal = Boolean(answers.localBaseUrl && answers.localModel);
  const backends = structuredClone(existing);
  const local = backends.find((b): b is ChatBackend => b.kind === "chat" && b.id === "local");

  if (!local) {
    // Nothing to patch. Only add one back if the user actually asked for it —
    // a deleted local backend plus a declined local model means they want none.
    if (wantsLocal) {
      const fresh = defaultBackends().find(
        (b): b is ChatBackend => b.kind === "chat" && b.id === "local",
      );
      if (fresh) backends.push(applyLocalAnswers(fresh, answers));
    }
    return { backends };
  }

  applyLocalAnswers(local, answers);
  return { backends };
}

function applyLocalAnswers(local: ChatBackend, answers: InitAnswers): ChatBackend {
  if (answers.localBaseUrl && answers.localModel) {
    local.baseUrl = answers.localBaseUrl;
    // The wizard asks for a single model name; it becomes a one-element chain.
    local.models = [answers.localModel];
    local.autoStart = answers.localAutoStart;
    local.enabled = true;
  } else {
    // Disabled rather than removed: an obvious thing to flip back on, and the
    // previously chosen address survives for whenever they do.
    local.enabled = false;
  }
  return local;
}

interface Prompter {
  rl: readline.Interface;
  closed: boolean;
}

function ask(prompter: Prompter, question: string, fallback: string): Promise<string> {
  // stdin can hit EOF (e.g. piped input running out) before every question is
  // answered; the interface closes itself in that case, and calling
  // rl.question() afterwards throws. Fall back to the default instead of crashing.
  if (prompter.closed) return Promise.resolve(fallback);
  const suffix = fallback ? pc.dim(` (${fallback})`) : "";
  return new Promise((resolve) => {
    prompter.rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || fallback);
    });
    prompter.rl.once("close", () => resolve(fallback));
  });
}

async function askBoolean(prompter: Prompter, question: string, fallback: boolean): Promise<boolean> {
  const answer = await ask(prompter, `${question} (y/n)`, fallback ? "y" : "n");
  return /^y/i.test(answer);
}

async function askNumber(prompter: Prompter, question: string, fallback: number): Promise<number> {
  const answer = await ask(prompter, question, String(fallback));
  const parsed = Number.parseFloat(answer);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function validateApiKey(apiKey: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KEY_VALIDATE_TIMEOUT_MS);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runInit(): Promise<void> {
  const dir = configDir();
  const existing = resolveConfig(readFileConfig(dir), {});
  const existingKey = readEnvKey(dir);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompter: Prompter = { rl, closed: false };
  rl.once("close", () => {
    prompter.closed = true;
  });
  process.stdout.write(pc.bold("\nprompt-router setup\n") + pc.dim("Enter keeps the current/default value.\n\n"));

  const apiKey = await ask(prompter, "OpenRouter API key", existingKey);
  if (apiKey && apiKey !== existingKey) {
    process.stdout.write(pc.dim("  validating key...\n"));
    const valid = await validateApiKey(apiKey);
    process.stdout.write(
      valid ? pc.green("  ✓ key looks valid\n") : pc.yellow("  ! could not verify key — saving it anyway\n"),
    );
  }

  // Defaults come from the resolved registry, so re-running setup offers back
  // whatever the local backend currently says rather than the built-in values.
  const existingLocal = existing.backends.find(
    (b): b is ChatBackend => b.kind === "chat" && b.id === "local",
  );
  const answers: InitAnswers = {
    localBaseUrl: null,
    localModel: null,
    localAutoStart: existingLocal?.autoStart ?? true,
  };
  const localEnabled = await askBoolean(prompter, "Use a local model", existingLocal?.enabled ?? true);
  if (localEnabled) {
    answers.localBaseUrl = await ask(
      prompter,
      "Local server URL",
      existingLocal?.baseUrl ?? existing.local.baseUrl,
    );
    answers.localModel = await ask(
      prompter,
      "Local model name",
      existingLocal?.models[0] ?? existing.local.model,
    );
    answers.localAutoStart = await askBoolean(
      prompter,
      "Auto-start the local server",
      answers.localAutoStart,
    );
    process.stdout.write(pc.dim("  checking local server...\n"));
    const up = await isServerUp(answers.localBaseUrl, LOCAL_PROBE_TIMEOUT_MS);
    process.stdout.write(up ? pc.green("  ✓ local server found\n") : pc.yellow("  ! local server not reachable yet\n"));
  }

  const confidence = await askNumber(prompter, "Confidence threshold (0-1)", existing.thresholds.confidence);
  const planComplexity = await askNumber(
    prompter,
    "Plan-first complexity threshold (0-1)",
    existing.thresholds.planComplexity,
  );
  const maxMessages = await askNumber(prompter, "Session history length (messages)", existing.session.maxMessages);
  const routingLog = await askBoolean(prompter, "Enable content-free routing log", existing.logging.routingLog);
  const timeoutMs = await askNumber(prompter, "Request timeout (ms)", existing.timeoutMs);

  const orchestraEnabled = await askBoolean(
    prompter,
    "Enable orchestra mode (agent selection + automatic review/fix loop)",
    existing.orchestra.enabled,
  );
  let orchestraComplexity = existing.orchestra.complexityThreshold;
  let orchestraMaxFixRounds = existing.orchestra.maxFixRounds;
  let orchestraDecompose = existing.orchestra.decompose;
  if (orchestraEnabled) {
    orchestraComplexity = await askNumber(
      prompter,
      "Orchestra complexity threshold (0-1)",
      existing.orchestra.complexityThreshold,
    );
    orchestraMaxFixRounds = await askNumber(
      prompter,
      "Orchestra max fix rounds",
      existing.orchestra.maxFixRounds,
    );
    orchestraDecompose = await askBoolean(
      prompter,
      "Split tasks across multiple agents when possible (vs. one agent per task)",
      existing.orchestra.decompose,
    );
  }

  if (!prompter.closed) rl.close();

  // The written file carries `backends` and no legacy `local` / `answerModels`
  // block: those two exist only to derive a registry for configs written
  // before it existed (see resolveBackends in config.ts), and a file that has
  // both would show the same setting twice with only one of them read. The
  // classifier and planner model chains stay — they are router infrastructure,
  // not backends.
  const config: Omit<RouterConfig, "openrouter" | "local"> & {
    openrouter: Omit<RouterConfig["openrouter"], "apiKey" | "answerModels">;
  } = {
    openrouter: {
      baseUrl: existing.openrouter.baseUrl,
      classifierModels: existing.openrouter.classifierModels,
      planModels: existing.openrouter.planModels,
    },
    ...buildInitConfig(answers, existing.backends),
    modelSelection: { enabled: existing.modelSelection.enabled },
    orchestra: {
      enabled: orchestraEnabled,
      complexityThreshold: orchestraComplexity,
      maxFixRounds: orchestraMaxFixRounds,
      decompose: orchestraDecompose,
    },
    thresholds: { confidence, planComplexity, modelTierLow: existing.thresholds.modelTierLow, modelTierHigh: existing.thresholds.modelTierHigh },
    session: { maxMessages },
    logging: { routingLog },
    timeoutMs,
  };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");

  if (apiKey) {
    let envText = "";
    try {
      envText = fs.readFileSync(path.join(dir, ".env"), "utf8");
    } catch {
      // no .env yet
    }
    fs.writeFileSync(path.join(dir, ".env"), mergeEnvKey(envText, apiKey), "utf8");
  }

  process.stdout.write(
    pc.bold("\n✓ saved to ") +
      pc.dim(dir) +
      pc.bold("\n\nTry it:\n") +
      pc.cyan(`  prompt-router "fix the login bug in auth.ts"\n\n`),
  );
}
