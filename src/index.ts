#!/usr/bin/env node

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import pc from "picocolors";
import { classify } from "./classify.js";
import { configDir, loadConfig, type RouterConfig } from "./config.js";
import { estimateComplexity, heuristicCategory } from "./heuristics.js";
import { runInit } from "./init.js";
import { streamChat, withModelFallback, type ChatMessage } from "./llm.js";
import { ensureLocalServer } from "./local.js";
import { appendRoutingLog } from "./log.js";
import { attachPlan, generatePlan } from "./plan.js";
import { decideRoute } from "./route.js";
import { pickModelTier } from "./tier.js";
import { buildClaudeArgs } from "./claudeArgs.js";
import { appendToSession, clearSession, loadSession } from "./session.js";
import { formatStats, loadStats, recordRoute } from "./stats.js";
import type { Classification, EffortLevel, RouteDecision, RouteTarget } from "./types.js";
import { isBatchShim, toShellArgs } from "./winShell.js";
import {
  askPlanChoice,
  askRouteChoice,
  showError,
  showPassThrough,
  showPlan,
  showRouting,
  startSpinner,
  TARGET_LABELS,
} from "./ui.js";

const MIN_PROMPT_LENGTH = 10;
const ANSWER_TIMEOUT_FLOOR_MS = 30_000;

const USAGE = `Usage: prompt-router "your prompt"
  init                 interactive setup wizard
  -c, --continue       carry the previous conversation into this one
      --to <target>    force a backend: claude | local | openrouter
      --model <name>   force the Claude Code model for this run (e.g. opus, sonnet, haiku)
      --effort <level> force the Claude Code effort for this run: low | medium | high | xhigh | max
      --no-route       skip optimization and routing, go straight to Claude Code
      --stats          show routing statistics
      --clear-session  forget the stored conversation
`;

interface CliArgs {
  prompt: string;
  continueSession: boolean;
  noRoute: boolean;
  forceTarget: RouteTarget | null;
  forceModel: string | null;
  forceEffort: EffortLevel | null;
  showStats: boolean;
  clear: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: "",
    continueSession: false,
    noRoute: false,
    forceTarget: null,
    forceModel: null,
    forceEffort: null,
    showStats: false,
    clear: false,
  };
  const parts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-c" || arg === "--continue") args.continueSession = true;
    else if (arg === "--no-route") args.noRoute = true;
    else if (arg === "--stats") args.showStats = true;
    else if (arg === "--clear-session") args.clear = true;
    else if (arg === "--to") {
      const target = argv[++i];
      if (target === "claude" || target === "local" || target === "openrouter") {
        args.forceTarget = target;
      } else {
        process.stderr.write("prompt-router: --to expects claude | local | openrouter\n");
        process.exit(1);
      }
    } else if (arg === "--model") {
      const model = argv[++i];
      if (!model) {
        process.stderr.write("prompt-router: --model expects a model name\n");
        process.exit(1);
      }
      args.forceModel = model;
    } else if (arg === "--effort") {
      const effort = argv[++i];
      if (
        effort === "low" ||
        effort === "medium" ||
        effort === "high" ||
        effort === "xhigh" ||
        effort === "max"
      ) {
        args.forceEffort = effort;
      } else {
        process.stderr.write(
          "prompt-router: --effort expects low | medium | high | xhigh | max\n",
        );
        process.exit(1);
      }
    } else parts.push(arg);
  }
  args.prompt = parts.join(" ").trim();
  return args;
}

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "build.gradle",
  "pom.xml",
];

function detectCodeProject(): boolean {
  return PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(process.cwd(), marker)));
}

function routeDetail(target: RouteTarget, config: RouterConfig, decision: RouteDecision): string {
  if (target === "local") return `${TARGET_LABELS.local} (${config.local.model})`;
  if (target === "openrouter") {
    return `${TARGET_LABELS.openrouter} (${config.openrouter.answerModels[0] ?? "free model"})`;
  }
  if (decision.model || decision.effort) {
    const parts = [decision.model, decision.effort ? `effort: ${decision.effort}` : undefined]
      .filter((part): part is string => part !== undefined);
    return `${TARGET_LABELS.claude} (${parts.join(", ")})`;
  }
  return TARGET_LABELS.claude;
}

function runClaude(
  text: string,
  continueSession: boolean,
  model?: string,
  effort?: EffortLevel,
): never {
  const useShell = process.platform === "win32";
  const claudeArgs = toShellArgs(
    buildClaudeArgs(text, continueSession, model, effort),
    useShell,
    useShell && isBatchShim("claude"),
  );
  const result = spawnSync("claude", claudeArgs, {
    stdio: "inherit",
    shell: useShell,
  });
  if (result.error) {
    showError(`failed to run claude: ${result.error.message}`);
    process.stderr.write("Your prompt, so it is not lost:\n\n");
    process.stdout.write(text + "\n");
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function openInEditor(content: string): string {
  const tmpFile = path.join(os.tmpdir(), `prompt-router-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, content, "utf8");

  const editor = process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi");
  const useShell = process.platform === "win32";
  spawnSync(editor, toShellArgs([tmpFile], useShell, useShell && isBatchShim(editor)), {
    stdio: "inherit",
    shell: useShell,
  });

  const edited = fs.readFileSync(tmpFile, "utf8").trim();
  fs.unlinkSync(tmpFile);
  return edited || content;
}

function logRouting(config: RouterConfig, decision: RouteDecision): void {
  // Opt-in and content-free by design: categories and targets only, never the prompt.
  if (!config.logging.routingLog) return;
  appendRoutingLog(configDir(), {
    target: decision.target,
    planFirst: decision.planFirst,
    uncertain: decision.uncertain,
  });
}

function withModelTier(
  decision: RouteDecision,
  cls: Classification | null,
  prompt: string,
  config: RouterConfig,
  args: CliArgs,
): RouteDecision {
  if (decision.target !== "claude") return decision;
  // The classifier's complexity score is the best signal; when it is missing
  // (no API key, timeout) a local estimate keeps the tier per-task instead of
  // silently running every prompt on Claude Code's default model.
  const auto = config.modelSelection.enabled
    ? pickModelTier(cls?.complexity ?? estimateComplexity(prompt), decision.uncertain, {
        lowThreshold: config.thresholds.modelTierLow,
        highThreshold: config.thresholds.modelTierHigh,
      })
    : null;
  return {
    ...decision,
    model: args.forceModel ?? auto?.model,
    effort: args.forceEffort ?? auto?.effort,
  };
}

async function runClaudeRoute(
  prompt: string,
  decision: RouteDecision,
  config: RouterConfig,
  args: CliArgs,
): Promise<never> {
  let finalPrompt = prompt;
  if (decision.planFirst) {
    const stopSpinner = startSpinner("Drafting plan...");
    const plan = await generatePlan(prompt, config);
    stopSpinner();
    if (plan) {
      showPlan(plan);
      const planChoice = await askPlanChoice();
      process.stderr.write("\n");
      if (planChoice === "accept") finalPrompt = attachPlan(prompt, plan);
      else if (planChoice === "edit") finalPrompt = attachPlan(prompt, openInEditor(plan));
      // "skip" keeps the prompt as-is
    } else {
      showPassThrough("plan generation unavailable — sending the prompt without a plan");
    }
  }
  runClaude(finalPrompt, args.continueSession, decision.model, decision.effort);
}

async function runChatRoute(
  prompt: string,
  decision: RouteDecision,
  cls: Classification | null,
  config: RouterConfig,
  args: CliArgs,
): Promise<void> {
  const dir = configDir();
  const history = args.continueSession ? loadSession(dir) : [];
  const messages: ChatMessage[] = [
    ...history.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    { role: "user", content: prompt },
  ];
  const timeoutMs = Math.max(config.timeoutMs, ANSWER_TIMEOUT_FLOOR_MS);
  const writeDelta = (text: string): void => {
    process.stdout.write(text);
  };

  // Stats and the routing log record the backend that actually served the
  // prompt, not the one the decision hoped for.
  const recordDispatch = (target: RouteTarget): void => {
    recordRoute(dir, target);
    logRouting(config, { ...decision, target });
  };
  const handOffToClaude = (reason: string): never => {
    showPassThrough(reason);
    recordDispatch("claude");
    // uncertain:false — the uncertain bump exists to protect code tasks from
    // weak backends, and a hand-off already lands on the strongest one.
    const claudeDecision = withModelTier(
      { target: "claude", planFirst: false, uncertain: false },
      cls,
      prompt,
      config,
      args,
    );
    return runClaude(prompt, args.continueSession, claudeDecision.model, claudeDecision.effort);
  };

  let answer: string | null = null;
  let answeredBy: RouteTarget = decision.target;

  // With no OpenRouter key the local server is the only chat backend left, so
  // give it a chance even when the route said "openrouter".
  const tryLocal =
    decision.target === "local" || (!config.openrouter.apiKey && config.local.enabled);

  if (tryLocal) {
    const stopSpinner = startSpinner("Reaching local model...");
    const up = await ensureLocalServer(config);
    stopSpinner();
    if (up) {
      answer = await streamChat(
        { baseUrl: config.local.baseUrl, model: config.local.model, messages, timeoutMs },
        writeDelta,
      );
      if (answer !== null) answeredBy = "local";
    }
  }

  if (answer === null) {
    if (!config.openrouter.apiKey) {
      handOffToClaude(
        tryLocal
          ? "local model unavailable and no OPENROUTER_API_KEY — handing off to Claude Code"
          : "no OPENROUTER_API_KEY — handing off to Claude Code",
      );
    }
    if (tryLocal) {
      showPassThrough("local model unavailable — falling back to OpenRouter");
    }
    answer = await withModelFallback(config.openrouter.answerModels, async (model) => {
      let wrote = false;
      const result = await streamChat(
        {
          baseUrl: config.openrouter.baseUrl,
          apiKey: config.openrouter.apiKey,
          model,
          messages,
          timeoutMs,
        },
        (text) => {
          wrote = true;
          writeDelta(text);
        },
      );
      if (result === null && wrote) {
        process.stdout.write(pc.dim("\n[stream interrupted — retrying with another model]\n"));
      }
      return result;
    });
    if (answer !== null) answeredBy = "openrouter";
  }

  if (answer === null) {
    return handOffToClaude("all answer backends failed — handing off to Claude Code");
  }

  recordDispatch(answeredBy);
  process.stdout.write("\n");
  appendToSession(
    dir,
    [
      { role: "user", content: prompt },
      { role: "assistant", content: answer },
    ],
    config.session.maxMessages,
  );
}

async function main(): Promise<void> {
  if (process.argv[2] === "init") {
    await runInit();
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const dir = configDir();

  if (args.showStats) {
    process.stdout.write(formatStats(loadStats(dir)) + "\n");
    return;
  }
  if (args.clear) {
    clearSession(dir);
    process.stderr.write("prompt-router: session cleared.\n");
    return;
  }
  if (!args.prompt) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const config = loadConfig();

  if (args.noRoute) {
    runClaude(
      args.prompt,
      args.continueSession,
      args.forceModel ?? undefined,
      args.forceEffort ?? undefined,
    );
  }

  const heuristic = heuristicCategory(args.prompt, { inCodeProject: detectCodeProject() });

  // Trivially short prompts skip the paid optimizer call but still get routed:
  // "naber?" is chat and "fix bug" is code — neither belongs on Claude Code by
  // default just for being short.
  let cls: Classification | null = null;
  if (args.prompt.length >= MIN_PROMPT_LENGTH) {
    const stopSpinner = startSpinner("Optimizing & routing...");
    cls = await classify(args.prompt, config);
    stopSpinner();
    if (!cls) showPassThrough("optimizer unavailable — using the original prompt");
  }

  let decision: RouteDecision = args.forceTarget
    ? {
        target: args.forceTarget,
        planFirst: false,
        uncertain: cls !== null && cls.confidence < config.thresholds.confidence,
      }
    : decideRoute(cls, heuristic, {
        confidenceThreshold: config.thresholds.confidence,
        planComplexityThreshold: config.thresholds.planComplexity,
        localAvailable: config.local.enabled,
      });
  decision = withModelTier(decision, cls, args.prompt, config, args);

  let finalPrompt = cls?.optimizedPrompt ?? args.prompt;

  // The confirmation bar also runs for --to: forcing a backend shouldn't mean
  // an unseen LLM rewrite goes out — the rewrite still needs a chance to be
  // rejected or edited. Only --no-route skips it.
  showRouting(
    args.prompt,
    finalPrompt,
    decision,
    routeDetail(decision.target, config, decision),
    cls,
  );
  const choice = await askRouteChoice();
  process.stderr.write("\n");
  if (choice.action === "reject") finalPrompt = args.prompt;
  else if (choice.action === "edit") finalPrompt = openInEditor(finalPrompt);
  if (choice.overrideTarget) {
    decision = withModelTier(
      {
        ...decision,
        target: choice.overrideTarget,
        planFirst: choice.overrideTarget === "claude" ? decision.planFirst : false,
      },
      cls,
      args.prompt,
      config,
      args,
    );
  }

  if (decision.target === "claude") {
    recordRoute(dir, "claude");
    logRouting(config, decision);
    await runClaudeRoute(finalPrompt, decision, config, args);
  } else {
    // runChatRoute records the backend that actually answers, since its
    // fallback chain can land somewhere other than the decided target.
    await runChatRoute(finalPrompt, decision, cls, config, args);
  }
}

main().catch((err: unknown) => {
  showError(err instanceof Error ? err.message : "unexpected error");
  process.exit(1);
});
