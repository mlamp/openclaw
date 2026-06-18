import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runCliSummarizerOneShotMock,
  runEmbeddedAgentMock,
  isCliProviderMock,
  resolveAgentEffectiveModelPrimaryMock,
} = vi.hoisted(() => ({
  runCliSummarizerOneShotMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  runEmbeddedAgentMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  isCliProviderMock: vi.fn<(...args: unknown[]) => boolean>(),
  resolveAgentEffectiveModelPrimaryMock: vi.fn<(...args: unknown[]) => string | undefined>(),
}));

vi.mock("../agents/cli-summarizer.js", () => ({
  runCliSummarizerOneShot: runCliSummarizerOneShotMock,
}));

vi.mock("../agents/embedded-agent.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/embedded-agent.js")>(
    "../agents/embedded-agent.js",
  );
  return {
    ...actual,
    runEmbeddedAgent: runEmbeddedAgentMock,
  };
});

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => "/tmp/ws",
  resolveAgentDir: () => "/tmp/agent",
  resolveAgentEffectiveModelPrimary: resolveAgentEffectiveModelPrimaryMock,
}));

vi.mock("../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-selection.js")>(
    "../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: isCliProviderMock,
  };
});

const { generateSlugViaLLM } = await import("./llm-slug-generator.js");

beforeEach(() => {
  runCliSummarizerOneShotMock.mockReset();
  runEmbeddedAgentMock.mockReset();
  isCliProviderMock.mockReset();
  resolveAgentEffectiveModelPrimaryMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("generateSlugViaLLM CLI branch", () => {
  it("delegates to runCliSummarizerOneShot when provider is CLI-backed", async () => {
    resolveAgentEffectiveModelPrimaryMock.mockReturnValue("claude-cli/claude-opus-4-7");
    isCliProviderMock.mockReturnValue(true);
    runCliSummarizerOneShotMock.mockResolvedValue({ text: "Vendor Pitch!" });

    const slug = await generateSlugViaLLM({
      sessionContent: "any conversation",
      cfg: {},
    });

    expect(slug).toBe("vendor-pitch");
    expect(runCliSummarizerOneShotMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    const args = runCliSummarizerOneShotMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.provider).toBe("claude-cli");
    expect(args.model).toBe("claude-opus-4-7");
    expect(args.timeoutMs).toBe(15_000);
  });

  it("returns null when CLI returns empty text", async () => {
    resolveAgentEffectiveModelPrimaryMock.mockReturnValue("claude-cli/claude-opus-4-7");
    isCliProviderMock.mockReturnValue(true);
    runCliSummarizerOneShotMock.mockResolvedValue({ text: "" });

    const slug = await generateSlugViaLLM({
      sessionContent: "any conversation",
      cfg: {},
    });
    expect(slug).toBeNull();
  });

  it("falls through to runEmbeddedAgent for non-CLI providers", async () => {
    resolveAgentEffectiveModelPrimaryMock.mockReturnValue("anthropic/claude-opus-4-7");
    isCliProviderMock.mockReturnValue(false);
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "API Slug" }],
    });

    const slug = await generateSlugViaLLM({
      sessionContent: "any conversation",
      cfg: {},
    });
    expect(slug).toBe("api-slug");
    expect(runCliSummarizerOneShotMock).not.toHaveBeenCalled();
  });
});
