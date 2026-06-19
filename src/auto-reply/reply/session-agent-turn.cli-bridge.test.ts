import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSessionAgentTurnParams } from "./session-agent-turn.js";

// Drives the REAL runCliAgentWithLifecycle and the REAL agent-event bus
// (./agent-runner-cli-dispatch.js and ../../infra/agent-events.js are NOT mocked)
// so the test proves the tool bridge actually delivers to onAgentToolResult under
// silentExpected — the cross-module coupling the fully-mocked seam test cannot see.
// Regression guard for: silentExpected -> suppressAssistantBridge suppressing the
// tool bridge and silently dropping CLI recall's memory hits.
const { runCliAgentMock, runEmbeddedAgentMock, resolveCliMock, isCliProviderMock } = vi.hoisted(
  () => ({
    runCliAgentMock: vi.fn(),
    runEmbeddedAgentMock: vi.fn(),
    resolveCliMock: vi.fn(),
    isCliProviderMock: vi.fn(),
  }),
);

vi.mock("../../agents/cli-runner.js", () => ({ runCliAgent: runCliAgentMock }));
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: runEmbeddedAgentMock }));
vi.mock("../../agents/model-runtime-aliases.js", async (importActual) => ({
  ...(await importActual<object>()),
  resolveCliExecutionProviderForSession: resolveCliMock,
}));
vi.mock("../../agents/model-selection.js", async (importActual) => ({
  ...(await importActual<object>()),
  isCliProvider: isCliProviderMock,
}));

const { emitAgentEvent } = await import("../../infra/agent-events.js");
const { runSessionAgentTurn } = await import("./session-agent-turn.js");

describe("runSessionAgentTurn CLI tool-bridge delivery (real dispatcher)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveCliMock.mockReturnValue("claude-cli");
    isCliProviderMock.mockReturnValue(true);
  });

  it("delivers tool results to onAgentToolResult even when the run is silent", async () => {
    // runCliAgentWithLifecycle subscribes the tool bridge to runId before invoking
    // runCliAgent; the fake runner emits a result-phase tool event that the bridge
    // must forward to onAgentToolResult despite silentExpected: true.
    runCliAgentMock.mockImplementation(async (p: { runId: string }) => {
      emitAgentEvent({
        runId: p.runId,
        stream: "tool",
        data: {
          phase: "result",
          name: "memory_search",
          args: {},
          isError: false,
          result: { results: [{ text: "lemon pepper wings" }] },
        },
      });
      return { payloads: [{ text: "summary" }], meta: {} };
    });

    const seen: Array<{ toolName: string; isError: boolean; result: unknown }> = [];
    await runSessionAgentTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      agentId: "main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      config: { agents: { defaults: {} } } as never,
      prompt: "recall",
      provider: "anthropic",
      model: "claude-opus-4-8",
      runId: "run-bridge-1",
      timeoutMs: 1000,
      agentRuntimeOverride: "claude-cli",
      silentExpected: true,
      onAgentToolResult: (e) => seen.push(e),
    } as RunSessionAgentTurnParams);

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(seen).toEqual([
      {
        toolName: "memory_search",
        isError: false,
        result: { results: [{ text: "lemon pepper wings" }] },
      },
    ]);
  });
});
