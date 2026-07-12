import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import pc from "picocolors";
import { configDir, resolveConfig, type RouterConfig } from "./config.js";
import { isServerUp } from "./local.js";

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

  const localEnabled = await askBoolean(prompter, "Use a local model", existing.local.enabled);
  const local: RouterConfig["local"] = { ...existing.local, enabled: localEnabled };
  if (localEnabled) {
    local.baseUrl = await ask(prompter, "Local server URL", existing.local.baseUrl);
    local.model = await ask(prompter, "Local model name", existing.local.model);
    local.autoStart = await askBoolean(prompter, "Auto-start the local server", existing.local.autoStart);
    process.stdout.write(pc.dim("  checking local server...\n"));
    const up = await isServerUp(local.baseUrl, LOCAL_PROBE_TIMEOUT_MS);
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

  if (!prompter.closed) rl.close();

  const config: Omit<RouterConfig, "openrouter"> & { openrouter: Omit<RouterConfig["openrouter"], "apiKey"> } = {
    openrouter: {
      baseUrl: existing.openrouter.baseUrl,
      classifierModels: existing.openrouter.classifierModels,
      answerModels: existing.openrouter.answerModels,
      planModels: existing.openrouter.planModels,
    },
    local,
    modelSelection: { enabled: existing.modelSelection.enabled },
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
