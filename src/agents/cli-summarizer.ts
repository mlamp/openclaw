import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveRotatedCompactionSessionFile,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
} from "../config/sessions.js";
import { readSessionMessages } from "../gateway/session-utils.fs.js";
import { formatErrorMessage as describeUnknownError } from "../infra/errors.js";
import {
  appendRegularFile,
  ensureAbsoluteDirectory,
  readRegularFile,
  statRegularFile,
} from "../infra/fs-safe.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { runCliAgent } from "./cli-runner.js";
import { estimateMessagesTokens } from "./compaction.js";
import { isFailoverError } from "./failover-error.js";
import { ensureSessionHeader } from "./pi-embedded-helpers.js";
import {
  asCompactionHookRunner,
  buildBeforeCompactionHookMetrics,
  runAfterCompactionHooks,
  runBeforeCompactionHooks,
  runPostCompactionSideEffects,
} from "./pi-embedded-runner/compaction-hooks.js";
import type { EmbeddedPiCompactResult, EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

const log = createSubsystemLogger("cli-summarize");

const DEFAULT_ONE_SHOT_TIMEOUT_MS = 60_000;
const DEFAULT_COMPACTION_PROMPT_TOKENS = 120_000;
const DEFAULT_FLUSH_PROMPT_TOKENS = 60_000;

export type CliSummarizerOneShotResult = {
  text: string;
  usage?: NonNullable<EmbeddedPiRunResult["meta"]["agentMeta"]>["usage"];
};

export type RunCliSummarizerOneShotParams = {
  prompt: string;
  provider: string;
  model: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId?: string;
  extraSystemPrompt?: string;
  timeoutMs?: number;
  authProfileId?: string;
};

/**
 * Run a single CLI completion against a fresh, throwaway session. Always one-shot:
 * never accepts a `cliSessionBinding`, so summarization does not depend on the
 * CLI's internal auto-compacted state.
 */
export async function runCliSummarizerOneShot(
  params: RunCliSummarizerOneShotParams,
): Promise<CliSummarizerOneShotResult> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-summarize-"));
  const tempSessionFile = path.join(tempDir, "session.jsonl");
  const sessionId = crypto.randomUUID();
  const runId = `cli-summarize-${sessionId}`;
  try {
    const result = await runCliAgent({
      sessionId,
      sessionFile: tempSessionFile,
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      config: params.config,
      prompt: params.prompt,
      provider: params.provider,
      model: params.model,
      timeoutMs: params.timeoutMs ?? DEFAULT_ONE_SHOT_TIMEOUT_MS,
      runId,
      extraSystemPrompt: params.extraSystemPrompt,
      authProfileId: params.authProfileId,
    });
    const text = result.payloads?.[0]?.text?.trim() ?? "";
    return { text, usage: result.meta?.agentMeta?.usage };
  } catch (err) {
    if (isFailoverError(err)) {
      throw err;
    }
    throw new Error(`CLI summarizer failed: ${describeUnknownError(err)}`, { cause: err });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export type SessionTailReadResult = {
  messages: AgentMessage[];
  tokensRead: number;
  truncated: boolean;
};

export type ReadSessionTailParams = {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
  maxPromptTokens: number;
};

/**
 * Read the openclaw session JSONL and return the tail bounded by `maxPromptTokens`.
 * Caller stitches the truncated marker into the prompt so the CLI does not
 * hallucinate completeness.
 */
export function readSessionTailForSummarization(
  params: ReadSessionTailParams,
): SessionTailReadResult {
  const messages = readSessionMessages(
    params.sessionId,
    params.storePath,
    params.sessionFile,
  ) as AgentMessage[];
  if (messages.length === 0) {
    return { messages: [], tokensRead: 0, truncated: false };
  }
  const budget = Math.max(1, params.maxPromptTokens);
  let tokens = 0;
  const tail: AgentMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    let cost = 0;
    try {
      cost = estimateTokens(msg);
    } catch {
      cost = 0;
    }
    if (cost > 0 && tokens + cost > budget && tail.length > 0) {
      return {
        messages: tail.toReversed(),
        tokensRead: tokens,
        truncated: true,
      };
    }
    tail.push(msg);
    tokens += cost;
  }
  return {
    messages: tail.toReversed(),
    tokensRead: tokens,
    truncated: false,
  };
}

function renderTranscriptForPrompt(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const content = (msg as { content?: unknown }).content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const blockText = (block as { text?: unknown }).text;
        if (typeof blockText === "string") {
          text += `${blockText}\n`;
        }
      }
    }
    text = text.trim();
    if (!text) {
      continue;
    }
    lines.push(`<${role}>\n${text}\n</${role}>`);
  }
  return lines.join("\n\n");
}

const COMPACTION_INSTRUCTION = [
  "Summarize this conversation for continuity.",
  "Preserve file paths, decisions, open questions, and user preferences.",
  "Omit already-resolved tangents.",
  "Reply with the summary only, no preamble.",
].join(" ");

const TRUNCATION_PREFIX =
  "Earlier messages were truncated due to length; summarize what follows.\n\n";

function buildCompactionPrompt(tail: SessionTailReadResult): string {
  const transcript = renderTranscriptForPrompt(tail.messages);
  const prefix = tail.truncated ? TRUNCATION_PREFIX : "";
  return `${prefix}${COMPACTION_INSTRUCTION}\n\n${transcript}`;
}

export type CompactViaCliBackendParams = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  provider: string;
  model: string;
  authProfileId?: string;
  storePath?: string;
  messageProvider?: string;
  diagId?: string;
  maxPromptTokens?: number;
  timeoutMs?: number;
  extraSystemPrompt?: string;
};

/**
 * CLI-native compaction: read the openclaw JSONL tail, summarize via a fresh
 * CLI one-shot, write the summary as the first user message of the rotated
 * session file. Pi-path hooks fire the same way for cross-transport parity.
 */
export async function compactViaCliBackend(
  params: CompactViaCliBackendParams,
): Promise<EmbeddedPiCompactResult> {
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  const diagPrefix = `[cli-summarize] site=compact sessionKey=${sessionKey} diagId=${params.diagId ?? "<none>"} provider=${params.provider}/${params.model}`;
  const startedAt = Date.now();
  const tail = readSessionTailForSummarization({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    maxPromptTokens: params.maxPromptTokens ?? DEFAULT_COMPACTION_PROMPT_TOKENS,
  });
  if (tail.messages.length === 0) {
    log.info(`${diagPrefix} skipping — empty transcript`);
    return { ok: true, compacted: false, reason: "nothing to compact" };
  }
  const fullMessages = readSessionMessages(
    params.sessionId,
    params.storePath,
    params.sessionFile,
  ) as AgentMessage[];
  const tokensBefore = estimateMessagesTokens(fullMessages);
  log.info(
    `${diagPrefix} promptTokens=${tail.tokensRead} truncated=${tail.truncated} fullTokens=${tokensBefore}`,
  );

  const hookRunner = asCompactionHookRunner(getGlobalHookRunner());
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
  });
  const beforeMetrics = buildBeforeCompactionHookMetrics({
    originalMessages: fullMessages,
    currentMessages: fullMessages,
    observedTokenCount: tokensBefore,
    estimateTokensFn: estimateTokens,
  });
  const { hookSessionKey, missingSessionKey } = await runBeforeCompactionHooks({
    hookRunner,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionAgentId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider,
    metrics: beforeMetrics,
  });

  let summary: string;
  let usage: CliSummarizerOneShotResult["usage"];
  try {
    const result = await runCliSummarizerOneShot({
      prompt: buildCompactionPrompt(tail),
      provider: params.provider,
      model: params.model,
      config: params.config,
      workspaceDir: params.workspaceDir,
      agentId: sessionAgentId,
      extraSystemPrompt: params.extraSystemPrompt,
      timeoutMs: params.timeoutMs,
      authProfileId: params.authProfileId,
    });
    summary = result.text;
    usage = result.usage;
  } catch (err) {
    if (isFailoverError(err)) {
      throw err;
    }
    log.warn(`${diagPrefix} cli summarize failed: ${describeUnknownError(err)}`);
    return { ok: false, compacted: false, reason: describeUnknownError(err) };
  }

  if (!summary) {
    log.info(`${diagPrefix} skipping — empty summary`);
    return { ok: true, compacted: false, reason: "nothing to compact" };
  }

  const newSessionId = crypto.randomUUID();
  const summaryEntryId = crypto.randomUUID();
  const newSessionFile = resolveNewSessionFile({
    sessionEntry: params.sessionEntry,
    sessionKey,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    newSessionId,
  });
  await ensureSessionHeader({
    sessionFile: newSessionFile,
    sessionId: newSessionId,
    cwd: params.workspaceDir,
  });
  await fs.appendFile(
    newSessionFile,
    `${JSON.stringify({
      id: summaryEntryId,
      type: "message",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: summary }],
      },
    })}\n`,
    "utf-8",
  );

  const summaryMessage: AgentMessage = {
    role: "user",
    content: summary,
    timestamp: Date.now(),
  } as AgentMessage;
  const tokensAfter = estimateMessagesTokens([summaryMessage]);
  if (
    typeof usage?.output === "number" &&
    usage.output > 0 &&
    Math.abs(usage.output - tokensAfter) / Math.max(tokensAfter, 1) > 0.2
  ) {
    log.warn(`${diagPrefix} usage.output=${usage.output} diverges from estimate=${tokensAfter}`);
  }

  await runAfterCompactionHooks({
    hookRunner,
    sessionId: newSessionId,
    sessionAgentId,
    hookSessionKey,
    missingSessionKey,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider,
    messageCountAfter: 1,
    tokensAfter,
    compactedCount: fullMessages.length,
    sessionFile: newSessionFile,
    summaryLength: summary.length,
    tokensBefore,
    firstKeptEntryId: summaryEntryId,
  });

  await runPostCompactionSideEffects({
    config: params.config,
    sessionKey: params.sessionKey,
    sessionFile: newSessionFile,
  });

  log.info(
    `${diagPrefix} done summaryLength=${summary.length} tokensBefore=${tokensBefore} tokensAfter=${tokensAfter} elapsedMs=${Date.now() - startedAt}`,
  );

  return {
    ok: true,
    compacted: true,
    result: {
      summary,
      // For CLI compaction this is the seeded summary entry, not a kept entry
      // from the prior session — the new session begins here.
      firstKeptEntryId: summaryEntryId,
      tokensBefore,
      tokensAfter,
      details: { newSessionId, newSessionFile },
    },
  };
}

function resolveNewSessionFile(params: {
  sessionEntry?: SessionEntry;
  sessionKey: string;
  storePath?: string;
  sessionFile: string;
  sessionId: string;
  newSessionId: string;
}): string {
  const entry: SessionEntry =
    params.sessionEntry ??
    ({
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      updatedAt: Date.now(),
    } as SessionEntry);
  const rotated = resolveRotatedCompactionSessionFile({
    entry,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    newSessionId: params.newSessionId,
  });
  if (rotated) {
    return rotated;
  }
  // Fallback: when the prior file naming does not match a recognized pattern,
  // place the new session next to it. Matches incrementCompactionCount's
  // resolveSessionFilePath default for relative entries.
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const opts = resolveSessionFilePathOptions({
    agentId,
    storePath: params.storePath,
  });
  return resolveSessionFilePath(params.newSessionId, undefined, opts);
}

export type RunCliMemoryFlushParams = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionFile: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  provider: string;
  model: string;
  authProfileId?: string;
  storePath?: string;
  flushPrompt: string;
  flushSystemPrompt?: string;
  memoryFlushWritePath: string;
  maxPromptTokens?: number;
  timeoutMs?: number;
  agentId?: string;
};

/**
 * CLI-native memory flush: read transcript tail, ask the CLI for the flush
 * payload, append it to the workspace memory file, and rotate the openclaw
 * session id so the bloated prefix drops out of subsequent runs.
 */
export async function runCliMemoryFlush(
  params: RunCliMemoryFlushParams,
): Promise<EmbeddedPiRunResult> {
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  const diagPrefix = `[cli-summarize] site=flush sessionKey=${sessionKey} provider=${params.provider}/${params.model}`;
  const tail = readSessionTailForSummarization({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    maxPromptTokens: params.maxPromptTokens ?? DEFAULT_FLUSH_PROMPT_TOKENS,
  });
  const startedAt = Date.now();
  const transcript = renderTranscriptForPrompt(tail.messages);
  const truncationPrefix = tail.truncated ? TRUNCATION_PREFIX : "";
  const composedPrompt = transcript
    ? `${truncationPrefix}${params.flushPrompt}\n\n${transcript}`
    : `${truncationPrefix}${params.flushPrompt}`;
  log.info(`${diagPrefix} promptTokens=${tail.tokensRead} truncated=${tail.truncated}`);

  const result = await runCliSummarizerOneShot({
    prompt: composedPrompt,
    provider: params.provider,
    model: params.model,
    config: params.config,
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
    extraSystemPrompt: params.flushSystemPrompt,
    timeoutMs: params.timeoutMs,
    authProfileId: params.authProfileId,
  });

  if (result.text) {
    // Append the flushed summary to the memory file within the workspace root,
    // creating parent dirs and prepending a newline when the existing file does
    // not already end with one (upstream removed the appendFileWithinRoot helper
    // in the @openclaw/fs-safe refactor; reimplement with the current primitives).
    const memoryFilePath = path.resolve(params.workspaceDir, params.memoryFlushWritePath);
    const memoryDir = await ensureAbsoluteDirectory(path.dirname(memoryFilePath));
    if (!memoryDir.ok) {
      throw memoryDir.error;
    }
    let memoryPrefix = "";
    if (!result.text.startsWith("\n")) {
      const memoryStat = await statRegularFile(memoryFilePath);
      if (!memoryStat.missing && memoryStat.stat.size > 0) {
        const { buffer } = await readRegularFile({ filePath: memoryFilePath });
        if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
          memoryPrefix = "\n";
        }
      }
    }
    await appendRegularFile({ filePath: memoryFilePath, content: memoryPrefix + result.text });
  } else {
    log.warn(`${diagPrefix} empty CLI output; skipping memory file write`);
  }

  const newSessionId = crypto.randomUUID();
  log.info(
    `${diagPrefix} done bytes=${result.text.length} elapsedMs=${Date.now() - startedAt} newSessionId=${newSessionId}`,
  );
  return {
    payloads: result.text ? [{ text: result.text }] : undefined,
    meta: {
      durationMs: Date.now() - startedAt,
      agentMeta: {
        sessionId: newSessionId,
        provider: params.provider,
        model: params.model,
        usage: result.usage,
      },
    },
  };
}

export type GenerateCliConversationLabelParams = {
  prompt: string;
  userMessage: string;
  provider: string;
  model: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId?: string;
  maxLength: number;
  timeoutMs?: number;
};

export async function generateCliConversationLabel(
  params: GenerateCliConversationLabelParams,
): Promise<string | null> {
  try {
    const result = await runCliSummarizerOneShot({
      prompt: `${params.prompt}\n\n${params.userMessage}`,
      provider: params.provider,
      model: params.model,
      config: params.config,
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      timeoutMs: params.timeoutMs ?? 15_000,
    });
    if (!result.text) {
      return null;
    }
    return result.text.slice(0, params.maxLength);
  } catch (err) {
    if (isFailoverError(err)) {
      throw err;
    }
    log.warn(
      `[cli-summarize] site=label provider=${params.provider}/${params.model} failed: ${describeUnknownError(err)}`,
    );
    return null;
  }
}
