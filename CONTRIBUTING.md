# Contributing to prompt-router

Thanks for taking the time to contribute! The following is a short guide to
help you get set up and send a good pull request.

## Code of Conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By
participating, you're expected to uphold it.

## Getting started

```bash
git clone https://github.com/PTB-0/prompt-router
cd prompt-router
pnpm install
pnpm test        # vitest — the routing logic is fully unit-tested
pnpm typecheck   # TypeScript strict, no `any`
pnpm dev "your prompt"
```

Requires Node.js ≥ 20 and [pnpm](https://pnpm.io).

## Development workflow

- **Test-first.** Every routing rule in `src/route.ts` and every heuristic in
  `src/heuristics.ts` is pinned by a test in `test/`. Add or update tests
  alongside any behavioral change.
- **Strict TypeScript.** `pnpm typecheck` must pass with no `any`.
- **CI parity.** CI runs `pnpm typecheck`, `pnpm test`, and `pnpm build` on
  Linux and Windows, Node 20 and 22 — the same commands you should run
  locally before opening a PR.

## Making a change

1. Fork the repo and create your branch from `main`.
2. Make your change, with tests for any behavior change.
3. Run `pnpm typecheck` and `pnpm test` and confirm they pass.
4. Update `README.md` if you changed user-facing behavior (CLI flags,
   config keys, defaults).
5. Open a pull request describing the change and why it's needed.

## Reporting bugs

Please use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
when filing an issue, and include your OS, Node version, and the exact
command you ran.

## Suggesting features

Open a [feature request](.github/ISSUE_TEMPLATE/feature_request.md)
describing the problem you're trying to solve, not just the solution —
it makes it easier to find the simplest fix.

## Security issues

Please do not open a public issue for security vulnerabilities — see
[SECURITY.md](SECURITY.md) for how to report them responsibly.
