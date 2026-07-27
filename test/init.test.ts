import { describe, expect, test } from "vitest";
import { defaultBackends } from "../src/config.js";
import { buildInitConfig, mergeEnvKey } from "../src/init.js";
import type { Backend, ChatBackend } from "../src/types.js";

function localOf(backends: Backend[]): ChatBackend | undefined {
  const found = backends.find((b) => b.id === "local");
  return found?.kind === "chat" ? found : undefined;
}

describe("mergeEnvKey", () => {
  test("appends the key when the file is empty", () => {
    expect(mergeEnvKey("", "sk-or-v1-abc")).toBe("OPENROUTER_API_KEY=sk-or-v1-abc\n");
  });

  test("appends the key when the file has other vars but no key", () => {
    expect(mergeEnvKey("SOME_OTHER=1\n", "sk-or-v1-abc")).toBe(
      "SOME_OTHER=1\nOPENROUTER_API_KEY=sk-or-v1-abc\n",
    );
  });

  test("replaces an existing key in place, preserving surrounding lines", () => {
    const before = "SOME_OTHER=1\nOPENROUTER_API_KEY=old-key\nANOTHER=2\n";
    expect(mergeEnvKey(before, "new-key")).toBe(
      "SOME_OTHER=1\nOPENROUTER_API_KEY=new-key\nANOTHER=2\n",
    );
  });
});

describe("buildInitConfig", () => {
  const accepted = { localBaseUrl: "http://localhost:9999/v1", localModel: "m", localAutoStart: true };
  const declined = { localBaseUrl: null, localModel: null, localAutoStart: true };

  test("a local-model setup produces the three default backends", () => {
    const cfg = buildInitConfig(accepted, defaultBackends());
    expect(cfg.backends.map((b) => b.id)).toEqual(["claude", "local", "openrouter"]);
  });

  test("the answers land on the local backend", () => {
    const cfg = buildInitConfig(accepted, defaultBackends());
    const local = localOf(cfg.backends);
    expect(local?.enabled).toBe(true);
    expect(local?.baseUrl).toBe("http://localhost:9999/v1");
    // The wizard asks for one model name; it becomes a one-element chain.
    expect(local?.models).toEqual(["m"]);
  });

  test("auto-start is carried through to the local backend", () => {
    const cfg = buildInitConfig({ ...accepted, localAutoStart: false }, defaultBackends());
    expect(localOf(cfg.backends)?.autoStart).toBe(false);
  });

  test("declining a local model leaves it disabled rather than absent", () => {
    // Keeping the entry but disabling it leaves an obvious thing to flip on
    // later, instead of a config the user would have to write from scratch.
    const cfg = buildInitConfig(declined, defaultBackends());
    const local = localOf(cfg.backends);
    expect(local).toBeDefined();
    expect(local?.enabled).toBe(false);
  });

  test("declining keeps the previous local address instead of blanking it", () => {
    const existing = defaultBackends();
    const previous = localOf(existing);
    if (previous) {
      previous.baseUrl = "http://localhost:4321/v1";
      previous.models = ["previously-chosen-model"];
    }
    const local = localOf(buildInitConfig(declined, existing).backends);
    expect(local?.baseUrl).toBe("http://localhost:4321/v1");
    expect(local?.models).toEqual(["previously-chosen-model"]);
  });

  test("backends the user added by hand survive a re-run", () => {
    // The wizard only ever asks about the local model, so it must patch that
    // one backend and leave the registry otherwise intact — re-running setup
    // must not silently delete a backend that was added by editing the file.
    const existing: Backend[] = [
      ...defaultBackends(),
      {
        id: "codex",
        label: "Codex",
        kind: "exec",
        categories: ["code"],
        priority: 20,
        enabled: true,
        command: "codex",
        args: ["{prompt}"],
        modelFlag: "--model",
        effortFlag: "--effort",
        continueFlag: "-c",
        supportsModelTier: false,
        supportsPlan: false,
        supportsContinue: false,
        modelPricing: {},
      },
    ];
    const cfg = buildInitConfig(accepted, existing);
    expect(cfg.backends.map((b) => b.id)).toEqual(["claude", "local", "openrouter", "codex"]);
    const codex = cfg.backends.find((b) => b.id === "codex");
    expect(codex?.priority).toBe(20);
  });

  test("does not mutate the backends it was given", () => {
    const existing = defaultBackends();
    buildInitConfig({ ...accepted, localBaseUrl: "http://localhost:1/v1" }, existing);
    expect(localOf(existing)?.baseUrl).toBe("http://localhost:1234/v1");
  });

  test("adds a local backend when the registry has none and one is wanted", () => {
    const existing = defaultBackends().filter((b) => b.id !== "local");
    const cfg = buildInitConfig(accepted, existing);
    const local = localOf(cfg.backends);
    expect(local?.enabled).toBe(true);
    expect(local?.baseUrl).toBe("http://localhost:9999/v1");
  });

  test("does not resurrect a deleted local backend when one is declined", () => {
    const existing = defaultBackends().filter((b) => b.id !== "local");
    expect(localOf(buildInitConfig(declined, existing).backends)).toBeUndefined();
  });
});
