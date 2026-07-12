import { config as loadDotenv } from "dotenv";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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
  thresholds: {
    confidence: number;
    planComplexity: number;
  };
  session: {
    maxMessages: number;
  };
  logging: {
    routingLog: boolean;
  };
  timeoutMs: number;
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
  thresholds: {
    confidence: 0.6,
    planComplexity: 0.7,
  },
  session: {
    maxMessages: 12,
  },
  logging: {
    routingLog: false,
  },
  timeoutMs: 8000,
};

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

  const thresholds = isRecord(file["thresholds"]) ? file["thresholds"] : {};
  cfg.thresholds.confidence = pickScore(thresholds["confidence"], cfg.thresholds.confidence);
  cfg.thresholds.planComplexity = pickScore(
    thresholds["planComplexity"],
    cfg.thresholds.planComplexity,
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
