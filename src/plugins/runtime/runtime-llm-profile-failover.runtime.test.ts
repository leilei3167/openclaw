// Auth-profile failover tests for direct plugin LLM completions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";
import type { LlmCompleteParams } from "./types-core.js";

const hoisted = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent:
    vi.fn<
      typeof import("../../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
  loadAuthProfileStoreForRuntimeAsync: vi.fn(),
  markAuthProfileFailure: vi.fn(),
  markAuthProfileSuccess: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: hoisted.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel: hoisted.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent: hoisted.resolveSimpleCompletionSelectionForAgent,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    loadAuthProfileStoreForRuntimeAsync: hoisted.loadAuthProfileStoreForRuntimeAsync,
    markAuthProfileFailure: hoisted.markAuthProfileFailure,
    markAuthProfileSuccess: hoisted.markAuthProfileSuccess,
  };
});

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
    },
  },
} satisfies OpenClawConfig;

function createPreparedModel(
  modelId = "gpt-5.5",
  profileId?: string,
): Extract<
  Awaited<ReturnType<typeof hoisted.acquireSimpleCompletionModelForAgent>>,
  { model: unknown }
> {
  return {
    async [Symbol.asyncDispose]() {},
    selection: {
      provider: "openai",
      modelId,
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "openai",
      id: modelId,
      name: modelId,
      api: "openai",
      baseUrl: "https://fixture.invalid/v1",
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    },
    auth: {
      apiKey: "test-api-key",
      source: "test",
      mode: "api-key",
      ...(profileId ? { profileId } : {}),
    },
  };
}

function primeCompletionMocks() {
  hoisted.acquireSimpleCompletionModelForAgent.mockResolvedValue(createPreparedModel());
  hoisted.resolveSimpleCompletionSelectionForAgent.mockImplementation(
    (params: { modelRef?: string; agentId: string }) => {
      if (!params.modelRef) {
        return {
          provider: "openai",
          modelId: "gpt-5.5",
          agentDir: `/tmp/${params.agentId}`,
        };
      }
      const slash = params.modelRef.indexOf("/");
      return {
        provider: slash > 0 ? params.modelRef.slice(0, slash) : "openai",
        modelId: slash > 0 ? params.modelRef.slice(slash + 1) : params.modelRef,
        agentDir: `/tmp/${params.agentId}`,
      };
    },
  );
  hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
    content: [{ type: "text", text: "done" }],
    responseModel: "gpt-5.5-2026-08-01",
    stopReason: "stop",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 2,
      total: 25,
      cost: { total: 0.0042 },
    },
  });
}

describe("runtime.llm.complete auth profile failover", () => {
  beforeEach(() => {
    hoisted.acquireSimpleCompletionModelForAgent.mockReset();
    hoisted.completeWithPreparedSimpleCompletionModel.mockReset();
    hoisted.resolveSimpleCompletionSelectionForAgent.mockReset();
    hoisted.loadAuthProfileStoreForRuntimeAsync.mockReset();
    hoisted.markAuthProfileFailure.mockReset();
    hoisted.markAuthProfileSuccess.mockReset();
    hoisted.loadAuthProfileStoreForRuntimeAsync.mockResolvedValue({
      version: 1,
      profiles: {},
    });
    hoisted.markAuthProfileFailure.mockResolvedValue(undefined);
    hoisted.markAuthProfileSuccess.mockResolvedValue(undefined);
    primeCompletionMocks();
  });

  it("records a 429 on the first auth profile and retries the backup", async () => {
    // Generic resolver puts preferredProfile back at the front even during cooldown.
    // Do not script acquire to return B; honor preferred the same way the real selector does.
    hoisted.acquireSimpleCompletionModelForAgent.mockImplementation(async (params) =>
      createPreparedModel(
        "gpt-5.4-mini",
        params.preferredProfile === "openai:primary" ? "openai:primary" : "openai:backup",
      ),
    );
    hoisted.completeWithPreparedSimpleCompletionModel
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "429 The usage limit has been reached",
        errorType: "usage_limit_reached",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "summarized" }],
        stopReason: "stop",
        usage: { input: 3, output: 2, total: 5 },
      });

    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
        allowModelOverride: true,
        preferredProfile: "openai:primary",
      },
    });

    const result = await llm.complete({
      model: "openai/gpt-5.4-mini",
      messages: [{ role: "user", content: "summarize" }],
      execution: undefined,
    });

    expect(result).toMatchObject({ text: "summarized", stopReason: "stop" });
    expect(hoisted.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(2);
    expect(
      hoisted.completeWithPreparedSimpleCompletionModel.mock.calls.map(
        (call) => (call[0] as { auth: { profileId?: string } }).auth.profileId,
      ),
    ).toEqual(["openai:primary", "openai:backup"]);
    expect(hoisted.markAuthProfileFailure).toHaveBeenCalledOnce();
    expect(hoisted.markAuthProfileFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "openai:primary",
        reason: "rate_limit",
        modelId: "gpt-5.4-mini",
      }),
    );
    expect(hoisted.markAuthProfileSuccess).toHaveBeenCalledOnce();
    expect(hoisted.markAuthProfileSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "openai:backup",
        provider: "openai",
        agentDir: "/tmp/openclaw-agent",
      }),
    );
    const acquireArgs = hoisted.acquireSimpleCompletionModelForAgent.mock.calls.map(
      (call) => call[0],
    );
    expect(acquireArgs).toHaveLength(2);
    expect(acquireArgs[0]).toEqual(expect.objectContaining({ preferredProfile: "openai:primary" }));
    expect(acquireArgs[1]).toEqual(
      expect.not.objectContaining({ preferredProfile: "openai:primary" }),
    );
  });

  it("clears recovered profile failure state so a later 429 starts a new cooldown", async () => {
    hoisted.acquireSimpleCompletionModelForAgent.mockImplementation(async (params) =>
      createPreparedModel(
        "gpt-5.4-mini",
        params.preferredProfile === "openai:primary" ? "openai:primary" : "openai:backup",
      ),
    );
    hoisted.completeWithPreparedSimpleCompletionModel
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "429 The usage limit has been reached",
        errorType: "usage_limit_reached",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "summarized" }],
        stopReason: "stop",
        usage: { input: 3, output: 2, total: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "" }],
        stopReason: "error",
        errorMessage: "429 The usage limit has been reached",
        errorType: "usage_limit_reached",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "summarized again" }],
        stopReason: "stop",
        usage: { input: 3, output: 2, total: 5 },
      });

    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: {
        allowComplete: true,
        allowModelOverride: true,
        preferredProfile: "openai:primary",
      },
    });
    const request: LlmCompleteParams = {
      model: "openai/gpt-5.4-mini",
      messages: [{ role: "user", content: "summarize" }],
      execution: undefined,
    };

    await expect(llm.complete(request)).resolves.toMatchObject({
      text: "summarized",
      stopReason: "stop",
    });
    await expect(llm.complete(request)).resolves.toMatchObject({
      text: "summarized again",
      stopReason: "stop",
    });

    expect(hoisted.markAuthProfileFailure.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ profileId: "openai:primary", reason: "rate_limit" }),
      expect.objectContaining({ profileId: "openai:primary", reason: "rate_limit" }),
    ]);
    expect(hoisted.markAuthProfileSuccess.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ profileId: "openai:backup", provider: "openai" }),
      expect.objectContaining({ profileId: "openai:backup", provider: "openai" }),
    ]);
  });

  it("does not rotate when the caller pinned a model auth profile", async () => {
    hoisted.acquireSimpleCompletionModelForAgent.mockResolvedValue(
      createPreparedModel("gpt-5.4-mini", "openai:primary"),
    );
    hoisted.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "429 The usage limit has been reached",
      errorType: "usage_limit_reached",
    });

    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { allowComplete: true, allowModelOverride: true },
    });

    await expect(
      llm.complete({
        model: "openai/gpt-5.4-mini@openai:primary",
        messages: [{ role: "user", content: "summarize" }],
        execution: undefined,
      }),
    ).resolves.toMatchObject({ text: "", stopReason: "error" });
    expect(hoisted.completeWithPreparedSimpleCompletionModel).toHaveBeenCalledOnce();
    expect(hoisted.markAuthProfileFailure).toHaveBeenCalledOnce();
    expect(hoisted.acquireSimpleCompletionModelForAgent).toHaveBeenCalledOnce();
  });
});
