# Backend Registry, Capability Manifests & Cost Accounting — Design

**Date:** 2026-07-26
**Status:** Approved
**Scope:** Replace the three hard-coded route targets with a config-defined backend
registry carrying capability manifests, and use those manifests' pricing to report
real spend and counterfactual savings in `--stats`.

## Problem

Three limits in the current design motivate this work:

1. **Targets are hard-coded.** `RouteTarget` is the literal union
   `"claude" | "local" | "openrouter"`, and `decideRoute` maps a category straight
   onto one of them. Running a second local model, adding a paid OpenRouter tier for
   hard reasoning, or dispatching to another coding agent all require code changes.
2. **Capabilities are implicit.** Plan-first and model/effort tiering are hard-wired
   to the Claude Code route. Nothing describes what a backend can actually do, so
   another agent cannot be substituted safely.
3. **The savings claim is unmeasured.** The README promises "how much Claude usage
   you've saved", but `stats.ts` stores three integers. There is no token or cost
   accounting behind the product's central pitch.

The roadmap item "per-backend capability manifests" is the first two; the manifest's
pricing field makes the third nearly free, so both ship together.

Out of scope: reusing prompt-op as a library (separate spec — prompt-op currently
exposes only a `bin`, and its optimizer does strictly less than `classify.ts`, which
returns the rewrite *and* the classification in one call).

## Goals

- Backends are declared in config, not code. Adding one is a few lines of JSON.
- Two kinds only: `chat` (OpenAI-compatible HTTP streaming) and `exec` (spawn a CLI
  and hand over the terminal). No arbitrary plugin code loading.
- Each backend declares a capability manifest: categories served, priority, feature
  support flags, and pricing.
- `--stats` reports per-backend counts/tokens/spend, per-category distribution,
  actual spend, and a counterfactual "saved vs. all-Claude" figure.
- No existing user has to edit their config, and no documented degradation behavior
  regresses.

## Non-goals (YAGNI)

- JS/npm plugin modules with their own dispatch logic. Rejected: arbitrary code
  execution, no sandbox, maintenance burden — config with two kinds covers the
  realistic cases.
- A third backend kind. If one is needed later the tagged union extends cleanly.
- Backfilling token/cost history for existing `stats.json` files. The data does not
  exist; inventing it would undermine the numbers' credibility.

## Architecture

Approach: **tagged-union data plus pure functions** — matching the codebase's
existing style (`route.ts`, `heuristics.ts`, and `tier.ts` are all pure functions
over plain data with injected `fetch`). Class-based adapters were rejected as
ceremony that fits poorly, since `exec` dispatch terminates the process while `chat`
dispatch returns text; a shared `dispatch()` contract would be artificial.

### Data model

```ts
// types.ts
export type BackendKind = "chat" | "exec";

export interface Pricing {
  inputPer1M: number;   // USD per 1M input tokens; 0 = free
  outputPer1M: number;  // USD per 1M output tokens; 0 = free
}

interface BackendBase {
  id: string;              // "claude" | "local" | "openrouter" | "aider" | ...
  categories: Category[];  // which categories this backend serves
  priority: number;        // higher wins within a category
  enabled: boolean;
}

export interface ChatBackend extends BackendBase {
  kind: "chat";
  baseUrl: string;
  apiKeyEnv?: string;   // NAME of the env var holding the key — never the key itself
  models: string[];     // internal fallback chain (formerly openrouter.answerModels)
  autoStart?: boolean;  // `lms server start` behavior (formerly local.autoStart)
  pricing: Pricing;
}

export interface ExecBackend extends BackendBase {
  kind: "exec";
  command: string;   // "claude" | "aider" | "gemini"
  args: string[];    // template with {prompt} {model} {effort} {continue}
  supportsModelTier?: boolean;  // claude: true → tier.ts picks --model/--effort
  supportsPlan?: boolean;       // claude: true → plan-first pipeline is eligible
  supportsContinue?: boolean;   // maps -c / --continue
  modelPricing?: Record<string, Pricing>; // haiku/sonnet/opus — counterfactual reference
}

export type Backend = ChatBackend | ExecBackend;
```

Keys are referenced by env var *name* (`apiKeyEnv`), never stored in `config.json`.

### Module map

| Module | Role |
|---|---|
| `backends.ts` *(new)* | `loadBackends(config)`, `selectCandidates()`, exec arg-template expansion |
| `cost.ts` *(new)* | token counting, pricing, counterfactual computation |
| `dispatch.ts` *(new)* | switch on `kind`: chat → `streamChat`, exec → spawn + hand over |
| `route.ts` *(changed)* | returns a **category decision**, not a concrete target |
| `claudeArgs.ts` → `execArgs.ts` | `buildClaudeArgs` generalizes to template + placeholders |
| `stats.ts` *(changed)* | per-backend `{count, inTok, outTok, spend}`, schema version |
| `config.ts` *(changed)* | `backends` schema + derivation from the legacy schema |
| `index.ts` *(shrinks)* | CLI flow and orchestration only |
| `tier.ts`, `plan.ts`, `llm.ts`, `heuristics.ts`, `classify.ts` | reused; `llm.ts` gains usage capture |

**The "brain" is not a backend.** The classifier, planner, and optimizer calls stay
under `config.openrouter` (`apiKey`, `baseUrl`, `classifierModels`, `planModels`).
Only `answerModels` moves into a chat backend named `openrouter`.

### Route flow

```
prompt
  └─▶ heuristics + classify              (unchanged)
        └─▶ decideRoute() → { category, complexity, uncertain }
              └─▶ selectCandidates(category, backends)
                    → ordered candidates [b1, b2, b3]   (priority DESC)
                          └─▶ first healthy candidate = target
                                └─▶ dispatch(kind)
```

`selectCandidates` is pure:

1. keep backends where `enabled === true` and `categories.includes(category)`
2. sort by `priority` descending; ties broken by config order (deterministic)
3. return the ordered list — head is the target, tail is the fallback chain

This is the backend-level analogue of the existing `withModelFallback`: if every
model of a chat backend fails, the next *backend* is tried; if all chat candidates
fail, the current behavior stands — hand off to the exec backend.

### Preserved behavior

| Current rule | Registry equivalent |
|---|---|
| `local.enabled: false` → simple-qa goes to OpenRouter | `enabled: false` drops it from candidates; the next one serves. Same outcome, general mechanism. |
| Code paranoia (uncertain → a code verdict wins) | Unchanged inside `decideRoute` — it is category-level and backend-independent. |
| `planFirst` when complexity ≥ threshold | Additionally requires the selected backend's `supportsPlan`. |
| Model/effort tiering | Applied only when the selected exec backend sets `supportsModelTier`. |
| `--to claude\|local\|openrouter` | Generalizes to any backend id (`--to aider`). The three legacy values are ids, so they still work. |
| `c`/`l`/`o` single-key override | First three candidates bind to `1`/`2`/`3`; the legacy `c`/`l`/`o` letters are kept for muscle memory. |
| Confirmation bar runs for `--to`, skipped only by `--no-route` | Unchanged. |

**Health checks.** `ensureLocalServer`'s probe-and-autostart generalizes to any chat
backend with `autoStart`. For exec backends, health is "is `command` resolvable" —
the existing `isBatchShim` / spawn-error path is preserved.

## Cost accounting

### Token sources

| Backend | Source | Fidelity |
|---|---|---|
| `chat` | `usage{prompt_tokens, completion_tokens}` from the API response | exact |
| `exec` | input `ceil(chars / 4)`; output not observable (terminal handed over) | estimated, input-only |

`llm.ts` currently extracts only `delta.content` from SSE. It gains usage capture
from the final SSE event (OpenRouter emits it with
`stream_options: { include_usage: true }`). If usage is absent, it falls back to the
`chars / 4` estimate and the value is flagged `estimated` — it never errors.

### Two distinct numbers

- **Actual spend** — what was really paid. Free models price at 0, so this stays
  `$0.00` unless a paid chat backend is configured.
- **Counterfactual saved** — what the diverted prompts would have cost on Claude:
  their *exact* token counts times the Claude reference price, where the reference
  model is whatever `tier.ts` would have chosen for that prompt (haiku/sonnet/opus).
  Pricing a cheap question at haiku rates and a heavy one at opus rates keeps the
  figure honest instead of inflated.

Prompts that actually went to Claude are not counted as savings.

### Storage — `stats.json` v2

```jsonc
{
  "version": 2,
  "backends": {
    "local": { "count": 40, "inTok": 120000, "outTok": 60000, "spend": 0 }
  },
  "categories": { "code": 12, "simple-qa": 40, "deep-qa": 18 },
  "saved": { "tokens": 500000, "usd": 4.20 }
}
```

A v1 file (`{claude, local, openrouter}`) migrates on read: counts are preserved,
token and spend fields start at 0.

**Privacy is unchanged.** No new content-bearing field is introduced — only numeric
aggregates. The README's privacy guarantees continue to hold verbatim.

### Output

```
prompt-router stats

  backend      prompts    tokens     spend
  claude            12     48k(in)       —
  local             40       180k    $0.00
  openrouter        18       320k    $0.02

  categories   code 12 · simple-qa 40 · deep-qa 18
  diverted     58 of 70 prompts
  ≈ $4.20 saved vs. all-Claude    (actual spend: $0.02)
```

The `claude` row shows input-only tokens because exec output is not observable.

## Error handling

The documented degradation table stays true, generalized:

| When… | It… |
|---|---|
| The selected backend is unhealthy | Moves to the next candidate (new: backend-level fallback) |
| Every model of a chat backend fails | Moves to the next backend |
| All chat candidates fail | Hands off to the exec backend (existing behavior) |
| The exec command is missing | Reports the error and prints the prompt so it is never lost |
| A backend entry in `config.json` is invalid | Skips that entry with a warning and continues with the rest |
| No candidate exists for the category | Hands off to the exec backend; failing that, prints the prompt |
| `usage` is absent from the response | Falls back to the `chars / 4` estimate, marked `~` |
| `stats.json` is corrupt | Starts from zero — never crashes |

### Config backward compatibility

Existing configs carry `local` and `openrouter` blocks. When `backends` is absent,
`migrateLegacyConfig` derives the three default backends from those blocks; when
present, `backends` wins. Legacy fields (`local.baseUrl`, `local.enabled`,
`openrouter.answerModels`) keep working, so **no user must edit their config**.
Env overrides (`PROMPT_ROUTER_LOCAL_URL`, `PROMPT_ROUTER_LOCAL_MODEL`) apply to the
backend with id `local`. `prompt-router init` writes the new schema.

Two mappings are made explicit because the shapes differ:

- The legacy singular `local.model` becomes a one-element `models` chain
  (`["gemma-4-12b-qat"]`); `openrouter.answerModels` transfers as-is.
- `PROMPT_ROUTER_LOCAL_MODEL` **replaces** the `local` backend's chain with a single
  entry rather than prepending to it, matching today's behavior where the variable
  names the one model that will be used.

## Testing

Every new pure function is pinned by a test, per the project's test-first norm.

| Test file | Coverage |
|---|---|
| `backends.test.ts` *(new)* | `selectCandidates`: priority order, `enabled` filter, category match, empty result, deterministic tie-breaking |
| `backends.test.ts` *(new)* | exec arg templates: `{prompt}`/`{model}`/`{continue}` expansion, absent placeholders, prompts containing spaces |
| `cost.test.ts` *(new)* | usage → cost, fallback to estimate, counterfactual against the tier-selected reference price, zero-price free models |
| `stats.test.ts` *(extended)* | v1 → v2 migration preserving counts, corrupt file, formatting |
| `config.test.ts` *(extended)* | legacy → `backends` derivation, invalid entry skipping, env override mapping |
| `route.test.ts` *(updated)* | now asserts on the category decision; every code-paranoia rule is retained |

`heuristics.test.ts` and the rest of the existing suite stay as the regression net:
the rules do not change, only the shape of the decision does.

## Risks

- **`index.ts` growth.** It is already 458 lines. Dispatch moves to `dispatch.ts` and
  backend selection to `backends.ts`, so `index.ts` should end up smaller, not larger.
- **Counterfactual credibility.** Tying the reference price to the tier the prompt
  would have used avoids valuing every trivial question at opus rates.
- **Migration silence.** Legacy-config derivation must be covered by tests; a silent
  mis-derivation would reroute a user's prompts without warning.
