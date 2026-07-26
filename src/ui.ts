import * as readline from "readline";
import pc from "picocolors";
import type { Backend, Classification, Dispatch } from "./types.js";

const WIDTH = Math.min(process.stderr.columns ?? 80, 100);
const LINE = "─".repeat(WIDTH);
const TIMEOUT_MS = 15_000;

export interface RouteChoice {
  action: "accept" | "reject" | "edit";
  overrideBackendId?: string;
}

/**
 * Numeric keys address the candidates positionally; the original c/l/o letters
 * stay bound to their backends so existing muscle memory keeps working.
 */
const LEGACY_KEYS: Record<string, string> = { c: "claude", l: "local", o: "openrouter" };

export function overrideKeyMap(candidates: readonly Backend[]): Map<string, string> {
  const keys = new Map<string, string>();
  candidates.slice(0, 3).forEach((backend, index) => {
    keys.set(String(index + 1), backend.id);
  });
  for (const [key, id] of Object.entries(LEGACY_KEYS)) {
    if (candidates.some((backend) => backend.id === id)) keys.set(key, id);
  }
  return keys;
}

export type PlanChoice = "accept" | "skip" | "edit";

export function showRouting(
  original: string,
  optimized: string,
  dispatch: Dispatch,
  detail: string,
  cls: Classification | null,
): void {
  const err = process.stderr;
  err.write("\n" + pc.dim(LINE) + "\n");
  err.write(pc.bold("  prompt-router") + pc.dim(" — optimized & routed\n"));
  err.write(pc.dim(LINE) + "\n\n");

  err.write(pc.dim("  ORIGINAL\n"));
  err.write(pc.dim("  " + original.replace(/\n/g, "\n  ")) + "\n\n");

  if (optimized !== original) {
    err.write(pc.green(pc.bold("  OPTIMIZED\n")));
    err.write(pc.green("  " + optimized.replace(/\n/g, "\n  ")) + "\n\n");
  }

  const planNote = dispatch.planFirst ? pc.cyan(" · plan-first") : "";
  const uncertainNote = dispatch.uncertain ? pc.yellow(" · low confidence") : "";
  err.write(pc.bold(`  ROUTE → ${detail}`) + planNote + uncertainNote + "\n");
  if (cls) {
    err.write(
      pc.dim(
        `  (${cls.category}, complexity ${cls.complexity.toFixed(1)}, confidence ${cls.confidence.toFixed(1)})`,
      ) + "\n",
    );
  }
  err.write("\n" + pc.dim(LINE) + "\n");
}

export function askRouteChoice(candidates: readonly Backend[]): Promise<RouteChoice> {
  // Piped/CI stdin can't answer (and its data must not be eaten as menu
  // keystrokes) — take the default immediately instead of pretending to wait.
  if (!process.stdin.isTTY) {
    process.stderr.write(pc.dim("  non-interactive session — accepting the route\n"));
    return Promise.resolve({ action: "accept" });
  }
  const keys = overrideKeyMap(candidates);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

    const overrides = candidates
      .slice(0, 3)
      .map((backend, index) => pc.magenta(`[${index + 1}]`) + pc.dim(` ${backend.label}  `))
      .join("");

    process.stderr.write(
      "  " +
        pc.green("[Y]") +
        pc.dim("es  ") +
        pc.red("[n]") +
        pc.dim("o, original  ") +
        pc.cyan("[e]") +
        pc.dim("dit  ") +
        overrides +
        pc.dim(`(${TIMEOUT_MS / 1000}s timeout → Y): `),
    );

    let settled = false;
    const finish = (choice: RouteChoice): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(choice);
    };

    const timer = setTimeout(() => {
      process.stderr.write(pc.dim("Y\n"));
      finish({ action: "accept" });
    }, TIMEOUT_MS);

    rl.once("close", () => finish({ action: "accept" }));

    rl.once("line", (line) => {
      const answer = line.trim().toLowerCase();
      if (answer === "n" || answer === "no") return finish({ action: "reject" });
      if (answer === "e" || answer === "edit") return finish({ action: "edit" });
      const override = keys.get(answer);
      if (override) return finish({ action: "accept", overrideBackendId: override });
      finish({ action: "accept" });
    });
  });
}

export function showPlan(plan: string): void {
  const err = process.stderr;
  err.write("\n" + pc.dim(LINE) + "\n");
  err.write(pc.bold("  PLAN") + pc.dim(" — will be attached to the prompt\n"));
  err.write(pc.dim(LINE) + "\n\n");
  err.write(pc.cyan("  " + plan.replace(/\n/g, "\n  ")) + "\n\n");
  err.write(pc.dim(LINE) + "\n");
}

export function askPlanChoice(): Promise<PlanChoice> {
  if (!process.stdin.isTTY) {
    process.stderr.write(pc.dim("  non-interactive session — attaching the plan\n"));
    return Promise.resolve("accept");
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

    process.stderr.write(
      "  " +
        pc.green("[Y]") +
        pc.dim("es, attach  ") +
        pc.red("[n]") +
        pc.dim("o, skip plan  ") +
        pc.cyan("[e]") +
        pc.dim("dit  ") +
        pc.dim(`(${TIMEOUT_MS / 1000}s timeout → Y): `),
    );

    let settled = false;
    const finish = (choice: PlanChoice): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(choice);
    };

    const timer = setTimeout(() => {
      process.stderr.write(pc.dim("Y\n"));
      finish("accept");
    }, TIMEOUT_MS);

    rl.once("close", () => finish("accept"));

    rl.once("line", (line) => {
      const answer = line.trim().toLowerCase();
      if (answer === "n" || answer === "no") finish("skip");
      else if (answer === "e" || answer === "edit") finish("edit");
      else finish("accept");
    });
  });
}

export function showPassThrough(reason: string): void {
  process.stderr.write(pc.dim(`prompt-router: ${reason}.\n`));
}

export function showError(message: string): void {
  process.stderr.write(pc.yellow(`prompt-router: ${message}\n`));
}

export function startSpinner(label: string): () => void {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  process.stderr.write(pc.dim(`  ${label}`));
  const interval = setInterval(() => {
    process.stderr.write("\r" + pc.dim(`  ${frames[i]} ${label}`));
    i = (i + 1) % frames.length;
  }, 80);
  return () => {
    clearInterval(interval);
    process.stderr.write("\r" + " ".repeat(label.length + 6) + "\r");
  };
}
