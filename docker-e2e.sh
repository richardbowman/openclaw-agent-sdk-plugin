#!/usr/bin/env bash
# docker-e2e.sh — Build the image and run a real end-to-end test.
#
# Starts OpenClaw's gateway inside a Podman container with the claude-agent-sdk
# plugin installed, sends a live chat message through OpenClaw's HTTP API, and
# verifies Claude responds via the Agent SDK.
#
# Prerequisites:
#   - podman installed and running
#   - `claude` is already logged in on this Mac (credentials stored in keychain)
#   - The ANTHROPIC_API_KEY env var OR Claude Code OAuth credentials exist
#
# Usage:
#   ./docker-e2e.sh
#
# Exit codes:
#   0 — PASS (Claude responded with "PONG")
#   1 — FAIL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="openclaw-proxy-e2e"
CONTAINER_NAME="openclaw-e2e-$$"
GATEWAY_PORT=13000
GATEWAY_URL="http://localhost:${GATEWAY_PORT}"
TMPDIR_HOST="$(mktemp -d)"

cleanup() {
  echo ""
  echo "==> Cleaning up"
  podman rm -f "${CONTAINER_NAME}" 2>/dev/null || true
  rm -rf "${TMPDIR_HOST}"
}
trap cleanup EXIT

# ─── Step 1: Extract credentials from macOS keychain ─────────────────────────
echo "==> Extracting Claude credentials from macOS keychain"

OAUTH_TOKEN=""

# Try keychain first (claude CLI stores creds here on macOS)
KEYCHAIN_JSON=""
KEYCHAIN_JSON="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)"

if [ -n "${KEYCHAIN_JSON}" ]; then
  # The keychain value is a JSON blob with claudeAiOauth.accessToken
  OAUTH_TOKEN="$(printf '%s' "${KEYCHAIN_JSON}" | node -e "
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => {
      try {
        const obj = JSON.parse(Buffer.concat(chunks).toString());
        const tok = obj?.claudeAiOauth?.accessToken ?? obj?.oauth_token ?? obj?.access_token ?? '';
        process.stdout.write(tok);
      } catch { process.stdout.write(''); }
    });
  " 2>/dev/null || true)"
fi

# Fall back to ANTHROPIC_API_KEY if no OAuth token
USE_API_KEY=false
if [ -z "${OAUTH_TOKEN}" ]; then
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "   No OAuth token in keychain — will use ANTHROPIC_API_KEY"
    USE_API_KEY=true
  else
    echo "FAIL: No Claude credentials found."
    echo "      Run 'claude auth login' on this Mac, or set ANTHROPIC_API_KEY."
    exit 1
  fi
else
  echo "   Found OAuth token (length ${#OAUTH_TOKEN})"
fi

# Write the token to a temp file that gets bind-mounted into the container
TOKEN_FILE="${TMPDIR_HOST}/oauth_token"
printf '%s' "${OAUTH_TOKEN}" > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}"

# ─── Step 2: Build the image ──────────────────────────────────────────────────
echo ""
echo "==> Building image: ${IMAGE_NAME}"
podman build -t "${IMAGE_NAME}" "${SCRIPT_DIR}"

# ─── Step 3: Create the claude wrapper script ─────────────────────────────────
# CLEAR_ENV in index.mjs strips CLAUDE_CODE_OAUTH_TOKEN before proxy.mjs runs,
# so the claude binary (spawned by the Agent SDK) has no auth.  We mount a
# wrapper at /usr/local/bin/claude (earlier in PATH than /usr/bin/claude) that
# reads the token from the mounted file and injects it into the environment
# before calling the real binary.
WRAPPER_SCRIPT="${TMPDIR_HOST}/claude-wrapper"
cat > "${WRAPPER_SCRIPT}" << 'WRAPPER_EOF'
#!/usr/bin/env bash
# Injected by docker-e2e.sh.  Reads the OAuth token from a mounted file and
# re-exports it before calling the real claude binary.
# The real binary is at /usr/bin/claude (npm global install location in the image).
TOKEN_FILE="/run/claude-auth/oauth_token"
if [ -f "${TOKEN_FILE}" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "${TOKEN_FILE}")"
fi
exec /usr/bin/claude "$@"
WRAPPER_EOF
chmod +x "${WRAPPER_SCRIPT}"

# ─── Step 4: Start the container ──────────────────────────────────────────────
echo ""
echo "==> Starting container"

API_KEY_ARG=""
if [ "${USE_API_KEY}" = "true" ]; then
  API_KEY_ARG="-e ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
fi

# shellcheck disable=SC2086
podman run -d \
  --name "${CONTAINER_NAME}" \
  -p "${GATEWAY_PORT}:3000" \
  -v "${TOKEN_FILE}:/run/claude-auth/oauth_token:ro" \
  -v "${WRAPPER_SCRIPT}:/usr/local/bin/claude:ro" \
  -e "OPENCLAW_GATEWAY_TOKEN=e2e-test-token" \
  ${API_KEY_ARG} \
  "${IMAGE_NAME}" \
  bash -c '
set -euo pipefail

export OPENCLAW_CONFIG_DIR=/tmp/openclaw-e2e

# ── Bootstrap baseline config (sets gateway.mode=local) ───────────────────
openclaw onboard --mode local --non-interactive --accept-risk --skip-health 2>&1 | tail -5

# ── Plugin install ──────────────────────────────────────────────────────────
openclaw plugins install /config/claude-sdk-proxy/ 2>&1 | tail -5

# ── Configure gateway ───────────────────────────────────────────────────────
# Enable chatCompletions HTTP endpoint
openclaw config set "gateway.http.endpoints.chatCompletions.enabled" "true"

# Set the default model to our backend
openclaw config set "agents.defaults.model" "claude-agent-sdk/claude-sonnet-4-6"

# ── Start gateway ────────────────────────────────────────────────────────────
# OPENCLAW_GATEWAY_TOKEN is set in the container env to "e2e-test-token".
# --bind auto  : in a container this binds to 0.0.0.0 (port-forward compatible)
# --port 3000  : fixed port
exec openclaw gateway run \
  --bind auto \
  --port 3000 \
  2>&1
'

# ─── Step 5: Wait for gateway to be ready ────────────────────────────────────
echo ""
echo "==> Waiting for gateway to be ready on port ${GATEWAY_PORT}"

MAX_WAIT=60
ELAPSED=0
READY=false

while [ "${ELAPSED}" -lt "${MAX_WAIT}" ]; do
  HTTP_STATUS="$(curl -s -o /dev/null -w "%{http_code}" "${GATEWAY_URL}/health" 2>/dev/null || true)"
  if [ "${HTTP_STATUS}" = "200" ]; then
    READY=true
    echo "   Gateway ready (${ELAPSED}s)"
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf "."
done
echo ""

if [ "${READY}" = "false" ]; then
  echo ""
  echo "FAIL: Gateway did not become ready within ${MAX_WAIT}s"
  echo ""
  echo "==> Container logs:"
  podman logs "${CONTAINER_NAME}" 2>&1 | tail -50
  exit 1
fi

# ─── Step 6: Show gateway startup logs ───────────────────────────────────────
echo ""
echo "==> Gateway startup logs:"
podman logs "${CONTAINER_NAME}" 2>&1 | head -30

# ─── Step 7: Send the test message ────────────────────────────────────────────
echo ""
echo "==> Sending test message"

RESPONSE_FILE="${TMPDIR_HOST}/response.json"
HTTP_CODE="$(curl -s -w "\n%{http_code}" \
  -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer e2e-test-token" \
  -d '{"model":"openclaw","messages":[{"role":"user","content":"Reply with just the word PONG and nothing else."}],"stream":false}' \
  --max-time 120 \
  -o "${RESPONSE_FILE}" \
  2>/dev/null || true)"
HTTP_CODE="$(echo "${HTTP_CODE}" | tail -1)"

echo "   HTTP status: ${HTTP_CODE}"

# ─── Step 8: Evaluate the response ────────────────────────────────────────────
echo ""
echo "==> Response body:"
if [ -f "${RESPONSE_FILE}" ]; then
  cat "${RESPONSE_FILE}"
  echo ""
fi

echo ""
echo "==> Gateway logs after request:"
podman logs "${CONTAINER_NAME}" 2>&1 | grep -i "claude-agent-sdk\|session_start\|tool_use\|cli argv\|error\|FAIL" | tail -30 || true

# Check for PONG in response
PASS=false
if [ -f "${RESPONSE_FILE}" ]; then
  CONTENT="$(node -e "
    const fs = require('fs');
    try {
      const body = fs.readFileSync('${RESPONSE_FILE}', 'utf8');
      const obj = JSON.parse(body);
      // OpenAI-compat format: choices[0].message.content
      const text = obj?.choices?.[0]?.message?.content ?? obj?.content ?? '';
      process.stdout.write(text);
    } catch(e) { process.stdout.write(''); }
  " 2>/dev/null || true)"

  echo ""
  echo "==> Extracted content: '${CONTENT}'"

  if echo "${CONTENT}" | grep -qi "PONG"; then
    PASS=true
  fi
fi

echo ""
echo "══════════════════════════════════════════"
if [ "${PASS}" = "true" ]; then
  echo "  RESULT: PASS"
  echo "  Claude responded via the Agent SDK."
else
  echo "  RESULT: FAIL"
  echo "  HTTP status: ${HTTP_CODE}"
  echo "  Expected 'PONG' in response content."
  echo ""
  echo "==> Full container logs:"
  podman logs "${CONTAINER_NAME}" 2>&1 | tail -60
fi
echo "══════════════════════════════════════════"

[ "${PASS}" = "true" ]
