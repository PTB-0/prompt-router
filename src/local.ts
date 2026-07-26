import { spawn } from "child_process";
import type { ChatBackend } from "./types.js";

const PROBE_TIMEOUT_MS = 1500;
const START_POLL_ATTEMPTS = 6;
const START_POLL_INTERVAL_MS = 1000;

export async function isServerUp(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/models`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Probe a chat backend, starting its server first when configured to. Remote
 * providers set `probe: false` — there is nothing local to wake, and paying a
 * round trip to find that out on every prompt is wasted latency.
 */
export async function ensureChatBackend(backend: ChatBackend): Promise<boolean> {
  if (!backend.enabled) return false;
  if (!backend.probe) return true;
  if (await isServerUp(backend.baseUrl, PROBE_TIMEOUT_MS)) return true;
  if (!backend.autoStart) return false;

  const [command, ...args] = backend.autoStartCommand;
  if (!command) return false;

  // The start command is a no-op when the server is already running. A missing
  // binary surfaces as an async "error" event (ENOENT), not a throw — bail out
  // immediately instead of polling for a server that can never start.
  const started = await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, {
        shell: process.platform === "win32",
        stdio: "ignore",
        detached: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });
  if (!started) return false;

  for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt++) {
    await delay(START_POLL_INTERVAL_MS);
    if (await isServerUp(backend.baseUrl, PROBE_TIMEOUT_MS)) return true;
  }
  return false;
}
