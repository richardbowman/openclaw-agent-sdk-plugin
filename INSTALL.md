# openclaw-claude-agent-sdk-plugin — Installation

Registers a first-class OpenClaw `CliBackendPlugin` that drives Claude Code via the
[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) instead of
shelling out to the `claude` CLI directly.

**What you get:**
- Richer status events (`tool_use_start/end`, `session_start`, rate-limit warnings)
- Node.js-level error handling instead of shell watchdog restarts
- Native multi-turn streaming via the SDK's async-generator protocol
- Clean arg assembly via OpenClaw's `CliBackendConfig` — no CLI flag impersonation

**What stays the same:**
- All OpenClaw session management, MCP bridge, permission mode, model selection
- The JSONL output format OpenClaw already parses
- Auth: reuses the `claude` login already configured in the addon

---

## 1. Open the terminal

In Home Assistant: **OpenClaw** addon > **Web UI terminal** (default port 7681).

---

## 2. Copy the plugin files

On your **local machine**, from the `openclaw-claude-agent-sdk-proxy/` folder:

```bash
scp proxy.mjs index.mjs package.json openclaw.plugin.json \
    root@<HA-IP>:/config/claude-sdk-proxy/
```

Or use the HA file editor / SSH to create `/config/claude-sdk-proxy/` and paste each file.

---

## 3. Install dependencies (inside the addon terminal)

```bash
cd /config/claude-sdk-proxy && npm install
```

This installs `@anthropic-ai/claude-agent-sdk` into `/config/claude-sdk-proxy/node_modules/`.
The `/config/` directory persists across addon updates, so you only do this once.

---

## 4. Install the plugin

```bash
openclaw plugins install /config/claude-sdk-proxy/
```

OpenClaw reads `package.json` (for the `"openclaw"` extension field), loads `index.mjs`,
and registers the `claude-agent-sdk` CLI backend.

---

## 5. Restart OpenClaw

```bash
openclaw restart
```

Or restart the addon from the HA UI.

---

## 6. Set the default model (openclaw.json)

```bash
nano /config/.openclaw/openclaw.json
```

Add (or update) the default model ref to point at the new backend:

```json
{
  "agents": {
    "defaults": {
      "model": "claude-agent-sdk/claude-sonnet-4-6"
    }
  }
}
```

The model ref format is `<backendId>/<modelName>`. Replace `claude-sonnet-4-6` with
whichever Claude model you have access to. This is the only required config change —
there is no longer a `cliBackends` override needed.

---

## 7. Verify it's working

Send a message in the OpenClaw chat. You should see extra JSONL events in the addon log
(**Supervisor > OpenClaw > Log**):

```
{"type":"system","subtype":"session_start","session_id":"..."}
{"type":"system","subtype":"tool_use_start","tool_name":"Read","tool_input":{...}}
{"type":"system","subtype":"tool_use_end","tool_name":"Read","is_error":false}
```

---

## Rollback

Uninstall the plugin and switch back to the built-in `claude-cli` backend:

```bash
openclaw plugins uninstall claude-agent-sdk
```

Then restore your original model ref in `openclaw.json` and restart.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find module '@anthropic-ai/claude-agent-sdk'` | `npm install` not run | `cd /config/claude-sdk-proxy && npm install` |
| `Cannot find package 'openclaw'` in index.mjs | openclaw peer symlink missing | The gateway creates a symlink at startup; if it fails, run `openclaw doctor --fix` |
| `claude: command not found` at startup | `claude` not on PATH when Node spawns | Add `pathToClaudeCodeExecutable` absolute path in `proxy.mjs` or ensure `PATH` is set in the addon env |
| Session never resumes after restart | Backend not selected as default | Confirm `openclaw.json` model ref uses `claude-agent-sdk/...` |
| Plugin not appearing in OpenClaw backends | `package.json` missing `"openclaw"` key | Verify the file has `"openclaw": { "extensions": ["./index.mjs"] }` |
| `zod` peer dep warnings | `zod v4` not found | `npm install zod@^4` in `/config/claude-sdk-proxy/` |
