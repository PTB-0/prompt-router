# Auto Model/Effort Selection for the Claude Code Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `prompt-router` routes a prompt to Claude Code, automatically pick `--model` and `--effort` flags from the task's classified complexity, with configurable thresholds and per-run CLI overrides.

**Architecture:** A new pure module `src/tier.ts` maps a `complexity` score (0–1) to a `{ model, effort }` tier. A new pure module `src/claudeArgs.ts` builds the actual `claude` CLI arg list. `src/index.ts` wires these into the existing `claude` route: it attaches the picked tier onto the `RouteDecision` whenever the target is `"claude"`, displays it in the routing banner, and passes it through to the `spawnSync("claude", ...)` call. `src/route.ts`'s `decideRoute()` is untouched.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, no `any`), Vitest, pnpm.

## Global Constraints

- No `any` anywhere in new or modified code.
- TypeScript strict mode with `noUncheckedIndexedAccess: true` — avoid array indexing that yields `T | undefined` without a guard; prefer explicit branching (matches this file's existing style in `src/route.ts`).
- Every pure-logic module gets its own test file under `test/`, mirroring `src/heuristics.ts` ↔ `test/heuristics.test.ts` and `src/winShell.ts` ↔ `test/winShell.test.ts`. `src/index.ts` itself stays without a dedicated test file — this matches the existing convention (it's CLI wiring around `spawnSync`, not pure logic).
- Follow existing code style exactly: named exports, no default exports, `.js` extensions on relative imports (NodeNext resolution), `describe`/`test`/`expect` from `vitest`.
- Full verification command for every task: `pnpm typecheck && pnpm test` (run from the repo root, `C:\Users\USER\Desktop\CODES\prompt-router`).
- Design spec: `docs/superpowers/specs/2026-07-12-model-effort-tiering-design.md`.

---

### Task 1: `tier.ts` — complexity → model/effort tiering

**Files:**
- Modify: `src/types.ts`
- Create: `src/tier.ts`
- Test: `test/tier.test.ts`

**Interfaces:**
- Consumes: nothing from other new files (this is the first task).
- Produces:
  - `src/types.ts`: `export type ClaudeModel = "haiku" | "sonnet" | "opus";`, `export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";`, `export interface ModelTier { model: ClaudeModel; effort: EffortLevel; }`, and `RouteDecision` gains `model?: string; effort?: EffortLevel;`.
  - `src/tier.ts`: `export interface TierOptions { lowThreshold: number; highThreshold: number; }` and `export function pickModelTier(complexity: number | null, uncertain: boolean, opts: TierOptions): ModelTier | null`. Later tasks (`index.ts`) import `pickModelTier` from `./tier.js`.

- [ ] **Step 1: Extend `src/types.ts` with the new types**

Open `src/types.ts` (currently 22 lines). Replace its full contents with:

```ts
export type Category = "code" | "simple-qa" | "deep-qa";

export type RouteTarget = "claude" | "local" | "openrouter";

export type ClaudeModel = "haiku" | "sonnet" | "opus";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelTier {
  model: ClaudeModel;
  effort: EffortLevel;
}

export interface Classification {
  optimizedPrompt: string;
  category: Category;
  complexity: number;
  confidence: number;
}

export interface RouteDecision {
  target: RouteTarget;
  planFirst: boolean;
  uncertain: boolean;
  model?: string;
  effort?: EffortLevel;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
}
```

Note `RouteDecision.model` is `string` (not `ClaudeModel`) because a user can force an arbitrary model name/alias via `--model` (e.g. `fable`) — `ClaudeModel` is only used for the auto-picked tiers themselves.

- [ ] **Step 2: Write the failing test for `pickModelTier`**

Create `test/tier.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { pickModelTier } from "../src/tier.js";

const opts = { lowThreshold: 0.35, highThreshold: 0.7 };

describe("pickModelTier", () => {
  test("no complexity signal returns null", () => {
    expect(pickModelTier(null, false, opts)).toBeNull();
    expect(pickModelTier(null, true, opts)).toBeNull();
  });

  test("low complexity picks haiku/low", () => {
    expect(pickModelTier(0.1, false, opts)).toEqual({ model: "haiku", effort: "low" });
    expect(pickModelTier(0.34, false, opts)).toEqual({ model: "haiku", effort: "low" });
  });

  test("mid complexity picks sonnet/medium", () => {
    expect(pickModelTier(0.35, false, opts)).toEqual({ model: "sonnet", effort: "medium" });
    expect(pickModelTier(0.5, false, opts)).toEqual({ model: "sonnet", effort: "medium" });
    expect(pickModelTier(0.69, false, opts)).toEqual({ model: "sonnet", effort: "medium" });
  });

  test("high complexity picks opus/high", () => {
    expect(pickModelTier(0.7, false, opts)).toEqual({ model: "opus", effort: "high" });
    expect(pickModelTier(0.95, false, opts)).toEqual({ model: "opus", effort: "high" });
  });

  test("uncertain classification escalates one tier", () => {
    expect(pickModelTier(0.1, true, opts)).toEqual({ model: "sonnet", effort: "medium" });
    expect(pickModelTier(0.5, true, opts)).toEqual({ model: "opus", effort: "high" });
  });

  test("uncertain escalation caps at the top tier", () => {
    expect(pickModelTier(0.9, true, opts)).toEqual({ model: "opus", effort: "high" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/tier.test.ts`
Expected: FAIL — `Cannot find module '../src/tier.js'` (the module doesn't exist yet).

- [ ] **Step 4: Implement `src/tier.ts`**

Create `src/tier.ts`:

```ts
import type { ModelTier } from "./types.js";

export interface TierOptions {
  lowThreshold: number;
  highThreshold: number;
}

export function pickModelTier(
  complexity: number | null,
  uncertain: boolean,
  opts: TierOptions,
): ModelTier | null {
  if (complexity === null) return null;

  const level = complexity >= opts.highThreshold ? 2 : complexity >= opts.lowThreshold ? 1 : 0;
  const escalated = uncertain ? Math.min(level + 1, 2) : level;

  if (escalated === 0) return { model: "haiku", effort: "low" };
  if (escalated === 1) return { model: "sonnet", effort: "medium" };
  return { model: "opus", effort: "high" };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/tier.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Typecheck the whole project**

Run: `pnpm typecheck`
Expected: no errors (confirms `RouteDecision`'s new optional fields don't break `src/route.ts`, which still returns object literals without `model`/`effort`).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/tier.ts test/tier.test.ts
git commit -m "Add pickModelTier: map complexity to a Claude model/effort tier"
```

---

### Task 2: `claudeArgs.ts` — build the `claude` CLI arg list

**Files:**
- Create: `src/claudeArgs.ts`
- Test: `test/claudeArgs.test.ts`

**Interfaces:**
- Consumes: `EffortLevel` from `src/types.ts` (Task 1).
- Produces: `export function buildClaudeArgs(text: string, continueSession: boolean, model?: string, effort?: EffortLevel): string[]`. Task 4 (`index.ts`) imports this from `./claudeArgs.js` and feeds its result into the existing `toShellArgs()` helper.

- [ ] **Step 1: Write the failing test**

Create `test/claudeArgs.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildClaudeArgs } from "../src/claudeArgs.js";

describe("buildClaudeArgs", () => {
  test("plain prompt, no continue, no model/effort", () => {
    expect(buildClaudeArgs("fix the bug", false)).toEqual(["fix the bug"]);
  });

  test("continue flag precedes the prompt", () => {
    expect(buildClaudeArgs("and now?", true)).toEqual(["-c", "and now?"]);
  });

  test("model flag is prepended before the prompt args", () => {
    expect(buildClaudeArgs("fix the bug", false, "sonnet")).toEqual([
      "--model",
      "sonnet",
      "fix the bug",
    ]);
  });

  test("effort flag is prepended before the prompt args", () => {
    expect(buildClaudeArgs("fix the bug", false, undefined, "high")).toEqual([
      "--effort",
      "high",
      "fix the bug",
    ]);
  });

  test("model and effort both prepended, continue flag stays with the prompt", () => {
    expect(buildClaudeArgs("and now?", true, "opus", "max")).toEqual([
      "--model",
      "opus",
      "--effort",
      "max",
      "-c",
      "and now?",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/claudeArgs.test.ts`
Expected: FAIL — `Cannot find module '../src/claudeArgs.js'`

- [ ] **Step 3: Implement `src/claudeArgs.ts`**

Create `src/claudeArgs.ts`:

```ts
import type { EffortLevel } from "./types.js";

export function buildClaudeArgs(
  text: string,
  continueSession: boolean,
  model?: string,
  effort?: EffortLevel,
): string[] {
  const flags: string[] = [];
  if (model) flags.push("--model", model);
  if (effort) flags.push("--effort", effort);
  const promptArgs = continueSession ? ["-c", text] : [text];
  return [...flags, ...promptArgs];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/claudeArgs.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/claudeArgs.ts test/claudeArgs.test.ts
git commit -m "Add buildClaudeArgs: assemble the claude CLI arg list"
```

---

### Task 3: Config surface — `modelSelection.enabled` and tier thresholds

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RouterConfig.modelSelection.enabled: boolean` and `RouterConfig.thresholds.modelTierLow: number` / `RouterConfig.thresholds.modelTierHigh: number`, both resolved by `resolveConfig()`. Task 4 reads `config.modelSelection.enabled`, `config.thresholds.modelTierLow`, `config.thresholds.modelTierHigh`.

- [ ] **Step 1: Write the failing tests**

Open `test/config.test.ts` (currently 38 lines) and replace its full contents with:

```ts
import { describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  test("applies defaults when nothing is provided", () => {
    const cfg = resolveConfig(undefined, {});
    expect(cfg.local.baseUrl).toBe("http://localhost:1234/v1");
    expect(cfg.local.enabled).toBe(true);
    expect(cfg.thresholds.planComplexity).toBe(0.7);
    expect(cfg.openrouter.classifierModels.length).toBeGreaterThan(0);
    expect(cfg.openrouter.apiKey).toBeUndefined();
    expect(cfg.logging.routingLog).toBe(false);
    expect(cfg.modelSelection.enabled).toBe(true);
    expect(cfg.thresholds.modelTierLow).toBe(0.35);
    expect(cfg.thresholds.modelTierHigh).toBe(0.7);
  });

  test("config file values override defaults without wiping siblings", () => {
    const cfg = resolveConfig({ local: { model: "qwen2.5-7b-instruct" } }, {});
    expect(cfg.local.model).toBe("qwen2.5-7b-instruct");
    expect(cfg.local.baseUrl).toBe("http://localhost:1234/v1");
  });

  test("environment variables override the file", () => {
    const cfg = resolveConfig(
      { timeoutMs: 5000 },
      { OPENROUTER_API_KEY: "sk-test", PROMPT_ROUTER_TIMEOUT: "12000" },
    );
    expect(cfg.openrouter.apiKey).toBe("sk-test");
    expect(cfg.timeoutMs).toBe(12000);
  });

  test("invalid timeout falls back to the default", () => {
    expect(resolveConfig({ timeoutMs: -5 }, {}).timeoutMs).toBe(8000);
    expect(resolveConfig(undefined, { PROMPT_ROUTER_TIMEOUT: "abc" }).timeoutMs).toBe(8000);
  });

  test("ignores a malformed config file", () => {
    expect(resolveConfig("not an object", {}).local.enabled).toBe(true);
  });

  test("modelSelection.enabled can be disabled via config file", () => {
    expect(resolveConfig({ modelSelection: { enabled: false } }, {}).modelSelection.enabled).toBe(
      false,
    );
  });

  test("model tier thresholds can be overridden without wiping siblings", () => {
    const cfg = resolveConfig({ thresholds: { modelTierLow: 0.2 } }, {});
    expect(cfg.thresholds.modelTierLow).toBe(0.2);
    expect(cfg.thresholds.modelTierHigh).toBe(0.7);
  });

  test("out-of-range model tier threshold falls back to the default", () => {
    expect(resolveConfig({ thresholds: { modelTierLow: 5 } }, {}).thresholds.modelTierLow).toBe(
      0.35,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm vitest run test/config.test.ts`
Expected: FAIL on the 3 new tests — `cfg.modelSelection` is `undefined` / `cfg.thresholds.modelTierLow` is `undefined`.

- [ ] **Step 3: Extend `src/config.ts`**

In `src/config.ts`, update the `RouterConfig` interface (currently lines 6–31) — add a `modelSelection` block after `local` and two fields inside `thresholds`:

```ts
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
}
```

Update `DEFAULTS` (currently lines 33–70) — add `modelSelection` after `local` and the two new threshold fields:

```ts
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
};
```

In `resolveConfig()` (currently lines 98–141), add a `modelSelection` block right after the existing `local` block (which ends with `cfg.local.enabled = pickBoolean(local["enabled"], cfg.local.enabled);`), and two new lines inside the existing `thresholds` block:

```ts
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
```

(The rest of `src/config.ts` — `isRecord`, `pickString`, `pickBoolean`, `pickPositive`, `pickScore`, `pickStringArray`, the `session`/`logging`/`timeoutMs` blocks, env var overrides, `configDir()`, `loadConfig()` — is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/config.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "Add modelSelection.enabled and model tier thresholds to config"
```

---

### Task 4: Wire tiering into the Claude Code route in `index.ts`

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `pickModelTier` from `./tier.js` (Task 1), `buildClaudeArgs` from `./claudeArgs.js` (Task 2), `config.modelSelection.enabled` / `config.thresholds.modelTierLow` / `config.thresholds.modelTierHigh` (Task 3), `EffortLevel`/`Classification` types from `./types.js` (Task 1).
- Produces: updated `CliArgs` (`forceModel: string | null`, `forceEffort: EffortLevel | null`), a `withModelTier()` helper, an updated `routeDetail()` signature, and `runClaude()`/`runClaudeRoute()` that pass `model`/`effort` through to the spawned `claude` process. Nothing outside `src/index.ts` depends on these — this is the final integration point.

This task has no dedicated automated test (consistent with the existing convention — `src/index.ts` has no test file because it's CLI wiring around `spawnSync`, and the pure logic it calls is already fully tested in Tasks 1–3). Verification is `pnpm typecheck`, the full `pnpm test` suite (confirms nothing else broke), and a manual CLI-argument-validation check that exercises the new flags without invoking the real `claude` binary.

- [ ] **Step 1: Update imports**

In `src/index.ts`, change line 19 from:

```ts
import type { RouteDecision, RouteTarget } from "./types.js";
```

to:

```ts
import type { Classification, EffortLevel, RouteDecision, RouteTarget } from "./types.js";
```

Add two new imports near the top, after the existing `import { decideRoute } from "./route.js";` line:

```ts
import { decideRoute } from "./route.js";
import { pickModelTier } from "./tier.js";
import { buildClaudeArgs } from "./claudeArgs.js";
```

- [ ] **Step 2: Extend `CliArgs` and `parseArgs()`**

Replace the `CliArgs` interface (currently lines 44–51):

```ts
interface CliArgs {
  prompt: string;
  continueSession: boolean;
  noRoute: boolean;
  forceTarget: RouteTarget | null;
  showStats: boolean;
  clear: boolean;
}
```

with:

```ts
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
```

Replace the whole `parseArgs()` function (currently lines 53–82):

```ts
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: "",
    continueSession: false,
    noRoute: false,
    forceTarget: null,
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
    } else parts.push(arg);
  }
  args.prompt = parts.join(" ").trim();
  return args;
}
```

with:

```ts
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
```

- [ ] **Step 3: Update the `USAGE` string**

Replace the `USAGE` constant (currently lines 35–42):

```ts
const USAGE = `Usage: prompt-router "your prompt"
  init                 interactive setup wizard
  -c, --continue       carry the previous conversation into this one
      --to <target>    force a backend: claude | local | openrouter
      --no-route       skip optimization and routing, go straight to Claude Code
      --stats          show routing statistics
      --clear-session  forget the stored conversation
`;
```

with:

```ts
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
```

- [ ] **Step 4: Update `routeDetail()`**

Replace the `routeDetail()` function (currently lines 100–106):

```ts
function routeDetail(target: RouteTarget, config: RouterConfig): string {
  if (target === "local") return `${TARGET_LABELS.local} (${config.local.model})`;
  if (target === "openrouter") {
    return `${TARGET_LABELS.openrouter} (${config.openrouter.answerModels[0] ?? "free model"})`;
  }
  return TARGET_LABELS.claude;
}
```

with:

```ts
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
```

- [ ] **Step 5: Update `runClaude()` to accept and forward model/effort**

Replace the `runClaude()` function (currently lines 108–122):

```ts
function runClaude(text: string, continueSession: boolean): never {
  const useShell = process.platform === "win32";
  const claudeArgs = toShellArgs(continueSession ? ["-c", text] : [text], useShell);
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
```

with:

```ts
function runClaude(
  text: string,
  continueSession: boolean,
  model?: string,
  effort?: EffortLevel,
): never {
  const useShell = process.platform === "win32";
  const claudeArgs = toShellArgs(buildClaudeArgs(text, continueSession, model, effort), useShell);
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
```

- [ ] **Step 6: Add the `withModelTier()` helper**

Immediately after the `logRouting()` function (currently lines 137–145, ending with the closing `}` after `});`), insert:

```ts
function withModelTier(
  decision: RouteDecision,
  cls: Classification | null,
  config: RouterConfig,
  args: CliArgs,
): RouteDecision {
  if (decision.target !== "claude") return decision;
  const auto = config.modelSelection.enabled
    ? pickModelTier(cls?.complexity ?? null, decision.uncertain, {
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
```

- [ ] **Step 7: Pass `decision.model`/`decision.effort` through `runClaudeRoute()`**

In `runClaudeRoute()`, change the final line (currently `runClaude(finalPrompt, args.continueSession);` at the end of the function, around line 169):

```ts
  runClaude(finalPrompt, args.continueSession);
}
```

to:

```ts
  runClaude(finalPrompt, args.continueSession, decision.model, decision.effort);
}
```

- [ ] **Step 8: Apply `withModelTier()` in `main()`**

In `main()`, replace this block (currently lines 286–309):

```ts
  let decision: RouteDecision = args.forceTarget
    ? { target: args.forceTarget, planFirst: false, uncertain: false }
    : decideRoute(cls, heuristic, {
        confidenceThreshold: config.thresholds.confidence,
        planComplexityThreshold: config.thresholds.planComplexity,
        localAvailable: config.local.enabled,
      });

  let finalPrompt = cls?.optimizedPrompt ?? args.prompt;

  if (!args.forceTarget) {
    showRouting(args.prompt, finalPrompt, decision, routeDetail(decision.target, config), cls);
    const choice = await askRouteChoice();
    process.stderr.write("\n");
    if (choice.action === "reject") finalPrompt = args.prompt;
    else if (choice.action === "edit") finalPrompt = openInEditor(finalPrompt);
    if (choice.overrideTarget) {
      decision = {
        ...decision,
        target: choice.overrideTarget,
        planFirst: choice.overrideTarget === "claude" ? decision.planFirst : false,
      };
    }
  }
```

with:

```ts
  let decision: RouteDecision = args.forceTarget
    ? { target: args.forceTarget, planFirst: false, uncertain: false }
    : decideRoute(cls, heuristic, {
        confidenceThreshold: config.thresholds.confidence,
        planComplexityThreshold: config.thresholds.planComplexity,
        localAvailable: config.local.enabled,
      });
  decision = withModelTier(decision, cls, config, args);

  let finalPrompt = cls?.optimizedPrompt ?? args.prompt;

  if (!args.forceTarget) {
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
        config,
        args,
      );
    }
  }
```

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 10: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all pre-existing tests plus the new `tier.test.ts`, `claudeArgs.test.ts`, and updated `config.test.ts` cases.

- [ ] **Step 11: Manual CLI-argument-validation check**

These checks exercise `parseArgs()`'s new branches without reaching `spawnSync("claude", ...)`, since invalid input exits before any network or process-spawn calls:

Run: `pnpm dev --effort bogus "test prompt"`
Expected: prints `prompt-router: --effort expects low | medium | high | xhigh | max` to stderr and exits with a non-zero status.

Run: `pnpm dev --model "" "test prompt"`

(Empty string is falsy, so this exercises the missing-value guard the same way an omitted value would.)
Expected: prints `prompt-router: --model expects a model name` to stderr and exits with a non-zero status.

- [ ] **Step 12: Commit**

```bash
git add src/index.ts
git commit -m "Auto-select Claude Code --model/--effort from task complexity"
```

---

### Task 5: Update `README.md`

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by other tasks — this is the last task.

- [ ] **Step 1: Add the two new flags to the Usage section**

In `README.md`, find the `## Usage` section's fenced code block (currently around lines 115–125):

```bash
prompt-router "fix the race condition in the session store"   # → Claude Code (plan-first if complex)
prompt-router "what's the difference between TCP and UDP?"    # → local model
prompt-router "compare event sourcing with CRUD for a bank"   # → OpenRouter

prompt-router -c "and which one scales better?"   # follow-up: carries conversation memory
prompt-router --to local "explain this simply"    # force a backend (claude | local | openrouter)
prompt-router --no-route "quick edit"             # skip everything, straight to Claude Code
prompt-router --stats                             # how much Claude usage you've saved
prompt-router --clear-session                     # forget the stored conversation
```

Replace it with:

```bash
prompt-router "fix the race condition in the session store"   # → Claude Code (plan-first if complex)
prompt-router "what's the difference between TCP and UDP?"    # → local model
prompt-router "compare event sourcing with CRUD for a bank"   # → OpenRouter

prompt-router -c "and which one scales better?"   # follow-up: carries conversation memory
prompt-router --to local "explain this simply"    # force a backend (claude | local | openrouter)
prompt-router --model opus --effort high "..."    # force Claude Code's model/effort for one run
prompt-router --no-route "quick edit"             # skip everything, straight to Claude Code
prompt-router --stats                             # how much Claude usage you've saved
prompt-router --clear-session                     # forget the stored conversation
```

- [ ] **Step 2: Add the new section to the Table of Contents**

In `README.md`'s table of contents (currently lines 37–51), find:

```markdown
- [The plan-first pipeline](#the-plan-first-pipeline)
- [Local models](#local-models)
```

Replace it with:

```markdown
- [The plan-first pipeline](#the-plan-first-pipeline)
- [Model & effort selection](#model--effort-selection)
- [Local models](#local-models)
```

- [ ] **Step 3: Add a "Model & effort selection" section**

Immediately after the `## The plan-first pipeline` section and before `## Local models` (currently around line 146), insert a new section:

```markdown
## Model & effort selection

When a task routes to Claude Code, prompt-router also picks `--model` and
`--effort` from the same complexity score used for the plan-first decision:

| Complexity | Model | Effort |
|---|---|---|
| below `modelTierLow` | `haiku` | `low` |
| between the two thresholds | `sonnet` | `medium` |
| at or above `modelTierHigh` | `opus` | `high` |

A low-confidence classification escalates one tier, on the same "misrouting
code is costly" principle the plan-first threshold uses. With no complexity
signal at all (`--no-route`, a very short prompt, or the classifier being
down), no flags are passed and Claude Code's own default applies.

Force a one-off override for a single run with `--model`/`--effort` — either
flag can be set independently, and the other still auto-picks. Disable
auto-selection entirely with `"modelSelection": { "enabled": false }` in
`config.json`. This only affects the Claude Code route; it's a no-op for the
local/OpenRouter routes.
```

- [ ] **Step 4: Add the new config fields to the Configuration section**

In `README.md`'s `## Configuration` section, find the `thresholds` block inside the documented config JSON (currently around lines 185–188):

```jsonc
  "thresholds": {
    "confidence": 0.6,          // below this, the route is flagged for your attention
    "planComplexity": 0.7       // at or above this, code tasks get the plan-first pipeline
  },
```

Replace it with:

```jsonc
  "thresholds": {
    "confidence": 0.6,          // below this, the route is flagged for your attention
    "planComplexity": 0.7,      // at or above this, code tasks get the plan-first pipeline
    "modelTierLow": 0.35,       // below this, Claude Code gets --model haiku --effort low
    "modelTierHigh": 0.7        // at or above this, Claude Code gets --model opus --effort high
  },
```

And immediately before that `thresholds` block, add the new `modelSelection` block (matching the existing `local`/`openrouter` block style):

```jsonc
  "modelSelection": {
    "enabled": true              // false = never auto-pick --model/--effort for Claude Code
  },
```

- [ ] **Step 5: Verify the README renders sensibly**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (README changes don't affect code, this just confirms Task 4's changes are still green before the docs commit lands on top of them).

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "Document auto model/effort selection for the Claude Code route"
```
