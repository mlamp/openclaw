#!/usr/bin/env bash
#
# Fork-local drift guard for Claude Code "out of extra usage" content-filter triggers.
#
# Background: docs/todo/OPENCLAW-CLAUDE-CLI-EXTRA-USAGE-BUG.md (kept in
# /Users/margus/_DEV/_TEMP/agent1-iac/docs/) catalogues exact-string phrases that
# cause Claude Code to fabricate 400 "out of extra usage" errors when found in
# system prompts. The fork has fork-local fixes for these. This script catches
# regressions before they ship by failing if any trigger phrase reappears in
# prompt-injected surfaces.
#
# Triggers checked:
#   1. "personal assistant" + "running inside OpenClaw" (compound)
#   2. literal HEARTBEAT_OK in prompt-injected files (system prompt, qqbot
#      template, AGENTS.md template). The constant in tokens.ts is intentionally
#      excluded (it stays "PULSE_ACK").
#   3. Schema tag "openclaw.inbound_meta.v1" or "openclaw.inbound_meta.v2"
#      (we use the defensive "oc.inbound_meta.v2" form).
#   4. compound "[[reply_to_current]]" + "stripped before sending" — upstream
#      already evades by using "stripped before user-visible rendering".
#
# Run: bash scripts/check-fork-triggers.sh
# Exit non-zero on any hit.

set -e
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail=0

# Trigger 1: compound "personal assistant" + "running inside OpenClaw" anywhere
# in source / extensions / templates.
hits=$(git grep -lE 'running inside OpenClaw' -- 'src/**' 'extensions/**' 'docs/reference/templates/**' 2>/dev/null | while read -r f; do
  if git grep -lE 'personal assistant' -- "$f" >/dev/null 2>&1; then
    echo "$f"
  fi
done)
if [ -n "$hits" ]; then
  echo "FAIL: Trigger 1 — files contain both 'personal assistant' and 'running inside OpenClaw':"
  echo "$hits" | sed 's/^/  /'
  fail=1
fi

# Trigger 2: literal HEARTBEAT_OK in prompt-injected surfaces. Whitelist:
# - src/auto-reply/heartbeat.ts comments are tolerated (not injected)
# - test files and CHANGELOG are tolerated
# - mocks/fixtures are tolerated
hits=$(git grep -nE 'HEARTBEAT_OK' -- \
  'src/agents/system-prompt.ts' \
  'extensions/qqbot/src/**' \
  'extensions/qqbot/skills/**' \
  'docs/reference/templates/**' \
  2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "FAIL: Trigger 2 — literal HEARTBEAT_OK in prompt-injected surface:"
  echo "$hits" | sed 's/^/  /'
  fail=1
fi

# Trigger 3: openclaw.inbound_meta.v[12] schema tag
hits=$(git grep -nE 'openclaw\.inbound_meta\.v[12]' -- 'src/**' 'test/**' 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "FAIL: Trigger 3 — openclaw.inbound_meta.vN schema tag (use oc.inbound_meta.v2):"
  echo "$hits" | sed 's/^/  /'
  fail=1
fi

# Trigger 4 guard: assert system-prompt.test.ts still pins the safe wording.
# If upstream ever drops that test, the wording can drift back into the trigger.
if ! git grep -q 'stripped before user-visible rendering' src/agents/system-prompt.test.ts 2>/dev/null; then
  echo "FAIL: Trigger 4 guard — src/agents/system-prompt.test.ts no longer pins 'stripped before user-visible rendering'."
  echo "  Upstream may have changed the reply-tag wording; verify it does not regress to 'stripped before sending'."
  fail=1
fi

if [ $fail -eq 0 ]; then
  echo "OK: no fork-local Claude CLI content-filter triggers detected."
fi
exit $fail
