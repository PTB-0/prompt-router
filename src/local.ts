import { spawn } from "child_process";
import type { RouterConfig } from "./config.js";

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

export async function ensureLocalServer(config: RouterConfig): Promise<boolean> {
  if (!config.local.enabled) return false;
  if (await isServerUp(config.local.baseUrl, PROBE_TIMEOUT_MS)) return true;
  if (!config.local.autoStart) return false;

  // LM Studio ships the `lms` CLI; `server start` is a no-op when already running.
  // A missing binary surfaces as an async "error" event (ENOENT), not a throw —
  // bail out immediately instead of polling for a server that can never start.
  const started = await new Promise<boolean>((resolve) => {
    try {
      const child = spawn("lms", ["server", "start"], {
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
    if (await isServerUp(config.local.baseUrl, PROBE_TIMEOUT_MS)) return true;
  }
  return false;
}
