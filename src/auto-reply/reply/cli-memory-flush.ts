import path from "node:path";
import { syncDirectoryBestEffort } from "@openclaw/fs-safe/durability";
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
const OMITTED_TRANSCRIPT_NOTICE =
  "Earlier transcript content was omitted due to length; use only the supplied tail.";
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
  contextWindowTokens: number;
};

/** Export durable memory without editing the CLI owner's native transcript. */
export async function runCliMemoryFlush(params: CliMemoryFlushParams): Promise<void> {
  params.assertCurrent?.();
  const {
    sessionTarget: _sessionTarget,
    memoryFlushWritePath,
    flushPrompt,
    flushSystemPrompt,
    contextWindowTokens,
    ...completion
  } = params;
  const systemPrompt = [
    flushSystemPrompt,
    "Return only the durable memory text to append. The host will append it to the memory file; do not attempt any file or tool operations.",
    `If there is nothing to preserve, reply exactly ${SILENT_REPLY_TOKEN}.`,
  ].join("\n\n");
  const maxTokens = Math.min(8192, Math.floor(contextWindowTokens / 4));
  const overheadTokens = estimateTokens({
    role: "user",
    content: [systemPrompt, flushPrompt, OMITTED_TRANSCRIPT_NOTICE].join("\n\n"),
    timestamp: 0,
  });
  // The flush model may be smaller than the conversation owner. Reserve output,
  // instructions and request framing before selecting its bounded transcript tail.
  const transcriptBudget = Math.min(
    MAX_FLUSH_PROMPT_TOKENS,
    contextWindowTokens - maxTokens - overheadTokens - 1024,
  );
  if (transcriptBudget <= 0) {
    throw new Error("CLI memory flush instructions exceed the selected model context budget");
  }
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
  if (transcript.length > transcriptBudget * 4) {
    transcript = transcript.slice(-transcriptBudget * 4);
    truncated = true;
  }
  // Preserve the fork's bounded tail contract even for one oversized message;
  // token estimation accounts for dense text instead of treating four chars as a guarantee.
  while (estimateTokens({ role: "user", content: transcript, timestamp: 0 }) > transcriptBudget) {
    transcript = transcript.slice(Math.ceil(transcript.length / 4));
    truncated = true;
  }
  if (/^[\uDC00-\uDFFF]/.test(transcript)) {
    transcript = transcript.slice(1);
  }
  const result = await runIsolatedCompletion({
    ...completion,
    systemPrompt,
    prompt: [flushPrompt, truncated ? OMITTED_TRANSCRIPT_NOTICE : "", transcript]
      .filter(Boolean)
      .join("\n\n"),
    streamParams: { maxTokens },
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
  const target = await fsRoot.openWritable(memoryFlushWritePath, {
    writeMode: "append",
    mkdir: true,
  });
  try {
    let prefix = "";
    if (!target.createdForWrite && target.stat.size > 0 && !result.text.startsWith("\n")) {
      const lastByte = Buffer.alloc(1);
      const { bytesRead } = await target.handle.read(lastByte, 0, 1, target.stat.size - 1);
      if (bytesRead === 1 && lastByte[0] !== 0x0a) {
        prefix = "\n";
      }
    }
    // Opening and reading the confined handle can outlive the session owner.
    // Revalidate after those awaits, immediately before submitting memory bytes.
    params.assertCurrent?.();
    params.abortSignal?.throwIfAborted();
    await target.handle.appendFile(`${prefix}${result.text}`, "utf8");
    await target.handle.sync();
    if (target.createdForWrite) {
      await syncDirectoryBestEffort(path.dirname(target.realPath));
    }
  } finally {
    await target.handle.close().catch(() => undefined);
  }
}
