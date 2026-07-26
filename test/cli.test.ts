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

/**
 * Spawns the built binary with a hermetic, non-TTY environment.
 *
 * Deliberately async (`spawn`, not `spawnSync`): `spawnSync` blocks this
 * process's own event loop until the child exits, and the "actually served"
 * test below runs an in-process stub HTTP server that the child needs to
 * reach — with `spawnSync`, the parent's event loop (and thus the stub
 * server) can never run while it's blocked waiting on the child, and the
 * child can never get a response while waiting on the parent. Confirmed by
 * reproducing the deadlock directly before switching to `spawn`.
 */
function runCli(dir: string, args: string[]): Promise<CliResult> {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  delete env.PROMPT_ROUTER_LOCAL_URL;
  delete env.PROMPT_ROUTER_LOCAL_MODEL;
  delete env.PROMPT_ROUTER_TIMEOUT;
  delete env.EDITOR;
  env.PROMPT_ROUTER_DIR = dir;

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

/** A minimal OpenAI-compatible /chat/completions stub, SSE with usage. */
function startStubServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/chat/completions") {
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
