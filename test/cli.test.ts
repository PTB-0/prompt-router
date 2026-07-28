import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * Black-box tests of the actual built CLI (`dist/index.js` — the file
 * package.json's `bin` field points at). The eight behavioural guarantees
 * from Task 11's brief are wiring properties of src/index.ts: which candidate
 * gets picked, which one recorded stats, whether a hand-off happens. No unit
 * test of a module index.ts *consumes* (backends.ts, dispatch.ts, cost.ts...)
 * can observe that wiring, so this file drives the real binary as a
 * subprocess instead.
 *
 * Hermeticity: every run gets its own PROMPT_ROUTER_DIR under the OS temp
 * dir and runs with that same directory as cwd (which never has a .env), and
 * OPENROUTER_API_KEY / PROMPT_ROUTER_LOCAL_* are stripped from the child's
 * env. That matters concretely in this repo: the repo root has a real `.env`
 * with a live OPENROUTER_API_KEY, and the ambient shell environment carries
 * one too — without stripping it, "hermetic" tests would silently place real,
 * billable calls to OpenRouter. Chat backends here point at either a closed
 * loopback port (instant ECONNREFUSED, no 30s timeout wait) or a local stub
 * HTTP server this file starts itself. No real network call is made.
 */

const ROOT = path.resolve(__dirname, "..");
const DIST_ENTRY = path.join(ROOT, "dist", "index.js");
const CLI_TIMEOUT_MS = 15_000;

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-router-cli-"));
  tmpDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, config: unknown): void {
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
}

interface BackendStatsEntry {
  count: number;
  inTok: number;
  outTok: number;
  spend: number;
}

interface StatsFile {
  backends: Record<string, BackendStatsEntry>;
  saved: { tokens: number; usd: number };
}

function readStats(dir: string): StatsFile {
  return JSON.parse(fs.readFileSync(path.join(dir, "stats.json"), "utf8")) as StatsFile;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const STRIPPED_ENV_VARS = [
  "OPENROUTER_API_KEY",
  "PROMPT_ROUTER_LOCAL_URL",
  "PROMPT_ROUTER_LOCAL_MODEL",
  "PROMPT_ROUTER_TIMEOUT",
  "EDITOR",
  // Windows' documented opt-out for the implicit current-directory search
  // (see resolveWindowsCommand in src/winShell.ts). It is set in some real
  // environments — including the one this suite was developed on — and
  // leaving it in place makes the cwd-resolution test below fail for a
  // reason that has nothing to do with the code under test.
  "NoDefaultCurrentDirectoryInExePath",
];

/**
 * Removes an environment variable from a plain env object, case-insensitively.
 *
 * `delete env.SOME_VAR` is not good enough on Windows. Windows environment
 * variables are case-insensitive, but `{ ...process.env }` is an ordinary
 * object whose `delete` is not — and the case a name is *stored* under is not
 * guaranteed to be the case written here. Under Vitest on Windows this test
 * process receives them uppercased, so `NoDefaultCurrentDirectoryInExePath`
 * arrives as `NODEFAULTCURRENTDIRECTORYINEXEPATH`: reads still work (Node's
 * `process.env` is a case-insensitive proxy there) but a mixed-case `delete`
 * on the spread copy silently misses, and the variable reaches the child
 * anyway. Anything whose name is not already all-caps needs this.
 */
function stripEnv(env: NodeJS.ProcessEnv, name: string): void {
  const target = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === target) delete env[key];
  }
}

/**
 * Spawns the built binary with a hermetic, non-TTY environment.
 *
 * `envOverrides` is applied last, after the strips below — so a test can put
 * a variable back deliberately to pin behaviour that depends on it.
 *
 * Deliberately async (`spawn`, not `spawnSync`): `spawnSync` blocks this
 * process's own event loop until the child exits, and the "actually served"
 * test below runs an in-process stub HTTP server that the child needs to
 * reach — with `spawnSync`, the parent's event loop (and thus the stub
 * server) can never run while it's blocked waiting on the child, and the
 * child can never get a response while waiting on the parent. Confirmed by
 * reproducing the deadlock directly before switching to `spawn`.
 */
function runCli(
  dir: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<CliResult> {
  const env = { ...process.env };
  for (const name of STRIPPED_ENV_VARS) stripEnv(env, name);
  env.PROMPT_ROUTER_DIR = dir;
  Object.assign(env, envOverrides);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_ENTRY, ...args], {
      cwd: dir, // no .env here, so dotenv's bare cwd-relative load is a no-op
      env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, CLI_TIMEOUT_MS);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });

    // Non-TTY stdin with immediate EOF: the confirmation bar must auto-accept.
    child.stdin.end();
  });
}

function execBackendConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "brokenexec",
    label: "Broken Exec",
    kind: "exec",
    categories: ["code"],
    priority: 10,
    enabled: true,
    command: "prompt-router-definitely-nonexistent-binary-xyz",
    args: ["{prompt}"],
    modelFlag: "--model",
    effortFlag: "--effort",
    continueFlag: "-c",
    supportsModelTier: false,
    supportsPlan: false,
    supportsContinue: false,
    modelPricing: {},
    ...overrides,
  };
}

/**
 * A minimal Windows batch file that proves it actually ran (rather than
 * merely being spawned and immediately failing) by writing a distinctive
 * marker to stdout and exiting 0. Deliberately ignores its own arguments —
 * this test only needs to prove resolution + execution, not argument
 * plumbing, so there is no need to fight cmd.exe's batch-file escaping.
 */
function writeSentinelCmd(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "sentinel.cmd"),
    "@echo off\r\necho SENTINEL_RAN\r\nexit /b 0\r\n",
    "utf8",
  );
}

function chatBackendConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "deadchat",
    label: "Dead Chat",
    kind: "chat",
    categories: ["simple-qa", "deep-qa"],
    priority: 10,
    enabled: true,
    baseUrl: "http://127.0.0.1:1", // nothing listens here — instant ECONNREFUSED
    models: ["dead-model"],
    probe: false,
    autoStart: false,
    autoStartCommand: [],
    pricing: { inputPer1M: 0, outputPer1M: 0 },
    ...overrides,
  };
}

/**
 * A minimal OpenAI-compatible stub: `/chat/completions` streams SSE with a
 * usage frame, and `/models` answers the health probe (src/local.ts's
 * isServerUp) so a `probe: true` backend can be exercised for real.
 */
function startStubServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        res.end('{"data":[]}');
      } else if (req.method === "POST" && req.url === "/chat/completions") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          // Force the socket closed so the CLI subprocess isn't held open by
          // an idle keep-alive connection waiting to be reused.
          Connection: "close",
        });
        res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
        res.write(
          'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n',
        );
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port });
    });
  });
}

beforeAll(() => {
  // Task 11's guarantees are about the shipped binary (package.json's `bin`
  // points at dist/index.js) — build it fresh rather than only exercising
  // the TS source in-process, so this suite also survives a `dist/` that's
  // absent or stale on a fresh clone.
  execSync("pnpm build", { cwd: ROOT, stdio: "pipe" });
}, 60_000);

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("prompt-router CLI (built binary, hermetic)", () => {
  test(
    "an unknown --to id fails with a message listing the configured ids, and exits non-zero",
    async () => {
      const dir = makeTmpDir();
      const result = await runCli(dir, ["--to", "bogus", "what year is it currently"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/unknown backend "bogus"/);
      expect(result.stderr).toMatch(/claude/);
      expect(result.stderr).toMatch(/local/);
      expect(result.stderr).toMatch(/openrouter/);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "--to refuses a disabled exec backend instead of spawning it",
    async () => {
      // `enabled: false` was only ever honoured by selectCandidates and (for
      // chat) ensureChatBackend. --to looked the id up in config.backends
      // directly, so a backend the user explicitly turned off still ran.
      const dir = makeTmpDir();
      writeConfig(dir, { backends: [execBackendConfig({ enabled: false })] });
      const result = await runCli(dir, ["--to", "brokenexec", "please refactor the auth module"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/backend "brokenexec" is disabled/);
      expect(result.stderr).toMatch(/"enabled": true/);
      // Not merely a different error path: the spawn never happened, so
      // nothing was recorded against it either.
      expect(result.stderr).not.toMatch(/failed to run/);
      expect(fs.existsSync(path.join(dir, "stats.json"))).toBe(false);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "--to refuses a disabled chat backend instead of billing for it",
    async () => {
      // The worse half: every remote provider sets `probe: false`, and the
      // only `enabled` check on the chat path lived inside ensureChatBackend,
      // which runs only when `probe` is true. So --to on a disabled remote
      // provider dispatched for real and billed the user.
      const { server, port } = await startStubServer();
      try {
        const dir = makeTmpDir();
        writeConfig(dir, {
          backends: [
            chatBackendConfig({
              id: "paidchat",
              label: "Paid Chat",
              enabled: false,
              baseUrl: `http://127.0.0.1:${port}`,
            }),
          ],
        });
        const result = await runCli(dir, ["--to", "paidchat", "what year is it currently"]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/backend "paidchat" is disabled/);
        expect(result.stdout).not.toContain("hello");
        expect(fs.existsSync(path.join(dir, "stats.json"))).toBe(false);
      } finally {
        server.close();
      }
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "a missing exec command prints the prompt so it is not lost",
    async () => {
      // On win32, src/dispatch.ts's execSpawnPlan always shells through
      // cmd.exe (see src/winShell.ts — needed to invoke .cmd shims
      // correctly). cmd.exe itself spawns successfully for a missing
      // command and merely exits non-zero with its own "not recognized"
      // message, so Node's spawnSync never populates `result.error`. Rather
      // than rely on that, runExec (src/index.ts) now checks
      // resolveWindowsCommand (src/winShell.ts) *before* spawning, so a
      // command that cannot resolve on win32 is caught the same way ENOENT
      // is caught on POSIX. This is what makes this test pass on every
      // platform now — see the fix report's RED/GREEN evidence for the
      // pre-fix failure this test used to expose.
      const dir = makeTmpDir();
      writeConfig(dir, { backends: [execBackendConfig()] });
      const prompt = "please refactor the auth module for clarity";
      const result = await runCli(dir, ["--to", "brokenexec", prompt]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(prompt);
      expect(result.stderr).toMatch(/failed to run/);
      // Pin the literal banner, not just the prompt text: the prompt alone
      // also appears in the routing preview, so without this the test would
      // still pass if the "not lost" path were removed entirely.
      expect(result.stderr).toContain("Your prompt, so it is not lost:");
    },
    CLI_TIMEOUT_MS,
  );

  // Both cwd-resolution tests are win32-only because the behaviour itself is:
  // implicit current-directory search is a cmd.exe/CreateProcess rule with no
  // POSIX counterpart, and commandUnresolvable (src/index.ts) is a documented
  // no-op off win32. On Linux the sentinel would simply fail to spawn, which
  // would test nothing. CI runs windows-latest, so these do get exercised.
  const onWindows = process.platform === "win32";

  test.runIf(onWindows)(
    "an exec backend resolved only via the current working directory (not PATH) genuinely runs",
    async () => {
      // Round-3 regression coverage: resolveWindowsCommand (src/winShell.ts)
      // now searches cwd before PATH for a bare command name, matching
      // cmd.exe's own resolution order. Before that fix, commandUnresolvable
      // (src/index.ts) would have wrongly refused this command — it is
      // deliberately absent from PATH, resolvable only via cwd — and
      // diverted the prompt into the "command not found" fallback instead
      // of actually running it. runCli's cwd is this same temp dir, so a
      // command resolvable only there is exactly the scenario that broke.
      const dir = makeTmpDir();
      writeSentinelCmd(dir);
      writeConfig(dir, {
        backends: [execBackendConfig({ id: "sentinelexec", command: "sentinel" })],
      });
      const prompt = "please refactor the auth module for clarity";
      const result = await runCli(dir, ["--to", "sentinelexec", prompt]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SENTINEL_RAN");
      expect(result.stderr).not.toContain("Your prompt, so it is not lost:");
      expect(result.stderr).not.toMatch(/failed to run/);
    },
    CLI_TIMEOUT_MS,
  );

  test.runIf(onWindows)(
    "an exec backend in cwd is refused when NoDefaultCurrentDirectoryInExePath disables that search",
    async () => {
      // The mirror of the test above, pinning the opt-out resolveWindowsCommand
      // deliberately honours. With this variable present, cmd.exe does not
      // search cwd either — so the command genuinely cannot run, and refusing
      // before spawning is the correct answer rather than a false negative.
      // Same fixture as above, one environment variable apart: that isolates
      // the opt-out as the only cause of the difference in outcome.
      const dir = makeTmpDir();
      writeSentinelCmd(dir);
      writeConfig(dir, {
        backends: [execBackendConfig({ id: "sentinelexec", command: "sentinel" })],
      });
      const prompt = "please refactor the auth module for clarity";
      const result = await runCli(dir, ["--to", "sentinelexec", prompt], {
        NoDefaultCurrentDirectoryInExePath: "1",
      });
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("SENTINEL_RAN");
      expect(result.stderr).toMatch(/failed to run sentinel: command not found/);
      // The prompt survives the refusal — the guarantee the guard exists for.
      expect(result.stderr).toContain("Your prompt, so it is not lost:");
      expect(result.stdout).toContain(prompt);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "an exec dispatch records input tokens only and contributes zero savings",
    async () => {
      // recordDispatch runs before the spawn attempt in runExecRoute
      // (src/index.ts), on every platform — so unlike the test above, this
      // assertion does not depend on how ENOENT does or doesn't surface.
      const dir = makeTmpDir();
      writeConfig(dir, { backends: [execBackendConfig()] });
      const prompt = "please refactor the auth module for clarity";
      const result = await runCli(dir, ["--to", "brokenexec", prompt]);
      expect(result.status).not.toBe(0);

      const stats = readStats(dir);
      const entry = stats.backends["brokenexec"];
      expect(entry).toBeDefined();
      expect(entry?.count).toBe(1);
      expect(entry?.inTok).toBeGreaterThan(0);
      expect(entry?.outTok).toBe(0);
      expect(entry?.spend).toBe(0);
      expect(stats.saved).toEqual({ tokens: 0, usd: 0 });
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "every chat candidate failing hands off to the exec backend rather than dropping the prompt",
    async () => {
      const dir = makeTmpDir();
      writeConfig(dir, {
        backends: [
          chatBackendConfig({ id: "deadchat", priority: 10 }),
          execBackendConfig({
            id: "handoffexec",
            label: "Handoff Exec",
            categories: ["code"],
            priority: 5,
          }),
        ],
      });
      // No "?" — resolves via decideRoute's no-signal branch to "deep-qa"
      // deterministically, which deadchat (not handoffexec) serves.
      const prompt = "what year is it currently";
      const result = await runCli(dir, [prompt]);
      // The handoff backend's command doesn't exist either, so this also
      // exits non-zero — the meaningful assertions are the ones below.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/handing off to Handoff Exec/);

      // Proof the prompt actually reached the hand-off backend rather than
      // being silently dropped: it was recorded — input-only, no savings,
      // since nothing was diverted once the router itself landed here.
      const stats = readStats(dir);
      expect(stats.backends["handoffexec"]).toBeDefined();
      expect(stats.backends["handoffexec"]?.count).toBe(1);
      expect(stats.backends["deadchat"]).toBeUndefined();
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "with no API key, an enabled chat backend outside the category is tried before the exec handoff",
    async () => {
      // README's degradation table: "There's no API key either → tries the
      // local server, and only then hands off to Claude Code as a last
      // resort." The default `local` backend serves only "simple-qa", and
      // with no API key every unclaimed prompt lands in decideRoute's
      // no-signal branch — "deep-qa" — whose only candidate is the keyless
      // remote provider. Without a last-resort sweep of the remaining enabled
      // chat backends, the local server is never contacted at all and the
      // paid agent gets every question.
      const { server, port } = await startStubServer();
      try {
        const dir = makeTmpDir();
        writeConfig(dir, {
          backends: [
            chatBackendConfig({
              id: "localstub",
              label: "local model",
              categories: ["simple-qa"],
              priority: 10,
              baseUrl: `http://127.0.0.1:${port}`,
              probe: true,
            }),
            chatBackendConfig({
              id: "keyedchat",
              label: "Keyed Chat",
              categories: ["simple-qa", "deep-qa"],
              priority: 5,
              apiKeyEnv: "OPENROUTER_API_KEY",
            }),
            execBackendConfig({
              id: "handoffexec",
              label: "Handoff Exec",
              categories: ["code"],
              priority: 5,
            }),
          ],
        });
        // No "?" — decideRoute's no-signal branch resolves this to "deep-qa",
        // which localstub does not serve.
        const prompt = "what year is it currently";
        const result = await runCli(dir, [prompt]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("hello");
        // The skip reason for the backend that was a candidate survives.
        expect(result.stderr).toMatch(/no OPENROUTER_API_KEY/);
        expect(result.stderr).not.toMatch(/handing off to/);

        const stats = readStats(dir);
        expect(stats.backends["localstub"]?.count).toBe(1);
        expect(stats.backends["handoffexec"]).toBeUndefined();
      } finally {
        server.close();
      }
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "a chat backend skipped for a missing key is not retried by the last-resort sweep",
    async () => {
      // The sweep exists for backends that were never candidates. Retrying one
      // that was already skipped for a missing API key would fail identically
      // and only duplicate the message.
      const dir = makeTmpDir();
      writeConfig(dir, {
        backends: [
          chatBackendConfig({
            id: "keyedchat",
            label: "Keyed Chat",
            categories: ["simple-qa", "deep-qa"],
            priority: 5,
            apiKeyEnv: "OPENROUTER_API_KEY",
          }),
          execBackendConfig({
            id: "handoffexec",
            label: "Handoff Exec",
            categories: ["code"],
            priority: 5,
          }),
        ],
      });
      const result = await runCli(dir, ["what year is it currently"]);
      expect(result.stderr.match(/no OPENROUTER_API_KEY/g)?.length).toBe(1);
      expect(result.stderr).toMatch(/handing off to Handoff Exec/);
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "the counterfactual is priced against the priced agent, not the top-priority one",
    async () => {
      // Declaring a second coding agent above Claude Code is the plan's
      // headline "config edit, not a release" use case. It changes where a
      // failure hands off — but the counterfactual must still be priced
      // against a backend that actually has modelPricing, or the headline
      // savings number silently stays at zero forever.
      const { server, port } = await startStubServer();
      try {
        const dir = makeTmpDir();
        writeConfig(dir, {
          backends: [
            chatBackendConfig({
              id: "livechat",
              priority: 10,
              baseUrl: `http://127.0.0.1:${port}`,
            }),
            execBackendConfig({ id: "aider", label: "Aider", priority: 20 }),
            execBackendConfig({
              id: "claude",
              label: "Claude Code",
              priority: 10,
              supportsModelTier: true,
              modelPricing: {
                haiku: { inputPer1M: 1, outputPer1M: 5 },
                sonnet: { inputPer1M: 3, outputPer1M: 15 },
                opus: { inputPer1M: 5, outputPer1M: 25 },
              },
            }),
          ],
        });
        const result = await runCli(dir, ["what year is it currently"]);
        expect(result.status).toBe(0);

        const stats = readStats(dir);
        // The stub reports 11 prompt + 3 completion tokens.
        expect(stats.saved.tokens).toBe(14);
        expect(stats.saved.usd).toBeGreaterThan(0);
      } finally {
        server.close();
      }
    },
    CLI_TIMEOUT_MS,
  );

  test(
    "stats record the backend that actually served, not the head candidate",
    async () => {
      const { server, port } = await startStubServer();
      try {
        const dir = makeTmpDir();
        writeConfig(dir, {
          backends: [
            chatBackendConfig({ id: "deadchat", priority: 10, baseUrl: "http://127.0.0.1:1" }),
            chatBackendConfig({
              id: "livechat",
              priority: 5,
              baseUrl: `http://127.0.0.1:${port}`,
            }),
          ],
        });
        const prompt = "what year is it currently";
        const result = await runCli(dir, [prompt]);
        expect(result.status).toBe(0);

        const stats = readStats(dir);
        expect(stats.backends["livechat"]).toBeDefined();
        expect(stats.backends["livechat"]?.count).toBe(1);
        expect(stats.backends["deadchat"]).toBeUndefined();
      } finally {
        server.close();
      }
    },
    CLI_TIMEOUT_MS,
  );
});
