# openclaw-claude-agent-sdk-plugin — Installation

Registers a first-class OpenClaw `CliBackendPlugin` that drives Claude Code via the
[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), plus an
OpenAI-compatible HTTP bridge for the HA voice assistant and embedded runner.

---

## 1. Open the terminal

In Home Assistant: **OpenClaw** addon > **Web UI terminal** (default port 7681).

---

## 2. Clone the plugin

```bash
git clone https://github.com/richardbowman/openclaw-agent-sdk-plugin.git \
    /config/claude-sdk-proxy
```

If `/config/claude-sdk-proxy/` already exists with files in it (previous manual install),
initialize it as a git repo instead:

```bash
cd /config/claude-sdk-proxy
git init
git remote add origin https://github.com/richardbowman/openclaw-agent-sdk-plugin.git
git fetch origin main
git checkout origin/main -- proxy.mjs index.mjs http-server.mjs package.json \
    openclaw.plugin.json start-http-server openclaw-config-patch.json
git checkout -b main
git reset origin/main
```

---

## 3. Install dependencies

```bash
cd /config/claude-sdk-proxy && npm install
```

Installs `@anthropic-ai/claude-agent-sdk` and `zod` into `node_modules/`.
The `/config/` directory persists across addon updates — this only needs to be done once
(or after a major dependency version bump).

---

## 4. Install the plugin

```bash
openclaw plugins install /config/claude-sdk-proxy/
```

OpenClaw reads `package.json` (for the `"openclaw"` extension field), loads `index.mjs`,
and registers the `claude-agent-sdk` CLI backend.

---

## 5. Configure openclaw.json

```bash
nano /config/.openclaw/openclaw.json
```

Add the HTTP provider and set it as the default model:

```json
{
  "models": {
    "providers": {
      "claude-agent-sdk": {
        "models": [
          {
            "id": "claude-haiku-4-5",
            "name": "Claude Haiku 4.5",
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-sonnet-4-6",
            "name": "Claude Sonnet 4.6",
            "input": ["text", "image"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 200000,
            "maxTokens": 64000
          }
        ],
        "baseUrl": "http://127.0.0.1:18791",
        "authHeader": false,
        "apiKey": "not-used",
        "localService": {
          "command": "/config/claude-sdk-proxy/start-http-server",
          "healthUrl": "http://127.0.0.1:18791/health",
          "readyTimeoutMs": 30000
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "claude-agent-sdk/claude-sonnet-4-6"
    }
  }
}
```

Adjust model IDs to whichever Claude models you have access to.

---

## 6. Restart OpenClaw

```bash
openclaw restart
```

Or restart the addon from the HA UI. OpenClaw will start `http-server.mjs` automatically
on first request via the `localService` config.

---

## 7. Verify

Send a message in the OpenClaw chat. You should see extra JSONL events in the addon log
(**Supervisor → OpenClaw → Log**):

```
{"type":"system","subtype":"session_start","session_id":"..."}
{"type":"system","subtype":"tool_use_start","tool_name":"Read","tool_input":{...}}
{"type":"system","subtype":"tool_use_end","tool_name":"Read","is_error":false}
```

And in the http-server log:

```bash
tail -f /config/claude-sdk-proxy/http-server.log
```

---

## Updating

Once installed, future updates are a single command run from the HA terminal:

```bash
/config/claude-sdk-proxy/update-plugin.sh
```

This fetches the latest `main` branch from GitHub, checks out the changed source files,
and restarts the addon. Runtime files (`chat-sessions.json`, logs, `node_modules/`) are
left untouched.

---

## Rollback

Uninstall the plugin and switch back to the built-in `claude-cli` backend:

```bash
openclaw plugins uninstall claude-agent-sdk
```

Restore your original model ref in `openclaw.json` (e.g. `"claude-cli/claude-sonnet-4-6"`)
and restart.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find module '@anthropic-ai/claude-agent-sdk'` | `npm install` not run | `cd /config/claude-sdk-proxy && npm install` |
| `Cannot find package 'openclaw'` in index.mjs | OpenClaw peer symlink missing | The gateway creates a symlink at startup; if it fails, run `openclaw doctor --fix` |
| `claude: command not found` at startup | `claude` not on PATH | Confirm the addon has `claude` installed |
| Session never resumes after restart | Backend not selected as default | Confirm `openclaw.json` model ref uses `claude-agent-sdk/...` |
| Raw JSON flooding Discord | Old version without turn-timeout fix | Run `update-plugin.sh` to pull v2.0+ |
| Plugin not appearing in OpenClaw backends | `package.json` missing `"openclaw"` key | Verify the file has `"openclaw": { "extensions": ["./index.mjs"] }` |
| `zod` peer dep warnings | `zod v4` not found | `npm install zod@^4` in `/config/claude-sdk-proxy/` |
| http-server not starting | `start-http-server` not executable | `chmod +x /config/claude-sdk-proxy/start-http-server` |
