#!/usr/bin/env node

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import pc from "picocolors";
import {
  findHandoffBackend,
  findPricingReferenceBackend,
  remainingChatBackends,
  selectCandidates,
} from "./backends.js";
import { classify } from "./classify.js";
import { configDir, loadConfig, type RouterConfig } from "./config.js";
import { estimateUsage, savingsFor } from "./cost.js";
import { dispatchChat, execSpawnPlan } from "./dispatch.js";
import { estimateComplexity, heuristicCategory } from "./heuristics.js";
import { runInit } from "./init.js";
import type { ChatMessage } from "./llm.js";
import { ensureChatBackend } from "./local.js";
import { appendRoutingLog } from "./log.js";
import {
  buildFixPrompt,
  buildReviewPrompt,
  buildStepPrompt,
  captureDiff,
  decomposeTask,
  parseVerdict,
  runPrintTask,
  selectAgent,
  type AgentCandidate,
} from "./orchestra.js";
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
  askOrchestraPlanChoice,
  askPlanChoice,
  askRouteChoice,
  showDebug,
  showError,
  showOrchestraPlan,
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
      --no-route       skip optimization and routing, go straight to the agentic backend
      --orchestra      force orchestra mode: agent selection + automatic review/fix loop
      --no-orchestra   disable orchestra mode even if it would trigger automatically
      --showdebug      print orchestra mode's selection and verdict reasoning
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
  orchestra: boolean;
  noOrchestra: boolean;
  showDebug: boolean;
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
    orchestra: false,
    noOrchestra: false,
    showDebug: false,
  };
  const parts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "-c" || arg === "--continue") args.continueSession = true;
    else if (arg === "--no-route") args.noRoute = true;
    else if (arg === "--orchestra") args.orchestra = true;
    else if (arg === "--no-orchestra") args.noOrchestra = true;
    else if (arg === "--showdebug") args.showDebug = true;
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

interface ExecOutcome {
  status: number;
  /** Set when the spawn itself failed — the prompt was never handed off. */
  failMessage?: string;
}

/**
 * The non-exiting core of running an exec backend interactively. Split out
 * of `runExec` so orchestra mode's multi-round loop can run several exec
 * backends in one process invocation and only exit once, at the very end.
 */
function spawnExecInteractive(
  backend: ExecBackend,
  text: string,
  continueSession: boolean,
  model?: string,
  effort?: EffortLevel,
): ExecOutcome {
  if (commandUnresolvable(backend.command)) return { status: 1, failMessage: "command not found" };

  const plan = execSpawnPlan(backend, { prompt: text, continueSession, model, effort });
  const result = spawnSync(plan.command, plan.args, {
    stdio: "inherit",
    shell: plan.useShell,
  });
  if (result.error) return { status: 1, failMessage: result.error.message };
  return { status: result.status ?? 1 };
}

function runExec(
  backend: ExecBackend,
  text: string,
  continueSession: boolean,
  model?: string,
  effort?: EffortLevel,
): never {
  const outcome = spawnExecInteractive(backend, text, continueSession, model, effort);
  if (outcome.failMessage) {
    showError(`failed to run ${backend.command}: ${outcome.failMessage}`);
    process.stderr.write("Your prompt, so it is not lost:\n\n");
    process.stdout.write(text + "\n");
    process.exit(1);
  }
  process.exit(outcome.status);
}

/**
 * $EDITOR conventionally carries flags too (`code --wait`, `vim -u NONE`), so
 * treating the whole value as one executable name — as spawnSync would if
 * handed it directly — fails with ENOENT the moment it contains a space.
 */
function parseEditorCommand(spec: string): { command: string; args: string[] } {
  const parts = spec.trim().split(/\s+/).filter(Boolean);
  const command = parts[0] ?? spec;
  return { command, args: parts.slice(1) };
}

function openInEditor(content: string): string {
  const tmpFile = path.join(os.tmpdir(), `prompt-router-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, content, "utf8");

  const editorSpec = process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi");
  const { command: editor, args: editorArgs } = parseEditorCommand(editorSpec);
  const useShell = process.platform === "win32";
  spawnSync(
    editor,
    toShellArgs([...editorArgs, tmpFile], useShell, useShell && isBatchShim(editor)),
    { stdio: "inherit", shell: useShell },
  );

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
    planFirst,
    uncertain: decision.uncertain,
    model: args.forceModel ?? tier?.model,
    effort: args.forceEffort ?? tier?.effort,
  };
}

/** Runs the plan-first pipeline when eligible; otherwise returns `prompt` unchanged. */
async function maybeAttachPlan(prompt: string, planFirst: boolean, config: RouterConfig): Promise<string> {
  if (!planFirst) return prompt;

  const stopSpinner = startSpinner("Drafting plan...");
  const plan = await generatePlan(prompt, config);
  stopSpinner();
  if (!plan) {
    showPassThrough("plan generation unavailable — sending the prompt without a plan");
    return prompt;
  }

  showPlan(plan);
  const planChoice = await askPlanChoice();
  process.stderr.write("\n");
  if (planChoice === "accept") return attachPlan(prompt, plan);
  if (planChoice === "edit") return attachPlan(prompt, openInEditor(plan));
  return prompt; // "skip" keeps the prompt as-is
}

async function runExecRoute(
  backend: ExecBackend,
  prompt: string,
  dispatch: Dispatch,
  category: Category,
  config: RouterConfig,
  args: CliArgs,
): Promise<never> {
  const finalPrompt = await maybeAttachPlan(prompt, dispatch.planFirst, config);

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

function toAgentCandidates(backends: readonly ExecBackend[]): AgentCandidate[] {
  return backends.map((b) => ({ id: b.id, label: b.label, strengths: b.strengths }));
}

/**
 * Orchestra mode. Either:
 *  - a conductor LLM call splits the task into an ordered, per-agent step
 *    list (decomposeTask) and each step runs on its assigned exec backend in
 *    sequence, in this same repo; or
 *  - when decomposition is off, unavailable, or there are too few agents to
 *    make it meaningful, the whole task goes to a single selected agent —
 *    orchestra mode's original, simpler behaviour.
 * Either way, the result is one automatic non-interactive review of the
 * resulting `git diff`, with up to `config.orchestra.maxFixRounds` rounds of
 * "reviewer finds issues → a (re-selected) fixer addresses them → reviewed
 * again" before handing control back to the user. Every round records
 * stats/logging exactly like runExecRoute; the process exits once, at the
 * end, with the last round's exit status.
 */
async function runOrchestraRoute(
  execBackends: ExecBackend[],
  prompt: string,
  decision: CategoryDecision,
  cls: Classification | null,
  config: RouterConfig,
  args: CliArgs,
): Promise<never> {
  const dir = configDir();
  const candidates = toAgentCandidates(execBackends);

  const runRound = (backend: ExecBackend, text: string, dispatch: Dispatch): ExecOutcome => {
    recordDispatch(dir, {
      backendId: backend.id,
      category: decision.category,
      usage: estimateUsage(text),
      spend: 0,
      savedTokens: 0,
      savedUsd: 0,
    });
    logRouting(config, backend.id, dispatch);
    const outcome = spawnExecInteractive(backend, text, args.continueSession, dispatch.model, dispatch.effort);
    if (outcome.failMessage) {
      showError(`failed to run ${backend.command}: ${outcome.failMessage}`);
      process.stderr.write("Your prompt, so it is not lost:\n\n");
      process.stdout.write(text + "\n");
    }
    return outcome;
  };

  const proposedSteps = config.orchestra.decompose ? await decomposeTask(prompt, candidates, config) : null;
  let steps: typeof proposedSteps = null;
  if (proposedSteps) {
    showOrchestraPlan(proposedSteps);
    const planChoice = await askOrchestraPlanChoice();
    process.stderr.write("\n");
    if (planChoice === "accept") steps = proposedSteps;
    else showPassThrough("orchestra: plan declined — handing the whole task to one agent instead");
  }
  let lastOutcome: ExecOutcome;

  if (steps) {
    showDebug(
      args.showDebug,
      `plan: ${steps.map((s, i) => `${i + 1}.[${s.backendId}] ${s.instruction}`).join(" | ")}`,
    );
    const agentCount = new Set(steps.map((s) => s.backendId)).size;
    showPassThrough(`orchestra: split into ${steps.length} step(s) across ${agentCount} agent(s)`);

    lastOutcome = { status: 0 };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const backend = execBackends.find((b) => b.id === step.backendId) ?? execBackends[0]!;
      showPassThrough(`orchestra: step ${i + 1}/${steps.length} → ${backend.label}`);
      const stepDispatch = resolveDispatch(backend, decision, cls, step.instruction, config, args);
      lastOutcome = runRound(backend, buildStepPrompt(prompt, steps, i), stepDispatch);
      if (lastOutcome.failMessage) break; // a step failed to spawn — later steps would build on nothing
    }
  } else {
    const primaryId = (await selectAgent(prompt, candidates, config)) ?? execBackends[0]!.id;
    const primary = execBackends.find((b) => b.id === primaryId) ?? execBackends[0]!;
    showDebug(args.showDebug, `agents: ${candidates.map((c) => c.id).join(", ")} → primary: ${primary.id}`);
    showPassThrough(`orchestra: ${primary.label} takes this task`);

    const primaryDispatch = resolveDispatch(primary, decision, cls, prompt, config, args);
    const primaryPrompt = await maybeAttachPlan(prompt, primaryDispatch.planFirst, config);
    lastOutcome = runRound(primary, primaryPrompt, primaryDispatch);
  }

  // A spawn failure (command not found, etc.) means nothing was diverted and
  // there is nothing sensible to review — same contract as runExec's single
  // attempt: report it and stop, rather than reviewing whatever partial diff
  // is lying around.
  if (lastOutcome.failMessage) process.exit(1);
  let lastStatus = lastOutcome.status;

  const reviewers = execBackends.filter((b) => b.printArgs && b.printArgs.length > 0);
  if (reviewers.length === 0) {
    showDebug(args.showDebug, "no reviewer-capable backend declares printArgs — skipping review");
    process.exit(lastStatus);
  }
  const reviewerCandidates = toAgentCandidates(reviewers);

  let task = prompt;
  for (let round = 0; round <= config.orchestra.maxFixRounds; round++) {
    const diff = captureDiff();
    if (diff === null) {
      showPassThrough("orchestra: not a git repository — skipping review");
      break;
    }
    if (diff.trim() === "") {
      showPassThrough("orchestra: no changes to review");
      break;
    }

    const reviewerId = (await selectAgent(task, reviewerCandidates, config)) ?? reviewers[0]!.id;
    const reviewer = reviewers.find((b) => b.id === reviewerId) ?? reviewers[0]!;
    showDebug(args.showDebug, `reviewer: ${reviewer.id}`);

    const stopSpinner = startSpinner(`${reviewer.label} is reviewing the change...`);
    const printResult = runPrintTask(reviewer, { prompt: buildReviewPrompt(task, diff), continueSession: false });
    stopSpinner();

    if (printResult.text === null) {
      showPassThrough(`orchestra: ${reviewer.label} review failed to run — stopping the review loop`);
      break;
    }

    const verdict = parseVerdict(printResult.text);
    showDebug(args.showDebug, `verdict: ${verdict.status}\n${verdict.raw}`);

    if (verdict.status === "clean") {
      showPassThrough(`orchestra: ${reviewer.label} found no issues`);
      break;
    }
    if (verdict.status === "unknown") {
      showError(`orchestra: ${reviewer.label} did not return a clear verdict — stopping the review loop`);
      process.stderr.write(verdict.raw + "\n");
      break;
    }

    process.stderr.write("\n" + pc.yellow("  orchestra: issues found") + "\n");
    process.stderr.write(pc.dim("  " + verdict.notes.replace(/\n/g, "\n  ")) + "\n\n");

    if (round >= config.orchestra.maxFixRounds) {
      showPassThrough(`orchestra: ${config.orchestra.maxFixRounds} fix round(s) used — stopping, review by hand`);
      break;
    }

    const fixerId = (await selectAgent(verdict.notes, candidates, config)) ?? execBackends[0]!.id;
    const fixer = execBackends.find((b) => b.id === fixerId) ?? execBackends[0]!;
    showDebug(args.showDebug, `fixer: ${fixer.id}`);
    showPassThrough(`orchestra: ${fixer.label} is fixing round ${round + 1}`);

    task = verdict.notes;
    const fixDispatch = resolveDispatch(fixer, decision, cls, task, config, args);
    lastStatus = runRound(fixer, buildFixPrompt(prompt, verdict.notes), fixDispatch).status;
  }

  process.exit(lastStatus);
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
  // Not the same backend as the hand-off target in general: the counterfactual
  // has to be priced against something that declares modelPricing, or adding a
  // higher-priority agent without prices zeroes the savings figure silently.
  const reference = findPricingReferenceBackend(config.backends);

  const chatCandidates = candidates.filter((b): b is ChatBackend => b.kind === "chat");
  // The category's candidates first, then every other enabled chat backend as
  // a last resort. Handing a question to the paid agent because no chat
  // backend happened to declare its category inverts the whole point of the
  // router; anything already tried above is excluded, including one skipped
  // for a missing key — that would fail identically.
  const attempts = [
    ...chatCandidates,
    ...remainingChatBackends(config.backends, new Set(chatCandidates.map((b) => b.id))),
  ];
  for (const backend of attempts) {
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
    const tier = reference
      ? tierFor(reference, cls, prompt, config, decision.uncertain)
      : null;
    const { savedTokens, savedUsd } = savingsFor(attempt.usage, reference, tier);
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
    // selectCandidates already drops disabled backends, but --to bypasses it
    // entirely — and for a chat backend the only other `enabled` check lives
    // inside ensureChatBackend, which is skipped for every remote provider
    // (probe: false). Forcing a backend the user turned off would dispatch for
    // real and bill them for it.
    if (!forced.enabled) {
      process.stderr.write(
        `prompt-router: backend "${forced.id}" is disabled — ` +
          `set "enabled": true for it in ${path.join(dir, "config.json")}\n`,
      );
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
        decision,
        cls,
        args.prompt,
        config,
        args,
      );
    }
  }

  if (head.kind === "exec") {
    // An explicit backend choice — --to or a numbered override at the
    // confirmation bar — is a direct "run this one" instruction; orchestra's
    // own agent selection would second-guess it, so it's skipped entirely.
    const explicitBackend = args.forceBackendId !== null || choice.overrideBackendId !== undefined;
    const execBackends = candidates.filter((b): b is ExecBackend => b.kind === "exec");
    const complexity = cls?.complexity ?? estimateComplexity(finalPrompt);
    const orchestraAuto =
      config.orchestra.enabled &&
      decision.category === "code" &&
      complexity >= config.orchestra.complexityThreshold;
    const useOrchestra =
      !explicitBackend && !args.noOrchestra && (args.orchestra || orchestraAuto) && execBackends.length > 0;

    if (useOrchestra) {
      await runOrchestraRoute(execBackends, finalPrompt, decision, cls, config, args);
    } else {
      await runExecRoute(head, finalPrompt, dispatch, decision.category, config, args);
    }
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
