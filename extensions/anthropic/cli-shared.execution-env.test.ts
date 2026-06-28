import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { resolveClaudeCliThinkingEnv } from "./cli-shared.js";

describe("Claude CLI execution environment", () => {
  it.each([
    [undefined, undefined],
    ["off", undefined],
    ["minimal", "low"],
    ["high", "high"],
    ["adaptive", "auto"],
    ["max", "max"],
  ] as const)(
    "prepares per-call effort %s for both transport modes",
    async (thinkingLevel, effort) => {
      const backend = buildAnthropicCliBackend();
      for (const executionMode of ["agent", "side-question"] as const) {
        const prepared = await backend.prepareExecution?.({
          workspaceDir: "/tmp/claude-effort",
          provider: "claude-cli",
          modelId: "claude-sonnet-4-6",
          thinkingLevel,
          executionMode,
        });
        expect(prepared?.env?.CLAUDE_CODE_EFFORT_LEVEL).toBe(effort);
      }
    },
  );

  it.each([
    ["high", { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1", MAX_THINKING_TOKENS: "16384" }],
    ["off", { MAX_THINKING_TOKENS: "0" }],
    ["adaptive", undefined],
  ] as const)("maps %s thinking to Claude Code's process environment", (level, expected) => {
    expect(resolveClaudeCliThinkingEnv(level, "claude-opus-4-8")).toEqual(expected);
  });

  it.each(["off", "high", "max"] as const)(
    "leaves mandatory-adaptive Fable thinking %s to Claude Code effort args",
    (level) => {
      expect(resolveClaudeCliThinkingEnv(level, "claude-fable-5")).toBeUndefined();
    },
  );
});
