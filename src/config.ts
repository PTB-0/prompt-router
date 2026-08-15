import { config as loadDotenv } from "dotenv";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Backend, Category, ChatBackend, Pricing } from "./types.js";

export interface RouterConfig {
  openrouter: {
    baseUrl: string;
    apiKey: string | undefined;
    classifierModels: string[];
    answerModels: string[];
    planModels: string[];
  };
  local: {
    baseUrl: string;
    model: string;
    autoStart: boolean;
    enabled: boolean;
  };
  modelSelection: {
    enabled: boolean;
  };
  orchestra: {
    enabled: boolean;
    complexityThreshold: number;
    maxFixRounds: number;
    /** Split the task across multiple agents when true; hand the whole task
     *  to one selected agent when false. */
    decompose: boolean;
  };
  thresholds: {
    confidence: number;
    planComplexity: number;
    modelTierLow: number;
    modelTierHigh: number;
  };
  session: {
    maxMessages: number;
  };
  logging: {
    routingLog: boolean;
  };
  timeoutMs: number;
  backends: Backend[];
}

const DEFAULTS: RouterConfig = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: undefined,
    classifierModels: [
      "openai/gpt-oss-20b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "meta-llama/llama-3.2-3b-instruct:free",
    ],
    answerModels: [
      "openai/gpt-oss-120b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "qwen/qwen3-next-80b-a3b-instruct:free",
    ],
    planModels: [
      "openai/gpt-oss-120b:free",
      "qwen/qwen3-coder:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ],
  },
  local: {
    baseUrl: "http://localhost:1234/v1",
    model: "gemma-4-12b-qat",
    autoStart: true,
    enabled: true,
  },
  modelSelection: {
    enabled: true,
  },
  orchestra: {
    enabled: true,
    // Independent of thresholds.planComplexity — orchestra mode's cost (an
    // extra LLM call plus a non-interactive review run) is higher than
    // plan-first's, so it only engages for tasks complex enough to be worth
    // a second agent's look.
    complexityThreshold: 0.75,
    maxFixRounds: 2,
    decompose: true,
  },
  thresholds: {
    confidence: 0.6,
    planComplexity: 0.7,
    modelTierLow: 0.35,
    modelTierHigh: 0.7,
  },
  session: {
    maxMessages: 12,
  },
  logging: {
    routingLog: false,
  },
  timeoutMs: 8000,
  // Overwritten by resolveBackends() at the end of resolveConfig; empty here
  // only to satisfy RouterConfig before that runs.
  backends: [],
};

const CLAUDE_MODEL_PRICING: Record<string, Pricing> = {
  haiku: { inputPer1M: 1, outputPer1M: 5 },
  sonnet: { inputPer1M: 3, outputPer1M: 15 },
  opus: { inputPer1M: 5, outputPer1M: 25 },
};

const FREE: Pricing = { inputPer1M: 0, outputPer1M: 0 };

/** Exported because the init wizard writes these same shapes (Task 12). */
export function defaultBackends(): Backend[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      kind: "exec",
      categories: ["code"],
      priority: 10,
      enabled: true,
      command: "claude",
      args: ["{model}", "{effort}", "{continue}", "{prompt}"],
      modelFlag: "--model",
      effortFlag: "--effort",
      continueFlag: "-c",
      supportsModelTier: true,
      supportsPlan: true,
      supportsContinue: true,
      modelPricing: { ...CLAUDE_MODEL_PRICING },
      strengths: "General-purpose agentic coding: multi-file edits, refactors, debugging, tests.",
      printArgs: ["-p", "{prompt}"],
    },
    {
      id: "local",
      label: "local model",
      kind: "chat",
      categories: ["simple-qa"],
      priority: 10,
      enabled: true,
      baseUrl: DEFAULTS.local.baseUrl,
      models: [DEFAULTS.local.model],
      probe: true,
      autoStart: true,
      autoStartCommand: ["lms", "server", "start"],
      pricing: { ...FREE },
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      kind: "chat",
      categories: ["simple-qa", "deep-qa"],
      priority: 5,
      enabled: true,
      baseUrl: DEFAULTS.openrouter.baseUrl,
      apiKeyEnv: "OPENROUTER_API_KEY",
      models: [...DEFAULTS.openrouter.answerModels],
      probe: false,
      autoStart: false,
      autoStartCommand: [],
      pricing: { ...FREE },
    },
  ];
}

const CATEGORIES: Category[] = ["code", "simple-qa", "deep-qa"];

function pickCategories(value: unknown, fallback: Category[]): Category[] {
  if (!Array.isArray(value)) return fallback;
  const picked = value.filter((v): v is Category =>
    typeof v === "string" && (CATEGORIES as string[]).includes(v),
  );
  return picked.length > 0 ? picked : fallback;
}

function pickPricing(value: unknown, fallback: Pricing): Pricing {
  if (!isRecord(value)) return fallback;
  const input = value["inputPer1M"];
  const output = value["outputPer1M"];
  return {
    inputPer1M: typeof input === "number" && input >= 0 ? input : fallback.inputPer1M,
    outputPer1M: typeof output === "number" && output >= 0 ? output : fallback.outputPer1M,
  };
}

function pickNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseBackend(raw: unknown): Backend | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw["id"] === "string" ? raw["id"] : "";
  if (!id) return null;
  const kind = raw["kind"];
  const label = pickString(raw["label"], id);
  const priority = pickNumber(raw["priority"], 0);
  const enabled = pickBoolean(raw["enabled"], true);

  if (kind === "exec") {
    const command = pickString(raw["command"], "");
    if (!command) return null;
    const args = pickStringArray(raw["args"], ["{prompt}"]);
    const modelPricing: Record<string, Pricing> = {};
    const rawPricing = raw["modelPricing"];
    if (isRecord(rawPricing)) {
      for (const [model, value] of Object.entries(rawPricing)) {
        modelPricing[model] = pickPricing(value, FREE);
      }
    }
    const strengths = typeof raw["strengths"] === "string" ? raw["strengths"] : undefined;
    const printArgs = pickStringArray(raw["printArgs"], []);
    return {
      id,
      label,
      kind: "exec",
      categories: pickCategories(raw["categories"], ["code"]),
      priority,
      enabled,
      command,
      args,
      modelFlag: pickString(raw["modelFlag"], "--model"),
      effortFlag: pickString(raw["effortFlag"], "--effort"),
      continueFlag: pickString(raw["continueFlag"], "-c"),
      supportsModelTier: pickBoolean(raw["supportsModelTier"], false),
      supportsPlan: pickBoolean(raw["supportsPlan"], false),
      supportsContinue: pickBoolean(raw["supportsContinue"], false),
      modelPricing,
      ...(strengths ? { strengths } : {}),
      ...(printArgs.length > 0 ? { printArgs } : {}),
    };
  }

  if (kind === "chat") {
    const baseUrl = pickString(raw["baseUrl"], "");
    if (!baseUrl) return null;
    const models = pickStringArray(raw["models"], []);
    if (models.length === 0) return null;
    const apiKeyEnv = typeof raw["apiKeyEnv"] === "string" ? raw["apiKeyEnv"] : undefined;
    return {
      id,
      label,
      kind: "chat",
      categories: pickCategories(raw["categories"], ["simple-qa", "deep-qa"]),
      priority,
      enabled,
      baseUrl,
      apiKeyEnv,
      models,
      probe: pickBoolean(raw["probe"], false),
      autoStart: pickBoolean(raw["autoStart"], false),
      autoStartCommand: pickStringArray(raw["autoStartCommand"], []),
      pricing: pickPricing(raw["pricing"], FREE),
    };
  }

  return null;
}

/**
 * Backends come from `backends` when present, otherwise they are derived from
 * the legacy `local` / `openrouter` blocks so an existing config keeps working
 * without an edit.
 */
function resolveBackends(file: Record<string, unknown>, cfg: RouterConfig): Backend[] {
  const declared = file["backends"];
  if (Array.isArray(declared)) {
    const parsed: Backend[] = [];
    for (const entry of declared) {
      const backend = parseBackend(entry);
      if (backend) parsed.push(backend);
      else process.stderr.write("prompt-router: skipping invalid backend entry in config.\n");
    }
    if (parsed.length > 0) return parsed;
  }

  const backends = defaultBackends();
  for (const backend of backends) {
    if (backend.kind !== "chat") continue;
    if (backend.id === "local") {
      backend.baseUrl = cfg.local.baseUrl;
      // The legacy `local.model` is singular; it becomes a one-element chain.
      backend.models = [cfg.local.model];
      backend.enabled = cfg.local.enabled;
      backend.autoStart = cfg.local.autoStart;
    } else if (backend.id === "openrouter") {
      backend.baseUrl = cfg.openrouter.baseUrl;
      backend.models = [...cfg.openrouter.answerModels];
    }
  }
  return backends;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickPositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function pickScore(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;
}

function pickStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === "string")
    ? value
    : fallback;
}

export function resolveConfig(fileCfg: unknown, env: NodeJS.ProcessEnv): RouterConfig {
  const cfg = structuredClone(DEFAULTS);
  const file = isRecord(fileCfg) ? fileCfg : {};

  const or = isRecord(file["openrouter"]) ? file["openrouter"] : {};
  cfg.openrouter.baseUrl = pickString(or["baseUrl"], cfg.openrouter.baseUrl);
  cfg.openrouter.classifierModels = pickStringArray(
    or["classifierModels"],
    cfg.openrouter.classifierModels,
  );
  cfg.openrouter.answerModels = pickStringArray(or["answerModels"], cfg.openrouter.answerModels);
  cfg.openrouter.planModels = pickStringArray(or["planModels"], cfg.openrouter.planModels);

  const local = isRecord(file["local"]) ? file["local"] : {};
  cfg.local.baseUrl = pickString(local["baseUrl"], cfg.local.baseUrl);
  cfg.local.model = pickString(local["model"], cfg.local.model);
  cfg.local.autoStart = pickBoolean(local["autoStart"], cfg.local.autoStart);
  cfg.local.enabled = pickBoolean(local["enabled"], cfg.local.enabled);

  const modelSelection = isRecord(file["modelSelection"]) ? file["modelSelection"] : {};
  cfg.modelSelection.enabled = pickBoolean(
    modelSelection["enabled"],
    cfg.modelSelection.enabled,
  );

  const orchestra = isRecord(file["orchestra"]) ? file["orchestra"] : {};
  cfg.orchestra.enabled = pickBoolean(orchestra["enabled"], cfg.orchestra.enabled);
  cfg.orchestra.complexityThreshold = pickScore(
    orchestra["complexityThreshold"],
    cfg.orchestra.complexityThreshold,
  );
  cfg.orchestra.maxFixRounds = pickPositive(orchestra["maxFixRounds"], cfg.orchestra.maxFixRounds);
  cfg.orchestra.decompose = pickBoolean(orchestra["decompose"], cfg.orchestra.decompose);

  const thresholds = isRecord(file["thresholds"]) ? file["thresholds"] : {};
  cfg.thresholds.confidence = pickScore(thresholds["confidence"], cfg.thresholds.confidence);
  cfg.thresholds.planComplexity = pickScore(
    thresholds["planComplexity"],
    cfg.thresholds.planComplexity,
  );
  cfg.thresholds.modelTierLow = pickScore(thresholds["modelTierLow"], cfg.thresholds.modelTierLow);
  cfg.thresholds.modelTierHigh = pickScore(
    thresholds["modelTierHigh"],
    cfg.thresholds.modelTierHigh,
  );

  const session = isRecord(file["session"]) ? file["session"] : {};
  cfg.session.maxMessages = pickPositive(session["maxMessages"], cfg.session.maxMessages);

  const logging = isRecord(file["logging"]) ? file["logging"] : {};
  cfg.logging.routingLog = pickBoolean(logging["routingLog"], cfg.logging.routingLog);

  cfg.timeoutMs = pickPositive(file["timeoutMs"], cfg.timeoutMs);

  // Environment overrides beat the file.
  if (env.OPENROUTER_API_KEY) cfg.openrouter.apiKey = env.OPENROUTER_API_KEY;
  if (env.PROMPT_ROUTER_LOCAL_URL) cfg.local.baseUrl = env.PROMPT_ROUTER_LOCAL_URL;
  if (env.PROMPT_ROUTER_LOCAL_MODEL) cfg.local.model = env.PROMPT_ROUTER_LOCAL_MODEL;
  if (env.PROMPT_ROUTER_TIMEOUT) {
    cfg.timeoutMs = pickPositive(Number.parseInt(env.PROMPT_ROUTER_TIMEOUT, 10), cfg.timeoutMs);
  }

  // Env overrides have already been folded into cfg.local, so deriving the
  // backends last means the local backend inherits them.
  cfg.backends = resolveBackends(file, cfg);

  // ...but only along the legacy path, which is the one that reads cfg.local.
  // A config that declares `backends` skips it, so the override has to be
  // re-applied to the resolved backend directly — otherwise the two documented
  // env vars would silently stop working the moment a config gained a
  // `backends` array, which is what the setup wizard now writes for everyone.
  const localBackend = cfg.backends.find(
    (b): b is ChatBackend => b.kind === "chat" && b.id === "local",
  );
  if (localBackend) {
    if (env.PROMPT_ROUTER_LOCAL_URL) localBackend.baseUrl = env.PROMPT_ROUTER_LOCAL_URL;
    // Singular by nature: an override names one model, replacing the chain.
    if (env.PROMPT_ROUTER_LOCAL_MODEL) localBackend.models = [env.PROMPT_ROUTER_LOCAL_MODEL];
  }

  return cfg;
}

export function configDir(): string {
  return process.env.PROMPT_ROUTER_DIR ?? path.join(os.homedir(), ".config", "prompt-router");
}

export function loadConfig(): RouterConfig {
  const dir = configDir();
  // Global install reads ~/.config/prompt-router/.env first; cwd/.env covers local dev.
  loadDotenv({ path: path.join(dir, ".env") });
  loadDotenv();

  let fileCfg: unknown;
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  } catch {
    fileCfg = undefined;
  }
  return resolveConfig(fileCfg, process.env);
}
