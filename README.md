# prompt-router

**Route every prompt to the AI that deserves it.**

[![CI](https://github.com/PTB-0/prompt-router/actions/workflows/ci.yml/badge.svg)](https://github.com/PTB-0/prompt-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

Sending "what's the capital of France?" to a frontier coding agent is a waste. Sending "build the production feature" to a 7B model is a disaster. **prompt-router** ends both: it optimizes your prompt, detects what you actually want, and dispatches it to the right backend — automatically, with a one-key override.

> **Make the simple work cheap. Make the hard work easy.**

```
$ prompt-router "fix the login bug in auth.ts"

  ────────────────────────────────────────────────────────
  prompt-router — optimized & routed
  ────────────────────────────────────────────────────────

  ORIGINAL
  fix the login bug in auth.ts

  OPTIMIZED
  In auth.ts, identify and fix the bug causing login failures.
  Check token validation and session handling. Keep the change
  minimal and do not modify unrelated files.

  ROUTE → Claude Code
  (code, complexity 0.4, confidence 0.9)

  ────────────────────────────────────────────────────────
  [Y]es  [n]o, original  [e]dit  [1] Claude Code  (15s timeout → Y):
```

---

## Table of contents

- [How it works](#how-it-works)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
- [The plan-first pipeline](#the-plan-first-pipeline)
- [Model & effort selection](#model--effort-selection)
- [Local models](#local-models)
- [Configuration](#configuration)
- [Graceful degradation](#graceful-degradation)
- [Privacy](#privacy)
- [Development](#development)
- [Roadmap](#roadmap)
- [Related](#related)

---

## How it works

One free LLM call on [OpenRouter](https://openrouter.ai) does two jobs at once: it **rewrites your prompt** to be precise and actionable, and it **classifies** it. Instant heuristics (code verbs in English and Turkish, file references, whether you're inside a repo) pre-filter the obvious cases before the network is even touched.

```
                     ┌──────────────────────────────┐
       prompt ──────▶│   optimize + classify        │   one free LLM call
                     │   (+ instant heuristics)     │
                     └──────────────┬───────────────┘
                                    │
                  ┌─────────────────┼──────────────────┐
                  ▼                 ▼                  ▼
             code task        simple question     broad question
                  │                 │                  │
         complex? ──▶ draft plan    ▼                  ▼
                  │   you approve   local model     OpenRouter
                  ▼                 (LM Studio,     (strong free model
             Claude Code            Ollama, ...)     + fallback chain)
```

| Your prompt looks like… | Goes to | Why |
|---|---|---|
| A coding task | **Claude Code** | Agentic execution where it matters |
| A *complex* coding task | **Claude Code + plan** | A free model drafts an implementation plan first; you review it; Claude starts with a head start instead of exploring |
| A quick question | **Your local model** | Instant, free, private, no rate limits |
| A broad, open-ended question | **OpenRouter free model** | Long-form answers without burning Claude usage |

**The router is deliberately paranoid — about code.** Misrouting a code task to a small model costs you real work; over-serving a question only costs tokens. So when the classifier is missing or unsure, a code verdict from either signal wins and escalates to Claude Code. A *confident* classification is trusted over the regex heuristics, though — "write a poem" doesn't become a code task just because you ran it inside a repo — and you always get the confirmation prompt with single-key overrides.

## Installation

```bash
npm install -g prompt-router
```

Requires Node.js ≥ 18 and the [Claude Code CLI](https://claude.com/claude-code) for the coding route.

## Quick start

**1.** Run the setup wizard — it asks for your OpenRouter key, probes for a local model, and writes the config for you:

```bash
prompt-router init
```

Prefer to do it by hand? Get a free API key at [openrouter.ai](https://openrouter.ai) and create `~/.config/prompt-router/.env`:

```env
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxx
```

**2.** *(Optional but recommended)* Run a local model with [LM Studio](https://lmstudio.ai) — prompt-router will even start the server for you via `lms server start`. No local model? Simple questions fall back to OpenRouter automatically.

**3.** Route something:

```bash
prompt-router "what is a monad?"
```

## Usage

```bash
prompt-router "fix the race condition in the session store"   # → Claude Code (plan-first if complex)
prompt-router "what's the difference between TCP and UDP?"    # → local model
prompt-router "compare event sourcing with CRUD for a bank"   # → OpenRouter

prompt-router -c "and which one scales better?"   # follow-up: carries conversation memory
prompt-router --to local "explain this simply"    # force a backend — any enabled configured id
prompt-router --model opus --effort high "..."    # force Claude Code's model/effort for one run
prompt-router --no-route "quick edit"             # skip everything, straight to the agentic backend
prompt-router --stats                             # per-backend spend, and what the routing saved
prompt-router --clear-session                     # forget the stored conversation
```

Every routed prompt shows the confirmation bar first:

| Key | Action |
|---|---|
| `Y` / Enter / timeout | Accept the optimized prompt and the chosen route |
| `n` | Keep your original wording (same route) |
| `e` | Edit the optimized prompt in `$EDITOR` |
| `1` / `2` / `3` | Override the route: the first three candidates for this category, in the order the bar lists them |
| `c` / `l` / `o` | Legacy aliases, hardwired to the backend ids `claude` / `local` / `openrouter` — kept for muscle memory, no longer shown, and a no-op if you rename or remove those backends |

Only the numeric keys are advertised, because which backends are offered depends on the category and on your registry: with the default config a code prompt has one candidate (`[1] Claude Code`) and a simple question has two, since only OpenRouter declares `deep-qa`.

## The plan-first pipeline

For code tasks classified above the complexity threshold, prompt-router inserts one extra step before Claude Code starts:

1. A strong free model drafts a concise, numbered implementation plan.
2. The plan is shown to you — accept it, edit it, or skip it.
3. The approved plan is attached to your prompt, so Claude Code begins executing instead of exploring.

You spend zero premium tokens on planning, and the expensive agent gets a map. This is the "make the hard work easy" half of the deal.

## Model & effort selection

When a task routes to Claude Code, prompt-router also picks `--model` and
`--effort` from the same complexity score used for the plan-first decision:

| Complexity | Model | Effort |
|---|---|---|
| below `modelTierLow` | `haiku` | `low` |
| between the two thresholds | `sonnet` | `medium` |
| at or above `modelTierHigh` | `opus` | `high` |

A low-confidence classification escalates one tier, on the same "misrouting
code is costly" principle the plan-first threshold uses. When the classifier
is unavailable (no API key, timeout), a conservative built-in estimate keeps
the pick per-task: small-edit markers (typo, rename, readme, ...) drop to the
low tier, system-wide markers (migration, "entire", production, very long
prompts) raise it to the high tier, and everything else runs the middle tier.
Only `--no-route` passes no flags at all, leaving Claude Code's own default.

Force a one-off override for a single run with `--model`/`--effort` — either
flag can be set independently, and the other still auto-picks. Disable
auto-selection entirely with `"modelSelection": { "enabled": false }` in
`config.json`. This only affects the Claude Code route; it's a no-op for the
local/OpenRouter routes.

## Local models

Any OpenAI-compatible server works — LM Studio, Ollama, llama.cpp, vLLM:

- **LM Studio** (default): prompt-router probes `http://localhost:1234/v1`, and if the server is down it runs `lms server start` and waits for it to come up.
- **Ollama or anything else**: point the `local` backend's `baseUrl` at it (e.g. `http://localhost:11434/v1`) and set your model name.
- **No GPU?** Set the `local` backend's `"enabled": false` (or just don't run a server) — simple questions route to OpenRouter instead. Nothing breaks.

## Configuration

Everything lives in `~/.config/prompt-router/` (override the directory with `PROMPT_ROUTER_DIR`). Every field is optional and falls back to its built-in default. The block below shows the defaults worth editing rather than every key a backend accepts — `defaultBackends()` in `src/config.ts` is the exhaustive list:

```jsonc
// ~/.config/prompt-router/config.json
{
  "backends": [
    {
      "id": "claude", "kind": "exec", "label": "Claude Code",
      "categories": ["code"], "priority": 10, "enabled": true,
      "command": "claude",
      "args": ["{model}", "{effort}", "{continue}", "{prompt}"],
      "supportsModelTier": true, "supportsPlan": true, "supportsContinue": true
    },
    {
      "id": "local", "kind": "chat", "label": "local model",
      "categories": ["simple-qa"], "priority": 10, "enabled": true,
      "baseUrl": "http://localhost:1234/v1",
      "models": ["gemma-4-12b-qat"],
      "probe": true,              // check /models before dispatching
      "autoStart": true,          // try `lms server start` when the server is down
      "autoStartCommand": ["lms", "server", "start"]
    },
    {
      "id": "openrouter", "kind": "chat", "label": "OpenRouter",
      "categories": ["simple-qa", "deep-qa"], "priority": 5, "enabled": true,
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",   // the NAME of the var, never the key
      "models": [                 // fallback chain — first healthy model wins
        "openai/gpt-oss-120b:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
        "qwen/qwen3-next-80b-a3b-instruct:free"
      ]
    }
  ],
  "openrouter": {                 // the classifier and planner — infrastructure,
    "baseUrl": "https://openrouter.ai/api/v1",   // not routable backends
    "classifierModels": [
      "openai/gpt-oss-20b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "meta-llama/llama-3.2-3b-instruct:free"
    ],
    "planModels": [
      "openai/gpt-oss-120b:free",
      "qwen/qwen3-coder:free",
      "nvidia/nemotron-3-super-120b-a12b:free"
    ]
  },
  "modelSelection": {
    "enabled": true              // false = never auto-pick --model/--effort for Claude Code
  },
  "thresholds": {
    "confidence": 0.6,          // below this, the route is flagged for your attention
    "planComplexity": 0.7,      // at or above this, code tasks get the plan-first pipeline
    "modelTierLow": 0.35,       // below this, Claude Code gets --model haiku --effort low
    "modelTierHigh": 0.7        // at or above this, Claude Code gets --model opus --effort high
  },
  "session": { "maxMessages": 12 },
  "logging": { "routingLog": false },
  "timeoutMs": 8000
}
```

Free models come and go — the model lists are **fallback chains you can edit without waiting for a release**.

Backends are matched to a category and ordered by `priority`: the highest-priority
healthy one serves the prompt, and the rest become its fallback chain. Adding
another coding agent, or a paid model for hard questions, is a config edit rather
than a release. **A config without a `backends` key keeps working** — the three
defaults above are derived from the older `local` / `openrouter.answerModels`
blocks, so nothing needs migrating by hand.

Setting `"enabled": false` takes a backend out of routing entirely — `--to` on it
is refused rather than silently overriding the setting. And an exec backend's
`modelPricing` (not shown above; the `claude` default carries reference prices for
`haiku`, `sonnet` and `opus`) is what `--stats` prices its counterfactual against:
the highest-priority enabled exec backend that declares any. Give a coding agent
you add its own `modelPricing` if you want it to be the yardstick — otherwise
`--stats` reports your actual spend and says there is nothing to compare it to.

| Environment variable | Overrides |
|---|---|
| `OPENROUTER_API_KEY` | API key (required for classification, deep answers, plans) |
| `PROMPT_ROUTER_LOCAL_URL` | the `local` backend's `baseUrl` |
| `PROMPT_ROUTER_LOCAL_MODEL` | the `local` backend's `models` (replaces the chain) |
| `PROMPT_ROUTER_TIMEOUT` | `timeoutMs` |
| `PROMPT_ROUTER_DIR` | Config/session/stats directory |

## Graceful degradation

prompt-router assumes things fail and never leaves you stranded:

| When… | It… |
|---|---|
| The classifier is down or you have no API key | Routes by the built-in heuristics: code tasks still go to Claude Code (with an estimated model/effort tier), everything else goes to the chat backends |
| The local server is down and can't be started | Falls back to OpenRouter |
| Every backend the category offers has failed | Sweeps the remaining enabled chat backends — the local server included, even when the category it declares isn't the one that got picked — and only then hands off to Claude Code as a last resort. This is what keeps a no-API-key run on the local model instead of the paid agent |
| A free model is rate-limited or stalls mid-stream | Retries with the next model in the chain (a silent stream is cut after `timeoutMs` of inactivity) |
| Every answer backend fails | Hands off to Claude Code |
| Claude Code itself isn't installed | Prints your prompt so it's never lost |
| The prompt is trivially short | Skips the optimizer call but still routes by heuristics |
| stdin isn't a terminal (pipes, CI) | Accepts the proposed route immediately instead of eating piped data as keystrokes |

## Privacy

- **Prompt content is never logged.** Not in stats, not in the routing log.
- `--stats` stores per-backend counts, token totals, and cost figures in a local file — still no prompt content.
- The opt-in routing log (`logging.routingLog: true`) records timestamps, targets, and confidence flags — useful for tuning thresholds, still content-free.
- Conversation memory (`-c`) lives in one local JSON file you can delete anytime with `--clear-session`.

## Development

```bash
git clone https://github.com/PTB-0/prompt-router
cd prompt-router
pnpm install
pnpm test        # vitest — the routing logic is fully unit-tested
pnpm typecheck   # TypeScript strict, no `any`
pnpm dev "your prompt"
```

Built test-first: every routing rule in `src/route.ts` and every heuristic in `src/heuristics.ts` is pinned by a test in `test/`. CI runs the suite on Linux and Windows, Node 18 and 22.

## Roadmap

- [x] `prompt-router init` — interactive setup wizard
- [ ] npm publish with GitHub Actions provenance
- [ ] Reuse [prompt-op](https://github.com/PTB-0/prompt-op)'s optimizer as a library dependency
- [x] Per-backend capability manifests

## Related

- [prompt-op](https://github.com/PTB-0/prompt-op) — the sibling tool this grew out of: prompt optimization for Claude Code, without routing.

## License

[MIT](LICENSE) © 2026 Ege



<!-- gonna relase v4 soon. it will be fire !!! -->
