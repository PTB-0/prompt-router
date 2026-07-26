# Backend Registry & Cost Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three hard-coded route targets with a config-defined registry of backends carrying capability manifests, and use that manifest pricing to report real spend and counterfactual savings in `--stats`.

**Architecture:** Backends are plain tagged-union data (`kind: "chat" | "exec"`) declared in `config.json`; pure functions select candidates by category and priority; a `dispatch` module switches on `kind`. `route.ts` stops naming a target and returns a category decision instead. Token usage captured from API responses feeds a cost module that computes both actual spend and a counterfactual "what this would have cost on Claude" figure.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥ 20, vitest, pnpm. Dependencies: `dotenv`, `picocolors` only — do not add any.

## Global Constraints

- **No `any`.** `tsconfig.json` sets `strict: true` and `noUncheckedIndexedAccess: true`. Indexed access (`arr[0]`, `rec[key]`) yields `T | undefined` — narrow it. `exactOptionalPropertyTypes` is off, so assigning `string | undefined` to `foo?: string` is legal.
- **Package manager is pnpm.** `pnpm test`, `pnpm typecheck`, `pnpm build`.
- **ESM imports need the `.js` extension** in relative specifiers (`./config.js`), even from `.ts` files.
- **Prompt content is never logged.** No new field may carry prompt or response text into `stats.json` or the routing log. Numeric aggregates only.
- **Reference pricing (USD per 1M tokens), verified 2026-07-26:** `haiku` $1.00 in / $5.00 out; `sonnet` $3.00 in / $15.00 out; `opus` $5.00 in / $25.00 out.
- **Backward compatibility is mandatory:** a `config.json` with no `backends` key must keep working unchanged.
- **When a step says "append to" an existing test file, merge the import lines** — do not paste a second `import { x } from "../src/y.js"` for a module the file already imports. A repeated binding name is a hard syntax error (`Identifier 'x' has already been declared`).
- Every task ends with a commit. Run `pnpm test` before each commit.

---

### Task 1: Backend types and config schema with legacy migration

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BackendKind`, `Pricing`, `ChatBackend`, `ExecBackend`, `Backend`, `CategoryDecision`, `Dispatch`, `TokenUsage` (all from `src/types.js`); `RouterConfig.backends: Backend[]` from `src/config.js`.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.ts` (keep every existing test):

```typescript
import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config.js";
import type { ChatBackend, ExecBackend } from "../src/types.js";

function chat(cfg: ReturnType<typeof resolveConfig>, id: string): ChatBackend {
  const found = cfg.backends.find((b) => b.id === id);
  if (!found || found.kind !== "chat") throw new Error(`no chat backend ${id}`);
  return found;
}

function exec(cfg: ReturnType<typeof resolveConfig>, id: string): ExecBackend {
  const found = cfg.backends.find((b) => b.id === id);
  if (!found || found.kind !== "exec") throw new Error(`no exec backend ${id}`);
  return found;
}

describe("backend registry config", () => {
  test("an empty config yields the three default backends", () => {
    const cfg = resolveConfig({}, {});
    expect(cfg.backends.map((b) => b.id)).toEqual(["claude", "local", "openrouter"]);
    expect(exec(cfg, "claude").supportsPlan).toBe(true);
    expect(chat(cfg, "local").categories).toEqual(["simple-qa"]);
    expect(chat(cfg, "openrouter").categories).toEqual(["simple-qa", "deep-qa"]);
  });

  test("claude carries reference pricing for every tier", () => {
    const pricing = exec(resolveConfig({}, {}), "claude").modelPricing;
    expect(pricing["haiku"]).toEqual({ inputPer1M: 1, outputPer1M: 5 });
    expect(pricing["sonnet"]).toEqual({ inputPer1M: 3, outputPer1M: 15 });
    expect(pricing["opus"]).toEqual({ inputPer1M: 5, outputPer1M: 25 });
  });

  test("legacy local block is derived into the local backend", () => {
    const cfg = resolveConfig(
      { local: { baseUrl: "http://x:1/v1", model: "m", enabled: false, autoStart: false } },
      {},
    );
    const local = chat(cfg, "local");
    expect(local.baseUrl).toBe("http://x:1/v1");
    expect(local.models).toEqual(["m"]);
    expect(local.enabled).toBe(false);
    expect(local.autoStart).toBe(false);
  });

  test("legacy answerModels become the openrouter backend chain", () => {
    const cfg = resolveConfig({ openrouter: { answerModels: ["a", "b"] } }, {});
    expect(chat(cfg, "openrouter").models).toEqual(["a", "b"]);
  });

  test("an explicit backends array replaces the defaults", () => {
    const cfg = resolveConfig(
      {
        backends: [
          { id: "aider", kind: "exec", command: "aider", args: ["--message", "{prompt}"] },
        ],
      },
      {},
    );
    expect(cfg.backends.map((b) => b.id)).toEqual(["aider"]);
    const aider = exec(cfg, "aider");
    expect(aider.args).toEqual(["--message", "{prompt}"]);
    expect(aider.supportsPlan).toBe(false);
    expect(aider.supportsModelTier).toBe(false);
    expect(aider.enabled).toBe(true);
  });

  test("an invalid backend entry is skipped, the rest survive", () => {
    const cfg = resolveConfig(
      {
        backends: [
          { id: "", kind: "exec", command: "x", args: [] },
          { id: "nokind", command: "x", args: [] },
          { id: "ok", kind: "exec", command: "ok", args: ["{prompt}"] },
        ],
      },
      {},
    );
    expect(cfg.backends.map((b) => b.id)).toEqual(["ok"]);
  });

  test("env overrides apply to the local backend", () => {
    const cfg = resolveConfig(
      {},
      { PROMPT_ROUTER_LOCAL_URL: "http://env:9/v1", PROMPT_ROUTER_LOCAL_MODEL: "envmodel" },
    );
    const local = chat(cfg, "local");
    expect(local.baseUrl).toBe("http://env:9/v1");
    expect(local.models).toEqual(["envmodel"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/config.test.ts`
Expected: FAIL — `cfg.backends` is undefined / not a property of `RouterConfig`.

- [ ] **Step 3: Add the backend types**

Append to `src/types.ts` (keep everything already there; `RouteTarget` stays for now and is removed in Task 11):

```typescript
export type BackendKind = "chat" | "exec";

export interface Pricing {
  /** USD per 1M input tokens. 0 = free. */
  inputPer1M: number;
  /** USD per 1M output tokens. 0 = free. */
  outputPer1M: number;
}

interface BackendBase {
  id: string;
  label: string;
  categories: Category[];
  priority: number;
  enabled: boolean;
}

export interface ChatBackend extends BackendBase {
  kind: "chat";
  baseUrl: string;
  /** NAME of the env var holding the key — never the key itself. */
  apiKeyEnv?: string;
  /** Internal model fallback chain. */
  models: string[];
  /** Probe /models before dispatching. False for remote providers. */
  probe: boolean;
  autoStart: boolean;
  /** Command run when the probe fails and autoStart is true. */
  autoStartCommand: string[];
  pricing: Pricing;
}

export interface ExecBackend extends BackendBase {
  kind: "exec";
  command: string;
  /** Template. {prompt} {model} {effort} {continue} expand; other tokens pass through. */
  args: string[];
  modelFlag: string;
  effortFlag: string;
  continueFlag: string;
  supportsModelTier: boolean;
  supportsPlan: boolean;
  supportsContinue: boolean;
  /** Reference prices per model name, used for the counterfactual figure. */
  modelPricing: Record<string, Pricing>;
}

export type Backend = ChatBackend | ExecBackend;

/** What the router decides before a backend is picked. */
export interface CategoryDecision {
  category: Category;
  /** Plan-first is eligible; the selected backend must also support it. */
  planFirst: boolean;
  uncertain: boolean;
}

/** A resolved decision: which backend runs, and what follows it if it fails. */
export interface Dispatch {
  backend: Backend;
  fallbacks: Backend[];
  planFirst: boolean;
  uncertain: boolean;
  model?: string;
  effort?: EffortLevel;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** True when the counts came from a char/4 estimate rather than the API. */
  estimated: boolean;
}
```

- [ ] **Step 4: Add backend resolution to the config**

In `src/config.ts`, add the import, extend `RouterConfig`, and add the resolution code. Keep every existing field and helper.

```typescript
import type { Backend, Category, ChatBackend, ExecBackend, Pricing } from "./types.js";
```

Add to the `RouterConfig` interface:

```typescript
  backends: Backend[];
```

Add after `DEFAULTS`:

```typescript
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
```

Then, at the very end of `resolveConfig`, immediately **before** `return cfg;`, add:

```typescript
  // Env overrides have already been folded into cfg.local, so deriving the
  // backends last means the local backend inherits them.
  cfg.backends = resolveBackends(file, cfg);
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run test/config.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts test/config.test.ts
git commit -m "feat: add backend registry types and config schema"
```

---

### Task 2: Candidate selection

**Files:**
- Create: `src/backends.ts`
- Test: `test/backends.test.ts`

**Interfaces:**
- Consumes: `Backend`, `ChatBackend`, `ExecBackend`, `Category` from `src/types.js`.
- Produces: `selectCandidates(category: Category, backends: readonly Backend[]): Backend[]` and `findHandoffBackend(backends: readonly Backend[]): ExecBackend | null` from `src/backends.js`.

- [ ] **Step 1: Write the failing test**

Create `test/backends.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { findHandoffBackend, selectCandidates } from "../src/backends.js";
import type { Backend, ChatBackend, ExecBackend } from "../src/types.js";

function chat(over: Partial<ChatBackend> & { id: string }): ChatBackend {
  return {
    label: over.id,
    kind: "chat",
    categories: ["simple-qa"],
    priority: 0,
    enabled: true,
    baseUrl: "http://x/v1",
    models: ["m"],
    probe: false,
    autoStart: false,
    autoStartCommand: [],
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    ...over,
  };
}

function exec(over: Partial<ExecBackend> & { id: string }): ExecBackend {
  return {
    label: over.id,
    kind: "exec",
    categories: ["code"],
    priority: 0,
    enabled: true,
    command: over.id,
    args: ["{prompt}"],
    modelFlag: "--model",
    effortFlag: "--effort",
    continueFlag: "-c",
    supportsModelTier: false,
    supportsPlan: false,
    supportsContinue: false,
    modelPricing: {},
    ...over,
  };
}

describe("selectCandidates", () => {
  test("orders matching backends by descending priority", () => {
    const backends: Backend[] = [
      chat({ id: "low", priority: 1 }),
      chat({ id: "high", priority: 10 }),
      chat({ id: "mid", priority: 5 }),
    ];
    expect(selectCandidates("simple-qa", backends).map((b) => b.id)).toEqual([
      "high",
      "mid",
      "low",
    ]);
  });

  test("drops backends that do not serve the category", () => {
    const backends: Backend[] = [chat({ id: "a" }), exec({ id: "b", categories: ["code"] })];
    expect(selectCandidates("simple-qa", backends).map((b) => b.id)).toEqual(["a"]);
  });

  test("drops disabled backends so the next candidate serves", () => {
    const backends: Backend[] = [
      chat({ id: "local", priority: 10, enabled: false }),
      chat({ id: "openrouter", priority: 5 }),
    ];
    expect(selectCandidates("simple-qa", backends).map((b) => b.id)).toEqual(["openrouter"]);
  });

  test("equal priorities keep config order", () => {
    const backends: Backend[] = [
      chat({ id: "first", priority: 5 }),
      chat({ id: "second", priority: 5 }),
    ];
    expect(selectCandidates("simple-qa", backends).map((b) => b.id)).toEqual([
      "first",
      "second",
    ]);
  });

  test("no candidate yields an empty list", () => {
    expect(selectCandidates("code", [chat({ id: "a" })])).toEqual([]);
  });
});

describe("findHandoffBackend", () => {
  test("returns the highest-priority enabled exec backend", () => {
    const backends: Backend[] = [
      chat({ id: "local" }),
      exec({ id: "aider", priority: 1 }),
      exec({ id: "claude", priority: 10 }),
    ];
    expect(findHandoffBackend(backends)?.id).toBe("claude");
  });

  test("ignores disabled exec backends", () => {
    const backends: Backend[] = [exec({ id: "claude", priority: 10, enabled: false })];
    expect(findHandoffBackend(backends)).toBeNull();
  });

  test("returns null when there is no exec backend at all", () => {
    expect(findHandoffBackend([chat({ id: "local" })])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/backends.test.ts`
Expected: FAIL — cannot resolve `../src/backends.js`.

- [ ] **Step 3: Write the implementation**

Create `src/backends.ts`:

```typescript
import type { Backend, Category, ExecBackend } from "./types.js";

/**
 * Ordered candidates for a category: the head is the target, the tail is the
 * fallback chain. Ties keep config order so the choice is deterministic.
 */
export function selectCandidates(category: Category, backends: readonly Backend[]): Backend[] {
  return backends
    .map((backend, index) => ({ backend, index }))
    .filter(({ backend }) => backend.enabled && backend.categories.includes(category))
    .sort((a, b) => b.backend.priority - a.backend.priority || a.index - b.index)
    .map(({ backend }) => backend);
}

/**
 * The backend every chat failure ultimately hands off to — the strongest
 * agentic one, since a hand-off must not land somewhere weaker.
 */
export function findHandoffBackend(backends: readonly Backend[]): ExecBackend | null {
  let best: ExecBackend | null = null;
  for (const backend of backends) {
    if (backend.kind !== "exec" || !backend.enabled) continue;
    if (best === null || backend.priority > best.priority) best = backend;
  }
  return best;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/backends.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends.ts test/backends.test.ts
git commit -m "feat: add category-based backend candidate selection"
```

---

### Task 3: Exec argument templates

**Files:**
- Create: `src/execArgs.ts`
- Delete: `src/claudeArgs.ts`
- Create: `test/execArgs.test.ts`
- Delete: `test/claudeArgs.test.ts`

**Interfaces:**
- Consumes: `ExecBackend`, `EffortLevel` from `src/types.js`.
- Produces: `ExecArgContext` and `buildExecArgs(backend: ExecBackend, ctx: ExecArgContext): string[]` from `src/execArgs.js`.

- [ ] **Step 1: Write the failing test**

Create `test/execArgs.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { buildExecArgs } from "../src/execArgs.js";
import type { ExecBackend } from "../src/types.js";

function exec(over: Partial<ExecBackend> = {}): ExecBackend {
  return {
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
    modelPricing: {},
    ...over,
  };
}

describe("buildExecArgs", () => {
  test("bare prompt when nothing else is set", () => {
    expect(buildExecArgs(exec(), { prompt: "hi", continueSession: false })).toEqual(["hi"]);
  });

  test("model and effort expand to flag pairs", () => {
    expect(
      buildExecArgs(exec(), {
        prompt: "hi",
        continueSession: false,
        model: "opus",
        effort: "high",
      }),
    ).toEqual(["--model", "opus", "--effort", "high", "hi"]);
  });

  test("continue expands to the configured flag", () => {
    expect(buildExecArgs(exec(), { prompt: "hi", continueSession: true })).toEqual(["-c", "hi"]);
  });

  test("continue is dropped when the backend does not support it", () => {
    const backend = exec({ supportsContinue: false });
    expect(buildExecArgs(backend, { prompt: "hi", continueSession: true })).toEqual(["hi"]);
  });

  test("literal tokens pass through and a prompt with spaces stays one argument", () => {
    const aider = exec({
      id: "aider",
      command: "aider",
      args: ["--message", "{prompt}"],
      supportsModelTier: false,
      supportsPlan: false,
      supportsContinue: false,
    });
    expect(
      buildExecArgs(aider, { prompt: "fix the login bug", continueSession: true, model: "opus" }),
    ).toEqual(["--message", "fix the login bug"]);
  });

  test("custom flag names are honoured", () => {
    const gemini = exec({ id: "gemini", command: "gemini", modelFlag: "-m" });
    expect(
      buildExecArgs(gemini, { prompt: "hi", continueSession: false, model: "pro" }),
    ).toEqual(["-m", "pro", "hi"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/execArgs.test.ts`
Expected: FAIL — cannot resolve `../src/execArgs.js`.

- [ ] **Step 3: Write the implementation and remove the old module**

Create `src/execArgs.ts`:

```typescript
import type { EffortLevel, ExecBackend } from "./types.js";

export interface ExecArgContext {
  prompt: string;
  continueSession: boolean;
  model?: string;
  effort?: EffortLevel;
}

/**
 * Expands a backend's argument template. A placeholder with nothing to say
 * expands to zero arguments, so an unset model never leaves a dangling flag.
 */
export function buildExecArgs(backend: ExecBackend, ctx: ExecArgContext): string[] {
  const out: string[] = [];
  for (const token of backend.args) {
    switch (token) {
      case "{prompt}":
        out.push(ctx.prompt);
        break;
      case "{model}":
        if (ctx.model) out.push(backend.modelFlag, ctx.model);
        break;
      case "{effort}":
        if (ctx.effort) out.push(backend.effortFlag, ctx.effort);
        break;
      case "{continue}":
        if (ctx.continueSession && backend.supportsContinue) out.push(backend.continueFlag);
        break;
      default:
        out.push(token);
    }
  }
  return out;
}
```

Then delete the superseded module and its test:

```bash
git rm src/claudeArgs.ts test/claudeArgs.test.ts
```

`src/index.ts` still imports `buildClaudeArgs` and will not compile until Task 11. That is expected — do not patch `index.ts` here.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/execArgs.test.ts`
Expected: PASS. (`pnpm typecheck` fails on `src/index.ts`'s stale import — that is resolved in Task 11.)

- [ ] **Step 5: Commit**

```bash
git add src/execArgs.ts test/execArgs.test.ts
git commit -m "feat: generalize claude args into exec arg templates"
```

---

### Task 4: Route decision returns a category

**Files:**
- Modify: `src/route.ts`
- Modify: `test/route.test.ts`

**Interfaces:**
- Consumes: `CategoryDecision`, `Category`, `Classification` from `src/types.js`.
- Produces: `RouteOptions { confidenceThreshold: number; planComplexityThreshold: number }` and `decideRoute(cls: Classification | null, heuristic: Category | null, opts: RouteOptions): CategoryDecision` from `src/route.js`.

- [ ] **Step 1: Rewrite the test**

Replace the whole of `test/route.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { decideRoute } from "../src/route.js";
import type { Classification } from "../src/types.js";

const opts = { confidenceThreshold: 0.6, planComplexityThreshold: 0.7 };

function cls(partial: Partial<Classification>): Classification {
  return {
    optimizedPrompt: "p",
    category: "simple-qa",
    complexity: 0.2,
    confidence: 0.9,
    ...partial,
  };
}

describe("decideRoute", () => {
  test("no signal at all falls back to a question, not a code task", () => {
    expect(decideRoute(null, null, opts)).toEqual({
      category: "deep-qa",
      planFirst: false,
      uncertain: true,
    });
  });

  test("a confident non-code classification beats a heuristic code verdict", () => {
    expect(decideRoute(cls({ category: "simple-qa", confidence: 0.9 }), "code", opts).category).toBe(
      "simple-qa",
    );
    expect(decideRoute(cls({ category: "deep-qa", confidence: 0.8 }), "code", opts).category).toBe(
      "deep-qa",
    );
  });

  test("heuristic code verdict wins when the classifier is unsure", () => {
    const decision = decideRoute(cls({ category: "simple-qa", confidence: 0.4 }), "code", opts);
    expect(decision.category).toBe("code");
    expect(decision.uncertain).toBe(true);
  });

  test("complex code task is eligible for the plan-first pipeline", () => {
    expect(decideRoute(cls({ category: "code", complexity: 0.9 }), null, opts)).toEqual({
      category: "code",
      planFirst: true,
      uncertain: false,
    });
  });

  test("trivial code task skips the plan", () => {
    expect(decideRoute(cls({ category: "code", complexity: 0.3 }), "code", opts)).toEqual({
      category: "code",
      planFirst: false,
      uncertain: false,
    });
  });

  test("a complex question is never plan-first", () => {
    expect(decideRoute(cls({ category: "deep-qa", complexity: 0.9 }), null, opts).planFirst).toBe(
      false,
    );
  });

  test("confident simple question stays simple-qa", () => {
    expect(decideRoute(cls({}), "simple-qa", opts).category).toBe("simple-qa");
  });

  test("low classifier confidence is flagged uncertain", () => {
    expect(decideRoute(cls({ confidence: 0.4 }), null, opts).uncertain).toBe(true);
  });

  test("heuristic-only code decision is not uncertain", () => {
    expect(decideRoute(null, "code", opts)).toEqual({
      category: "code",
      planFirst: false,
      uncertain: false,
    });
  });

  test("heuristic-only simple question when the classifier is down", () => {
    expect(decideRoute(null, "simple-qa", opts)).toEqual({
      category: "simple-qa",
      planFirst: false,
      uncertain: false,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/route.test.ts`
Expected: FAIL — the returned object has `target`, not `category`.

- [ ] **Step 3: Rewrite the implementation**

Replace the whole of `src/route.ts`:

```typescript
import type { Category, CategoryDecision, Classification } from "./types.js";

export interface RouteOptions {
  confidenceThreshold: number;
  planComplexityThreshold: number;
}

function resolveCategory(
  cls: Classification | null,
  heuristic: Category | null,
  uncertain: boolean,
): Category {
  // A confident classification is the best signal we have; the regex heuristic
  // only decides when the classifier is missing or unsure.
  if (cls && !uncertain) return cls.category;

  // Among weak signals, a code verdict from either side wins: misrouting a
  // code task to a small chat model is far worse than over-serving a question.
  if (heuristic === "code" || cls?.category === "code") return "code";

  if (cls) return cls.category;
  return heuristic ?? "deep-qa"; // heuristic is non-null here; ?? satisfies the type system
}

export function decideRoute(
  cls: Classification | null,
  heuristic: Category | null,
  opts: RouteOptions,
): CategoryDecision {
  if (!cls && !heuristic) {
    // No signal at all: treat it as a question. Agentic backends are reserved
    // for code; the chat fallback chain still ends at one if every answer
    // backend is unreachable, so nothing is lost.
    return { category: "deep-qa", planFirst: false, uncertain: true };
  }

  const uncertain = cls !== null && cls.confidence < opts.confidenceThreshold;
  const category = resolveCategory(cls, heuristic, uncertain);

  return {
    category,
    planFirst:
      category === "code" && cls !== null && cls.complexity >= opts.planComplexityThreshold,
    uncertain,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/route.ts test/route.test.ts
git commit -m "refactor: decideRoute returns a category decision, not a target"
```

---

### Task 5: Capture token usage from the API

**Files:**
- Modify: `src/llm.ts`
- Modify: `test/llm.test.ts`

**Interfaces:**
- Consumes: `TokenUsage` from `src/types.js`.
- Produces: `ChatRequest.onUsage?: (usage: TokenUsage) => void`; `extractSseDeltas(buffer: string): { deltas: string[]; usage: TokenUsage | null; rest: string }` from `src/llm.js`. `chatCompletion` and `streamChat` keep their existing signatures and return types.

- [ ] **Step 1: Write the failing test**

Append to `test/llm.test.ts` (keep the existing tests; update any that assert on `extractSseDeltas`'s exact return shape to also expect `usage`):

```typescript
import { describe, expect, test } from "vitest";
import { chatCompletion, extractSseDeltas, streamChat } from "../src/llm.js";
import type { TokenUsage } from "../src/types.js";

describe("usage capture", () => {
  test("extractSseDeltas surfaces a trailing usage event", () => {
    const buffer =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n';
    const { deltas, usage } = extractSseDeltas(buffer);
    expect(deltas).toEqual(["hi"]);
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 34, estimated: false });
  });

  test("extractSseDeltas reports null usage when the stream omits it", () => {
    const { usage } = extractSseDeltas('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    expect(usage).toBeNull();
  });

  test("chatCompletion reports usage from the response body", async () => {
    const seen: TokenUsage[] = [];
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const text = await chatCompletion({
      baseUrl: "http://x/v1",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
      fetchImpl,
      onUsage: (usage) => seen.push(usage),
    });

    expect(text).toBe("ok");
    expect(seen).toEqual([{ inputTokens: 5, outputTokens: 7, estimated: false }]);
  });

  test("streamChat reports usage captured from the stream", async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\n' +
      "data: [DONE]\n\n";
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const seen: TokenUsage[] = [];
    const text = await streamChat(
      {
        baseUrl: "http://x/v1",
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 1000,
        fetchImpl,
        onUsage: (usage) => seen.push(usage),
      },
      () => {},
    );

    expect(text).toBe("hi");
    expect(seen).toEqual([{ inputTokens: 3, outputTokens: 4, estimated: false }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/llm.test.ts`
Expected: FAIL — `onUsage` is not a property of `ChatRequest`; `extractSseDeltas` returns no `usage`.

- [ ] **Step 3: Write the implementation**

In `src/llm.ts`, add the import, a usage parser, and the wiring. Keep everything else as it is.

```typescript
import type { TokenUsage } from "./types.js";
```

Add to the `ChatRequest` interface:

```typescript
  /** Called with exact token counts when the provider reports them. */
  onUsage?: (usage: TokenUsage) => void;
```

Add next to `messageContent`:

```typescript
function usageFrom(data: unknown): TokenUsage | null {
  if (typeof data !== "object" || data === null) return null;
  const usage = (data as Record<string, unknown>)["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const input = record["prompt_tokens"];
  const output = record["completion_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return null;
  return { inputTokens: input, outputTokens: output, estimated: false };
}
```

Change `extractSseDeltas` to collect usage as well — the signature becomes:

```typescript
export function extractSseDeltas(buffer: string): {
  deltas: string[];
  usage: TokenUsage | null;
  rest: string;
} {
  const deltas: string[] = [];
  let usage: TokenUsage | null = null;
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
      // Providers emit usage on a trailing event; the last one wins.
      const eventUsage = usageFrom(parsed);
      if (eventUsage) usage = eventUsage;
    }
  }
  return { deltas, usage, rest };
}
```

In `chatCompletion`, replace `return messageContent(await response.json());` with:

```typescript
    const data: unknown = await response.json();
    const usage = usageFrom(data);
    if (usage) req.onUsage?.(usage);
    return messageContent(data);
```

In `streamChat`, add `stream_options` to the request body (right after `stream: true`):

```typescript
        stream_options: { include_usage: true },
```

…declare a local before the read loop:

```typescript
    let streamUsage: TokenUsage | null = null;
```

…update the destructuring inside the loop and record usage:

```typescript
      const { deltas, usage, rest } = extractSseDeltas(buffer);
      buffer = rest;
      if (usage) streamUsage = usage;
```

…and report it just before `return full || null;`:

```typescript
    if (streamUsage) req.onUsage?.(streamUsage);
    return full || null;
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/llm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/llm.ts test/llm.test.ts
git commit -m "feat: capture token usage from chat and stream responses"
```

---

### Task 6: Cost and counterfactual computation

**Files:**
- Create: `src/cost.ts`
- Create: `test/cost.test.ts`

**Interfaces:**
- Consumes: `TokenUsage`, `Pricing`, `ExecBackend`, `ModelTier` from `src/types.js`.
- Produces: `estimateTokens(text: string): number`, `estimateUsage(prompt: string): TokenUsage`, `costOf(usage: TokenUsage, pricing: Pricing): number`, `referencePricing(backend: ExecBackend | null, tier: ModelTier | null): Pricing | null` from `src/cost.js`.

- [ ] **Step 1: Write the failing test**

Create `test/cost.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { costOf, estimateTokens, estimateUsage, referencePricing } from "../src/cost.js";
import type { ExecBackend } from "../src/types.js";

const claude: ExecBackend = {
  id: "claude",
  label: "Claude Code",
  kind: "exec",
  categories: ["code"],
  priority: 10,
  enabled: true,
  command: "claude",
  args: ["{prompt}"],
  modelFlag: "--model",
  effortFlag: "--effort",
  continueFlag: "-c",
  supportsModelTier: true,
  supportsPlan: true,
  supportsContinue: true,
  modelPricing: {
    haiku: { inputPer1M: 1, outputPer1M: 5 },
    sonnet: { inputPer1M: 3, outputPer1M: 15 },
    opus: { inputPer1M: 5, outputPer1M: 25 },
  },
};

describe("estimateTokens", () => {
  test("approximates four characters per token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("estimateUsage marks the result as estimated with no output tokens", () => {
    expect(estimateUsage("abcdefgh")).toEqual({
      inputTokens: 2,
      outputTokens: 0,
      estimated: true,
    });
  });
});

describe("costOf", () => {
  test("prices input and output separately", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, estimated: false };
    expect(costOf(usage, { inputPer1M: 3, outputPer1M: 15 })).toBeCloseTo(18, 10);
  });

  test("a free model costs nothing", () => {
    const usage = { inputTokens: 500_000, outputTokens: 500_000, estimated: false };
    expect(costOf(usage, { inputPer1M: 0, outputPer1M: 0 })).toBe(0);
  });

  test("partial millions scale linearly", () => {
    const usage = { inputTokens: 250_000, outputTokens: 0, estimated: false };
    expect(costOf(usage, { inputPer1M: 4, outputPer1M: 0 })).toBeCloseTo(1, 10);
  });
});

describe("referencePricing", () => {
  test("prices a cheap prompt at the haiku tier and a heavy one at opus", () => {
    expect(referencePricing(claude, { model: "haiku", effort: "low" })).toEqual({
      inputPer1M: 1,
      outputPer1M: 5,
    });
    expect(referencePricing(claude, { model: "opus", effort: "high" })).toEqual({
      inputPer1M: 5,
      outputPer1M: 25,
    });
  });

  test("falls back to the sonnet tier when no tier was selected", () => {
    expect(referencePricing(claude, null)).toEqual({ inputPer1M: 3, outputPer1M: 15 });
  });

  test("returns null when the backend has no pricing for the tier", () => {
    const bare: ExecBackend = { ...claude, modelPricing: {} };
    expect(referencePricing(bare, { model: "opus", effort: "high" })).toBeNull();
    expect(referencePricing(null, { model: "opus", effort: "high" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/cost.test.ts`
Expected: FAIL — cannot resolve `../src/cost.js`.

- [ ] **Step 3: Write the implementation**

Create `src/cost.ts`:

```typescript
import type { ExecBackend, ModelTier, Pricing, TokenUsage } from "./types.js";

const CHARS_PER_TOKEN = 4;
/** The tier a prompt is valued at when no tier was selected. */
const DEFAULT_REFERENCE_MODEL = "sonnet";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Fallback for exec backends and providers that report no usage: the input is
 * approximated from its length, and output is unobservable once the terminal
 * is handed over, so it counts as zero rather than as a guess.
 */
export function estimateUsage(prompt: string): TokenUsage {
  return { inputTokens: estimateTokens(prompt), outputTokens: 0, estimated: true };
}

export function costOf(usage: TokenUsage, pricing: Pricing): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

/**
 * The price the counterfactual is valued at: whatever tier this prompt would
 * have run on. Pricing a trivial question at the top tier would inflate the
 * savings figure, so the tier the router actually picked is used.
 */
export function referencePricing(
  backend: ExecBackend | null,
  tier: ModelTier | null,
): Pricing | null {
  if (!backend) return null;
  const model = tier?.model ?? DEFAULT_REFERENCE_MODEL;
  return backend.modelPricing[model] ?? null;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/cost.test.ts && pnpm vitest run test/backends.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cost.ts test/cost.test.ts
git commit -m "feat: add token cost and counterfactual pricing"
```

---

### Task 7: Stats v2 with per-backend totals and savings

**Files:**
- Modify: `src/stats.ts`
- Modify: `test/stats.test.ts`

**Interfaces:**
- Consumes: `Backend`, `Category`, `TokenUsage` from `src/types.js`.
- Produces: `BackendStats`, `Stats`, `DispatchRecord`, `loadStats(dir: string): Stats`, `recordDispatch(dir: string, record: DispatchRecord): void`, `formatStats(stats: Stats, backends: readonly Backend[]): string` from `src/stats.js`.

- [ ] **Step 1: Rewrite the test**

Replace the whole of `test/stats.test.ts`:

```typescript
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatStats, loadStats, recordDispatch } from "../src/stats.js";
import type { Backend } from "../src/types.js";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-router-stats-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const backends: Backend[] = [
  {
    id: "claude",
    label: "Claude Code",
    kind: "exec",
    categories: ["code"],
    priority: 10,
    enabled: true,
    command: "claude",
    args: ["{prompt}"],
    modelFlag: "--model",
    effortFlag: "--effort",
    continueFlag: "-c",
    supportsModelTier: true,
    supportsPlan: true,
    supportsContinue: true,
    modelPricing: {},
  },
];

describe("stats v2", () => {
  test("a missing file starts from an empty v2 record", () => {
    const stats = loadStats(dir);
    expect(stats.version).toBe(2);
    expect(stats.backends).toEqual({});
    expect(stats.saved).toEqual({ tokens: 0, usd: 0 });
  });

  test("a corrupt file starts from zero instead of throwing", () => {
    fs.writeFileSync(path.join(dir, "stats.json"), "{not json", "utf8");
    expect(loadStats(dir).version).toBe(2);
  });

  test("a v1 file migrates with its counts preserved and no invented tokens", () => {
    fs.writeFileSync(
      path.join(dir, "stats.json"),
      JSON.stringify({ claude: 3, local: 7, openrouter: 2 }),
      "utf8",
    );
    const stats = loadStats(dir);
    expect(stats.version).toBe(2);
    expect(stats.backends["claude"]).toEqual({ count: 3, inTok: 0, outTok: 0, spend: 0 });
    expect(stats.backends["local"]?.count).toBe(7);
    expect(stats.backends["openrouter"]?.count).toBe(2);
    expect(stats.saved).toEqual({ tokens: 0, usd: 0 });
  });

  test("recordDispatch accumulates per backend, per category, and savings", () => {
    recordDispatch(dir, {
      backendId: "local",
      category: "simple-qa",
      usage: { inputTokens: 100, outputTokens: 200, estimated: false },
      spend: 0,
      savedTokens: 300,
      savedUsd: 0.5,
    });
    recordDispatch(dir, {
      backendId: "local",
      category: "simple-qa",
      usage: { inputTokens: 10, outputTokens: 20, estimated: false },
      spend: 0.25,
      savedTokens: 30,
      savedUsd: 0.1,
    });

    const stats = loadStats(dir);
    expect(stats.backends["local"]).toEqual({
      count: 2,
      inTok: 110,
      outTok: 220,
      spend: 0.25,
    });
    expect(stats.categories["simple-qa"]).toBe(2);
    expect(stats.saved.tokens).toBe(330);
    expect(stats.saved.usd).toBeCloseTo(0.6, 10);
  });

  test("formatStats reports the headline savings and actual spend", () => {
    recordDispatch(dir, {
      backendId: "claude",
      category: "code",
      usage: { inputTokens: 40, outputTokens: 0, estimated: true },
      spend: 0,
      savedTokens: 0,
      savedUsd: 0,
    });
    const output = formatStats(loadStats(dir), backends);
    expect(output).toContain("claude");
    expect(output).toContain("saved");
    expect(output).not.toContain("undefined");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/stats.test.ts`
Expected: FAIL — `recordDispatch` is not exported; `loadStats` returns the v1 shape.

- [ ] **Step 3: Rewrite the implementation**

Replace the whole of `src/stats.ts`:

```typescript
import * as fs from "fs";
import * as path from "path";
import type { Backend, Category, TokenUsage } from "./types.js";

export interface BackendStats {
  count: number;
  inTok: number;
  outTok: number;
  spend: number;
}

export interface Stats {
  version: 2;
  backends: Record<string, BackendStats>;
  categories: Record<string, number>;
  saved: { tokens: number; usd: number };
}

export interface DispatchRecord {
  backendId: string;
  category: Category;
  usage: TokenUsage;
  /** Actual USD paid to this backend for this prompt. */
  spend: number;
  /** Tokens that did not go to the agentic backend. 0 when it served. */
  savedTokens: number;
  /** Counterfactual USD those tokens would have cost there. */
  savedUsd: number;
}

const V1_KEYS = ["claude", "local", "openrouter"] as const;

function statsFile(dir: string): string {
  return path.join(dir, "stats.json");
}

function emptyStats(): Stats {
  return { version: 2, backends: {}, categories: {}, saved: { tokens: 0, usd: 0 } };
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBackendStats(value: unknown): BackendStats {
  if (!isRecord(value)) return { count: 0, inTok: 0, outTok: 0, spend: 0 };
  return {
    count: toCount(value["count"]),
    inTok: toCount(value["inTok"]),
    outTok: toCount(value["outTok"]),
    spend: toCount(value["spend"]),
  };
}

/**
 * A v1 file holds three counters and nothing else. Its counts carry over; the
 * token and spend fields start at zero rather than being back-filled with
 * numbers that were never measured.
 */
function migrateV1(record: Record<string, unknown>): Stats {
  const stats = emptyStats();
  for (const key of V1_KEYS) {
    const count = toCount(record[key]);
    if (count > 0) stats.backends[key] = { count, inTok: 0, outTok: 0, spend: 0 };
  }
  return stats;
}

export function loadStats(dir: string): Stats {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statsFile(dir), "utf8"));
  } catch {
    return emptyStats();
  }
  if (!isRecord(parsed)) return emptyStats();
  if (parsed["version"] !== 2) return migrateV1(parsed);

  const stats = emptyStats();
  const backends = parsed["backends"];
  if (isRecord(backends)) {
    for (const [id, value] of Object.entries(backends)) {
      stats.backends[id] = parseBackendStats(value);
    }
  }
  const categories = parsed["categories"];
  if (isRecord(categories)) {
    for (const [name, value] of Object.entries(categories)) {
      stats.categories[name] = toCount(value);
    }
  }
  const saved = parsed["saved"];
  if (isRecord(saved)) {
    stats.saved = { tokens: toCount(saved["tokens"]), usd: toCount(saved["usd"]) };
  }
  return stats;
}

export function recordDispatch(dir: string, record: DispatchRecord): void {
  const stats = loadStats(dir);
  const current = stats.backends[record.backendId] ?? {
    count: 0,
    inTok: 0,
    outTok: 0,
    spend: 0,
  };
  stats.backends[record.backendId] = {
    count: current.count + 1,
    inTok: current.inTok + record.usage.inputTokens,
    outTok: current.outTok + record.usage.outputTokens,
    spend: current.spend + record.spend,
  };
  stats.categories[record.category] = (stats.categories[record.category] ?? 0) + 1;
  stats.saved = {
    tokens: stats.saved.tokens + record.savedTokens,
    usd: stats.saved.usd + record.savedUsd,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statsFile(dir), JSON.stringify(stats, null, 2), "utf8");
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

export function formatStats(stats: Stats, backends: readonly Backend[]): string {
  const execIds = new Set(backends.filter((b) => b.kind === "exec").map((b) => b.id));
  const ids = Object.keys(stats.backends);
  const lines = ["prompt-router stats", "", `  ${pad("backend", 13)}${padStart("prompts", 8)}${padStart("tokens", 11)}${padStart("spend", 10)}`];

  let total = 0;
  let diverted = 0;
  let spend = 0;
  for (const id of ids) {
    const entry = stats.backends[id];
    if (!entry) continue;
    total += entry.count;
    spend += entry.spend;
    const isExec = execIds.has(id);
    if (!isExec) diverted += entry.count;
    // Exec backends hand over the terminal, so their output is unobservable —
    // the token column shows input only, and says so.
    const tokens = isExec
      ? `${formatTokens(entry.inTok)}(in)`
      : formatTokens(entry.inTok + entry.outTok);
    const money = isExec ? "—" : `$${entry.spend.toFixed(2)}`;
    lines.push(`  ${pad(id, 13)}${padStart(String(entry.count), 8)}${padStart(tokens, 11)}${padStart(money, 10)}`);
  }

  const categories = Object.entries(stats.categories)
    .map(([name, count]) => `${name} ${count}`)
    .join(" · ");
  lines.push("");
  if (categories) lines.push(`  categories   ${categories}`);
  lines.push(`  diverted     ${diverted} of ${total} prompts`);
  lines.push(
    `  ≈ $${stats.saved.usd.toFixed(2)} saved vs. all-Claude    (actual spend: $${spend.toFixed(2)})`,
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stats.ts test/stats.test.ts
git commit -m "feat: per-backend stats with token, spend, and savings totals"
```

---

### Task 8: Generalize the health probe to any chat backend

**Files:**
- Modify: `src/local.ts`
- Modify: `test/local.test.ts`

**Interfaces:**
- Consumes: `ChatBackend` from `src/types.js`.
- Produces: `isServerUp(baseUrl: string, timeoutMs: number, fetchImpl?: typeof fetch): Promise<boolean>` (unchanged) and `ensureChatBackend(backend: ChatBackend): Promise<boolean>` from `src/local.js`. `ensureLocalServer` is removed.

- [ ] **Step 1: Write the failing test**

Append to `test/local.test.ts` (keep the existing `isServerUp` tests):

```typescript
import { describe, expect, test } from "vitest";
import { ensureChatBackend } from "../src/local.js";
import type { ChatBackend } from "../src/types.js";

function backend(over: Partial<ChatBackend> = {}): ChatBackend {
  return {
    id: "local",
    label: "local model",
    kind: "chat",
    categories: ["simple-qa"],
    priority: 10,
    enabled: true,
    baseUrl: "http://127.0.0.1:1/v1",
    models: ["m"],
    probe: true,
    autoStart: false,
    autoStartCommand: [],
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    ...over,
  };
}

describe("ensureChatBackend", () => {
  test("a disabled backend is never reachable", async () => {
    await expect(ensureChatBackend(backend({ enabled: false }))).resolves.toBe(false);
  });

  test("a backend that does not probe is assumed reachable", async () => {
    await expect(ensureChatBackend(backend({ probe: false }))).resolves.toBe(true);
  });

  test("a probing backend with no server and no autostart is unreachable", async () => {
    await expect(ensureChatBackend(backend({ probe: true, autoStart: false }))).resolves.toBe(
      false,
    );
  });

  test("autoStart with an empty command cannot start anything", async () => {
    await expect(
      ensureChatBackend(backend({ probe: true, autoStart: true, autoStartCommand: [] })),
    ).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/local.test.ts`
Expected: FAIL — `ensureChatBackend` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/local.ts`, keep `isServerUp` and `delay` exactly as they are. Replace the `RouterConfig` import and the whole `ensureLocalServer` function:

```typescript
import { spawn } from "child_process";
import type { ChatBackend } from "./types.js";
```

```typescript
/**
 * Probe a chat backend, starting its server first when configured to. Remote
 * providers set `probe: false` — there is nothing local to wake, and paying a
 * round trip to find that out on every prompt is wasted latency.
 */
export async function ensureChatBackend(backend: ChatBackend): Promise<boolean> {
  if (!backend.enabled) return false;
  if (!backend.probe) return true;
  if (await isServerUp(backend.baseUrl, PROBE_TIMEOUT_MS)) return true;
  if (!backend.autoStart) return false;

  const [command, ...args] = backend.autoStartCommand;
  if (!command) return false;

  // The start command is a no-op when the server is already running. A missing
  // binary surfaces as an async "error" event (ENOENT), not a throw — bail out
  // immediately instead of polling for a server that can never start.
  const started = await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, {
        shell: process.platform === "win32",
        stdio: "ignore",
        detached: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });
  if (!started) return false;

  for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt++) {
    await delay(START_POLL_INTERVAL_MS);
    if (await isServerUp(backend.baseUrl, PROBE_TIMEOUT_MS)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/local.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/local.ts test/local.test.ts
git commit -m "refactor: generalize the local probe to any chat backend"
```

---

### Task 9: Dispatch module

**Files:**
- Create: `src/dispatch.ts`
- Create: `test/dispatch.test.ts`

**Interfaces:**
- Consumes: `buildExecArgs`/`ExecArgContext` from `src/execArgs.js`; `streamChat`/`withModelFallback`/`ChatMessage` from `src/llm.js`; `ensureChatBackend` from `src/local.js`; `costOf`/`estimateUsage` from `src/cost.js`; `isBatchShim`/`toShellArgs` from `src/winShell.js`.
- Produces: `ChatAttempt`, `dispatchChat(backend: ChatBackend, opts: ChatDispatchOptions): Promise<ChatAttempt | null>`, and `execSpawnPlan(backend: ExecBackend, ctx: ExecArgContext): { command: string; args: string[]; useShell: boolean }` from `src/dispatch.js`.

- [ ] **Step 1: Write the failing test**

Create `test/dispatch.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { dispatchChat, execSpawnPlan } from "../src/dispatch.js";
import type { ChatBackend, ExecBackend } from "../src/types.js";

const exec: ExecBackend = {
  id: "claude",
  label: "Claude Code",
  kind: "exec",
  categories: ["code"],
  priority: 10,
  enabled: true,
  command: "claude",
  args: ["{model}", "{prompt}"],
  modelFlag: "--model",
  effortFlag: "--effort",
  continueFlag: "-c",
  supportsModelTier: true,
  supportsPlan: true,
  supportsContinue: true,
  modelPricing: {},
};

function chat(over: Partial<ChatBackend> = {}): ChatBackend {
  return {
    id: "or",
    label: "OpenRouter",
    kind: "chat",
    categories: ["deep-qa"],
    priority: 5,
    enabled: true,
    baseUrl: "http://x/v1",
    models: ["m1", "m2"],
    probe: false,
    autoStart: false,
    autoStartCommand: [],
    pricing: { inputPer1M: 2, outputPer1M: 10 },
    ...over,
  };
}

function sseResponse(text: string, promptTokens: number, completionTokens: number): Response {
  const body =
    `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n` +
    `data: {"choices":[],"usage":{"prompt_tokens":${promptTokens},"completion_tokens":${completionTokens}}}\n\n` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("execSpawnPlan", () => {
  test("expands the template and reports the command", () => {
    const plan = execSpawnPlan(exec, { prompt: "hi", continueSession: false, model: "opus" });
    expect(plan.command).toBe("claude");
    expect(plan.args).toContain("--model");
    expect(plan.args).toContain("opus");
    expect(plan.args).toContain("hi");
  });
});

describe("dispatchChat", () => {
  test("returns the answer, the serving model, exact usage, and the cost", async () => {
    const fetchImpl = (async () => sseResponse("hello", 1_000_000, 0)) as unknown as typeof fetch;
    const result = await dispatchChat(chat(), {
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
      onDelta: () => {},
      fetchImpl,
    });

    expect(result?.text).toBe("hello");
    expect(result?.model).toBe("m1");
    expect(result?.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 0, estimated: false });
    expect(result?.spend).toBeCloseTo(2, 10);
  });

  test("falls through to the next model when the first fails", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return new Response("nope", { status: 500 });
      return sseResponse("second", 4, 6);
    }) as unknown as typeof fetch;

    const result = await dispatchChat(chat(), {
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
      onDelta: () => {},
      fetchImpl,
    });

    expect(result?.text).toBe("second");
    expect(result?.model).toBe("m2");
  });

  test("returns null when every model fails", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await dispatchChat(chat(), {
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 1000,
      onDelta: () => {},
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  test("falls back to an estimate when the provider reports no usage", async () => {
    const body = 'data: {"choices":[{"delta":{"content":"abcd"}}]}\n\ndata: [DONE]\n\n';
    const fetchImpl = (async () =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch;

    const result = await dispatchChat(chat(), {
      messages: [{ role: "user", content: "12345678" }],
      timeoutMs: 1000,
      onDelta: () => {},
      fetchImpl,
    });

    expect(result?.usage.estimated).toBe(true);
    expect(result?.usage.inputTokens).toBe(2);
    expect(result?.usage.outputTokens).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/dispatch.test.ts`
Expected: FAIL — cannot resolve `../src/dispatch.js`.

- [ ] **Step 3: Write the implementation**

Create `src/dispatch.ts`:

```typescript
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/dispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.ts test/dispatch.test.ts
git commit -m "feat: add kind-based dispatch for chat and exec backends"
```

---

### Task 10: Dynamic override keys in the confirmation bar

**Files:**
- Modify: `src/ui.ts`
- Create: `test/ui.test.ts`

**Interfaces:**
- Consumes: `Backend`, `Dispatch`, `Classification` from `src/types.js`.
- Produces: `overrideKeyMap(candidates: readonly Backend[]): Map<string, string>`, `RouteChoice { action: "accept" | "reject" | "edit"; overrideBackendId?: string }`, `askRouteChoice(candidates: readonly Backend[]): Promise<RouteChoice>`, `showRouting(original: string, optimized: string, dispatch: Dispatch, detail: string, cls: Classification | null): void`. `TARGET_LABELS` is removed.

- [ ] **Step 1: Write the failing test**

Create `test/ui.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { overrideKeyMap } from "../src/ui.js";
import type { Backend, ChatBackend } from "../src/types.js";

function chat(id: string): ChatBackend {
  return {
    id,
    label: id,
    kind: "chat",
    categories: ["simple-qa"],
    priority: 0,
    enabled: true,
    baseUrl: "http://x/v1",
    models: ["m"],
    probe: false,
    autoStart: false,
    autoStartCommand: [],
    pricing: { inputPer1M: 0, outputPer1M: 0 },
  };
}

describe("overrideKeyMap", () => {
  test("binds the first three candidates to 1, 2, and 3", () => {
    const candidates: Backend[] = [chat("a"), chat("b"), chat("c"), chat("d")];
    const keys = overrideKeyMap(candidates);
    expect(keys.get("1")).toBe("a");
    expect(keys.get("2")).toBe("b");
    expect(keys.get("3")).toBe("c");
    expect(keys.has("4")).toBe(false);
  });

  test("keeps the legacy c/l/o letters bound to their backends", () => {
    const candidates: Backend[] = [chat("local"), chat("openrouter"), chat("claude")];
    const keys = overrideKeyMap(candidates);
    expect(keys.get("c")).toBe("claude");
    expect(keys.get("l")).toBe("local");
    expect(keys.get("o")).toBe("openrouter");
  });

  test("a legacy letter is not bound when its backend is absent", () => {
    expect(overrideKeyMap([chat("aider")]).has("c")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/ui.test.ts`
Expected: FAIL — `overrideKeyMap` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/ui.ts`: delete `TARGET_LABELS`, change the `RouteDecision`/`RouteTarget` import to `Backend`/`Dispatch`, and apply the changes below. `showPlan`, `askPlanChoice`, `showPassThrough`, `showError`, and `startSpinner` are untouched.

```typescript
import type { Backend, Classification, Dispatch } from "./types.js";
```

```typescript
export interface RouteChoice {
  action: "accept" | "reject" | "edit";
  overrideBackendId?: string;
}

/**
 * Numeric keys address the candidates positionally; the original c/l/o letters
 * stay bound to their backends so existing muscle memory keeps working.
 */
const LEGACY_KEYS: Record<string, string> = { c: "claude", l: "local", o: "openrouter" };

export function overrideKeyMap(candidates: readonly Backend[]): Map<string, string> {
  const keys = new Map<string, string>();
  candidates.slice(0, 3).forEach((backend, index) => {
    keys.set(String(index + 1), backend.id);
  });
  for (const [key, id] of Object.entries(LEGACY_KEYS)) {
    if (candidates.some((backend) => backend.id === id)) keys.set(key, id);
  }
  return keys;
}
```

Change `showRouting`'s signature to take `dispatch: Dispatch` and read `dispatch.planFirst` / `dispatch.uncertain` where it previously read `decision.*`. The body is otherwise unchanged.

Replace `askRouteChoice` with a candidate-aware version:

```typescript
export function askRouteChoice(candidates: readonly Backend[]): Promise<RouteChoice> {
  // Piped/CI stdin can't answer (and its data must not be eaten as menu
  // keystrokes) — take the default immediately instead of pretending to wait.
  if (!process.stdin.isTTY) {
    process.stderr.write(pc.dim("  non-interactive session — accepting the route\n"));
    return Promise.resolve({ action: "accept" });
  }
  const keys = overrideKeyMap(candidates);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

    const overrides = candidates
      .slice(0, 3)
      .map((backend, index) => pc.magenta(`[${index + 1}]`) + pc.dim(` ${backend.label}  `))
      .join("");

    process.stderr.write(
      "  " +
        pc.green("[Y]") +
        pc.dim("es  ") +
        pc.red("[n]") +
        pc.dim("o, original  ") +
        pc.cyan("[e]") +
        pc.dim("dit  ") +
        overrides +
        pc.dim(`(${TIMEOUT_MS / 1000}s timeout → Y): `),
    );

    let settled = false;
    const finish = (choice: RouteChoice): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(choice);
    };

    const timer = setTimeout(() => {
      process.stderr.write(pc.dim("Y\n"));
      finish({ action: "accept" });
    }, TIMEOUT_MS);

    rl.once("close", () => finish({ action: "accept" }));

    rl.once("line", (line) => {
      const answer = line.trim().toLowerCase();
      if (answer === "n" || answer === "no") return finish({ action: "reject" });
      if (answer === "e" || answer === "edit") return finish({ action: "edit" });
      const override = keys.get(answer);
      if (override) return finish({ action: "accept", overrideBackendId: override });
      finish({ action: "accept" });
    });
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/ui.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui.ts test/ui.test.ts
git commit -m "feat: bind confirmation-bar override keys to the candidate list"
```

---

### Task 11: Wire the registry through the CLI

**Files:**
- Modify: `src/index.ts`
- Modify: `src/types.ts` (remove `RouteTarget` and `RouteDecision`)

**Interfaces:**
- Consumes: everything produced by Tasks 1–10.
- Produces: a working `prompt-router` binary. No new exports.

- [ ] **Step 1: Confirm the build is currently broken**

Run: `pnpm typecheck`
Expected: FAIL — `src/index.ts` still imports `buildClaudeArgs`, `ensureLocalServer`, `recordRoute`, and `TARGET_LABELS`.

- [ ] **Step 2: Rewrite the imports and helpers in `src/index.ts`**

Replace the import block:

```typescript
#!/usr/bin/env node

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import pc from "picocolors";
import { findHandoffBackend, selectCandidates } from "./backends.js";
import { classify } from "./classify.js";
import { configDir, loadConfig, type RouterConfig } from "./config.js";
import { costOf, estimateUsage, referencePricing } from "./cost.js";
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
import { pickModelTier } from "./tier.js";
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
  TokenUsage,
} from "./types.js";
import {
  askPlanChoice,
  askRouteChoice,
  showError,
  showPassThrough,
  showPlan,
  showRouting,
  startSpinner,
} from "./ui.js";
```

In `CliArgs`, change `forceTarget: RouteTarget | null` to `forceBackendId: string | null`, and in `parseArgs` replace the `--to` branch (validation now happens against the registry, which is not loaded yet at parse time):

```typescript
    } else if (arg === "--to") {
      const target = argv[++i];
      if (!target) {
        process.stderr.write("prompt-router: --to expects a backend id\n");
        process.exit(1);
      }
      args.forceBackendId = target;
```

Update `USAGE`:

```typescript
      --to <backend>   force a backend by id (claude | local | openrouter | ...)
```

Replace `routeDetail`, `runClaude`, and `withModelTier`:

```typescript
function routeDetail(backend: Backend, dispatch: Dispatch): string {
  if (backend.kind === "chat") return `${backend.label} (${backend.models[0] ?? "model"})`;
  const parts = [dispatch.model, dispatch.effort ? `effort: ${dispatch.effort}` : undefined].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? `${backend.label} (${parts.join(", ")})` : backend.label;
}

function runExec(
  backend: ExecBackend,
  text: string,
  continueSession: boolean,
  model?: string,
  effort?: EffortLevel,
): never {
  const plan = execSpawnPlan(backend, { prompt: text, continueSession, model, effort });
  const result = spawnSync(plan.command, plan.args, {
    stdio: "inherit",
    shell: plan.useShell,
  });
  if (result.error) {
    showError(`failed to run ${backend.command}: ${result.error.message}`);
    process.stderr.write("Your prompt, so it is not lost:\n\n");
    process.stdout.write(text + "\n");
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

function tierFor(
  backend: Backend,
  cls: Classification | null,
  prompt: string,
  config: RouterConfig,
  uncertain: boolean,
): ModelTier | null {
  if (backend.kind !== "exec" || !backend.supportsModelTier) return null;
  if (!config.modelSelection.enabled) return null;
  // The classifier's complexity score is the best signal; when it is missing
  // (no API key, timeout) a local estimate keeps the tier per-task instead of
  // silently running every prompt on the backend's default model.
  return pickModelTier(cls?.complexity ?? estimateComplexity(prompt), uncertain, {
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
```

Replace `logRouting` so it records the backend id:

```typescript
function logRouting(config: RouterConfig, backendId: string, dispatch: Dispatch): void {
  // Opt-in and content-free by design: ids and flags only, never the prompt.
  if (!config.logging.routingLog) return;
  appendRoutingLog(configDir(), {
    target: backendId,
    planFirst: dispatch.planFirst,
    uncertain: dispatch.uncertain,
  });
}
```

- [ ] **Step 3: Rewrite the two route runners**

Replace `runClaudeRoute` and `runChatRoute` wholesale:

```typescript
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

function savingsFor(
  usage: TokenUsage,
  handoff: ExecBackend | null,
  tier: ModelTier | null,
): { savedTokens: number; savedUsd: number } {
  const pricing = referencePricing(handoff, tier);
  if (!pricing) return { savedTokens: 0, savedUsd: 0 };
  return {
    savedTokens: usage.inputTokens + usage.outputTokens,
    savedUsd: costOf(usage, pricing),
  };
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
```

- [ ] **Step 4: Rewrite `main`**

Replace the body of `main` from `const config = loadConfig();` to the end:

```typescript
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
```

Also update the `--stats` branch:

```typescript
  if (args.showStats) {
    const config = loadConfig();
    process.stdout.write(formatStats(loadStats(dir), config.backends) + "\n");
    return;
  }
```

- [ ] **Step 5: Remove the dead types**

In `src/types.ts`, delete `RouteTarget` and `RouteDecision`. Keep `Category`, `ClaudeModel`, `EffortLevel`, `ModelTier`, `Classification`, `SessionMessage`, and everything added in Task 1.

- [ ] **Step 6: Run the whole suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS, no type errors, every test green.

- [ ] **Step 7: Smoke-test the real binary**

```bash
printf 'what is a monad?\n' | pnpm dev "what is a monad?"
pnpm dev --stats
```
Expected: the confirmation bar lists numbered candidates and accepts non-interactively; `--stats` prints the table with no `undefined` or `NaN`.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/types.ts
git commit -m "feat: route through the backend registry end to end"
```

---

### Task 12: Setup wizard and documentation

**Files:**
- Modify: `src/init.ts`
- Modify: `test/init.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the config schema from Task 1.
- Produces: no new exports; `runInit` writes a `backends` array.

- [ ] **Step 1: Write the failing test**

Append to `test/init.test.ts` (keep the existing tests; adapt the names below to the existing helper that builds the config object — `init.ts` already has a pure config-building function, so assert on that rather than on disk I/O):

```typescript
import { describe, expect, test } from "vitest";
import { buildInitConfig } from "../src/init.js";

describe("init writes the backend registry", () => {
  test("a local-model setup produces three backends", () => {
    const cfg = buildInitConfig({ localBaseUrl: "http://localhost:1234/v1", localModel: "m" });
    const ids = cfg.backends.map((b) => b.id);
    expect(ids).toEqual(["claude", "local", "openrouter"]);
  });

  test("declining a local model leaves it disabled rather than absent", () => {
    const cfg = buildInitConfig({ localBaseUrl: null, localModel: null });
    const local = cfg.backends.find((b) => b.id === "local");
    expect(local?.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/init.test.ts`
Expected: FAIL — `buildInitConfig` is not exported, or the written config has no `backends`.

- [ ] **Step 3: Update the wizard**

In `src/init.ts`, extract the config-object construction into an exported pure function and have it emit the new schema. Import the shared defaults rather than restating them:

```typescript
import { defaultBackends } from "./config.js";
import type { Backend } from "./types.js";
```

```typescript
export interface InitAnswers {
  localBaseUrl: string | null;
  localModel: string | null;
}

/** The config the wizard writes. Pure so it can be asserted on directly. */
export function buildInitConfig(answers: InitAnswers): { backends: Backend[] } {
  const backends = defaultBackends();
  for (const backend of backends) {
    if (backend.kind !== "chat" || backend.id !== "local") continue;
    if (answers.localBaseUrl && answers.localModel) {
      backend.baseUrl = answers.localBaseUrl;
      backend.models = [answers.localModel];
      backend.enabled = true;
    } else {
      // Keeping the entry but disabling it leaves an obvious thing to flip on
      // later, instead of an empty file the user has to write from scratch.
      backend.enabled = false;
    }
  }
  return { backends };
}
```

Have `runInit` call `buildInitConfig` and write `JSON.stringify(config, null, 2)` to `config.json`. `defaultBackends` is exported from `src/config.ts` in Task 1 — there is exactly one definition of those shapes, and `init.ts` imports it.

- [ ] **Step 4: Run the tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Update the README**

Make these edits to `README.md`:

1. **Configuration section** — replace the `config.json` example's `local` / `openrouter.answerModels` blocks with the `backends` array, keeping `openrouter.apiKey` / `classifierModels` / `planModels` (the classifier and planner are infrastructure, not backends):

````markdown
```jsonc
// ~/.config/prompt-router/config.json
{
  "backends": [
    {
      "id": "claude", "kind": "exec", "label": "Claude Code",
      "categories": ["code"], "priority": 10,
      "command": "claude",
      "args": ["{model}", "{effort}", "{continue}", "{prompt}"],
      "supportsModelTier": true, "supportsPlan": true, "supportsContinue": true
    },
    {
      "id": "local", "kind": "chat", "label": "local model",
      "categories": ["simple-qa"], "priority": 10,
      "baseUrl": "http://localhost:1234/v1",
      "models": ["gemma-4-12b-qat"],
      "probe": true, "autoStart": true,
      "autoStartCommand": ["lms", "server", "start"]
    },
    {
      "id": "openrouter", "kind": "chat", "label": "OpenRouter",
      "categories": ["simple-qa", "deep-qa"], "priority": 5,
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "models": ["openai/gpt-oss-120b:free"]
    }
  ]
}
```

Backends are matched to a category and ordered by `priority` — the highest
healthy one serves, and the rest become its fallback chain. Adding another
coding agent or a paid model for hard questions is a config edit, not a
release. **A config without a `backends` key keeps working**: the three
defaults are derived from the older `local` / `openrouter` blocks.
````

2. **Usage section** — change the `--to` line to `--to <backend-id>` and note that any configured id works.

3. **Privacy section** — add one line: `--stats` stores per-backend counts, token totals, and cost figures — still no prompt content.

4. **Roadmap** — tick `Per-backend capability manifests`.

- [ ] **Step 6: Verify the docs match the code**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: PASS. Then re-read the README config block against `defaultBackends()` in `src/config.ts` and confirm every field name matches.

- [ ] **Step 7: Commit**

```bash
git add src/init.ts test/init.test.ts README.md
git commit -m "feat: init wizard writes the backend registry; document it"
```
