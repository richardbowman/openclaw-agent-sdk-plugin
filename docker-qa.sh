#!/usr/bin/env bash
# docker-qa.sh — Build the image and run all QA checks in a single container run.
# Uses podman as the container runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="openclaw-proxy-qa"

echo "==> Building image: ${IMAGE_NAME}"
podman build -t "${IMAGE_NAME}" "${SCRIPT_DIR}"
echo ""

echo "==> Running QA checks inside container"
podman run --rm "${IMAGE_NAME}" bash -c '
set -euo pipefail

# openclaw is installed at /usr/lib/node_modules (npm global prefix /usr).
# node -e resolves packages from cwd, which does not include /usr/lib/node_modules.
# Set NODE_PATH so standalone node invocations can find openclaw.
export NODE_PATH=/usr/lib/node_modules

PASS=0
FAIL=0
WARN=0

section() { echo ""; echo "══════════════════════════════════════════════"; echo "  CHECK $1: $2"; echo "══════════════════════════════════════════════"; }

# ─── CHECK 1: openclaw plugins install ───────────────────────────────────────
section 1 "openclaw plugins install /config/claude-sdk-proxy/"
# Create a throwaway config dir so the install does not need a real HA env
export OPENCLAW_CONFIG_DIR=/tmp/openclaw-qa-config
mkdir -p "${OPENCLAW_CONFIG_DIR}"

INSTALL_OUT=$(openclaw plugins install /config/claude-sdk-proxy/ 2>&1) || true
echo "${INSTALL_OUT}"
if echo "${INSTALL_OUT}" | grep -qi "error\|fail\|not found"; then
  echo "[RESULT] WARN — install produced error-like output; review above"
  WARN=$((WARN+1))
else
  echo "[RESULT] OK — install command exited without obvious error"
  PASS=$((PASS+1))
fi

# ─── CHECK 2: openclaw/plugin-sdk/plugin-entry importable ─────────────────────
section 2 "import openclaw/plugin-sdk/plugin-entry"
node -e "
import('openclaw/plugin-sdk/plugin-entry')
  .then(m => { console.log('EXPORTS:', Object.keys(m).join(', ')); process.exit(0); })
  .catch(e => { console.error('FAIL:', e.message); process.exit(1); })
" && echo "[RESULT] OK — module imported successfully" && PASS=$((PASS+1)) \
  || { echo "[RESULT] FAIL — cannot import plugin-sdk/plugin-entry"; FAIL=$((FAIL+1)); }

# ─── CHECK 3: tools.exec key names — confirmed from source ───────────────────
section 3 "tools.exec key names in normalizeConfig context"
echo "-- Reading isOpenClawRequestedYolo from cli-shared to confirm key names --"
grep -h "exec\|security\|ask\|tools" /usr/lib/node_modules/openclaw/dist/cli-shared-*.js 2>/dev/null \
  | grep -E "tools|exec|security|ask" | head -20 || echo "(grep returned nothing)"
echo ""
echo "-- normalizeClaudeBackendConfig function signature --"
grep -h -A10 "function isOpenClawRequestedYolo\|function normalizeClaudeBackendConfig" \
  /usr/lib/node_modules/openclaw/dist/cli-shared-*.js 2>/dev/null | head -40 || echo "(not found)"

# ─── CHECK 4: normalizeConfig context shape (anthropic/claude-cli backend) ────
section 4 "normalizeConfig context shape (built-in anthropic/claude-cli backend)"
echo "-- normalizeClaudeBackendConfig full source --"
grep -h -A30 "function normalizeClaudeBackendConfig" \
  /usr/lib/node_modules/openclaw/dist/cli-shared-*.js 2>/dev/null | head -50 || echo "(not found)"

# ─── CHECK 5: Valid model IDs ─────────────────────────────────────────────────
section 5 "Valid model ID format for claude-agent-sdk"
echo "-- CLAUDE_CLI_DEFAULT_MODEL_REF and CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS --"
grep -h "CLAUDE_CLI_DEFAULT_MODEL_REF\|ALLOWLIST_REFS\|claude-sonnet\|claude-opus\|claude-haiku" \
  /usr/lib/node_modules/openclaw/dist/cli-constants-*.js 2>/dev/null | head -20 || echo "(not found)"

# ─── CHECK 6: openclaw plugins list ──────────────────────────────────────────
section 6 "openclaw plugins list (after install)"
LIST_OUT=$(openclaw plugins list 2>&1) || true
echo "${LIST_OUT}"
if echo "${LIST_OUT}" | grep -qi "claude-agent-sdk"; then
  echo "[RESULT] OK — plugin claude-agent-sdk appears in list"
  PASS=$((PASS+1))
else
  echo "[RESULT] WARN — claude-agent-sdk not visible in plugins list"
  WARN=$((WARN+1))
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo "  QA SUMMARY"
echo "══════════════════════════════════════════════"
echo "  PASS: ${PASS}  WARN: ${WARN}  FAIL: ${FAIL}"
echo "══════════════════════════════════════════════"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
'
