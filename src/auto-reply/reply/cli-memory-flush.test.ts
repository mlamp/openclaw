import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";

const runIsolatedCompletion = vi.hoisted(() => vi.fn());
vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion }));
import { runCliMemoryFlush } from "./cli-memory-flush.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => runIsolatedCompletion.mockReset());
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

async function fixture() {
  const workspaceDir = tempDirs.make("openclaw-cli-memory-flush-");
  const sessionTarget = {
    agentId: "main",
    sessionId: "memory-session",
    sessionKey: "agent:main:memory-flush",
    storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 1 });
  await appendTranscriptMessage(sessionTarget, {
    cwd: workspaceDir,
    message: { role: "user", content: "Remember that the project uses Rust.", timestamp: 1 },
  });
  return {
    sessionTarget,
    workspaceDir,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    agentId: "main",
    agentHarnessRuntimeOverride: "claude-cli",
    flushPrompt: "Preserve durable memories.",
    flushSystemPrompt: "Write durable memory notes.",
    memoryFlushWritePath: "memory/notes.md",
    timeoutMs: 240_000,
    contextWindowTokens: 200_000,
    thinkLevel: "low" as const,
  };
}

describe("CLI memory export", () => {
  it("fits a smaller flush model's context while retaining the newest transcript tail", async () => {
    const params = await fixture();
    await appendTranscriptMessage(params.sessionTarget, {
      cwd: params.workspaceDir,
      message: {
        role: "user",
        content: `${"Older detail. ".repeat(20_000)}NEWEST_MEMORY`,
        timestamp: 2,
      },
    });
    runIsolatedCompletion.mockResolvedValue({ text: "NO_REPLY" });

    await runCliMemoryFlush({ ...params, contextWindowTokens: 8192 });

    const call = runIsolatedCompletion.mock.calls[0];
    if (!call) {
      throw new Error("Expected a memory flush completion request");
    }
    const [request] = call;
    const inputTokens = estimateTokens({
      role: "user",
      content: `${request.systemPrompt}\n\n${request.prompt}`,
      timestamp: 0,
    });
    expect(inputTokens + request.streamParams.maxTokens).toBeLessThan(8192);
    expect(request.prompt).toContain("NEWEST_MEMORY");
    expect(request.prompt).toContain("Earlier transcript content was omitted");
  });

  it.each(["Existing note", "Existing note\n"])(
    "appends the SQLite conversation memory after %j without rotating the session",
    async (initial) => {
      const params = await fixture();
      const file = path.join(params.workspaceDir, params.memoryFlushWritePath);
      await fs.mkdir(path.dirname(file));
      await fs.writeFile(file, initial);
      runIsolatedCompletion.mockResolvedValue({ text: "Project uses Rust." });

      await runCliMemoryFlush(params);

      expect(await fs.readFile(file, "utf8")).toBe("Existing note\nProject uses Rust.");
      expect(loadSessionEntry(params.sessionTarget)?.sessionId).toBe(
        params.sessionTarget.sessionId,
      );
      expect(runIsolatedCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "anthropic",
          agentHarnessRuntimeOverride: "claude-cli",
          prompt: expect.stringContaining("Remember that the project uses Rust."),
          systemPrompt: expect.stringContaining("The host will append it"),
          timeoutMs: 240_000,
          thinkLevel: "low",
        }),
      );
    },
  );

  it.each(["aborted", "replaced"])(
    "does not append after its owner is %s during inference",
    async (state) => {
      const params = await fixture();
      const abort = new AbortController();
      let current = true;
      runIsolatedCompletion.mockImplementation(async () => {
        if (state === "aborted") {
          abort.abort(new Error("aborted"));
        } else {
          current = false;
        }
        return { text: "Stale memory" };
      });
      await expect(
        runCliMemoryFlush({
          ...params,
          abortSignal: abort.signal,
          assertCurrent: () => {
            if (!current) {
              throw new Error("replaced");
            }
          },
        }),
      ).rejects.toThrow(state);
      await expect(
        fs.stat(path.join(params.workspaceDir, params.memoryFlushWritePath)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["aborted", "replaced"])(
    "preserves existing memory when its owner is %s during the final file read",
    async (state) => {
      const params = await fixture();
      const file = path.join(params.workspaceDir, params.memoryFlushWritePath);
      await fs.mkdir(path.dirname(file));
      await fs.writeFile(file, "Existing note");
      const realFile = await fs.realpath(file);
      const abort = new AbortController();
      let current = true;
      let readCompleted = false;
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) === realFile) {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
            const result = await Reflect.apply(read, handle, readArgs);
            readCompleted = true;
            if (state === "aborted") {
              abort.abort(new Error("aborted"));
            } else {
              current = false;
            }
            return result;
          });
        }
        return handle;
      });
      runIsolatedCompletion.mockResolvedValue({ text: "Stale memory" });

      await expect(
        runCliMemoryFlush({
          ...params,
          abortSignal: abort.signal,
          assertCurrent: () => {
            if (!current) {
              throw new Error("replaced");
            }
          },
        }),
      ).rejects.toThrow(state);

      expect(readCompleted).toBe(true);
      expect(await fs.readFile(file, "utf8")).toBe("Existing note");
    },
  );

  it("rejects empty output and confines successful writes to the workspace", async () => {
    const params = await fixture();
    runIsolatedCompletion.mockResolvedValueOnce({ text: "" });
    await expect(runCliMemoryFlush(params)).rejects.toThrow("empty output");
    runIsolatedCompletion.mockResolvedValueOnce({ text: "Memory" });
    await expect(
      runCliMemoryFlush({ ...params, memoryFlushWritePath: "../outside.md" }),
    ).rejects.toThrow();
  });
});
