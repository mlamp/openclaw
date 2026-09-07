#!/usr/bin/env bash
# Fork-local routing inventory. This is a drift heuristic, not runtime proof.
# September renamed the embedded entrypoint and split guards from callers.
# Inspect named imports, aliases, facade calls, and dynamic imports via the repo's
# TypeScript parser. Reviewed adapters do not prove their utility callers safe.
# Newly discovered leaks and changed routing evidence fail. The pre-existing
# July voice gaps remain visible and outside this upgrade's feature scope.
# Usage: bash scripts/check-cli-routing.sh [repo-root]
set -euo pipefail
cd "${1:-$PWD}"
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const repoRequire = createRequire(path.resolve("package.json"));
let ts;
try {
  ts = repoRequire("typescript");
} catch {
  console.error("ERROR: install the repository's pinned dependencies before routing audit.");
  process.exit(2);
}
const read = (file) => fs.readFileSync(file, "utf8");
const reviews = new Map([
  ["src/gateway/session-companion-ask.ts", ["GUARDED", "bounded companion tools opt into subscription CLI dispatch", ['cliBackendDispatch: "subscription-auth"', "SESSION_COMPANION_TOOLS", "authProfileId: selection.profileId"]]],
  ["src/skills/workshop/review-run.ts", ["FAIL-VISIBLE", "new workshop CLI capability is unsupported; owner rejects before provider execution", ["resolveCliRuntimeExecutionProvider", "isCliProvider", "throw new Error", "Skill Workshop reviews are unavailable with the selected CLI runtime"]]],
  ["src/agents/command/attempt-execution.ts", ["GUARDED", "command runtime selection", ["resolveCliRuntimeExecutionProvider", "isCliProvider", "runCliAgent"]]],
  ["src/cron/isolated-agent/run-executor.ts", ["GUARDED", "cron runtime selection", ["resolveCliRuntimeExecutionProvider", "isCliProvider", "runCliAgent"]]],
  ["src/auto-reply/reply/agent-runner-embedded-candidate.ts", ["GUARDED", "caller owns CLI/embedded candidate selection", [], "src/auto-reply/reply/agent-runner-fallback-candidate.ts", ["resolveCliRuntimeExecutionProvider", "runCliFallbackCandidate", "runEmbeddedFallbackCandidate"]]],
  ["src/auto-reply/reply/agent-runner-memory.ts", ["GUARDED", "memory flush owner routes CLI separately", ["runCliMemoryFlush", "if (isCli)"]]],
  ["extensions/active-memory/recall-run.ts", ["GUARDED", "subscription dispatch with bounded recall tools", ['cliBackendDispatch: "subscription-auth"', "toolsAllow:"]]],
  ["src/system-agent/agent-turn.ts", ["GUARDED", "verified inference plan chooses CLI or embedded", ['plan.runner === "cli"', "runCli"]]],
  ["src/system-agent/assistant.ts", ["GUARDED", "verified inference route chooses CLI or embedded", ['route.runner === "cli"', "runCliAgent"]]],
  ["src/plugins/registry-runtime.ts", ["ADAPTER", "plugin scope and session ownership; callers remain audited", ["prepareRunSessionExecution", "runWithPluginScope"]]],
  ["src/plugins/runtime/runtime-embedded-agent.runtime.ts", ["ADAPTER", "plugin admission; callers remain audited", ["prepareAgentRunAdmission", "preparedRunAdmission"]]],
  ["src/gateway/talk-client-agent-consult.ts", ["ADAPTER", "Talk admission; agent-consult-runtime remains audited", ["prepareAgentRunAdmission", "consultRealtimeVoiceAgent"]]],
  ["src/commands/models/list.probe.ts", ["DIAGNOSTIC", "explicit provider/profile authentication probe", ["authProfileId:", "disableTools: true", "modelRun: true", 'agentHarnessRuntimeOverride: "openclaw"']]],
]);
// These exact surfaces were already documented in July's fork guard/playbook.
// This is an explicit scope limitation, not a claim that their routing is safe.
const knownGaps = new Map([
  ["src/talk/agent-consult-runtime.ts", "pre-existing Talk gap documented in personal extra-usage invariants (formerly realtime-voice/)"],
  ["extensions/voice-call/src/response-generator.ts", "pre-existing voice response gap documented in v2026.7.1-mlamp:scripts/check-cli-routing.sh"],
]);
function sourceFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      return /^(?:node_modules|dist|test|tests|__mocks__)$/.test(entry.name) ? [] : sourceFiles(file);
    }
    return entry.isFile() && /\.tsx?$/.test(file) &&
      !/(?:^|[.-])(?:test|harness|mock|cases)(?:[.-]|$)/.test(entry.name) ? [file] : [];
  });
}
function embeddedCalls(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const aliases = new Set(["runEmbeddedAgent", "runEmbeddedPiAgent"]);
  function referencesRunner(node) {
    if (!node) return false;
    if (ts.isIdentifier(node)) return aliases.has(node.text);
    if (ts.isPropertyAccessExpression(node)) return aliases.has(node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      return aliases.has(node.argumentExpression.text);
    }
    if (ts.isCallExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false;
    return ts.forEachChild(node, referencesRunner) === true;
  }
  function discover(node) {
    if (ts.isImportSpecifier(node) && aliases.has((node.propertyName ?? node.name).text)) {
      aliases.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && referencesRunner(node.initializer)) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, discover);
  }
  discover(tree);
  const lines = [];
  function visit(node) {
    if (ts.isCallExpression(node) && referencesRunner(node.expression)) {
      lines.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return lines;
}
let failed = false;
let seen = 0;
let knownGapCount = 0;
try {
  for (const [file, markers] of [
    ["src/agents/embedded-agent-runner/run-orchestrator.ts", ["runEmbeddedAgentViaCliBackendIfEligible", "if (cliDispatched)"]],
    ["src/agents/embedded-agent-runner/cli-backend-dispatch.ts", ["resolveEmbeddedCliBackendDispatchEligibility", "runCliAgent", "resolveDispatchableToolsAllow"]],
    ["src/agents/embedded-agent-runner/cli-backend-dispatch-eligibility.ts", ["resolveCliRuntimeExecutionProvider", "subscriptionAuthDispatch"]],
  ]) {
    const missing = markers.filter((marker) => !read(file).includes(marker));
    if (missing.length) {
      console.log(`DRIFT ${file} — missing central dispatch evidence: ${missing.join(", ")}`);
      failed = true;
    }
  }
  for (const file of [...sourceFiles("src"), ...sourceFiles("extensions")].sort()) {
    const source = read(file);
    const lines = embeddedCalls(file, source);
    if (!lines.length) continue;
    seen += lines.length;
    const review = reviews.get(file);
    const refs = lines.map((line) => `${file}:${line}`).join(", ");
    if (knownGaps.has(file)) {
      console.log(`KNOWN-GAP ${refs} — ${knownGaps.get(file)}; CLI safety unproven, outside upgrade scope`);
      knownGapCount += lines.length;
    } else if (!review) {
      console.log(`UNREVIEWED ${refs} — inspect owning caller, runtime choice, and tool/context contract`);
      failed = true;
    } else {
      const [category, reason, markers, owner, ownerMarkers] = review;
      const missing = markers.filter((marker) => !source.includes(marker));
      if (owner) missing.push(...ownerMarkers.filter((marker) => !read(owner).includes(marker)));
      if (missing.length) {
        console.log(`DRIFT ${refs} — missing reviewed routing evidence: ${missing.join(", ")}`);
        failed = true;
      } else {
        console.log(`${category} ${refs} — ${reason}`);
      }
    }
  }
} catch (error) {
  console.error(`ERROR: routing audit could not complete: ${error.message}`);
  process.exit(2);
}
if (!seen) {
  console.error("ERROR: found no embedded runner invocations; inventory cannot establish coverage.");
  process.exit(2);
}
console.log(`${failed ? "FAIL" : "OK"}: ${seen} embedded invocations inventoried; ${knownGapCount} pre-existing out-of-scope gap(s) remain. Routing markers require manual path review and live CLI proof.`);
process.exit(failed ? 1 : 0);
NODE
