// Auth-profile failover for direct plugin LLM completions: mark failures, skip the preferred
// profile on retry, and clear recovered failure state after a successful alternate profile.
import { asFiniteNumber } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  loadAuthProfileStoreForRuntimeAsync,
  markAuthProfileFailure,
  markAuthProfileSuccess,
} from "../../agents/auth-profiles.js";
import { classifyAssistantFailoverReason } from "../../agents/embedded-agent-helpers/assistant-message-failures.js";
import { resolveAuthProfileFailureReason } from "../../agents/embedded-agent-runner/run/auth-profile-failure-policy.js";
import type {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "../../agents/simple-completion-runtime.js";
import type { PrepareSimpleCompletionModelForAgentParams } from "../../agents/simple-completion.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Api, Message } from "../../llm/types.js";
import { createLlmCompleteError as completionError } from "./runtime-llm-error.js";
import type { LlmCompleteParams, LlmCompleteResult, RuntimeLogger } from "./types-core.js";

type AcquiredPreparedSimpleCompletionModel = Extract<
  Awaited<ReturnType<typeof acquireSimpleCompletionModelForAgent>>,
  { model: unknown }
>;

type FinalizePluginLlmCompletion = (params: {
  cfg: OpenClawConfig;
  hostPluginId?: string;
  suppressUsage?: boolean;
  rawUsage: unknown;
  logger?: RuntimeLogger;
  result: Omit<LlmCompleteResult, "usage">;
}) => LlmCompleteResult;

function buildSystemPrompt(params: LlmCompleteParams): string | undefined {
  const segments = [
    normalizeOptionalString(params.systemPrompt),
    ...params.messages
      .filter((message) => message.role === "system")
      .map((message) => normalizeOptionalString(message.content)),
  ].filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("\n\n") : undefined;
}

function buildMessages(params: {
  request: LlmCompleteParams;
  provider: string;
  model: string;
  api: Api;
}): Message[] {
  const now = Date.now();
  return params.request.messages
    .filter((message) => message.role !== "system")
    .map((message) =>
      message.role === "user"
        ? { role: "user" as const, content: message.content, timestamp: now }
        : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: message.content }],
            api: params.api,
            provider: params.provider,
            model: params.model,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: now,
          },
    );
}

/**
 * Run a direct-provider plugin completion, rotating away from a failed preferred auth profile.
 */
export async function completeDirectProviderWithProfileFailover(params: {
  request: LlmCompleteParams;
  cfg: OpenClawConfig;
  agentId: string;
  hostPluginId?: string;
  acquireParams: PrepareSimpleCompletionModelForAgentParams;
  prepared: AcquiredPreparedSimpleCompletionModel;
  requestedModelProfile?: string;
  audit: LlmCompleteResult["audit"];
  logger: RuntimeLogger;
  finalizePluginLlmCompletion: FinalizePluginLlmCompletion;
  acquireSimpleCompletionModelForAgent: typeof acquireSimpleCompletionModelForAgent;
  completeWithPreparedSimpleCompletionModel: typeof completeWithPreparedSimpleCompletionModel;
}): Promise<LlmCompleteResult> {
  const {
    request,
    cfg,
    agentId,
    hostPluginId,
    acquireParams,
    requestedModelProfile,
    audit,
    logger,
    finalizePluginLlmCompletion,
  } = params;
  const attemptedProfiles = new Set<string>();
  let lastFailure: LlmCompleteResult | undefined;
  let current = params.prepared;
  let retryLease: AcquiredPreparedSimpleCompletionModel | undefined;
  try {
    for (;;) {
      if (request.requiredAuthMode && current.auth.mode !== request.requiredAuthMode) {
        throw completionError(
          "LLM_COMPLETION_NOT_AUTHORIZED",
          "Plugin LLM completion selected a credential with the wrong authentication mode.",
        );
      }
      if (requestedModelProfile && current.auth.profileId !== requestedModelProfile) {
        throw completionError(
          "LLM_COMPLETION_NOT_AUTHORIZED",
          "Plugin LLM completion selected a different authentication profile.",
        );
      }

      const profileId = normalizeOptionalString(current.auth.profileId);
      if (lastFailure && (!profileId || attemptedProfiles.has(profileId))) {
        return lastFailure;
      }

      const context = {
        systemPrompt: buildSystemPrompt(request),
        messages: buildMessages({
          request,
          provider: current.model.provider,
          model: current.model.id,
          api: current.model.api,
        }),
      };

      const result = await params.completeWithPreparedSimpleCompletionModel({
        model: current.model,
        auth: current.auth,
        cfg,
        context,
        options: {
          maxTokens: asFiniteNumber(request.maxTokens),
          temperature: asFiniteNumber(request.temperature),
          ...(request.responseFormat !== undefined
            ? { responseFormat: request.responseFormat }
            : {}),
          ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
          signal: request.signal,
        },
      });

      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      const completed = finalizePluginLlmCompletion({
        cfg,
        hostPluginId,
        // Provider failures resolve as messages; only visible successful output owns usage.
        suppressUsage: !text.trim() || !["stop", "length", "toolUse"].includes(result.stopReason),
        rawUsage: result.usage,
        logger,
        result: {
          text,
          provider: current.selection.provider,
          model: current.selection.modelId,
          responseModel: result.responseModel,
          stopReason: result.stopReason,
          agentId,
          execution: {
            mode: "direct-provider",
            owner: { kind: "provider", id: current.selection.provider },
          },
          audit,
        },
      });
      const succeeded = ["stop", "length", "toolUse"].includes(result.stopReason);
      if (succeeded || result.stopReason === "aborted" || request.signal?.aborted) {
        if (profileId && succeeded && !request.signal?.aborted) {
          try {
            const store = await loadAuthProfileStoreForRuntimeAsync(current.selection.agentDir);
            await markAuthProfileSuccess({
              store,
              provider: current.selection.provider,
              profileId,
              agentDir: current.selection.agentDir,
            });
          } catch (error) {
            logger.warn("plugin llm auth profile success bookkeeping failed", {
              profileId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return completed;
      }

      lastFailure = completed;
      const failoverReason = classifyAssistantFailoverReason(result, {
        provider: current.model.provider,
      });
      const failureReason = resolveAuthProfileFailureReason({
        failoverReason,
        providerStarted: true,
      });
      if (profileId && failureReason) {
        try {
          const store = await loadAuthProfileStoreForRuntimeAsync(current.selection.agentDir);
          await markAuthProfileFailure({
            store,
            profileId,
            reason: failureReason,
            cfg,
            agentDir: current.selection.agentDir,
            modelId: current.selection.modelId,
          });
        } catch (error) {
          logger.warn("plugin llm auth profile failure bookkeeping failed", {
            profileId,
            reason: failureReason,
            error: error instanceof Error ? error.message : String(error),
          });
          return completed;
        }
      }
      if (requestedModelProfile || !failureReason || !profileId) {
        return completed;
      }
      attemptedProfiles.add(profileId);

      const retry = await params.acquireSimpleCompletionModelForAgent({
        ...acquireParams,
        preferredProfile: undefined,
      });
      if ("error" in retry) {
        return lastFailure;
      }
      const retryProfileId = normalizeOptionalString(retry.auth.profileId);
      if (!retryProfileId || attemptedProfiles.has(retryProfileId)) {
        await retry[Symbol.asyncDispose]();
        return lastFailure;
      }
      if (retryLease) {
        await retryLease[Symbol.asyncDispose]();
      }
      retryLease = retry;
      current = retry;
    }
  } finally {
    if (retryLease) {
      await retryLease[Symbol.asyncDispose]();
    }
  }
}
