#!/usr/bin/env node

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import pc from "picocolors";
import { findHandoffBackend, selectCandidates } from "./backends.js";
import { classify } from "./classify.js";
import { configDir, loadConfig, type RouterConfig } from "./config.js";
import { estimateUsage, savingsFor } from "./cost.js";
import { dispatchChat, execSpawnPlan } from "./dispatch.js";
import { estimateComplexity, heuristicCategory } from "./heuristics.js";
import { runInit } from "./init.js";
import type { ChatMessage } from "./llm.js";
import { ensureChatBackend } from "./local.js";
import { appendRoutingLog } from "./log.js";
import { attachPlan, generatePlan } from "./plan.js";
import { decideRoute } from "./route.js";
import { appendToSession, clearSession, loadSession } from "./session.js";
import { formatStats, loadStats, recordDispatch } from "./stats.js";
import { tierForBackend } from "./tier.js";
import type {
  Backend,
  Category,
  CategoryDecision,
  ChatBackend,
  Classification,
  Dispatch,
  EffortLevel,
  ExecBackend,
  ModelTier,
} from "./types.js";
import { isBatchShim, resolveWindowsCommand, toShellArgs } from "./winShell.js";
import {
  askPlanChoice,
  askRouteChoice,
  showError,
  showPassThrough,
  showPlan,
  showRouting,
  startSpinner,
} from "./ui.js";

const MIN_PROMPT_LENGTH = 10;
const ANSWER_TIMEOUT_FLOOR_MS = 30_000;

const USAGE = `Usage: prompt-router "your prompt"
  init                 interactive setup wizard
  -c, --continue       carry the previous conversation into this one
      --to <backend>   force a backend by id (claude | local | openrouter | ...)
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
  forceBackendId: string | null;
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
    forceBackendId: null,
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
      if (!target) {
        process.stderr.write("prompt-router: --to expects a backend id\n");
        process.exit(1);
      }
      args.forceBackendId = target;
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

function routeDetail(backend: Backend, dispatch: Dispatch): string {
  if (backend.kind === "chat") return `${backend.label} (${backend.models[0] ?? "model"})`;
  const parts = [dispatch.model, dispatch.effort ? `effort: ${dispatch.effort}` : undefined].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? `${backend.label} (${parts.join(", ")})` : backend.label;
}

/**
 * True when the command cannot possibly be spawned. Only meaningful on
 * win32: execSpawnPlan always shells through cmd.exe there (see
 * src/winShell.ts), so cmd.exe itself launches fine and merely exits
 * non-zero with its own "not recognized" message on a missing command —
 * spawnSync's `result.error` never gets set, so that check alone misses it.
 * Off win32, no shell is used and a genuinely missing command already
 * surfaces as a real ENOENT on `result.error`, so this pre-check is a no-op
 * there and behaviour is unchanged.
 */
function commandUnresolvable(command: string): boolean {
  return process.platform === "win32" && resolveWindowsCommand(command) === null;
}

function runExec(
  backend: ExecBackend,
  text: string,
  continueSession: boolean,
  model?: string,
  effort?: EffortLevel,
): never {
  const fail = (reason: string): never => {
    showError(`failed to run ${backend.command}: ${reason}`);
    process.stderr.write("Your prompt, so it is not lost:\n\n");
    process.stdout.write(text + "\n");
    process.exit(1);
  };

  if (commandUnresolvable(backend.command)) fail("command not found");

  const plan = execSpawnPlan(backend, { prompt: text, continueSession, model, effort });
  const result = spawnSync(plan.command, plan.args, {
    stdio: "inherit",
    shell: plan.useShell,
  });
  if (result.error) fail(result.error.message);
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

function logRouting(config: RouterConfig, backendId: string, dispatch: Dispatch): void {
  // Opt-in and content-free by design: ids and flags only, never the prompt.
  if (!config.logging.routingLog) return;
  appendRoutingLog(configDir(), {
    target: backendId,
    planFirst: dispatch.planFirst,
    uncertain: dispatch.uncertain,
  });
}

function tierFor(
  backend: Backend,
  cls: Classification | null,
  prompt: string,
  config: RouterConfig,
  uncertain: boolean,
): ModelTier | null {
  // The classifier's complexity score is the best signal; when it is missing
  // (no API key, timeout) a local estimate keeps the tier per-task instead of
  // silently running every prompt on the backend's default model. The
  // capability gate itself (which backends are even eligible) lives in
  // tier.ts, where it can be unit-tested without the CLI.
  return tierForBackend(backend, cls?.complexity ?? estimateComplexity(prompt), uncertain, {
    enabled: config.modelSelection.enabled,
    lowThreshold: config.thresholds.modelTierLow,
    highThreshold: config.thresholds.modelTierHigh,
  });
}

function resolveDispatch(
  backend: Backend,
  fallbacks: Backend[],
  decision: CategoryDecision,
  cls: Classification | null,
  prompt: string,
  config: RouterConfig,
  args: CliArgs,
): Dispatch {
  const tier = tierFor(backend, cls, prompt, config, decision.uncertain);
  const planFirst =
    decision.planFirst && backend.kind === "exec" && backend.supportsPlan;
  return {
    backend,
    fallbacks,
    planFirst,
    uncertain: decision.uncertain,
    model: args.forceModel ?? tier?.model,
    effort: args.forceEffort ?? tier?.effort,
  };
}

async function runExecRoute(
  backend: ExecBackend,
  prompt: string,
  dispatch: Dispatch,
  category: Category,
  config: RouterConfig,
  args: CliArgs,
): Promise<never> {
  let finalPrompt = prompt;
  if (dispatch.planFirst) {
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

  // The exec backend serves the prompt itself, so nothing was diverted and the
  // output tokens are unobservable once the terminal is handed over.
  recordDispatch(configDir(), {
    backendId: backend.id,
    category,
    usage: estimateUsage(finalPrompt),
    spend: 0,
    savedTokens: 0,
    savedUsd: 0,
  });
  logRouting(config, backend.id, dispatch);
  runExec(backend, finalPrompt, args.continueSession, dispatch.model, dispatch.effort);
}

async function runChatRoute(
  candidates: Backend[],
  dispatch: Dispatch,
  prompt: string,
  decision: CategoryDecision,
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
  const handoff = findHandoffBackend(config.backends);

  const chatCandidates = candidates.filter((b): b is ChatBackend => b.kind === "chat");
  for (const backend of chatCandidates) {
    const apiKey = backend.apiKeyEnv ? process.env[backend.apiKeyEnv] : undefined;
    if (backend.apiKeyEnv && !apiKey) {
      showPassThrough(`${backend.label}: no ${backend.apiKeyEnv} — trying the next backend`);
      continue;
    }

    if (backend.probe) {
      const stopSpinner = startSpinner(`Reaching ${backend.label}...`);
      const up = await ensureChatBackend(backend);
      stopSpinner();
      if (!up) {
        showPassThrough(`${backend.label} unavailable — trying the next backend`);
        continue;
      }
    }

    const attempt = await dispatchChat(backend, {
      messages,
      timeoutMs,
      apiKey,
      onDelta: (text) => process.stdout.write(text),
      onModelSwitch: () =>
        process.stdout.write(pc.dim("\n[stream interrupted — retrying with another model]\n")),
    });
    if (!attempt) {
      showPassThrough(`${backend.label} failed — trying the next backend`);
      continue;
    }

    // The tier this prompt would have used decides the reference price, so a
    // trivial question is not valued at the top tier.
    const tier = handoff
      ? tierFor(handoff, cls, prompt, config, decision.uncertain)
      : null;
    const { savedTokens, savedUsd } = savingsFor(attempt.usage, handoff, tier);
    recordDispatch(dir, {
      backendId: backend.id,
      category: decision.category,
      usage: attempt.usage,
      spend: attempt.spend,
      savedTokens,
      savedUsd,
    });
    logRouting(config, backend.id, dispatch);

    process.stdout.write("\n");
    appendToSession(
      dir,
      [
        { role: "user", content: prompt },
        { role: "assistant", content: attempt.text },
      ],
      config.session.maxMessages,
    );
    return;
  }

  if (!handoff) {
    showError("every answer backend failed and no agentic backend is configured");
    process.stderr.write("Your prompt, so it is not lost:\n\n");
    process.stdout.write(prompt + "\n");
    process.exit(1);
  }

  showPassThrough(`all answer backends failed — handing off to ${handoff.label}`);
  // uncertain:false — the uncertain bump exists to protect code tasks from
  // weak backends, and a hand-off already lands on the strongest one.
  const handoffDispatch = resolveDispatch(
    handoff,
    [],
    { category: decision.category, planFirst: false, uncertain: false },
    cls,
    prompt,
    config,
    args,
  );
  await runExecRoute(handoff, prompt, handoffDispatch, decision.category, config, args);
}

async function main(): Promise<void> {
  if (process.argv[2] === "init") {
    await runInit();
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const dir = configDir();

  if (args.showStats) {
    const config = loadConfig();
    process.stdout.write(formatStats(loadStats(dir), config.backends) + "\n");
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
    const handoff = findHandoffBackend(config.backends);
    if (!handoff) {
      showError("--no-route needs an exec backend, and none is configured");
      process.exit(1);
    }
    runExec(
      handoff,
      args.prompt,
      args.continueSession,
      args.forceModel ?? undefined,
      args.forceEffort ?? undefined,
    );
  }

  const heuristic = heuristicCategory(args.prompt, { inCodeProject: detectCodeProject() });

  // Trivially short prompts skip the paid optimizer call but still get routed:
  // "naber?" is chat and "fix bug" is code — neither belongs on an agentic
  // backend by default just for being short.
  let cls: Classification | null = null;
  if (args.prompt.length >= MIN_PROMPT_LENGTH) {
    const stopSpinner = startSpinner("Optimizing & routing...");
    cls = await classify(args.prompt, config);
    stopSpinner();
    if (!cls) showPassThrough("optimizer unavailable — using the original prompt");
  }

  const decision = decideRoute(cls, heuristic, {
    confidenceThreshold: config.thresholds.confidence,
    planComplexityThreshold: config.thresholds.planComplexity,
  });

  let candidates = selectCandidates(decision.category, config.backends);
  if (args.forceBackendId) {
    const forced = config.backends.find((b) => b.id === args.forceBackendId);
    if (!forced) {
      const ids = config.backends.map((b) => b.id).join(", ");
      process.stderr.write(`prompt-router: unknown backend "${args.forceBackendId}" (have: ${ids})\n`);
      process.exit(1);
    }
    candidates = [forced, ...candidates.filter((b) => b.id !== forced.id)];
  }

  let head = candidates[0];
  if (!head) {
    const handoff = findHandoffBackend(config.backends);
    if (!handoff) {
      showError(`no backend serves "${decision.category}"`);
      process.exit(1);
    }
    candidates = [handoff];
    head = handoff;
  }

  let dispatch = resolveDispatch(
    head,
    candidates.slice(1),
    decision,
    cls,
    args.prompt,
    config,
    args,
  );

  let finalPrompt = cls?.optimizedPrompt ?? args.prompt;

  // The confirmation bar also runs for --to: forcing a backend shouldn't mean
  // an unseen LLM rewrite goes out — the rewrite still needs a chance to be
  // rejected or edited. Only --no-route skips it.
  showRouting(args.prompt, finalPrompt, dispatch, routeDetail(head, dispatch), cls);
  const choice = await askRouteChoice(candidates);
  process.stderr.write("\n");
  if (choice.action === "reject") finalPrompt = args.prompt;
  else if (choice.action === "edit") finalPrompt = openInEditor(finalPrompt);

  if (choice.overrideBackendId) {
    const chosen = config.backends.find((b) => b.id === choice.overrideBackendId);
    if (chosen) {
      candidates = [chosen, ...candidates.filter((b) => b.id !== chosen.id)];
      head = chosen;
      dispatch = resolveDispatch(
        chosen,
        candidates.slice(1),
        decision,
        cls,
        args.prompt,
        config,
        args,
      );
    }
  }

  if (head.kind === "exec") {
    await runExecRoute(head, finalPrompt, dispatch, decision.category, config, args);
  } else {
    // runChatRoute records the backend that actually answers, since its
    // fallback chain can land somewhere other than the head candidate.
    await runChatRoute(candidates, dispatch, finalPrompt, decision, cls, config, args);
  }
}

main().catch((err: unknown) => {
  showError(err instanceof Error ? err.message : "unexpected error");
  process.exit(1);
});
