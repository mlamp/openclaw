#!/usr/bin/env bash
#
# Fork-local drift guard for CLI-backed agent routing.
#
# Background: a CLI-backed agent runs through a Claude Code CLI runtime while its
# model is persisted under the canonical SDK id (e.g. "anthropic/..." after
# doctor/anthropic-plugin canonicalization). Such an agent must route its turns
# through the CLI runtime, NOT the metered in-process SDK (runEmbeddedAgent),
# which fabricates a 400 "out of extra usage" for subscription accounts.
#
# Commit b4b734266b5 fixed compaction + memory-flush. The active-memory recall
# sub-agent routes through the CLI-aware api.runtime.agent.runSessionAgentTurn
# seam (src/auto-reply/reply/session-agent-turn.ts), which resolves the CLI
# execution provider and dispatches CLI-backed sessions to the CLI runner.
#
# This script fails if that routing regresses: the seam loses its CLI gate, the
# seam falls out of the plugin SDK contract, recall drops back onto the raw SDK
# path, or the regression tests are deleted. --untracked so it works before the
# new files are committed.
#
# KNOWN REMAINING LEAK SITES (same bug class, NOT yet routed — explicit follow-up;
# re-check/patch on each upstream rebase). Each runs an embedded agent on the
# session's own model with no CLI-routing gate, so a CLI-backed agent leaks onto
# the metered SDK there too:
#   - src/commitments/runtime.ts (commitments extraction)
#   - extensions/voice-call/src/response-generator.ts (voice response)
#   - extensions/llm-task/src/llm-task-tool.ts (llm-task tool)
#   - src/hooks/llm-slug-generator.ts + src/auto-reply/reply/conversation-label-generator.ts
#     (gate on the RAW provider, so they still leak when a session is CLI-pinned
#     via agentRuntimeOverride but the configured default is non-CLI)
# Fix each by routing through api.runtime.agent.runSessionAgentTurn (plugins) or the
# resolveCliExecutionProviderForSession + isCliProvider gate (core).
#
# Run: bash scripts/check-cli-routing.sh
# Exit non-zero on any regression.

set -e
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SEAM="src/auto-reply/reply/session-agent-turn.ts"
SEAM_TEST="src/auto-reply/reply/session-agent-turn.test.ts"
RECALL="extensions/active-memory/index.ts"
RECALL_TEST="extensions/active-memory/index.test.ts"

grep_repo() { git grep --untracked "$@"; }

fail=0

# Guard 1: the seam must gate on the RESOLVED CLI execution provider (not the raw
# model provider) and dispatch through the CLI runner. This is the whole fix.
for needle in resolveCliExecutionProviderForSession isCliProvider runCliAgentWithLifecycle; do
  if ! grep_repo -q "$needle" -- "$SEAM" 2>/dev/null; then
    echo "FAIL: $SEAM no longer references '$needle' — the CLI routing gate is missing."
    fail=1
  fi
done

# Guard 2: the seam must stay wired into the plugin SDK runtime contract so
# plugins reach it as api.runtime.agent.runSessionAgentTurn.
if ! grep_repo -q 'runSessionAgentTurn' -- src/plugins/runtime/types-core.ts src/plugins/runtime/runtime-agent.ts 2>/dev/null; then
  echo "FAIL: runSessionAgentTurn is not wired into the plugin runtime SDK (types-core.ts / runtime-agent.ts)."
  fail=1
fi

# Guard 3: active-memory recall must dispatch through the CLI-aware seam.
if ! grep_repo -q 'runtime\.agent\.runSessionAgentTurn' -- "$RECALL" 2>/dev/null; then
  echo "FAIL: $RECALL no longer routes recall through runSessionAgentTurn."
  fail=1
fi

# Guard 4 (negative): recall must NOT call the raw embedded SDK runner directly —
# that is the metered-billing leak this fix closes.
hits=$(grep_repo -nE 'runtime\.agent\.runEmbeddedAgent' -- "$RECALL" 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "FAIL: $RECALL calls runEmbeddedAgent directly — CLI-backed recall leaks onto the metered SDK path:"
  echo "$hits" | sed 's/^/  /'
  fail=1
fi

# Guard 5: pin the regression tests so the routing proof cannot be silently dropped.
if ! grep_repo -q 'runSessionAgentTurn' -- "$SEAM_TEST" 2>/dev/null; then
  echo "FAIL: $SEAM_TEST no longer covers runSessionAgentTurn CLI routing."
  fail=1
fi
if ! grep_repo -q 'runSessionAgentTurn' -- "$RECALL_TEST" 2>/dev/null; then
  echo "FAIL: $RECALL_TEST no longer covers recall routing through the CLI-aware seam."
  fail=1
fi

if [ $fail -eq 0 ]; then
  echo "OK: CLI-backed agent routing is guarded (recall -> runSessionAgentTurn -> CLI runtime)."
fi
exit $fail
