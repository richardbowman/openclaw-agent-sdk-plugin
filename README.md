# openclaw-claude-agent-sdk-proxy

An OpenClaw plugin that routes all agent traffic through the
[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  OpenClaw gateway                                        │
│                                                          │
│  Discord · voice · webchat · HA conversation · cron     │
│    → CLI backend "claude-agent-sdk"                      │
│      (cron always uses CLI backend — hardcoded in OC)    │
└──────────────────────────┬──────────────────────────────┘
                           │  spawns subprocess per turn
                           v
┌─────────────────────────────────────────────────────────┐
│  proxy.mjs  (Node.js 22)                                │
│                                                          │
│  1. Parse OpenClaw argv (model, --resume, --mcp-config) │
│  2. Load OAuth token from /config/.claude/.credentials  │
│  3. Derive chat_id from stdin (Discord/cron metadata)   │
│  4. Load/save session from chat-sessions.json           │
│  5. Run Agent SDK query()                               │
│  6. Discord turns: auto-deliver text via OpenClaw MCP,  │
│     emit result=NO_REPLY to suppress re-deliver         │
│  7. Stream JSONL back to OpenClaw (claude-stream-json)  │
└──────────────────────────┬──────────────────────────────┘
                           │  SDK spawns subprocess
                           v
┌─────────────────────────────────────────────────────────┐
│  @anthropic-ai/claude-agent-sdk                         │
│  claude  (bundled linux-x64 binary in node_modules)     │
└─────────────────────────────────────────────────────────┘
```

### HTTP server (warm standby)

`http-server.mjs` runs on port 18791 as an OpenAI-compatible HTTP endpoint.
It is **not** used for normal routing — the CLI backend handles everything —
but is kept alive because:

- If the CLI backend registration is ever removed, OpenClaw falls back to the
  HTTP provider automatically (configured in `openclaw.json`).
- The OpenAI-compatible endpoint can be used by external tools.

**Auto-start:** `index.mjs` probes port 18791 on every plugin load (every
OpenClaw restart). If nothing is listening, it spawns `start-http-server`
immediately — the server is ready within ~3 seconds, independent of OpenClaw's
lazy `localService` trigger.

---

## Files

| File | Purpose |
|---|---|
| `index.mjs` | Plugin entry. Registers CLI backend + eager HTTP server spawn on plugin load. |
| `proxy.mjs` | **Active.** CLI backend subprocess — Agent SDK bridge, session stitching, Discord auto-delivery. |
| `http-server.mjs` | OpenAI-compat HTTP server on port 18791. Warm standby; auto-started by plugin on each OpenClaw restart. |
| `start-http-server` | Shell wrapper: execs `http-server.mjs`, redirects output to `http-server.log`. |
| `package.json` | npm metadata + `"openclaw"` extension field |
| `openclaw.plugin.json` | OpenClaw plugin manifest |
| `openclaw-config-patch.json` | Reference patch for the two `openclaw.json` additions |

---

## Session management (proxy.mjs)

OpenClaw spawns `proxy.mjs` as a subprocess for each turn (per-turn mode, no persistent process).

- **Last user message only** is passed as `prompt` to `query()`.
- **`--resume <sessionId>`** is passed by OpenClaw for resumed sessions; the Agent SDK reloads prior context from Anthropic's servers.
- **`chat-sessions.json`** maps `chat_id → { sessionId, ts }` so proxy.mjs can look up the resume ID when OpenClaw doesn't pass `--resume`.

### Discord delivery

For Discord turns, `proxy.mjs`:
1. Removes `mcp__openclaw__message` from the allowed tool list (Claude must not self-deliver).
2. Intercepts every assistant text block and delivers it directly to Discord via OpenClaw's MCP `message` tool (edit-in-place, growing the message as tokens stream in).
3. Emits `result=NO_REPLY` so OpenClaw does **not** re-deliver the result text as a second Discord message.

---

## Authentication

Credentials are read on each `proxy.mjs` invocation:

1. `/run/claude-auth/oauth_token` — Docker test environment only (bind-mounted by `docker-e2e.sh`).
2. `/config/.claude/.credentials.json` — standard HA location. Reads `claudeAiOauth.accessToken` + `refreshToken`.

If the token is expired, `CLAUDE_CONFIG_DIR=/config/.claude` is set so the claude binary refreshes via the stored refresh token.

---

## OpenClaw config (`openclaw.json` additions)

Two sections required. See `openclaw-config-patch.json` for the full patch.

**HTTP provider** (warm standby + triggers `localService` auto-start):
```json
"models": {
  "providers": {
    "claude-agent-sdk": {
      "models": [ ... ],
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
}
```

**Agent model** (routes all agents through this provider/backend):
```json
"agents": {
  "defaults": {
    "model": { "primary": "claude-agent-sdk/claude-sonnet-4-6" }
  }
}
```

---

## Installation

```bash
# 1. Copy files to HA addon config dir
scp index.mjs proxy.mjs http-server.mjs start-http-server package.json \
    openclaw.plugin.json \
    root@<HA-IP>:/addon_configs/17e0cc66_openclaw_assistant/claude-sdk-proxy/

# 2. Install dependencies
ssh root@<HA-IP> "cd /config/claude-sdk-proxy && npm install"

# 3. Register the plugin
ssh root@<HA-IP> "openclaw plugins install /config/claude-sdk-proxy/"

# 4. Apply openclaw-config-patch.json additions to openclaw.json

# 5. Restart OpenClaw
ha addons restart 17e0cc66_openclaw_assistant
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Cron jobs fail: `Unknown CLI backend: claude-agent-sdk` | Plugin not installed or `registerCliBackend` not called | Reinstall plugin, restart OpenClaw |
| Discord responds twice | `result=NO_REPLY` not emitted; OpenClaw re-delivers | Check proxy.log for `INFO result-fix:` line — if missing, capturedMsgText was not set |
| HTTP server not restarting after OpenClaw restart | Eager spawn not firing | Check http-server.log for `[plugin] register: probing port 18791` within 15s of restart |
| `auth: no OAuth token found` in proxy.log | Credentials missing or expired | Re-run `claude auth login` inside the addon terminal |
| Session never resumes | Wrong chat_id or stale chat-sessions.json | Check `DIAG chatId:` in proxy.log; inspect `/config/claude-sdk-proxy/chat-sessions.json` |

---

## Development / testing

Tests require Podman and a logged-in `claude` on the host.

```bash
./docker-qa.sh    # plugin install + config checks (no API calls)
./docker-test.sh  # proxy.mjs integration tests (real API)
./docker-e2e.sh   # full end-to-end: POST /v1/chat/completions → response
```
