#!/usr/bin/env bash
# docker-test.sh — Build the Docker image and run the proxy test harness.
# Uses podman as the container runtime (compatible with Docker CLI syntax).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="openclaw-proxy-test"

echo "==> Building Docker image: ${IMAGE_NAME}"
podman build -t "${IMAGE_NAME}" "${SCRIPT_DIR}"

# Extract the Claude OAuth access token from the macOS keychain so it can be
# passed into the Linux container as ANTHROPIC_API_KEY.  The container cannot
# access the macOS keychain directly.
echo ""
echo "==> Extracting Claude credentials from macOS keychain"
CLAUDE_CREDS_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
if [ -z "${CLAUDE_CREDS_JSON}" ]; then
  echo "ERROR: Could not read 'Claude Code-credentials' from keychain. Run 'claude login' first."
  exit 1
fi
ANTHROPIC_API_KEY=$(echo "${CLAUDE_CREDS_JSON}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['claudeAiOauth']['accessToken'])")
if [ -z "${ANTHROPIC_API_KEY}" ]; then
  echo "ERROR: Could not parse accessToken from keychain credentials."
  exit 1
fi
echo "   Credentials extracted successfully."

echo ""
echo "==> Running test harness inside container"
# Mount ~/.claude into the container user's home.
# Credentials are passed via ANTHROPIC_API_KEY (extracted from macOS keychain
# above) because the macOS keychain is not accessible inside the Linux container.
podman run --rm \
  -v "${HOME}/.claude:/home/claude/.claude:ro" \
  -e HOME=/home/claude \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  "${IMAGE_NAME}" \
  node /config/claude-sdk-proxy/test-harness.mjs
