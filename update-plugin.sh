#!/bin/sh
# Update the claude-agent-sdk plugin from GitHub and restart the addon.
# Run this from the HA host to deploy new code.
set -e

PLUGIN_DIR="/addon_configs/17e0cc66_openclaw_assistant/claude-sdk-proxy"
cd "$PLUGIN_DIR"

echo "Fetching latest from GitHub..."
git fetch origin main

echo "Checking out source files..."
git checkout origin/main -- proxy.mjs index.mjs http-server.mjs package.json openclaw.plugin.json start-http-server openclaw-config-patch.json

echo "Restarting addon..."
ha apps restart 17e0cc66_openclaw_assistant

echo "Done! Plugin updated to:"
git log --oneline origin/main -1
