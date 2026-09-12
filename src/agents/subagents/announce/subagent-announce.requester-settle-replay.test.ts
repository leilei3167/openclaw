import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentDedupeLifecycle } from "../../../gateway/agent-turn/agent-dedupe-lifecycle.js";
import { setGatewayDedupeEntries } from "../../../gateway/agent-turn/agent-dedupe.js";
import { createInternalAgentTurnFacade } from "../../../gateway/agent-turn/internal-facade.js";
import { createGatewayMethodRegistry } from "../../../gateway/methods/registry.js";
import { createChatRunState } from "../../../gateway/server-chat-state.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../../shared/async-work-scope.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-delivery.runtime.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

const registryRead = vi.hoisted(() => ({
  getLatestLiveSubagentRunByChildSessionKey: vi.fn(() => undefined),
  hasDescendantRunAwaitingSettle: vi.fn(() => false),
  listSubagentRunsForRequester: vi.fn<() => SubagentRunRecord[]>(() => []),
  getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
}));
const deliver = vi.hoisted(() => vi.fn());

// Keep admission preflight, turn service, dedupe and facade real. Only the
// enclosing request envelope and the registry/session fixture are substituted.
vi.mock("../../../gateway/server-methods.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
  createRequestGatewayMethodRegistry: () => ({ isControlPlaneWrite: () => false }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));
vi.mock("../registry/subagent-registry-read.js", () => registryRead);
vi.mock("../spawn/subagent-depth.js", () => ({ getSubagentDepthFromSessionStore: () => 0 }));
vi.mock("./subagent-announce.js", () => ({ hasUsableSessionEntry: () => true }));
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (...args: unknown[]) => deliver(...args),
  loadRequesterSessionEntry: () => ({
    canonicalKey: "agent:main:main",
    entry: { sessionId: "requester-session" },
  }),
}));

const REQUESTER_KEY = "agent:main:main";
const ATTEMPT_KEY = `announce:requester-settle:main:${REQUESTER_KEY}:settled-child:yield-1`;

describe("requester settle canonical admission replay", () => {
  afterEach(() => {
    setSubagentAnnounceDeliveryDepsForTest();
    registryRead.listSubagentRunsForRequester.mockReset();
    deliver.mockReset();
  });

  it.each(["pending", "terminal"] as const)(
    "requires terminal evidence before retiring a required-visible batch: %s",
    async (phase) => {
      const methodRegistry = createGatewayMethodRegistry([]);
      const context = Object.assign({} as GatewayRequestContext, {
        trackExecution: trackAsyncWork,
        agentRunSeq: new Map(),
        broadcast: vi.fn(),
        chatAbortControllers: new Map(),
        chatRunState: createChatRunState(),
        dedupe: new Map(),
        getRuntimeConfig: () => ({}),
        getGatewayMethodRegistry: () => methodRegistry,
        logGateway: { error: vi.fn(), warn: vi.fn() },
        nodeSendToSession: vi.fn(),
        removeChatRun: vi.fn(),
      });
      context.createAgentTurnFacade = (principal) =>
        createInternalAgentTurnFacade({
          ...principal,
          getContext: () => context,
          getMethodRegistry: () => methodRegistry,
        });
      const child: SubagentRunRecord = {
        runId: "settled-child",
        childSessionKey: "agent:main:subagent:settled-child",
        requesterSessionKey: REQUESTER_KEY,
        requesterDisplayKey: "main",
        requesterAgentId: "main",
        task: "finish child work",
        cleanup: "keep",
        createdAt: 1_000,
        execution: { status: "terminal", endedAt: 3_000, outcome: { status: "ok" } },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "child result", capturedAt: 3_000 },
        delivery: { status: "delivered" },
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          batchRunIds: ["settled-child"],
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      };
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
      setSubagentAnnounceDeliveryDepsForTest({
        getRuntimeConfig: () => ({}),
        loadRequesterSessionEntry: () => ({
          cfg: {},
          canonicalKey: REQUESTER_KEY,
          agentId: "main",
          entry: { sessionId: "requester-session", updatedAt: 1 },
        }),
        getRequesterSessionActivity: () => ({ sessionId: "requester-session", isActive: false }),
      });
      deliver.mockImplementation(sendSubagentAnnounceDirectly);
      const keys = [`agent:${ATTEMPT_KEY}`];
      const reservation = createAgentDedupeLifecycle({
        cfg: {},
        request: { idempotencyKey: ATTEMPT_KEY, sessionKey: REQUESTER_KEY, message: "settle" },
        runId: "original-requester-run",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        agentDedupeKeys: keys,
        suppressVisibleSessionEffects: false,
        context,
        io: { emitAcceptance: vi.fn(), emitFinal: vi.fn() },
      });
      // Model the existing handoff while asynchronous admission is outstanding.
      // The real reservation owner writes accepted + reservationId; the real
      // service must derive in_flight/admissionPending, not a mocked RPC reply.
      reservation.reserve(REQUESTER_KEY, "main");
      if (phase === "terminal") {
        // Control only: a synthetic committed transcript final, not outbound proof.
        setGatewayDedupeEntries({
          dedupe: context.dedupe,
          keys,
          entry: {
            ts: Date.now(),
            ok: true,
            payload: {
              status: "ok",
              runId: "original-requester-run",
              result: { payloads: [{ text: "consolidated requester final" }] },
            },
          },
        });
      }
      const completeBatch = vi.fn(() => {
        child.requesterSettleWake = undefined;
      });
      try {
        const settled = await withPluginRuntimeGatewayRequestScope(
          { context, client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
          () =>
            maybeWakeRequesterAfterAllChildrenSettled({
              requesterSessionKey: REQUESTER_KEY,
              settledEntry: child,
              transitionBatch: (_batch, state) => {
                child.requesterSettleWake = state;
              },
              completeBatch,
            }),
        );
        expect(deliver).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            directIdempotencyKey: ATTEMPT_KEY,
            sourceTool: "subagent_settle",
            requireVisibleReply: true,
          }),
        );
        if (phase === "pending") {
          expect(context.dedupe.get(keys[0]!)?.payload).toMatchObject({
            status: "accepted",
            reservationId: reservation.reservationId,
          });
          expect.soft(completeBatch).not.toHaveBeenCalled();
          expect.soft(settled).toBe(false);
          expect(child.requesterSettleWake).toBeDefined();
        } else {
          expect(settled).toBe(true);
          expect(completeBatch).toHaveBeenCalledWith(
            [child],
            1,
            expect.objectContaining({
              delivered: true,
              requesterVisibleFinalDelivered: true,
            }),
          );
          expect(child.requesterSettleWake).toBeUndefined();
        }
      } finally {
        reservation.clearUnaccepted();
        context.dedupe.clear();
      }
    },
  );
});
