# Auto model/effort selection for the Claude Code route

**Date:** 2026-07-12
**Status:** Approved

## Problem

`prompt-router` already classifies every code task with a `complexity` score
(0–1) before routing it to Claude Code, but it always launches `claude` with
no `--model`/`--effort` flags, leaving Claude Code's own defaults in place
regardless of how heavy the task is. Claude Code's CLI exposes both flags
directly (`--model <haiku|sonnet|opus|...>`, `--effort <low|medium|high|xhigh|max>`),
so the router can turn its existing complexity signal into a concrete
model/effort pick instead of leaving it on the table.

## Goals

- When a prompt routes to Claude Code, automatically pick `--model` and
  `--effort` based on the task's classified complexity.
- Make the tier boundaries configurable (same pattern as
  `thresholds.planComplexity`), with an escape hatch to disable auto-picking
  entirely.
- Let a user force one-off `--model`/`--effort` values for a single run.
- Degrade gracefully to "no flags" (Claude Code's own default) whenever there
  is no complexity signal to act on — consistent with the project's existing
  graceful-degradation philosophy.

## Non-goals

- No changes to `decideRoute()`'s target/category/planFirst logic in
  `src/route.ts`.
- No changes to the routing log format.
- No new interactive override keys beyond CLI flags (`--model`/`--effort`).
- No per-category tiering — complexity is the only signal.

## Design

### `src/tier.ts` (new)

A pure, unit-tested module, structurally parallel to `src/heuristics.ts` and
`src/route.ts`:

```ts
export type ClaudeModel = "haiku" | "sonnet" | "opus";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelTier {
  model: ClaudeModel;
  effort: EffortLevel;
}

export interface TierOptions {
  lowThreshold: number;
  highThreshold: number;
}

export function pickModelTier(
  complexity: number | null,
  uncertain: boolean,
  opts: TierOptions,
): ModelTier | null;
```

Behavior:
- `complexity === null` → returns `null`. Callers omit `--model`/`--effort`
  entirely and Claude Code's own default takes over. Covers `--no-route`,
  sub-`MIN_PROMPT_LENGTH` prompts, and classifier-unavailable cases.
- Otherwise, pick a base tier by threshold:
  - `complexity < opts.lowThreshold` → `{ model: "haiku", effort: "low" }`
  - `opts.lowThreshold <= complexity < opts.highThreshold` → `{ model: "sonnet", effort: "medium" }`
  - `complexity >= opts.highThreshold` → `{ model: "opus", effort: "high" }`
- If `uncertain` is true, bump one tier up (capped at the top tier). Mirrors
  the existing "misrouting code is costly" escalation already present in
  `decideRoute()`.

Default thresholds: `lowThreshold = 0.35`, `highThreshold = 0.7`.

### `src/types.ts`

Add `EffortLevel` (re-exported or imported from `tier.ts`) and extend
`RouteDecision`:

```ts
export interface RouteDecision {
  target: RouteTarget;
  planFirst: boolean;
  uncertain: boolean;
  model?: string;
  effort?: EffortLevel;
}
```

### `src/config.ts`

New config surface, following the `local.enabled` / `thresholds.planComplexity`
patterns exactly:

```jsonc
{
  "modelSelection": { "enabled": true },
  "thresholds": {
    "confidence": 0.6,
    "planComplexity": 0.7,
    "modelTierLow": 0.35,
    "modelTierHigh": 0.7
  }
}
```

`resolveConfig()` parses `modelSelection.enabled` via the existing
`pickBoolean` helper and the two new thresholds via the existing `pickScore`
helper (already clamps to [0,1]). No env var overrides needed for these (none
of the existing threshold fields have them either).

### `src/index.ts`

- **CLI flags:** add `--model <name>` (forwarded to Claude Code as-is, no
  validation beyond non-empty — Claude Code accepts aliases like `fable` too)
  and `--effort <level>` (validated against the 5-value enum, exits with an
  error message on an invalid value, same style as the existing `--to`
  validation). Both stored on `CliArgs` as `forceModel?: string` /
  `forceEffort?: EffortLevel`. Documented in the `USAGE` string.
- **`withModelTier(decision, cls, config, args)`** (local helper): no-ops
  unless `decision.target === "claude"`. When it applies, computes the
  auto-pick via `pickModelTier(cls?.complexity ?? null, decision.uncertain, {...})`
  (skipped entirely, i.e. treated as `null`, when `config.modelSelection.enabled`
  is `false`), then sets `decision.model = args.forceModel ?? auto?.model` and
  `decision.effort = args.forceEffort ?? auto?.effort`. Per-field override, so
  a user can force just the model and let effort stay auto-picked, or vice
  versa.
- Called once right after the initial `decision` is computed (whether via
  `decideRoute()` or the `--to` force-target branch), and again after the
  interactive `[c]` override key changes the target to `claude` (the only
  point where the target can change post-hoc).
- **`routeDetail()`** (existing local formatter): the `claude` branch now
  checks `decision.model`/`decision.effort` and renders
  `"Claude Code (sonnet, effort: medium)"` when set, falling back to the bare
  label otherwise. This is what the user sees in the routing banner before
  confirming.
- **`runClaude()`**: gains optional `model?: string, effort?: EffortLevel`
  params, prepending `--model <model>` / `--effort <effort>` (only the ones
  that are set) to the arg list before the existing `-c`/prompt positional
  args, ahead of the existing `toShellArgs()` quoting step.
- **`runClaudeRoute()`**: passes `decision.model, decision.effort` through to
  its `runClaude()` call at the end.
- All other `runClaude()` call sites (pass-through paths with no
  classification) are unchanged — they simply don't pass model/effort, so
  Claude Code's own default applies, matching current behavior.

### Interaction with existing routes

- `local` / `openrouter` targets: `withModelTier` no-ops, `forceModel`/
  `forceEffort` are silently unused if the final route isn't Claude Code.
  Documented in the README as "only takes effect when routed to Claude Code."

## Testing

- `test/tier.test.ts` (new): boundary behavior at/below/above each threshold,
  the uncertain-escalation bump including the cap at the top tier, and the
  `null`-complexity passthrough.
- `test/config.test.ts`: cases for `modelSelection.enabled` and the two new
  threshold fields (default + override + invalid-value fallback).
- `test/route.test.ts`: unchanged — `decideRoute()` isn't touched.
- `src/index.ts` remains without a dedicated test file, consistent with the
  current project convention (CLI wiring, not pure logic).

## Documentation

`README.md` updates:
- Usage table: document `--model`/`--effort` flags.
- Configuration section: add `modelSelection` and the two new thresholds to
  the documented config JSON block and defaults.
- A short note that model/effort auto-selection only applies to the Claude
  Code route, with the confidence-driven escalation behavior explained
  alongside the existing plan-first threshold description.
