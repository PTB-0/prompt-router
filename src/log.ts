import * as fs from "fs";
import * as path from "path";

/** Appends one JSON line to `<dir>/routing-log.jsonl`. Content-free by design — event must never carry prompt or model-output text, only categories/targets/error reasons. */
export function appendRoutingLog(dir: string, event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "routing-log.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
      "utf8",
    );
  } catch {
    // logging must never break routing
  }
}
