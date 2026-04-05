import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";

const appendMessageMock = vi.fn();
const emitSessionTranscriptUpdateMock = vi.fn();
const logErrorMock = vi.fn();
const logWarnMock = vi.fn();

vi.mock("@mariozechner/pi-coding-agent", () => ({
  SessionManager: {
    open: () => ({ appendMessage: appendMessageMock }),
  },
}));

vi.mock("../../config/sessions/transcript.js", () => ({
  resolveSessionTranscriptFile: vi.fn(async () => ({
    sessionFile: "/tmp/test-session.jsonl",
    sessionEntry: undefined,
  })),
}));

vi.mock("../pi-embedded-runner/session-manager-init.js", () => ({
  prepareSessionManagerForRun: vi.fn(async () => {}),
}));

vi.mock("../../sessions/transcript-events.js", () => ({
  emitSessionTranscriptUpdate: emitSessionTranscriptUpdateMock,
}));

// Mock heavy transitive dependencies to avoid pulling in the full module graph
vi.mock("../pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
}));

vi.mock("../cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

vi.mock("../cli-session.js", () => ({
  getCliSessionBinding: vi.fn(),
  clearCliSession: vi.fn(),
  setCliSessionBinding: vi.fn(),
}));

vi.mock("../model-selection.js", () => ({
  isCliProvider: vi.fn(() => false),
}));

vi.mock("../../auto-reply/reply/normalize-reply.js", () => ({
  normalizeReplyPayload: vi.fn((text: string) => ({ text })),
}));

vi.mock("../../auto-reply/tokens.js", () => ({
  isSilentReplyPrefixText: vi.fn(() => false),
  isSilentReplyText: vi.fn(() => false),
  SILENT_REPLY_TOKEN: "__SILENT__",
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../config/sessions.js", () => ({
  mergeSessionEntry: vi.fn((_existing: unknown, incoming: unknown) => ({
    ...(incoming as object),
  })),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: logWarnMock,
    error: logErrorMock,
    debug: vi.fn(),
  }),
}));

vi.mock("../../terminal/ansi.js", () => ({
  sanitizeForLog: (s: string) => s,
}));

vi.mock("../../utils/message-channel.js", () => ({
  resolveMessageChannel: vi.fn(),
}));

vi.mock("../bootstrap-budget.js", () => ({
  resolveBootstrapWarningSignaturesSeen: vi.fn(() => []),
}));

vi.mock("../failover-error.js", () => ({
  FailoverError: class FailoverError extends Error {
    reason: string;
    constructor(message: string, params: { reason: string }) {
      super(message);
      this.reason = params.reason;
    }
  },
}));

vi.mock("../internal-events.js", () => ({
  formatAgentInternalEventsForPrompt: vi.fn(),
}));

vi.mock("../internal-runtime-context.js", () => ({
  hasInternalRuntimeContext: vi.fn(() => false),
}));

vi.mock("../skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(),
}));

vi.mock("./run-context.js", () => ({
  resolveAgentRunContext: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    default: {
      ...(orig.default as Record<string, unknown>),
      access: vi.fn(async () => {}),
    },
  };
});

const { persistCliTurnTranscript, runAgentAttempt } = await import("./attempt-execution.js");
const { runCliAgent } = await import("../cli-runner.js");
const { isCliProvider } = await import("../model-selection.js");
const { getCliSessionBinding, clearCliSession } = await import("../cli-session.js");
const { FailoverError } = await import("../failover-error.js");

function makeResult(
  text?: string,
  opts?: {
    payloads?: EmbeddedPiRunResult["payloads"];
    usage?: { input?: number; output?: number; total?: number };
  },
): EmbeddedPiRunResult {
  return {
    payloads: opts?.payloads !== undefined ? opts.payloads : text ? [{ text }] : undefined,
    meta: {
      durationMs: 100,
      agentMeta: {
        sessionId: "cli-sess-1",
        provider: "claude-cli",
        model: "claude-opus-4-6",
        usage: opts?.usage,
      },
      stopReason: "end_turn",
    },
  };
}

const baseParams = {
  body: "What is 2+2?",
  sessionId: "sess-1",
  sessionKey: "key-1",
  sessionEntry: undefined,
  sessionAgentId: "agent-1",
  sessionCwd: "/tmp/workspace",
};

describe("persistCliTurnTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("appends user and assistant messages to the session transcript", async () => {
    const result = makeResult("The answer is 4.");

    await persistCliTurnTranscript(result, baseParams);

    expect(appendMessageMock).toHaveBeenCalledTimes(2);

    const userCall = appendMessageMock.mock.calls[0][0];
    expect(userCall.role).toBe("user");
    expect(userCall.content).toBe("What is 2+2?");

    const assistantCall = appendMessageMock.mock.calls[1][0];
    expect(assistantCall.role).toBe("assistant");
    expect(assistantCall.content).toEqual([{ type: "text", text: "The answer is 4." }]);
    expect(assistantCall.api).toBe("cli");
    expect(assistantCall.provider).toBe("claude-cli");
    expect(assistantCall.model).toBe("claude-opus-4-6");
    expect(assistantCall.stopReason).toBe("stop");

    expect(emitSessionTranscriptUpdateMock).toHaveBeenCalledWith("/tmp/test-session.jsonl");
  });

  it("does nothing when payloads are undefined and body is empty", async () => {
    const result = makeResult();

    await persistCliTurnTranscript(result, { ...baseParams, body: "" });

    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(emitSessionTranscriptUpdateMock).not.toHaveBeenCalled();
  });

  it("still appends user message when payloads are undefined but body exists", async () => {
    const result = makeResult();

    await persistCliTurnTranscript(result, baseParams);

    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock.mock.calls[0][0].role).toBe("user");
    expect(emitSessionTranscriptUpdateMock).toHaveBeenCalled();
  });

  it("writes only user message for empty payloads array (tool-only run)", async () => {
    const result = makeResult(undefined, { payloads: [] });

    await persistCliTurnTranscript(result, baseParams);

    // Tool-only runs: user prompt is persisted but no synthetic assistant
    // message is written. The announce machinery handles "(no output)".
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock.mock.calls[0][0].role).toBe("user");
  });

  it("writes only user message for payloads with empty-string text", async () => {
    const result = makeResult(undefined, { payloads: [{ text: "" }] });

    await persistCliTurnTranscript(result, baseParams);

    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock.mock.calls[0][0].role).toBe("user");
  });

  it("joins multiple payload texts", async () => {
    const result: EmbeddedPiRunResult = {
      payloads: [{ text: "Line 1" }, { text: "Line 2" }],
      meta: {
        durationMs: 50,
        agentMeta: {
          sessionId: "cli-sess-2",
          provider: "test-cli",
          model: "test-model",
        },
      },
    };

    await persistCliTurnTranscript(result, baseParams);

    const assistantCall = appendMessageMock.mock.calls[1][0];
    expect(assistantCall.content).toEqual([{ type: "text", text: "Line 1\nLine 2" }]);
  });

  it("uses fallback provider/model when agentMeta is missing", async () => {
    const result: EmbeddedPiRunResult = {
      payloads: [{ text: "hello" }],
      meta: { durationMs: 10 },
    };

    await persistCliTurnTranscript(result, baseParams);

    const assistantCall = appendMessageMock.mock.calls[1][0];
    expect(assistantCall.provider).toBe("cli");
    expect(assistantCall.model).toBe("cli");
  });

  it("forwards agentMeta.usage into transcript usage", async () => {
    const result = makeResult("done", { usage: { input: 500, output: 200, total: 700 } });

    await persistCliTurnTranscript(result, baseParams);

    const assistantCall = appendMessageMock.mock.calls[1][0];
    expect(assistantCall.usage.input).toBe(500);
    expect(assistantCall.usage.output).toBe(200);
    expect(assistantCall.usage.totalTokens).toBe(700);
    expect(assistantCall.usage.cacheRead).toBe(0);
    expect(assistantCall.usage.cacheWrite).toBe(0);
    // cost stays zeroed — CLI doesn't report cost
    expect(assistantCall.usage.cost.total).toBe(0);
  });

  it("falls back to zero usage when agentMeta has no usage", async () => {
    const result = makeResult("done");

    await persistCliTurnTranscript(result, baseParams);

    const assistantCall = appendMessageMock.mock.calls[1][0];
    expect(assistantCall.usage.input).toBe(0);
    expect(assistantCall.usage.totalTokens).toBe(0);
  });

  it("returns a fresh cost object (not a shared reference)", async () => {
    const result1 = makeResult("first");
    const result2 = makeResult("second");

    await persistCliTurnTranscript(result1, baseParams);
    await persistCliTurnTranscript(result2, baseParams);

    const cost1 = appendMessageMock.mock.calls[1][0].usage.cost;
    const cost2 = appendMessageMock.mock.calls[3][0].usage.cost;
    expect(cost1).not.toBe(cost2);
    expect(cost1).toEqual(cost2);
  });
});

describe("runAgentAttempt — CLI transcript wiring", () => {
  const runCliAgentMock = vi.mocked(runCliAgent);
  const isCliProviderMock = vi.mocked(isCliProvider);

  function makeRunAgentParams(overrides?: Partial<Parameters<typeof runAgentAttempt>[0]>) {
    return {
      providerOverride: "claude-cli",
      modelOverride: "claude-opus-4-6",
      cfg: {} as ReturnType<typeof import("../../config/config.js").loadConfig>,
      sessionEntry: undefined,
      sessionId: "sess-1",
      sessionKey: "key-1",
      sessionAgentId: "agent-1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp/workspace",
      body: "Do the thing",
      isFallbackRetry: false,
      resolvedThinkLevel: "off" as const,
      timeoutMs: 30_000,
      runId: "run-1",
      opts: {
        message: "Do the thing",
        senderIsOwner: true,
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined as unknown as Parameters<
        typeof runAgentAttempt
      >[0]["messageChannel"],
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: "/tmp/agent",
      onAgentEvent: vi.fn(),
      authProfileProvider: "claude-cli",
      sessionStore: {},
      storePath: "/tmp/sessions.json",
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    isCliProviderMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls persistCliTurnTranscript after successful runCliAgent", async () => {
    const cliResult = makeResult("Agent output here");
    runCliAgentMock.mockResolvedValue(cliResult);

    const result = await runAgentAttempt(makeRunAgentParams());

    // The original result is returned
    expect(result).toBe(cliResult);
    // Transcript was persisted (user + assistant messages)
    expect(appendMessageMock).toHaveBeenCalledTimes(2);
    expect(appendMessageMock.mock.calls[0][0].role).toBe("user");
    expect(appendMessageMock.mock.calls[1][0].role).toBe("assistant");
    expect(appendMessageMock.mock.calls[1][0].content).toEqual([
      { type: "text", text: "Agent output here" },
    ]);
  });

  it("returns original result when persistCliTurnTranscript throws", async () => {
    const cliResult = makeResult("Some output");
    runCliAgentMock.mockResolvedValue(cliResult);

    // Make the session transcript resolution throw
    const { resolveSessionTranscriptFile } = await import("../../config/sessions/transcript.js");
    vi.mocked(resolveSessionTranscriptFile).mockRejectedValueOnce(new Error("disk full"));

    const result = await runAgentAttempt(makeRunAgentParams());

    // Original result is returned despite persistence failure
    expect(result).toBe(cliResult);
    // The error was logged so the failure is observable
    expect(logErrorMock).toHaveBeenCalledOnce();
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("CLI transcript persistence failed"),
    );
  });

  it("retries with a fresh session on session_expired failover and persists transcript", async () => {
    const retryResult = makeResult("Retry output");
    retryResult.meta.agentMeta = {
      ...retryResult.meta.agentMeta!,
      cliSessionBinding: { sessionId: "new-cli-sess" },
    };

    const runCliAgentMock = vi.mocked(runCliAgent);
    runCliAgentMock
      .mockRejectedValueOnce(new FailoverError("expired", { reason: "session_expired" }))
      .mockResolvedValueOnce(retryResult);

    vi.mocked(getCliSessionBinding).mockReturnValue({
      sessionId: "old-cli-sess",
    });

    // updateSessionStore is called by persistSessionEntry; return the entry as-is
    const { updateSessionStore: updateSessionStoreMock } = await import("../../config/sessions.js");
    vi.mocked(updateSessionStoreMock).mockImplementation(async (_path, fn) => {
      const store = {} as Record<string, import("../../config/sessions/types.js").SessionEntry>;
      return fn(store);
    });

    const sessionStore = {
      "key-1": { updatedAt: 1 },
    } as unknown as Record<string, import("../../config/sessions/types.js").SessionEntry>;

    const result = await runAgentAttempt(
      makeRunAgentParams({
        sessionStore: sessionStore as never,
        storePath: "/tmp/sessions.json",
      }),
    );

    // Retry succeeded and result was returned
    expect(result).toBe(retryResult);

    // CLI agent was called twice: initial (rejected) + retry
    expect(runCliAgentMock).toHaveBeenCalledTimes(2);
    // Retry used undefined sessionId to force a fresh session
    expect(runCliAgentMock.mock.calls[1][0].cliSessionId).toBeUndefined();

    // Expired session was cleared
    expect(vi.mocked(clearCliSession)).toHaveBeenCalledOnce();

    // Session expiry was logged as a warning
    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("CLI session expired"));

    // Transcript was persisted after failover (user + assistant messages)
    expect(appendMessageMock).toHaveBeenCalledTimes(2);
    expect(appendMessageMock.mock.calls[0][0].role).toBe("user");
    expect(appendMessageMock.mock.calls[1][0].role).toBe("assistant");
  });
});
