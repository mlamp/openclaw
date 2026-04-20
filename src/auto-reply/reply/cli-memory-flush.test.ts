import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    thinkLevel: "low" as const,
  };
}

describe("CLI memory export", () => {
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
        if (state === "aborted") abort.abort(new Error("aborted"));
        else current = false;
        return { text: "Stale memory" };
      });
      await expect(
        runCliMemoryFlush({
          ...params,
          abortSignal: abort.signal,
          assertCurrent: () => {
            if (!current) throw new Error("replaced");
          },
        }),
      ).rejects.toThrow(state);
      await expect(
        fs.stat(path.join(params.workspaceDir, params.memoryFlushWritePath)),
      ).rejects.toMatchObject({ code: "ENOENT" });
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
