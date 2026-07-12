# `prompt-router init` — interactive setup wizard

## Purpose
Collapse the README "Quick start" steps (OpenRouter key, local model, thresholds) into one guided command, so first-time setup doesn't require hand-editing `config.json`/`.env`.

## Architecture
- New `src/init.ts` exporting `runInit(): Promise<void>`.
- `index.ts`: before the existing `parseArgs` flow, check `process.argv[2] === "init"`; if so call `runInit()` and return. Add `init` to the `USAGE` text.

## Flow
1. Load existing `config.json` (via `resolveConfig`/raw JSON read) and `.env` (`OPENROUTER_API_KEY`) as defaults. Every prompt shows the current value; empty input keeps it.
2. **OpenRouter API key** — if non-empty and changed, validate with a lightweight `GET https://openrouter.ai/api/v1/models` (Bearer header, ~3s timeout). Warn (don't block) on failure or network error.
3. **Local model** — y/n enabled; if yes, ask `baseUrl`, `model`, `autoStart`, then probe with `isServerUp` from `local.ts` and print found/not-found.
4. **Thresholds** — `confidence` (0–1), `planComplexity` (0–1).
5. **Session** — `maxMessages`.
6. **Logging** — `routingLog` y/n.
7. **Timeout** — `timeoutMs`.
8. Write `config.json` (all fields except `apiKey`, which never lives in config.json) to `configDir()`. Merge `OPENROUTER_API_KEY` into `configDir()/.env`, preserving any other lines already there.
9. Print a summary and a "you're ready — try `prompt-router \"...\"`" message.

## Error handling
Network calls (key validation, local probe) never abort the wizard — same "never break the primary flow" pattern as `local.ts`/`log.ts`. Failures print a dim warning and the wizard continues with whatever was entered.

## Testing
Unit-test the pure logic only (matches existing test style — `ui.ts`/`init.ts`'s readline interaction itself is not tested):
- `.env` line-merge function: updates `OPENROUTER_API_KEY` in place, preserves other lines, appends if absent.
- Config-object-assembly from collected answers.

## Out of scope
- Shell completions, alias setup, packaging — separate roadmap items.
