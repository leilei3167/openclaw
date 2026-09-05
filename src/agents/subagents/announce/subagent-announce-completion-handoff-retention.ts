/**
 * Retained Gateway completion-handoff ownership for announce retries.
 *
 * When an announce gets a nonterminal gateway response (accepted / in_flight),
 * keep the idempotency key so a later retry rejoins that handoff instead of
 * steering into a successor requester run after the original handle settles.
 */
import { isActiveEmbeddedRunId } from "./subagent-announce-delivery.runtime.js";

const retainedCompletionHandoffKeys = new Set<string>();

export function normalizeCompletionHandoffKey(key: string | undefined): string | undefined {
  const normalized = key?.trim();
  return normalized || undefined;
}

export function retainCompletionHandoffKey(key: string | undefined): void {
  const normalized = normalizeCompletionHandoffKey(key);
  if (normalized) {
    retainedCompletionHandoffKeys.add(normalized);
  }
}

export function releaseCompletionHandoffKey(key: string | undefined): void {
  const normalized = normalizeCompletionHandoffKey(key);
  if (normalized) {
    retainedCompletionHandoffKeys.delete(normalized);
  }
}

export function clearRetainedCompletionHandoffKeysForTest(): void {
  retainedCompletionHandoffKeys.clear();
}

export function shouldJoinOriginalCompletionHandoff(key: string | undefined): boolean {
  const normalized = normalizeCompletionHandoffKey(key);
  if (!normalized) {
    return false;
  }
  // Prefer Gateway replay whenever we already own a pending handoff for this
  // key, or the original run is still the active embedded handle.
  return retainedCompletionHandoffKeys.has(normalized) || isActiveEmbeddedRunId(normalized);
}
