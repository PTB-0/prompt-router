# Security Policy

## Supported Versions

Only the latest published release of `prompt-router` receives security fixes.

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |
| < latest | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, please **do not open a public
GitHub issue**. Instead, report it privately using one of the following:

- [GitHub Security Advisories](https://github.com/PTB-0/prompt-router/security/advisories/new)
  for this repository (preferred).
- Open a [private issue](https://github.com/PTB-0/prompt-router/issues/new)
  requesting a private channel if advisories aren't available to you.

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, including any relevant config or command-line flags.
- The version of `prompt-router` and Node.js you're using.

We'll acknowledge your report as soon as possible and follow up with next
steps once the issue is confirmed.

## Scope notes

`prompt-router` runs locally and reads your `OPENROUTER_API_KEY` from
`~/.config/prompt-router/.env` (or the environment). It sends prompt text to
OpenRouter and, optionally, a local model server or the Claude Code CLI — it
does not otherwise transmit data to third parties. See the
[Privacy section of the README](README.md#privacy) for what is and isn't
logged locally.
