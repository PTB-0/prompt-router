import type { Backend, Category, ExecBackend } from "./types.js";

/**
 * Ordered candidates for a category: the head is the target, the tail is the
 * fallback chain. Ties keep config order so the choice is deterministic.
 */
export function selectCandidates(category: Category, backends: readonly Backend[]): Backend[] {
  return backends
    .map((backend, index) => ({ backend, index }))
    .filter(({ backend }) => backend.enabled && backend.categories.includes(category))
    .sort((a, b) => b.backend.priority - a.backend.priority || a.index - b.index)
    .map(({ backend }) => backend);
}

/**
 * The backend every chat failure ultimately hands off to — the strongest
 * agentic one, since a hand-off must not land somewhere weaker.
 */
export function findHandoffBackend(backends: readonly Backend[]): ExecBackend | null {
  let best: ExecBackend | null = null;
  for (const backend of backends) {
    if (backend.kind !== "exec" || !backend.enabled) continue;
    if (best === null || backend.priority > best.priority) best = backend;
  }
  return best;
}
