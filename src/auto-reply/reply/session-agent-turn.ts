import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
/**
 * CLI-aware agent-turn seam for session-model runs.
 *
 * A CLI-backed agent persists its model under the canonical SDK provider id
 * (e.g. "anthropic/…" after doctor/anthropic-plugin canonicalization) while its
 * turns actually execute through a Claude Code CLI runtime (e.g. "claude-rotating").
 * Calling the in-process SDK runner (runEmbeddedAgent) directly for such an agent
 * makes a metered Anthropic API call with the subscription OAuth token and fails
 * with 400 "out of extra usage".
 *
 * This seam centralizes the same CLI-vs-SDK decision the chat dispatch makes
 * (agent-runner-execution.ts) and that b4b734266b5 added to compaction/memory-flush,
 * so any session-model caller (e.g. the active-memory recall sub-agent) can route
 * correctly by opting in here instead of re-deriving the routing at every call site.
 * Callers that intentionally need the SDK path on a CLI-backed agent (auth probes,
 * JSON single-shots) keep calling runEmbeddedAgent directly.
 */
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { resolveCliExecutionProviderForSession } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { runCliAgentWithLifecycle } from "./agent-runner-cli-dispatch.js";

export type RunSessionAgentTurnParams = RunEmbeddedAgentParams & {
  /**
   * Per-session CLI runtime pin (SessionEntry.agentRuntimeOverride). When it (or
   * the configured/auth-order CLI runtime) resolves to a CLI backend, the turn
   * runs through the CLI runtime instead of the metered in-process SDK.
   */
  agentRuntimeOverride?: string;
};

/**
 * Run one agent turn for a session, routing CLI-backed sessions through the CLI
 * runtime and everything else through the embedded SDK runner. The CLI branch
 * forwards the fields a generic turn needs; embedded-SDK-only concerns that have
 * no CLI equivalent (agentDir, verbose/reasoning level, allowGatewaySubagentBinding,
 * authProfileFailurePolicy, the message-tool omission of disableMessageTool) are
 * intentionally dropped — the CLI harness owns those behaviors itself.
 */
export async function runSessionAgentTurn(
  params: RunSessionAgentTurnParams,
): Promise<EmbeddedAgentRunResult> {
  const provider = params.provider;
  if (!provider) {
    return runEmbeddedAgent(params);
  }
  // Gate on the resolved CLI runtime execution provider, not the raw model
  // provider: a CLI-backed agent's model is the canonical SDK id ("anthropic/…"),
  // so gating on it misses isCliProvider and drops the run onto the direct SDK
  // path (no API key / "out of extra usage" for the subscription account).
  const cliExecutionProvider = resolveCliExecutionProviderForSession({
    provider,
    cfg: params.config,
    agentId: params.agentId,
    modelId: params.model,
    authProfileId: params.authProfileId,
    agentRuntimeOverride: params.agentRuntimeOverride,
  });
  if (!isCliProvider(cliExecutionProvider, params.config)) {
    return runEmbeddedAgent(params);
  }
  const onAgentToolResult = params.onAgentToolResult;
  return runCliAgentWithLifecycle({
    runId: params.runId,
    lifecycleGeneration: params.lifecycleGeneration,
    provider: cliExecutionProvider,
    // Do NOT suppress the event bridges: runCliAgentWithLifecycle gates the tool
    // bridge on suppressAssistantBridge too, and silent sub-agents (recall sets
    // silentExpected) still need tool results via onToolEvent -> onAgentToolResult.
    // Suppressing here would silently drop recall's memory hits on the CLI path.
    // Silence (no channel reply) is carried by requireExplicitMessageTarget /
    // sourceReplyDeliveryMode below; this seam wires no assistant/reasoning text
    // delivery, so leaving the bridges active is a no-op for those streams.
    suppressAssistantBridge: false,
    onToolEvent: onAgentToolResult
      ? async (payload) => {
          // CLI tool outcomes arrive via onToolEvent; only result-phase events
          // carry the sanitized result the embedded onAgentToolResult observer
          // expects.
          if (payload.phase !== "result") {
            return;
          }
          onAgentToolResult({
            toolName: payload.name ?? "",
            result: payload.result,
            isError: payload.isError === true,
          });
        }
      : undefined,
    runParams: {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      trigger: params.trigger,
      sessionFile: params.sessionFile,
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
      config: params.config,
      prompt: params.prompt,
      transcriptPrompt: params.transcriptPrompt,
      currentInboundEventKind: params.currentInboundEventKind,
      currentInboundContext: params.currentInboundContext,
      inputProvenance: params.inputProvenance,
      provider: cliExecutionProvider,
      model: params.model,
      bootstrapContextMode: params.bootstrapContextMode,
      bootstrapContextRunKind: params.bootstrapContextRunKind,
      thinkLevel: params.thinkLevel,
      timeoutMs: params.timeoutMs,
      runTimeoutOverrideMs: params.runTimeoutOverrideMs,
      runId: params.runId,
      lane: params.lane,
      extraSystemPrompt: params.extraSystemPrompt,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      silentReplyPromptMode: params.silentReplyPromptMode,
      allowEmptyAssistantReplyAsSilent: params.allowEmptyAssistantReplyAsSilent,
      // disableMessageTool omits the message tool on the embedded path; the CLI
      // harness cannot, so suppress implicit last-route sends instead.
      requireExplicitMessageTarget:
        params.requireExplicitMessageTarget ?? params.disableMessageTool,
      ownerNumbers: params.ownerNumbers,
      authProfileId: params.authProfileId,
      images: params.images,
      imageOrder: params.imageOrder,
      skillsSnapshot: params.skillsSnapshot,
      messageChannel: params.messageChannel,
      messageProvider: params.messageProvider,
      toolsAllow: params.toolsAllow,
      disableTools: params.disableTools,
      abortSignal: params.abortSignal,
      replyOperation: params.replyOperation,
      cleanupBundleMcpOnRunEnd: params.cleanupBundleMcpOnRunEnd,
      oneShotCliRun: params.oneShotCliRun,
    },
  });
}
