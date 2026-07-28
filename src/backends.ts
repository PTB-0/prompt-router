import type { Backend, Category, ChatBackend, ExecBackend } from "./types.js";

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
 * Enabled chat backends that are not in `tried`, in the same priority order
 * selectCandidates uses.
 *
 * These are the last resort before a chat failure burns the agentic backend.
 * A backend that does not serve the chosen category is still a better answer
 * than paying the agent for a question — which is exactly the degradation the
 * README documents for a user with no API key: every prompt the heuristic
 * doesn't claim resolves to "deep-qa", the local backend only declares
 * "simple-qa", so without this sweep the local server would never be contacted
 * at all.
 */
export function remainingChatBackends(
  backends: readonly Backend[],
  tried: ReadonlySet<string>,
): ChatBackend[] {
  return backends
    .map((backend, index) => ({ backend, index }))
    .filter(
      (entry): entry is { backend: ChatBackend; index: number } =>
        entry.backend.kind === "chat" && entry.backend.enabled && !tried.has(entry.backend.id),
    )
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

/**
 * The backend the counterfactual is priced against: the strongest enabled exec
 * backend that actually declares `modelPricing`, falling back to the handoff
 * backend when none does (savings then come out zero, which is honest — there
 * is no price to compare against).
 *
 * Deliberately separate from findHandoffBackend. *Where a failure hands off*
 * and *what the saving is priced against* are different questions: declaring a
 * second coding agent above Claude Code with no pricing changes the first, and
 * conflating them would silently zero the product's headline number forever.
 */
export function findPricingReferenceBackend(backends: readonly Backend[]): ExecBackend | null {
  let best: ExecBackend | null = null;
  for (const backend of backends) {
    if (backend.kind !== "exec" || !backend.enabled) continue;
    if (Object.keys(backend.modelPricing).length === 0) continue;
    if (best === null || backend.priority > best.priority) best = backend;
  }
  return best ?? findHandoffBackend(backends);
}
