> **SUPERSEDED by `HANDOVER-2026-07-28-backend-registry.md`.** Kept for history only.
> Everything still live is repeated there. Do not work from this file: Task 11 and
> Task 12 are both finished now, and this file's diagnosis of the failing test is
> only half right — the recommended remedy was already in the tree and did not work.

# Handover — Backend Registry & Cost Accounting

**Written:** 2026-07-27
**Branch:** `main` (user declined worktree isolation, explicit consent)
**HEAD:** `0bd7dc2` — *fix: detect an unresolvable exec command before spawning on win32*
**Plan:** `docs/superpowers/plans/2026-07-26-backend-registry-cost-accounting.md`
**Spec:** `docs/superpowers/specs/2026-07-26-backend-registry-cost-accounting-design.md`
**Ledger:** `.superpowers/sdd/2026-07-26-backend-registry-cost-accounting/progress.md` (git-ignored scratch)

Execution method: `superpowers:subagent-driven-development` — a fresh implementer subagent per task, a spec+quality review after each, a scoped re-review after each fix round, and a broad whole-branch review at the end.

---

## Status at a glance

| | |
|---|---|
| Tasks complete | **11 of 12** (Task 11 has an open fix round) |
| Tests | 157 passing, **1 failing**, 1 skipped |
| Typecheck | clean (0 errors) |
| Build | succeeds |
| Working tree | **dirty** — 3 files with uncommitted round-3 work |

The migration itself is done and working: the CLI routes through the config-defined backend registry end to end, and `--stats` reports real spend and counterfactual savings.

---

## ⚠️ Uncommitted work in progress — read before touching anything

Three files are modified and **not committed**. This is Task 11's fix round 3, interrupted mid-debugging.

```
 M src/winShell.ts        (+27/-4)   the fix — correct, keep it
 M test/cli.test.ts       (+53/-1)   new test — currently RED
 M test/winShell.test.ts  (+59)      new tests — passing
```

`src/winShell.ts` also carries **debug `console.error` statements left in `test/cli.test.ts` (around lines 274-281)** that must be removed before committing.

### The one failing test, already diagnosed

`test/cli.test.ts > "an exec backend resolved only via the current working directory (not PATH) genuinely runs"`

**It fails for an environmental reason, not a logic error.** The debug output shows:

```
DEBUG env has var true      ← NoDefaultCurrentDirectoryInExePath is present
DEBUG stderr  ... failed to run sentinel: command not found
```

Chain of causation:

1. `resolveWindowsCommand` (as amended) honours the documented Windows opt-out `NoDefaultCurrentDirectoryInExePath` — when that variable exists, the implicit current-directory search is skipped, by cmd.exe as much as by this resolver.
2. **That variable is present in this session's process environment** (value `1`).
3. So `searchCwd` is `false`, the cwd-resident `sentinel.cmd` never resolves, `commandUnresolvable` fires, and the CLI correctly reports "command not found".
4. The test asserts the command *runs*, so it fails.

I verified where the variable comes from:

```
[Environment]::GetEnvironmentVariable(...,'User')     → empty
[Environment]::GetEnvironmentVariable(...,'Machine')  → empty
$env:NoDefaultCurrentDirectoryInExePath               → 1
```

It is **not a persistent machine setting** — it is inherited from the parent process chain (the Claude Code session / terminal). Consequence: this test would very likely **pass on CI's `windows-latest`**, where the variable is not set, and fail only when run under this session. An ambient-environment dependency like that is exactly what a hermetic test must not have.

### Recommended resolution

`runCli` spawns a child process, and the resolver runs *inside that child*. So the fix is to control the child's environment rather than depend on the ambient one: for this test, spawn with `NoDefaultCurrentDirectoryInExePath` **deleted** from the child env, making the cwd-search path deterministic on every machine.

Consider also adding the mirror-image test — the variable **set** in the child env, asserting the command is then correctly refused. That pins the opt-out behaviour the resolver deliberately honours, which is currently unverified.

Do not "fix" this by weakening `resolveWindowsCommand`. Honouring the variable is correct: ignoring it would make the resolver claim "this will run" for a command real cmd.exe then refuses — precisely the false positive the guard exists to prevent.

---

## What was built

Twelve planned tasks; eleven landed. Each commit is one task (plus fix rounds).

| # | Task | Commit | Fix rounds |
|---|---|---|---|
| 1 | Backend types + config schema, legacy migration | `6d03d29` | — |
| 2 | Candidate selection (`selectCandidates`) | `c8426f0` | — |
| 3 | Exec arg templates (replaced `claudeArgs.ts`) | `2aebc2e` | — |
| 4 | `decideRoute` returns a category | `ef4bac5` | 1 |
| 5 | Token usage capture in `llm.ts` | `43149f0` | — |
| 6 | Cost + counterfactual (`cost.ts`) | `4069de4` | — |
| 7 | Stats v2, per-backend, v1 migration | `116d14e` | 1 |
| 8 | Generalized health probe (`ensureChatBackend`) | `89390c1` | 1 |
| 9 | Dispatch module (chat vs exec) | `e771407` | 1 |
| 10 | Dynamic override keys in the confirmation bar | `b236681` | 1 (report-only) |
| 11 | Wire the registry through the CLI | `8167402`, `21e2689`, `0bd7dc2` | **3 (one open)** |
| 12 | Init wizard + README | — | **not started** |

Tasks 3–10 deliberately left `src/index.ts` broken; Task 11 made the build green for the first time.

---

## Remaining work

### 1. Finish Task 11 fix round 3
Resolve the failing test per the diagnosis above, strip the debug statements, run the suite, and commit `src/winShell.ts` + both test files together. Then run a scoped re-review over that fix range.

### 2. Task 12 — wizard and documentation
Brief already generated: `.superpowers/sdd/2026-07-26-backend-registry-cost-accounting/task-12-brief.md`

- Extract `buildInitConfig` from `src/init.ts` as an exported pure function that emits the `backends` schema; import `defaultBackends` from `src/config.ts` (already exported in Task 1 for exactly this).
- Declining a local model leaves that backend `enabled: false` rather than absent.
- README: replace the `local`/`openrouter.answerModels` config example with the `backends` array (keep `openrouter.apiKey`/`classifierModels`/`planModels` — the classifier and planner are infrastructure, not backends); change `--to` to take any backend id; add a line that `--stats` stores per-backend counts, tokens and cost but still no prompt content; tick the roadmap's "per-backend capability manifests".

### 3. Final whole-branch review
Dispatch on the most capable model, over `git merge-base main HEAD`..HEAD, using `superpowers:requesting-code-review`'s `code-reviewer.md`. **Point it at the deferred-minor list below** so it can triage what must be fixed before merge. If it returns findings: one fix dispatch, one scoped re-review, then adjudicate residuals.

### 4. Finish
`superpowers:finishing-a-development-branch`. Then delete the SDD workspace (`.superpowers/sdd/2026-07-26-backend-registry-cost-accounting/`) — git history becomes the record.

---

## Decisions the user made (standing)

- **Worktree declined** — work happens directly on `main`, with intermediate commits where the build is knowingly broken.
- **Plan-vs-finding conflicts: the finding governs.** Ruled at Task 4, when a reviewer found the plan's verbatim test file failed to pin a binding safety rule. Applied without re-asking at Tasks 7, 9 and 11 — recorded in the ledger each time.
- **Task 11's out-of-scope fixes authorized twice:** first to move cost/tier policy into testable modules and add hermetic CLI tests, then to fix the Windows product bug rather than skip its test.

## Two real defects the review process caught

Worth knowing, because both had already been committed and both were invisible to a passing suite:

1. **Task 8** — the implementer deleted a pre-existing skipped test instead of porting it, leaving *zero* coverage of the ENOENT fast-fail path the brief calls binding.
2. **Task 9** — the implementer skipped the `execSpawnPlan` test on win32, removing CI coverage of the caret-quoting path `src/winShell.ts` exists for, on the one runner where it executes. This repo has previously shipped a real `^--model^` bug there.

And one genuine **product** bug, found in Task 11 round 2: on Windows the "your prompt is not lost" guarantee did not hold, because `shell: true` routes through cmd.exe, which swallows ENOENT into an ordinary non-zero exit so `result.error` never populated. Fixed in `0bd7dc2`.

---

## Deferred minors — hand these to the final review

Recorded across all tasks; none blocking on its own.

**Config / types**
- Unused `ChatBackend`/`ExecBackend` type imports at `src/config.ts:5` (copied from the plan).
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
- The missing-exec test never pins the literal `Your prompt, so it is not lost:` line.
- No test covers: `costOf` with zero tokens; `referencePricing` on an empty `modelPricing` with a null tier; the absence of an `onUsage` call; a malformed/partial usage object; two usage events proving last-one-wins; a legacy override letter bound to a backend outside the first three candidates; `execArgs` templates with a repeated or absent placeholder; custom `effortFlag`/`continueFlag` values.
- `test/backends.test.ts`'s equal-priority test cannot distinguish the explicit index tie-break from ES2019 sort stability.
- The `probe: true, autoStart: false` test makes a real loopback connection instead of using a `fetchImpl` stub.
- The now-unskipped win32 quoting assertion depends on `isBatchShim("claude")` doing a live PATH lookup — non-hermetic; assumes no `claude.cmd`/`.bat` on the runner's PATH.
- `src/index.ts` has no unit test file; the eight binding CLI behaviours rest on `test/cli.test.ts`'s five hermetic cases.

---

## Operational notes

- **Session limits interrupted this work four times.** Each time the ledger and `git log` were enough to resume with nothing lost. Trust those over recollection.
- **A subagent's smoke test once wrote to the real `~/.config/prompt-router/`** and made a live OpenRouter call. The CLI tests added later are hermetic — verified by comparing that file's mtime across a full suite run. Keep it that way: redirect `PROMPT_ROUTER_DIR`.
- That real config file is now v2 and is itself good evidence the v1 migration behaves: the pre-existing `claude`/`local` counters carried over with **zero** tokens (never measured), while `openrouter` carries genuinely measured ones.
- CI matrix is `os: [ubuntu-latest, windows-latest] × node: [20, 22]`, running `typecheck`, `test`, `build`. A `skipIf(win32)` therefore hides a path CI would otherwise exercise — the reason two of the findings above were raised.
- Reference pricing used throughout (USD per 1M tokens): haiku 1/5, sonnet 3/15, opus 5/25.
