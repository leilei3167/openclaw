import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { logWarn } from "../../../logger.js";
import { ANNOUNCE_COMPLETION_HARD_EXPIRY_MS } from "../registry/subagent-registry-helpers.js";
import type {
  RequesterSettleWakeState,
  SubagentRunRecord,
} from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

export type RequesterSettleWakeBatchState = Omit<RequesterSettleWakeState, "retireAfterSettle">;

export const REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS = 1_024;
export const ROUTE_NOTICE_TRUNCATION = "\n[model-route changes truncated]";
export const REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS = [30_000, 120_000] as const;

export function resolveRequesterSettleObservationDeadline(
  batch: readonly SubagentRunRecord[],
  state: RequesterSettleWakeBatchState,
  now: number,
): number {
  if (typeof state.deadlineAt === "number") {
    return state.deadlineAt;
  }
  // Prefer the existing announce delivery deadline when the batch still owns one.
  const inherited = batch
    .map((entry) =>
      entry.expectsCompletionMessage === true && typeof entry.delivery?.deadlineAt === "number"
        ? entry.delivery.deadlineAt
        : undefined,
    )
    .filter((value): value is number => typeof value === "number");
  if (inherited.length > 0) {
    return Math.min(...inherited);
  }
  // Same hard expiry clock as completion announce cleanup.
  return now + ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
}

export function withWakeDeadline(
  deadlineAt: number | undefined,
): Pick<RequesterSettleWakeBatchState, "deadlineAt"> {
  return typeof deadlineAt === "number" ? { deadlineAt } : {};
}

export function buildRequesterSettleWakeMessage(params: {
  findings?: string;
  requireVisibleReply: boolean;
  modelRouteChange?: string;
  preserveModelRouteNotice: boolean;
}): string {
  return [
    "[Subagent Context] Every subagent spawned from this session has now settled — none are still running or awaiting completion delivery.",
    "[Subagent Context] Do not keep waiting or call sessions_yield again for this batch; no further completion events will arrive.",
    "[Subagent Context] Child settlement ends this batch, not necessarily the original user request. Review the results against the requested outcome and continue any remaining in-scope work before replying.",
    params.requireVisibleReply
      ? "[Subagent Context] Child completion delivery is internal; the original user request still requires your visible final answer only after the requested outcome is complete or genuinely blocked."
      : `[Subagent Context] Reply ONLY: ${SILENT_REPLY_TOKEN} only if you already delivered the consolidated final answer for this batch.`,
    ...(params.modelRouteChange
      ? [
          params.modelRouteChange,
          params.preserveModelRouteNotice
            ? "[Subagent Context] Preserve this runtime-authored model-route change notice in your final answer."
            : "[Subagent Context] Keep this runtime-authored model-route change notice internal on this shared surface.",
        ]
      : []),
    "",
    params.findings ??
      "(each child result was announced individually in earlier completion events)",
  ].join("\n");
}

export function buildConnectedSettledWave(
  candidates: readonly SubagentRunRecord[],
  settledEntry: SubagentRunRecord,
): SubagentRunRecord[] {
  const targetIndex = candidates.findIndex((entry) => entry.runId === settledEntry.runId);
  const target = candidates[targetIndex];
  if (!target) {
    return [];
  }

  const sorted = candidates
    .map((entry, originalIndex) => ({
      entry,
      originalIndex,
      endedAt:
        typeof entry.execution.endedAt === "number"
          ? entry.execution.endedAt
          : Number.MAX_SAFE_INTEGER,
    }))
    .toSorted(
      (a, b) =>
        a.entry.createdAt - b.entry.createdAt ||
        a.endedAt - b.endedAt ||
        a.originalIndex - b.originalIndex,
    );
  const first = sorted[0];
  if (!first) {
    return [];
  }

  let componentStart = 0;
  let componentEnd = first.endedAt;
  let containsTarget = first.originalIndex === targetIndex;
  for (let index = 1; index <= sorted.length; index += 1) {
    const next = sorted[index];
    // Interval-graph components are contiguous after sorting by spawn time.
    // Spawn time, rather than execution admission, keeps capacity-queued siblings together.
    if (!next || next.entry.createdAt > componentEnd) {
      if (containsTarget) {
        const component = sorted
          .slice(componentStart, index)
          .filter((item) => item.originalIndex !== targetIndex)
          .toSorted((a, b) => a.originalIndex - b.originalIndex);
        return [target, ...component.map((item) => item.entry)];
      }
      if (!next) {
        break;
      }
      componentStart = index;
      componentEnd = next.endedAt;
      containsTarget = next.originalIndex === targetIndex;
      continue;
    }
    componentEnd = Math.max(componentEnd, next.endedAt);
    containsTarget ||= next.originalIndex === targetIndex;
  }
  return [];
}

export function readSharedBatchState(batch: readonly SubagentRunRecord[]): RequesterSettleWakeBatchState {
  const states = batch
    .map((entry) => entry.requesterSettleWake)
    .filter((state): state is RequesterSettleWakeState => Boolean(state));
  const dispatching = states.find((state) => state.status === "dispatching");
  const source = dispatching ?? states[0];
  return {
    status: source?.status ?? "pending",
    attemptCount: Math.max(0, ...states.map((state) => state.attemptCount)),
    ...(source?.replayCount !== undefined ? { replayCount: source.replayCount } : {}),
    ...(source?.nextAttemptAt !== undefined ? { nextAttemptAt: source.nextAttemptAt } : {}),
    ...(source?.deadlineAt !== undefined ? { deadlineAt: source.deadlineAt } : {}),
    ...(source?.batchRunIds ? { batchRunIds: [...source.batchRunIds] } : {}),
    ...(states.some((state) => state.requesterYieldBatch === true)
      ? { requesterYieldBatch: true }
      : {}),
    ...(states.some((state) => state.afterRequesterYield === true)
      ? { afterRequesterYield: true }
      : {}),
    ...(source?.rearmGeneration !== undefined ? { rearmGeneration: source.rearmGeneration } : {}),
    ...(source?.lastError !== undefined ? { lastError: source.lastError } : {}),
    deferralCount: Math.max(0, ...states.map((state) => state.deferralCount ?? 0)),
  };
}

export function truncateRequesterSettleRouteNotices(routeNotices: string): string {
  return routeNotices.length > REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS
    ? `${truncateUtf16Safe(
        routeNotices,
        REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS - ROUTE_NOTICE_TRUNCATION.length,
      )}${ROUTE_NOTICE_TRUNCATION}`
    : routeNotices;
}

export function handleRequesterSettlePendingHandoff(params: {
  settledBatch: readonly SubagentRunRecord[];
  state: RequesterSettleWakeBatchState;
  delivery: SubagentAnnounceDeliveryResult;
  batchRunIds: readonly string[];
  transitionBatch: (
    batch: readonly SubagentRunRecord[],
    state: RequesterSettleWakeBatchState,
  ) => void;
  completeBatch: (
    batch: readonly SubagentRunRecord[],
    rearmGeneration?: number,
    delivery?: SubagentAnnounceDeliveryResult,
  ) => void;
}): boolean {
  const now = Date.now();
  const lastError = params.delivery.error ?? params.delivery.reason ?? "completion_handoff_pending";
  const deadlineAt = resolveRequesterSettleObservationDeadline(params.settledBatch, params.state, now);
  if (now >= deadlineAt) {
    params.completeBatch(params.settledBatch, params.state.rearmGeneration, {
      delivered: false,
      path: "none",
      error: "requester settle wake expired",
    });
    return false;
  }
  const alreadyPending =
    params.state.lastError === "completion_handoff_pending" || params.state.lastError === lastError;
  // Index with literals so noUncheckedIndexedAccess stays definite (const tuple).
  const retryDelayMs = alreadyPending
    ? REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[1]
    : REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[0];
  const nextAttemptAt = Math.min(now + retryDelayMs, deadlineAt);
  const state: RequesterSettleWakeBatchState = {
    status: "dispatching",
    attemptCount: params.state.attemptCount,
    // Preserve any prior transport-failure replayCount; do not increment it.
    ...(params.state.replayCount !== undefined ? { replayCount: params.state.replayCount } : {}),
    nextAttemptAt,
    deadlineAt,
    batchRunIds: params.batchRunIds,
    ...(params.state.requesterYieldBatch === true ? { requesterYieldBatch: true } : {}),
    ...(params.state.afterRequesterYield === true ? { afterRequesterYield: true } : {}),
    ...(params.state.rearmGeneration !== undefined ? { rearmGeneration: params.state.rearmGeneration } : {}),
    lastError,
  };
  params.transitionBatch(params.settledBatch, state);
  logWarn(
    `requester settle wake pending handoff observation scheduled in ${Math.round((nextAttemptAt - now) / 1000)}s: ${lastError}`,
  );
  return false;
}
