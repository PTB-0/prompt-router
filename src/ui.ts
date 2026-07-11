import * as readline from "readline";
import pc from "picocolors";
import type { Classification, RouteDecision, RouteTarget } from "./types.js";

const WIDTH = Math.min(process.stderr.columns ?? 80, 100);
const LINE = "─".repeat(WIDTH);
const TIMEOUT_MS = 15_000;

export const TARGET_LABELS: Record<RouteTarget, string> = {
  claude: "Claude Code",
  local: "local model",
  openrouter: "OpenRouter",
};

export interface RouteChoice {
  action: "accept" | "reject" | "edit";
  overrideTarget?: RouteTarget;
}

export type PlanChoice = "accept" | "skip" | "edit";

export function showRouting(
  original: string,
  optimized: string,
  decision: RouteDecision,
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

  const planNote = decision.planFirst ? pc.cyan(" · plan-first") : "";
  const uncertainNote = decision.uncertain ? pc.yellow(" · low confidence") : "";
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

export function askRouteChoice(): Promise<RouteChoice> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

    process.stderr.write(
      "  " +
        pc.green("[Y]") +
        pc.dim("es  ") +
        pc.red("[n]") +
        pc.dim("o, original  ") +
        pc.cyan("[e]") +
        pc.dim("dit  ") +
        pc.magenta("[c]") +
        pc.dim("laude  ") +
        pc.magenta("[l]") +
        pc.dim("ocal  ") +
        pc.magenta("[o]") +
        pc.dim("penrouter  ") +
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
      if (answer === "n" || answer === "no") finish({ action: "reject" });
      else if (answer === "e" || answer === "edit") finish({ action: "edit" });
      else if (answer === "c") finish({ action: "accept", overrideTarget: "claude" });
      else if (answer === "l") finish({ action: "accept", overrideTarget: "local" });
      else if (answer === "o") finish({ action: "accept", overrideTarget: "openrouter" });
      else finish({ action: "accept" });
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
