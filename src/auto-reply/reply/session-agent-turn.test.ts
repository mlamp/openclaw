import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSessionAgentTurnParams } from "./session-agent-turn.js";

// Isolate the routing decision: mock the embedded SDK runner, the CLI runner,
// and the provider resolver/gate so the test asserts only which path the seam
// dispatches to (and how it maps params), not the runners themselves.
const {
  runEmbeddedAgentMock,
  runCliAgentWithLifecycleMock,
  resolveCliExecutionProviderForSessionMock,
  isCliProviderMock,
} = vi.hoisted(() => ({
  runEmbeddedAgentMock: vi.fn(),
  runCliAgentWithLifecycleMock: vi.fn(),
  resolveCliExecutionProviderForSessionMock: vi.fn(),
  isCliProviderMock: vi.fn(),
}));

vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runEmbeddedAgentMock }));
vi.mock("./agent-runner-cli-dispatch.js", () => ({
  runCliAgentWithLifecycle: runCliAgentWithLifecycleMock,
}));
vi.mock("../../agents/model-runtime-aliases.js", () => ({
  resolveCliExecutionProviderForSession: resolveCliExecutionProviderForSessionMock,
}));
vi.mock("../../agents/model-selection.js", () => ({ isCliProvider: isCliProviderMock }));

const { runSessionAgentTurn } = await import("./session-agent-turn.js");

const baseParams = (): RunSessionAgentTurnParams =>
  ({
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    agentId: "main",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    config: { agents: { defaults: {} } } as never,
    prompt: "recall query",
    provider: "anthropic",
    model: "claude-opus-4-8",
    runId: "run-1",
    timeoutMs: 1000,
    toolsAllow: ["memory_search", "memory_get"],
  }) as RunSessionAgentTurnParams;

describe("runSessionAgentTurn CLI routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runEmbeddedAgentMock.mockResolvedValue({ payloads: [], meta: {} });
    runCliAgentWithLifecycleMock.mockResolvedValue({ payloads: [], meta: {} });
  });

  it("routes a CLI-backed session through the CLI runtime, not the metered SDK path", async () => {
    // Canonical "anthropic/…" model whose session is pinned to a CLI runtime:
    // the seam must resolve the CLI execution provider and dispatch to the CLI
    // runner with the RESOLVED provider, never the in-process SDK (which has no
    // API key for the subscription account -> "out of extra usage").
    resolveCliExecutionProviderForSessionMock.mockReturnValue("claude-cli");
    isCliProviderMock.mockReturnValue(true);

    await runSessionAgentTurn({
      ...baseParams(),
      agentRuntimeOverride: "claude-cli",
      bootstrapContextMode: "lightweight",
    });

    expect(resolveCliExecutionProviderForSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        agentRuntimeOverride: "claude-cli",
        modelId: "claude-opus-4-8",
      }),
    );
    expect(runCliAgentWithLifecycleMock).toHaveBeenCalledTimes(1);
    const cliCall = runCliAgentWithLifecycleMock.mock.calls[0][0];
    expect(cliCall.provider).toBe("claude-cli");
    expect(cliCall.runParams.provider).toBe("claude-cli");
    expect(cliCall.runParams.model).toBe("claude-opus-4-8");
    expect(cliCall.runParams.toolsAllow).toEqual(["memory_search", "memory_get"]);
    // Caller-set bootstrap context mode must reach the CLI runner (it consumes it),
    // not silently default to "full".
    expect(cliCall.runParams.bootstrapContextMode).toBe("lightweight");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("keeps a non-CLI session on the embedded SDK path unchanged", async () => {
    resolveCliExecutionProviderForSessionMock.mockReturnValue("github-copilot");
    isCliProviderMock.mockReturnValue(false);

    await runSessionAgentTurn({ ...baseParams(), provider: "github-copilot" });

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock.mock.calls[0][0].provider).toBe("github-copilot");
    expect(runCliAgentWithLifecycleMock).not.toHaveBeenCalled();
  });

  it("maps embedded disableMessageTool to the CLI requireExplicitMessageTarget lever", async () => {
    // The CLI harness cannot omit its message tool the way the embedded runner
    // does; suppressing implicit sends is the faithful equivalent.
    resolveCliExecutionProviderForSessionMock.mockReturnValue("claude-cli");
    isCliProviderMock.mockReturnValue(true);

    await runSessionAgentTurn({
      ...baseParams(),
      agentRuntimeOverride: "claude-cli",
      disableMessageTool: true,
      silentExpected: true,
    });

    const cliCall = runCliAgentWithLifecycleMock.mock.calls[0][0];
    expect(cliCall.runParams.requireExplicitMessageTarget).toBe(true);
    // Even though recall is silent, the seam must NOT suppress the bridges:
    // runCliAgentWithLifecycle gates the tool bridge on suppressAssistantBridge,
    // and recall needs tool results via onAgentToolResult. Silence is carried by
    // requireExplicitMessageTarget, not bridge suppression.
    expect(cliCall.suppressAssistantBridge).toBe(false);
  });

  it("adapts onAgentToolResult to CLI onToolEvent result-phase events", async () => {
    resolveCliExecutionProviderForSessionMock.mockReturnValue("claude-cli");
    isCliProviderMock.mockReturnValue(true);
    const onAgentToolResult = vi.fn();
    // The CLI dispatcher surfaces tool outcomes via onToolEvent; recall observes
    // them through onAgentToolResult. Only result-phase events carry the result.
    runCliAgentWithLifecycleMock.mockImplementation(async (p) => {
      await p.onToolEvent?.({ name: "memory_search", phase: "start", args: {} });
      await p.onToolEvent?.({
        name: "memory_search",
        phase: "result",
        args: {},
        isError: false,
        result: { results: [{ text: "hit" }] },
      });
      return { payloads: [], meta: {} };
    });

    await runSessionAgentTurn({
      ...baseParams(),
      agentRuntimeOverride: "claude-cli",
      onAgentToolResult,
    });

    expect(onAgentToolResult).toHaveBeenCalledTimes(1);
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "memory_search",
      result: { results: [{ text: "hit" }] },
      isError: false,
    });
  });

  it("falls back to the SDK path when no provider is set", async () => {
    await runSessionAgentTurn({ ...baseParams(), provider: undefined });

    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(resolveCliExecutionProviderForSessionMock).not.toHaveBeenCalled();
    expect(runCliAgentWithLifecycleMock).not.toHaveBeenCalled();
  });
});
