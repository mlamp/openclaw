import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createBackgroundWorkOwner } from "../../process/background-work.js";
import { getGatewayRestartDrainSignal } from "../../process/gateway-work-admission.js";

const reviews = createBackgroundWorkOwner({ owner: "core:skill-workshop", maxConcurrent: 1 });

/** All Workshop reviewers share admission, model locking, and background capacity. */
export async function runSkillWorkshopReview(
  params: RunEmbeddedAgentParams & {
    agentId: string;
    config: OpenClawConfig;
    reviewKind: "experience" | "history-scan" | "collection-review";
  },
) {
  const provider = params.provider ?? "";
  const cliRuntime = resolveCliRuntimeExecutionProvider({
    cfg: params.config,
    agentId: params.agentId,
    provider,
    modelId: params.model,
    authProfileId: params.authProfileId,
  });
  // The CLI bridge cannot carry the review's proposal/reconciliation authority.
  // Refuse before admission rather than silently billing the direct provider API.
  if (cliRuntime || isCliProvider(provider, params.config)) {
    throw new Error(
      "Skill Workshop reviews are unavailable with the selected CLI runtime. Use an explicitly configured API runtime for reviews, or leave the review pending.",
    );
  }
  const { reviewKind, ...runParams } = params;
  const restartSignal = getGatewayRestartDrainSignal();
  const abortSignal = params.abortSignal
    ? AbortSignal.any([restartSignal, params.abortSignal])
    : restartSignal;
  abortSignal.throwIfAborted();
  const preparedRunAdmission = prepareSystemAgentRunAdmission(
    params.config,
    params.runId,
    params.agentId,
    `skill-workshop.${reviewKind}`,
  );
  try {
    const { runEmbeddedAgent } = await import("../../agents/embedded-agent.js");
    return await runEmbeddedAgent({
      ...runParams,
      preparedRunAdmission,
      abortSignal,
      lane: reviews.lane,
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      // Review prompts and cloned prefixes are sized for this exact model.
      modelSelectionLocked: true,
      modelFallbacksOverride: [],
      disableTrajectory: true,
      skillWorkshopProposalOnly: true,
      cleanupBundleMcpOnRunEnd: true,
      verboseLevel: "off",
    });
  } finally {
    preparedRunAdmission.close();
  }
}
