import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { afterEach, describe, expect, test } from "vitest";
import { resolveConfig } from "../src/config.js";
import {
  buildFixPrompt,
  buildReviewPrompt,
  buildStepPrompt,
  captureDiff,
  decomposeTask,
  parseDecomposition,
  parseSelection,
  parseVerdict,
  runPrintTask,
  selectAgent,
} from "../src/orchestra.js";
import type { AgentCandidate } from "../src/orchestra.js";
import type { ExecBackend } from "../src/types.js";

function exec(over: Partial<ExecBackend> = {}): ExecBackend {
  return {
    id: "claude",
    label: "Claude Code",
    kind: "exec",
    categories: ["code"],
    priority: 10,
    enabled: true,
    command: "claude",
    args: ["{prompt}"],
    modelFlag: "--model",
    effortFlag: "--effort",
    continueFlag: "-c",
    supportsModelTier: false,
    supportsPlan: false,
    supportsContinue: false,
    modelPricing: {},
    ...over,
  };
}

describe("parseSelection", () => {
  test("extracts a backend_id present in the candidate list", () => {
    expect(parseSelection('{"backend_id": "codex"}', ["claude", "codex"])).toBe("codex");
  });

  test("rejects a backend_id that is not among the candidates", () => {
    expect(parseSelection('{"backend_id": "ghost"}', ["claude", "codex"])).toBeNull();
  });

  test("tolerates surrounding commentary", () => {
    expect(parseSelection('Sure!\n{"backend_id": "claude"}\nDone.', ["claude"])).toBe("claude");
  });

  test("returns null for unparseable input", () => {
    expect(parseSelection("not json at all", ["claude"])).toBeNull();
  });
});

describe("selectAgent", () => {
  test("returns the only candidate without calling the LLM", async () => {
    const config = resolveConfig({}, {});
    const candidates: AgentCandidate[] = [{ id: "solo", label: "Solo" }];
    const result = await selectAgent("fix the bug", candidates, config);
    expect(result).toBe("solo");
  });

  test("returns null when there is no API key to run the selection call", async () => {
    const config = resolveConfig({}, {});
    const candidates: AgentCandidate[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    expect(await selectAgent("fix the bug", candidates, config)).toBeNull();
  });
});

describe("parseDecomposition", () => {
  const ids = ["agentA", "agentB"];

  test("parses a valid ordered step list", () => {
    const raw = JSON.stringify({
      steps: [
        { instruction: "write the endpoint", backend_id: "agentA" },
        { instruction: "write tests for it", backend_id: "agentB" },
      ],
    });
    expect(parseDecomposition(raw, ids)).toEqual([
      { instruction: "write the endpoint", backendId: "agentA" },
      { instruction: "write tests for it", backendId: "agentB" },
    ]);
  });

  test("rejects a step whose backend_id is not among the candidates", () => {
    const raw = JSON.stringify({ steps: [{ instruction: "x", backend_id: "ghost" }] });
    expect(parseDecomposition(raw, ids)).toBeNull();
  });

  test("rejects an empty step list", () => {
    expect(parseDecomposition(JSON.stringify({ steps: [] }), ids)).toBeNull();
  });

  test("rejects a step with a blank instruction", () => {
    const raw = JSON.stringify({ steps: [{ instruction: "  ", backend_id: "agentA" }] });
    expect(parseDecomposition(raw, ids)).toBeNull();
  });

  test("returns null for unparseable input", () => {
    expect(parseDecomposition("not json", ids)).toBeNull();
  });
});

describe("decomposeTask", () => {
  test("returns null with a single candidate — nothing to split across", async () => {
    const config = resolveConfig({}, {});
    const candidates: AgentCandidate[] = [{ id: "solo", label: "Solo" }];
    expect(await decomposeTask("build the feature", candidates, config)).toBeNull();
  });

  test("returns null when there is no API key to run the decomposition call", async () => {
    const config = resolveConfig({}, {});
    const candidates: AgentCandidate[] = [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ];
    expect(await decomposeTask("build the feature", candidates, config)).toBeNull();
  });
});

describe("buildStepPrompt", () => {
  const steps = [
    { instruction: "write the endpoint", backendId: "agentA" },
    { instruction: "write tests for it", backendId: "agentB" },
  ];

  test("names the current step and lists the full plan for context", () => {
    const prompt = buildStepPrompt("build a login endpoint", steps, 1);
    expect(prompt).toContain("build a login endpoint");
    expect(prompt).toContain("write tests for it");
    expect(prompt).toContain("step 2 of 2");
    expect(prompt).toContain("1. [agentA] write the endpoint");
    expect(prompt).toContain("2. [agentB] write tests for it");
  });

  test("throws for an out-of-range index rather than silently producing a broken prompt", () => {
    expect(() => buildStepPrompt("task", steps, 5)).toThrow();
  });
});

describe("parseVerdict", () => {
  test("recognizes a clean verdict", () => {
    const verdict = parseVerdict("Looks correct.\nORCHESTRA_VERDICT: CLEAN");
    expect(verdict.status).toBe("clean");
    expect(verdict.notes).toBe("Looks correct.");
  });

  test("recognizes an issues verdict and strips the marker from the notes", () => {
    const verdict = parseVerdict("- missing null check\nORCHESTRA_VERDICT: ISSUES");
    expect(verdict.status).toBe("issues");
    expect(verdict.notes).toBe("- missing null check");
  });

  test("is unknown when no marker is present", () => {
    const verdict = parseVerdict("I looked at the diff and it seems fine.");
    expect(verdict.status).toBe("unknown");
  });

  test("the last marker wins when the instructions are echoed earlier", () => {
    const raw =
      "End with ORCHESTRA_VERDICT: CLEAN or ORCHESTRA_VERDICT: ISSUES.\n\n" +
      "- the retry loop never resets its counter\nORCHESTRA_VERDICT: ISSUES";
    const verdict = parseVerdict(raw);
    expect(verdict.status).toBe("issues");
    expect(verdict.notes).toContain("retry loop");
  });

  test("is case-insensitive", () => {
    expect(parseVerdict("all good\norchestra_verdict: clean").status).toBe("clean");
  });
});

describe("buildReviewPrompt / buildFixPrompt", () => {
  test("the review prompt embeds the task and diff and asks for a read-only check", () => {
    const prompt = buildReviewPrompt("fix the login bug", "diff --git a/auth.ts b/auth.ts");
    expect(prompt).toContain("fix the login bug");
    expect(prompt).toContain("diff --git a/auth.ts b/auth.ts");
    expect(prompt).toContain("Do NOT modify any files");
    expect(prompt).toContain("ORCHESTRA_VERDICT: CLEAN");
    expect(prompt).toContain("ORCHESTRA_VERDICT: ISSUES");
  });

  test("the fix prompt embeds the original task and the reviewer's issues", () => {
    const prompt = buildFixPrompt("fix the login bug", "- token check is inverted");
    expect(prompt).toContain("fix the login bug");
    expect(prompt).toContain("token check is inverted");
  });
});

describe("captureDiff", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-router-orchestra-"));
    tmpDirs.push(dir);
    return dir;
  }

  test("returns null outside a git work tree", () => {
    const dir = makeTmpDir();
    expect(captureDiff(dir)).toBeNull();
  });

  test("returns an empty string for a clean repository", () => {
    const dir = makeTmpDir();
    execSync("git init -q", { cwd: dir });
    execSync('git -c user.email=a@b.c -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
    expect(captureDiff(dir)?.trim()).toBe("");
  });

  test("returns the diff for an uncommitted change against HEAD", () => {
    const dir = makeTmpDir();
    execSync("git init -q", { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    execSync("git add a.txt", { cwd: dir });
    execSync('git -c user.email=a@b.c -c user.name=t commit -q -m init', { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    const diff = captureDiff(dir);
    expect(diff).toContain("a.txt");
    expect(diff).toContain("-one");
    expect(diff).toContain("+two");
  });

  test("diffs against the index when the branch has no commits yet", () => {
    const dir = makeTmpDir();
    execSync("git init -q", { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    execSync("git add a.txt", { cwd: dir });
    const diff = captureDiff(dir);
    expect(diff).not.toBeNull();
  });
});

describe("runPrintTask", () => {
  test("returns nulls when the backend declares no printArgs", () => {
    const result = runPrintTask(exec(), { prompt: "review this", continueSession: false });
    expect(result).toEqual({ text: null, status: null });
  });
});
