# Handover — Backend Registry & Cost Accounting (2)

**Written:** 2026-07-28
**Supersedes:** `HANDOVER-2026-07-27-backend-registry.md` (kept for history; everything still live is repeated here — do not work from the older file, its Task 11 diagnosis is only half right)
**Branch:** `main` (user declined worktree isolation, explicit consent)
**HEAD:** `26009da` — *feat: init wizard writes the backend registry; document it*
**Base of this work:** `c5a2a44` — the review/merge range is `c5a2a44..HEAD` (21 commits, 33 files, +3001/−432)
**Plan:** `docs/superpowers/plans/2026-07-26-backend-registry-cost-accounting.md`
**Spec:** `docs/superpowers/specs/2026-07-26-backend-registry-cost-accounting-design.md`
**Ledger:** `.superpowers/sdd/2026-07-26-backend-registry-cost-accounting/progress.md` (git-ignored scratch, current through Task 12)

Execution method: `superpowers:subagent-driven-development` — a fresh implementer subagent per task, a spec+quality review after each, a scoped re-review after each fix round, and a broad whole-branch review at the end.

---

## The goal

Replace prompt-router's three hardcoded routes (Claude Code / local / OpenRouter) with a **backend registry defined in config**, and add **per-backend cost accounting** on top of it.

Concretely, what "done" means:

- Any number of backends, declared in `config.json`, each with a `kind` (`chat` = OpenAI-compatible HTTP, `exec` = spawned CLI), categories it serves, and a priority.
- The router picks a **category**, not a target; candidate selection then orders that category's healthy backends by priority — head serves, the rest are its fallback chain.
- Adding a coding agent or a paid model is a **config edit, not a release**.
- Configs written before the registry existed **keep working untouched** — the three defaults are derived from the legacy `local` / `openrouter.answerModels` blocks.
- `--stats` reports real per-backend spend plus the **counterfactual**: what the same work would have cost on Claude, i.e. what the routing actually saved. Still content-free.

**All of that is built and working.** Twelve of twelve tasks have landed.

---

## Status at a glance

| | |
|---|---|
| Tasks complete | **12 of 12** |
| Tests | **170 passing, 0 failing, 1 skipped** |
| Typecheck | clean (0 errors) |
| Build | succeeds |
| Working tree | **clean** — nothing uncommitted |
| Remaining | final whole-branch review → finish branch → delete scratch |

Verify on resume with `pnpm typecheck && pnpm test && pnpm build`. Trust that and `git log` over recollection.

---

## Remaining work — in order

### 1. Final whole-branch review ← **the next action**

**The user has already authorized the subagent dispatch for this** (asked and answered on 2026-07-28, immediately before this handover was written). No need to re-ask.

- Range: `c5a2a44..HEAD`.
- Dispatch on the most capable model, using `superpowers:requesting-code-review`'s `code-reviewer.md`.
- **Point it at the deferred-minor list below** so it can triage what must be fixed before merge rather than rediscovering it.
- Call out the two items marked **⚠ NEW, UNREVIEWED** — they were written this session and have had no second pair of eyes.
- If it returns findings: one fix dispatch, one scoped re-review, then adjudicate residuals.

### 2. Finish the branch
`superpowers:finishing-a-development-branch`.

### 3. Clean up
- Delete the SDD workspace `.superpowers/sdd/2026-07-26-backend-registry-cost-accounting/` — git history becomes the record.
- Decide the fate of both handover files in `docs/superpowers/`. They were written to survive session limits; once merged they are dead weight. Recommend deleting both in the finishing commit.

---

## What was built

Each commit is one task, plus its fix rounds. Oldest first.

| # | Task | Commit(s) | Fix rounds |
|---|---|---|---|
| 1 | Backend types + config schema, legacy migration | `6d03d29` | — |
| 2 | Candidate selection (`selectCandidates`) | `c8426f0` | — |
| 3 | Exec arg templates (replaced `claudeArgs.ts`) | `2aebc2e` | — |
| 4 | `decideRoute` returns a category | `a2897bc`, `ef4bac5` | 1 |
| 5 | Token usage capture in `llm.ts` | `43149f0` | — |
| 6 | Cost + counterfactual (`cost.ts`) | `4069de4` | — |
| 7 | Stats v2, per-backend, v1 migration | `6e23807`, `116d14e` | 1 |
| 8 | Generalized health probe (`ensureChatBackend`) | `6d910cb`, `89390c1` | 1 |
| 9 | Dispatch module (chat vs exec) | `9903aca`, `e771407` | 1 |
| 10 | Dynamic override keys in the confirmation bar | `b236681` | 1 (report-only) |
| 11 | Wire the registry through the CLI | `8167402`, `21e2689`, `0bd7dc2`, `abe44f6` | 3 (all closed) |
| — | Env overrides vs. declared registry | `bcd600f` | ⚠ new, unreviewed |
| 12 | Init wizard + README | `26009da` | ⚠ new, unreviewed |

Tasks 3–10 deliberately left `src/index.ts` broken; Task 11 made the build green for the first time.

---

## What happened this session (2026-07-28)

### Task 11, fix round 3 — closed (`abe44f6`)

The previous handover diagnosed the single failing test as an ambient-environment problem: `NoDefaultCurrentDirectoryInExePath` is present in this machine's process environment, so the resolver correctly skipped the cwd search and the CLI correctly refused a cwd-resident command. **That diagnosis was right.** Its recommended fix — delete that variable from the child env in `runCli` — was **already in the working tree and was not working**, which the handover did not realise.

The real reason, found by probing rather than reasoning:

- Windows environment variables are case-insensitive, and Node's `process.env` on Windows is a case-insensitive proxy — so `in`, get, and `delete` all work regardless of case.
- `{ ...process.env }` is an **ordinary object**. Its `delete` is case-sensitive.
- Under Vitest on Windows the inherited names arrive **uppercased** — `NODEFAULTCURRENTDIRECTORYINEXEPATH`. `Object.keys(process.env)` shows them uppercased and sorted; reads still work through the proxy, which is what hides it.
- So `delete env.NoDefaultCurrentDirectoryInExePath` on the spread copy silently missed, the variable reached the child, and the CLI refused — correctly.

Proven, not inferred: the same scenario **passes outside Vitest and fails inside**, and a probe test printed parent/copy/child keys all uppercased. Fix is a `stripEnv()` helper doing a case-insensitive delete over `Object.keys`.

Two further things came out of that round:

- **Both cwd tests are now `test.runIf(win32)`.** As written the positive test would have **failed on CI's ubuntu-latest**: off win32, `commandUnresolvable` is a documented no-op and `spawnSync("sentinel")` ENOENTs, so it asserted `status 0` on a platform where the behaviour under test does not exist. This was a latent CI break, not a style choice.
- **The mirror test the old handover suggested now exists**: same fixture, variable *set* in the child env, asserting refusal with the prompt preserved. Positive and mirror differ by exactly one environment variable, which isolates the opt-out as the cause of the difference.

### Task 12 — init wizard + README (`26009da`)

The wizard was writing the legacy `local` / `openrouter.answerModels` blocks — i.e. producing configs in exactly the shape the registry replaced. It now writes `backends` directly and drops both legacy keys (a file carrying both would show the same setting twice with only one copy read). `openrouter.classifierModels` / `planModels` stay: the classifier and planner are router infrastructure, not routable backends.

**Deviation from the brief, deliberate** (standing rule: the finding governs): the brief had `buildInitConfig` rebuild from `defaultBackends()`. That would **silently delete any backend the user added by hand** every time they re-ran setup, since the wizard only ever asks about the local model. It now patches the registry already in effect, and is pinned by a test using a fourth hand-added backend. Declining a local model disables that backend rather than removing it, and keeps the previously chosen address for whenever it gets flipped back on.

Verification beyond the suite:
- The wizard was **smoke-tested hermetically** (temp `PROMPT_ROUTER_DIR`, stdin at EOF, no network): writes `backends`, no legacy `local` block, no `answerModels`, round-trips through `resolveConfig`, and the real `~/.config/prompt-router/` was untouched (mtime of every file compared before/after).
- The README config block was checked against `defaultBackends()` **programmatically** — parsed the jsonc, stripped comments, compared every key shown, round-tripped through `resolveConfig`, confirmed an empty config yields the same backend set. Zero mismatches.

### The out-of-scope fix (`bcd600f`) — needs the user's blessing

`PROMPT_ROUTER_LOCAL_URL` and `PROMPT_ROUTER_LOCAL_MODEL` were folded only into `cfg.local`, which **only the legacy derivation reads**. A config carrying a `backends` array skips that path entirely, so both documented env vars were dead there. Demonstrated directly: legacy config honours them, v2 config ignores them.

This was pre-existing (Task 1), but **Task 12 is what would have made it universal** — the wizard now writes `backends` for everyone, so every user who ran setup would silently lose two documented env vars. Fixing it was a precondition for documenting the env table honestly, so it was fixed rather than deferred. It was **not authorized in advance**; the user has been told and has not objected, but it has had no review.

The pre-existing test `env overrides apply to the local backend` claimed the general property while exercising only the legacy shape — which is why the gap survived. It is renamed to say what it tests, and the declared-registry case is pinned alongside it.

---

## Decisions the user made (standing)

- **Worktree declined** — work happens directly on `main`, with intermediate commits where the build is knowingly broken.
- **Plan-vs-finding conflicts: the finding governs.** Ruled at Task 4. Applied without re-asking at Tasks 7, 9, 11 and 12 — recorded in the ledger each time.
- **Task 11's out-of-scope fixes authorized twice**: first to move cost/tier policy into testable modules and add hermetic CLI tests, then to fix the Windows product bug rather than skip its test.
- **The final whole-branch review is authorized to run as a subagent dispatch** (2026-07-28).

---

## Three real defects the review process caught

Worth knowing, because all three had already been committed and all three were invisible to a passing suite.

1. **Task 8** — the implementer deleted a pre-existing skipped test instead of porting it, leaving *zero* coverage of the ENOENT fast-fail path the brief calls binding.
2. **Task 9** — the implementer skipped the `execSpawnPlan` test on win32, removing CI coverage of the caret-quoting path `src/winShell.ts` exists for, on the one runner where it executes. This repo has previously shipped a real `^--model^` bug there.
3. **Task 11 round 2** — a genuine **product** bug: on Windows the "your prompt is not lost" guarantee did not hold, because `shell: true` routes through cmd.exe, which swallows ENOENT into an ordinary non-zero exit so `result.error` never populated. Fixed in `0bd7dc2`.

---

## Deferred minors — hand these to the final review

None blocking on its own. **Closed this session** are struck through with why.

**⚠ NEW this session, unreviewed — look here first**
- `bcd600f` (local env overrides vs. a declared registry) was written and self-tested in one session with no second reader. It mutates the resolved backend after `resolveBackends`, and targets the backend whose id is literally `local` — arbitrary if someone renames it.
- `buildInitConfig`'s `existing` parameter defaults to `defaultBackends()`, but `runInit` always passes explicitly — the default exists only for the tests.
- The wizard no longer writes `local` / `answerModels`, so a user who downgrades to a pre-registry version loses their local settings. Probably acceptable; unmentioned anywhere.
- The README says "All fields are optional — these are the defaults", but the `claude` backend block omits `modelFlag` / `effortFlag` / `continueFlag` / `modelPricing`. Every field *shown* is verified correct; the block is just not exhaustive.

**Config / types**
- ~~Unused `ChatBackend`/`ExecBackend` type imports at `src/config.ts:5`~~ — closed: `ChatBackend` is now genuinely used, `ExecBackend` removed.
- `resolveBackends` silently falls back to legacy defaults when a declared `backends` array is empty or wholly invalid — a reasonable safety net, undocumented and untested.
- The invalid-entry test emits stderr noise, so `pnpm test` output is not pristine.

**Dead / duplicated**
- `src/route.ts:19`'s `cls?.category === "code"` disjunct is provably dead code — removing it is a behavioural no-op for every input, because the next line returns the same value. Plan-mandated and carried over from the pre-refactor router. Either drop it or comment why it stays.
- `Dispatch.fallbacks` is written and never read; the real chain travels as the separate `candidates` array. Two representations, one dead.

**Behaviour worth a second look**
- `--to` now enables plan-first where it previously forced it off (user-visible change, unmentioned in any changelog).
- `--to` bypasses `enabled: false`: a disabled exec backend forced via `--to` is spawned; a disabled chat backend produces a misleading "unavailable — trying the next backend".
- Exec stats are recorded *before* the spawn, so a missing binary over-counts a prompt as served.
- `--no-route` records nothing at all, biasing the `diverted N of M` denominator.
- An orphaned backend id (in `stats.json` but absent from the passed `backends`) silently renders as a chat backend.
- Float `spend` accumulates read-modify-write with no integer-cents representation.
- Unresolvable override id is a silent no-op (unreachable today).
- When one backend streams then fails and the next succeeds, the two partial answers concatenate on stdout with no separator.
- `src/local.ts` is no longer local-specific; the filename under-describes it.
- `resolveWindowsCommand` is now called twice per Windows exec dispatch (the guard, then `isBatchShim`).

**Test coverage gaps**
- `runCli`'s 15s timeout only requests SIGTERM without independently resolving, so an unkillable child could leak the stub server.
- ~~The missing-exec test never pins the literal `Your prompt, so it is not lost:` line.~~ — closed, pinned in `abe44f6`.
- No test covers: `costOf` with zero tokens; `referencePricing` on an empty `modelPricing` with a null tier; the absence of an `onUsage` call; a malformed/partial usage object; two usage events proving last-one-wins; a legacy override letter bound to a backend outside the first three candidates; `execArgs` templates with a repeated or absent placeholder; custom `effortFlag`/`continueFlag` values.
- `test/backends.test.ts`'s equal-priority test cannot distinguish the explicit index tie-break from ES2019 sort stability.
- The `probe: true, autoStart: false` test makes a real loopback connection instead of using a `fetchImpl` stub.
- The now-unskipped win32 quoting assertion depends on `isBatchShim("claude")` doing a live PATH lookup — non-hermetic; assumes no `claude.cmd`/`.bat` on the runner's PATH.
- `src/index.ts` has no unit test file; the binding CLI behaviours rest on `test/cli.test.ts`'s seven hermetic cases.
- The two new cwd tests are win32-only by design, so ubuntu-latest exercises neither. Correct — the behaviour is Windows-only — but it does mean half the matrix skips them.

---

## Operational notes

- **Session limits interrupted this work five times.** Each time the ledger and `git log` were enough to resume with nothing lost.
- **A subagent's smoke test once wrote to the real `~/.config/prompt-router/`** and made a live OpenRouter call. Everything since is hermetic — always redirect `PROMPT_ROUTER_DIR`, and verify by comparing mtimes of the real directory across the run.
- **The repo root has a real `.env` with a live `OPENROUTER_API_KEY`**, and the ambient shell carries one too. `test/cli.test.ts` strips it from child environments for exactly that reason. Do not weaken that.
- CI matrix is `os: [ubuntu-latest, windows-latest] × node: [20, 22]`, running `typecheck`, `test`, `build`. There is no linter or formatter — match the surrounding style by hand (~100 col).
- Reference pricing used throughout (USD per 1M tokens): haiku 1/5, sonnet 3/15, opus 5/25.

### Windows gotcha worth remembering beyond this project

`{ ...process.env }` loses Windows' case-insensitive environment semantics — the copy is a plain object, so `delete copy.MixedCaseName` is case-sensitive and silently misses when the stored key has different casing (Vitest hands them over uppercased). Reads keep working through Node's proxy, which is what makes it so hard to see. Any name that is not already all-caps needs a case-insensitive delete.
