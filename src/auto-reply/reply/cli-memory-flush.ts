import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { serializeConversation } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { runIsolatedCompletion } from "../../agents/isolated-completion.js";
import { convertToLlm } from "../../agents/sessions/messages.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { root } from "../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../tokens.js";

const MAX_FLUSH_PROMPT_TOKENS = 60_000;
const MAX_FLUSH_TRANSCRIPT_CHARS = MAX_FLUSH_PROMPT_TOKENS * 4;
const log = createSubsystemLogger("auto-reply/cli-memory-flush");

type CliMemoryFlushParams = Omit<
  Parameters<typeof runIsolatedCompletion>[0],
  "prompt" | "systemPrompt"
> & {
  sessionTarget: SessionTranscriptRuntimeTarget;
  workspaceDir: string;
  flushPrompt: string;
  flushSystemPrompt: string;
  memoryFlushWritePath: string;
};

/** Export durable memory without editing the CLI owner's native transcript. */
export async function runCliMemoryFlush(params: CliMemoryFlushParams): Promise<void> {
  params.assertCurrent?.();
  let truncated = false;
  const manager = SessionManager.openBounded(params.sessionTarget, {
    maxBytes: 2 * 1024 * 1024,
    maxEvents: 2048,
    onTruncated: () => {
      truncated = true;
    },
  });
  const messages = convertToLlm(manager.buildSessionContext().messages);
  const serialized = serializeConversation(messages);
  let transcript = serialized;
  if (transcript.length > MAX_FLUSH_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(-MAX_FLUSH_TRANSCRIPT_CHARS);
    truncated = true;
  }
  // Preserve the fork's bounded tail contract even for one oversized message;
  // token estimation accounts for dense text instead of treating four chars as a guarantee.
  while (
    estimateTokens({ role: "user", content: transcript, timestamp: 0 }) > MAX_FLUSH_PROMPT_TOKENS
  ) {
    transcript = transcript.slice(Math.ceil(transcript.length / 4));
    truncated = true;
  }
  if (/^[\uDC00-\uDFFF]/.test(transcript)) {
    transcript = transcript.slice(1);
  }
  const {
    sessionTarget: _sessionTarget,
    memoryFlushWritePath,
    flushPrompt,
    flushSystemPrompt,
    ...completion
  } = params;
  const result = await runIsolatedCompletion({
    ...completion,
    systemPrompt: [
      flushSystemPrompt,
      "Return only the durable memory text to append. The host will append it to the memory file; do not attempt any file or tool operations.",
      `If there is nothing to preserve, reply exactly ${SILENT_REPLY_TOKEN}.`,
    ].join("\n\n"),
    prompt: [
      flushPrompt,
      truncated
        ? "Earlier transcript content was omitted due to length; use only the supplied tail."
        : "",
      transcript,
    ]
      .filter(Boolean)
      .join("\n\n"),
    streamParams: { maxTokens: 8192 },
  });
  params.assertCurrent?.();
  params.abortSignal?.throwIfAborted();
  if (isSilentReplyText(result.text, SILENT_REPLY_TOKEN)) {
    log.debug("CLI memory flush completed with no durable memories");
    return;
  }
  if (!result.text.trim()) {
    throw new Error("CLI memory flush returned empty output");
  }
  if (result.text.length > 32_768) {
    throw new Error("CLI memory flush output exceeded the memory artifact limit");
  }
  const fsRoot = await root(params.workspaceDir);
  params.assertCurrent?.();
  params.abortSignal?.throwIfAborted();
  await fsRoot.append(memoryFlushWritePath, result.text, {
    prependNewlineIfNeeded: true,
    mkdir: true,
  });
}
