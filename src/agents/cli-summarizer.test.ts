import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { FailoverError } from "./failover-error.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

const {
  runCliAgentMock,
  hookRunnerMocks,
  triggerInternalHookMock,
  runPostCompactionSideEffectsMock,
} = vi.hoisted(() => ({
  runCliAgentMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  hookRunnerMocks: {
    hasHooks: vi.fn<(name?: string) => boolean>(),
    runBeforeCompaction: vi.fn<(...args: unknown[]) => Promise<void>>(),
    runAfterCompaction: vi.fn<(...args: unknown[]) => Promise<void>>(),
  },
  triggerInternalHookMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  runPostCompactionSideEffectsMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock("./cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: hookRunnerMocks.hasHooks,
    runBeforeCompaction: hookRunnerMocks.runBeforeCompaction,
    runAfterCompaction: hookRunnerMocks.runAfterCompaction,
  }),
}));

vi.mock("../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(() => ({ kind: "internal" })),
  triggerInternalHook: triggerInternalHookMock,
}));

vi.mock("./pi-embedded-runner/compaction-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("./pi-embedded-runner/compaction-hooks.js")>(
    "./pi-embedded-runner/compaction-hooks.js",
  );
  return {
    ...actual,
    runPostCompactionSideEffects: runPostCompactionSideEffectsMock,
  };
});

const {
  compactViaCliBackend,
  generateCliConversationLabel,
  readSessionTailForSummarization,
  runCliMemoryFlush,
  runCliSummarizerOneShot,
} = await import("./cli-summarizer.js");

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-summarizer-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeRunResult(text: string, sessionId = "cli-session-id"): EmbeddedPiRunResult {
  return {
    payloads: text ? [{ text }] : undefined,
    meta: {
      durationMs: 5,
      agentMeta: {
        sessionId,
        provider: "claude-cli",
        model: "claude-opus-4-7",
        usage: { input: 100, output: text.length },
      },
    },
  };
}

beforeEach(() => {
  runCliAgentMock.mockReset();
  hookRunnerMocks.hasHooks.mockReset();
  hookRunnerMocks.hasHooks.mockReturnValue(false);
  hookRunnerMocks.runBeforeCompaction.mockReset();
  hookRunnerMocks.runAfterCompaction.mockReset();
  triggerInternalHookMock.mockReset();
  triggerInternalHookMock.mockResolvedValue(undefined);
  runPostCompactionSideEffectsMock.mockReset();
  runPostCompactionSideEffectsMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runCliSummarizerOneShot", () => {
  it("passes prompt through, returns text + usage, cleans up temp dir", async () => {
    runCliAgentMock.mockResolvedValueOnce(makeRunResult("hello world"));
    const tempDirsBefore = (await fs.readdir(os.tmpdir())).filter((f) =>
      f.startsWith("openclaw-cli-summarize-"),
    );
    const result = await runCliSummarizerOneShot({
      prompt: "summarize this",
      provider: "claude-cli",
      model: "claude-opus-4-7",
      workspaceDir: "/tmp/ws",
    });
    expect(result.text).toBe("hello world");
    expect(result.usage?.input).toBe(100);
    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    const callArgs = runCliAgentMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.prompt).toBe("summarize this");
    expect(callArgs.provider).toBe("claude-cli");
    expect(callArgs.cliSessionBinding).toBeUndefined();
    expect(callArgs.cliSessionId).toBeUndefined();
    const tempDirsAfter = (await fs.readdir(os.tmpdir())).filter((f) =>
      f.startsWith("openclaw-cli-summarize-"),
    );
    expect(tempDirsAfter.length).toBeLessThanOrEqual(tempDirsBefore.length);
  });

  it("re-throws FailoverError unchanged", async () => {
    const failover = new FailoverError("rate limited", { reason: "rate_limit" });
    runCliAgentMock.mockRejectedValueOnce(failover);
    await expect(
      runCliSummarizerOneShot({
        prompt: "x",
        provider: "claude-cli",
        model: "claude-opus-4-7",
        workspaceDir: "/tmp/ws",
      }),
    ).rejects.toBe(failover);
  });

  it("wraps unknown errors with describeUnknownError", async () => {
    runCliAgentMock.mockRejectedValueOnce(new Error("kaboom"));
    await expect(
      runCliSummarizerOneShot({
        prompt: "x",
        provider: "claude-cli",
        model: "claude-opus-4-7",
        workspaceDir: "/tmp/ws",
      }),
    ).rejects.toThrow(/CLI summarizer failed: kaboom/);
  });
});

describe("readSessionTailForSummarization", () => {
  async function writeJsonl(dir: string, sessionId: string, lines: unknown[]): Promise<string> {
    const file = path.join(dir, `${sessionId}.jsonl`);
    const body = lines.map((line) => JSON.stringify(line)).join("\n");
    await fs.writeFile(file, `${body}\n`, "utf-8");
    return file;
  }

  it("returns tail bounded by maxPromptTokens with truncated flag", async () => {
    const dir = await makeTempDir();
    const sessionId = "abcd-1234";
    const longText = "word ".repeat(200).trim();
    const lines: unknown[] = [];
    for (let i = 0; i < 20; i += 1) {
      lines.push({
        id: `msg-${i}`,
        type: "message",
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `${longText} ${i}` }],
        },
      });
    }
    const sessionFile = await writeJsonl(dir, sessionId, lines);
    const result = readSessionTailForSummarization({
      sessionId,
      sessionFile,
      maxPromptTokens: 200,
    });
    expect(result.truncated).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(20);
    const lastMessage = result.messages[result.messages.length - 1] as {
      content?: Array<{ text?: string }>;
    };
    expect(lastMessage.content?.[0]?.text).toContain("19");
  });

  it("returns empty when transcript missing", () => {
    const result = readSessionTailForSummarization({
      sessionId: "missing-id",
      sessionFile: "/tmp/does-not-exist.jsonl",
      maxPromptTokens: 1000,
    });
    expect(result).toEqual({ messages: [], tokensRead: 0, truncated: false });
  });
});

describe("compactViaCliBackend", () => {
  async function setupSession(): Promise<{
    sessionFile: string;
    workspaceDir: string;
    sessionEntry: SessionEntry;
  }> {
    const dir = await makeTempDir();
    const workspaceDir = path.join(dir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionsDir = path.join(dir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, "old-session-id.jsonl");
    const lines = [
      { type: "session", version: 2, id: "old-session-id", timestamp: new Date().toISOString() },
      {
        id: "msg-1",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "first user message" }] },
      },
      {
        id: "msg-2",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "an assistant reply" }] },
      },
    ];
    await fs.writeFile(sessionFile, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf-8");
    const sessionEntry: SessionEntry = {
      sessionId: "old-session-id",
      sessionFile,
      updatedAt: Date.now(),
      cliSessionBindings: { "claude-cli": { sessionId: "old-cli" } },
      cliSessionIds: { "claude-cli": "old-cli" },
      claudeCliSessionId: "old-cli",
    };
    return { sessionFile, workspaceDir, sessionEntry };
  }

  it("rotates session, seeds summary, fires hooks, returns matching shape", async () => {
    const { sessionFile, workspaceDir, sessionEntry } = await setupSession();
    runCliAgentMock.mockResolvedValueOnce(makeRunResult("compact summary text"));
    hookRunnerMocks.hasHooks.mockImplementation(
      (name) => name === "before_compaction" || name === "after_compaction",
    );

    const result = await compactViaCliBackend({
      sessionId: "old-session-id",
      sessionKey: "agent:main:telegram:direct:compaction",
      sessionEntry,
      sessionFile,
      workspaceDir,
      provider: "claude-cli",
      model: "claude-opus-4-7",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.result?.summary).toBe("compact summary text");
    expect(result.result?.tokensBefore).toBeGreaterThan(0);
    expect(result.result?.firstKeptEntryId).toBeTruthy();
    const details = result.result?.details as { newSessionId: string; newSessionFile: string };
    expect(details.newSessionId).toBeTruthy();
    expect(details.newSessionFile).toBeTruthy();
    expect(details.newSessionFile).toContain(`${details.newSessionId}.jsonl`);

    const newFileContents = await fs.readFile(details.newSessionFile, "utf-8");
    const newLines = newFileContents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(newLines[0]).toMatchObject({ type: "session", id: details.newSessionId });
    expect(newLines[1]).toMatchObject({
      id: result.result?.firstKeptEntryId,
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "compact summary text" }],
      },
    });

    expect(hookRunnerMocks.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runAfterCompaction).toHaveBeenCalledTimes(1);
    expect(triggerInternalHookMock).toHaveBeenCalledTimes(2);
    expect(runPostCompactionSideEffectsMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionFile: details.newSessionFile }),
    );
  });

  it("returns nothing-to-compact when transcript empty", async () => {
    const dir = await makeTempDir();
    const workspaceDir = path.join(dir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionFile = path.join(dir, "empty-session.jsonl");
    await fs.writeFile(sessionFile, "", "utf-8");
    const result = await compactViaCliBackend({
      sessionId: "empty-session",
      sessionFile,
      workspaceDir,
      provider: "claude-cli",
      model: "claude-opus-4-7",
    });
    expect(result).toEqual({ ok: true, compacted: false, reason: "nothing to compact" });
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("re-throws FailoverError unchanged", async () => {
    const { sessionFile, workspaceDir, sessionEntry } = await setupSession();
    const failover = new FailoverError("auth", { reason: "auth" });
    runCliAgentMock.mockRejectedValueOnce(failover);
    await expect(
      compactViaCliBackend({
        sessionId: "old-session-id",
        sessionEntry,
        sessionFile,
        workspaceDir,
        provider: "claude-cli",
        model: "claude-opus-4-7",
      }),
    ).rejects.toBe(failover);
  });

  it("returns failure result when CLI returns empty text", async () => {
    const { sessionFile, workspaceDir, sessionEntry } = await setupSession();
    runCliAgentMock.mockResolvedValueOnce(makeRunResult(""));
    const result = await compactViaCliBackend({
      sessionId: "old-session-id",
      sessionEntry,
      sessionFile,
      workspaceDir,
      provider: "claude-cli",
      model: "claude-opus-4-7",
    });
    expect(result).toEqual({ ok: true, compacted: false, reason: "nothing to compact" });
  });
});

describe("runCliMemoryFlush", () => {
  it("appends summary to memory file and returns rotated session id", async () => {
    const dir = await makeTempDir();
    const workspaceDir = path.join(dir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionFile = path.join(dir, "session.jsonl");
    const lines = [
      { type: "session", version: 2, id: "sess-1", timestamp: new Date().toISOString() },
      {
        id: "m1",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
    ];
    await fs.writeFile(sessionFile, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

    runCliAgentMock.mockResolvedValueOnce(makeRunResult("- key fact one\n- key fact two"));

    const result = await runCliMemoryFlush({
      sessionId: "sess-1",
      sessionFile,
      workspaceDir,
      provider: "claude-cli",
      model: "claude-opus-4-7",
      flushPrompt: "flush prompt",
      memoryFlushWritePath: "memory/notes.md",
    });

    expect(result.payloads?.[0]?.text).toBe("- key fact one\n- key fact two");
    expect(result.meta.agentMeta?.sessionId).toBeTruthy();
    expect(result.meta.agentMeta?.sessionId).not.toBe("sess-1");
    const written = await fs.readFile(path.join(workspaceDir, "memory/notes.md"), "utf-8");
    expect(written).toContain("- key fact one");
  });

  it("skips file write when CLI returns empty text but still rotates session id", async () => {
    const dir = await makeTempDir();
    const workspaceDir = path.join(dir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionFile = path.join(dir, "sess.jsonl");
    await fs.writeFile(sessionFile, "", "utf-8");
    runCliAgentMock.mockResolvedValueOnce(makeRunResult(""));

    const result = await runCliMemoryFlush({
      sessionId: "sess-empty",
      sessionFile,
      workspaceDir,
      provider: "claude-cli",
      model: "claude-opus-4-7",
      flushPrompt: "do flush",
      memoryFlushWritePath: "notes.md",
    });

    expect(result.payloads).toBeUndefined();
    expect(result.meta.agentMeta?.sessionId).toBeTruthy();
    const memoryFileExists = await fs
      .stat(path.join(workspaceDir, "notes.md"))
      .then(() => true)
      .catch(() => false);
    expect(memoryFileExists).toBe(false);
  });
});

describe("generateCliConversationLabel", () => {
  it("returns slice up to maxLength", async () => {
    runCliAgentMock.mockResolvedValueOnce(makeRunResult("a label that should be truncated"));
    const label = await generateCliConversationLabel({
      prompt: "give a label",
      userMessage: "hi",
      provider: "claude-cli",
      model: "claude-opus-4-7",
      workspaceDir: "/tmp/ws",
      maxLength: 10,
    });
    expect(label).toBe("a label th");
  });

  it("returns null on empty CLI response", async () => {
    runCliAgentMock.mockResolvedValueOnce(makeRunResult(""));
    const label = await generateCliConversationLabel({
      prompt: "p",
      userMessage: "u",
      provider: "claude-cli",
      model: "claude-opus-4-7",
      workspaceDir: "/tmp/ws",
      maxLength: 10,
    });
    expect(label).toBeNull();
  });

  it("returns null on unknown error and re-throws FailoverError", async () => {
    runCliAgentMock.mockRejectedValueOnce(new Error("boom"));
    const label = await generateCliConversationLabel({
      prompt: "p",
      userMessage: "u",
      provider: "claude-cli",
      model: "claude-opus-4-7",
      workspaceDir: "/tmp/ws",
      maxLength: 10,
    });
    expect(label).toBeNull();

    runCliAgentMock.mockRejectedValueOnce(new FailoverError("auth", { reason: "auth" }));
    await expect(
      generateCliConversationLabel({
        prompt: "p",
        userMessage: "u",
        provider: "claude-cli",
        model: "claude-opus-4-7",
        workspaceDir: "/tmp/ws",
        maxLength: 10,
      }),
    ).rejects.toBeInstanceOf(FailoverError);
  });
});
