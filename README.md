# openclaw-claude-agent-sdk-proxy

An OpenClaw plugin that routes all agent traffic — Discord, voice, webchat, HA
conversation, cron — through a local HTTP server backed by the
[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).

The plugin registers `claude-agent-sdk` as an **HTTP provider** in OpenClaw
(not a CLI backend). OpenClaw calls `POST http://127.0.0.1:18791/v1/chat/completions`
for every turn; `http-server.mjs` handles session stitching and calls the Agent SDK.

> **Note:** `proxy.mjs` and the `buildBackend()` function in `index.mjs` are
> preserved but dormant. The `registerCliBackend` call is commented out.
> To revert to the CLI backend path, uncomment it and update `openclaw.json`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  OpenClaw gateway                                        │
│                                                          │
│  All channels: Discord · voice · webchat · cron · HA    │
│  Model ref: "claude-agent-sdk/claude-sonnet-4-6"        │
│  Provider type: HTTP  (models.providers["claude-agent-  │
│                         sdk"].baseUrl = :18791)          │
└──────────────────────────┬──────────────────────────────┘
                           │  POST /v1/chat/completions
                           │  { model, messages[], stream }
                           v
┌─────────────────────────────────────────────────────────┐
│  http-server.mjs  (Node.js 22, port 18791)              │
│                                                          │
│  1. Derive chat_id from request:                        │
│       body.user  →  embedded JSON block  →  sys-hash    │
│  2. Load session from chat-sessions.json                │
│  3. Read OAuth token from /config/.claude/.credentials  │
│  4. Read HA MCP from /config/.mcporter/mcporter.json    │
│  5. query({ prompt: lastUserMsg, options: { resume,     │
│              mcpServers, model, ... } })                 │
│  6. Stream/return response as OpenAI format             │
│  7. Save new session_id to chat-sessions.json           │
└──────────────────────────┬──────────────────────────────┘
                           │  SDK spawns subprocess
                           v
┌─────────────────────────────────────────────────────────┐
│  @anthropic-ai/claude-agent-sdk                         │
│  - Manages agent loop + native session compaction       │
│  - Fires tool calls against HA MCP (mcp__HA__*)         │
└──────────────────────────┬──────────────────────────────┘
                           │  spawns
                           v
┌─────────────────────────────────────────────────────────┐
│  claude  (bundled linux-x64 binary in node_modules)     │
│  - Auth via CLAUDE_CODE_OAUTH_TOKEN env var             │
└─────────────────────────────────────────────────────────┘
```

### localService auto-start

`openclaw.json` declares a `localService` on the provider:

```json
"localService": {
  "command": "/config/claude-sdk-proxy/start-http-server",
  "healthUrl": "http://127.0.0.1:18791/health",
  "readyTimeoutMs": 30000
}
```

OpenClaw starts `http-server.mjs` automatically on the first request and keeps
it alive. The process must be listening and returning `200` on `/health` within
30 seconds or OpenClaw marks the provider unhealthy.

`start-http-server` is a thin shell wrapper that logs node version and exec's
the server, redirecting both stdout and stderr to `http-server.log`.

---

## Session management

OpenClaw sends a **full conversation history** (all prior messages) in each
HTTP request, exactly like a stateless OpenAI API. We deliberately ignore that
history and instead maintain our own session continuity:

- **Last user message only** is passed as `prompt` to `query()`.
- **`resume: sessionId`** causes the Agent SDK to reload the prior context from
  Anthropic's servers, so Claude has full history without us replaying it.
- **`chat-sessions.json`** maps a stable `chat_id` → `{ sessionId, ts }`.

### Session key derivation

For each request, a stable conversation key is derived in priority order:

| Priority | Source | Example key |
|---|---|---|
| 1 | `body.user` field | `user:abc123` |
| 2 | `chat_id` in fenced JSON block inside any message | `channel:150591...` |
| 3 | MD5 of first 100 chars of system message | `http:5e760a20` |
| 4 | Fallback | `http:default` |

The system-prompt hash (priority 3) is stable per agent configuration, so each
OpenClaw agent gets a consistent session even when no explicit ID is provided.

### Session TTLs

| Key prefix | TTL |
|---|---|
| `voice:*` | 30 minutes |
| everything else | 4 hours |

### Compaction

**OpenClaw's own compaction is disabled** — `agents.defaults.compaction.maxActiveTranscriptBytes: 0`
means OpenClaw never triggers a compaction call. This is intentional:

- OpenClaw's compaction would grow the HTTP payload over time, but since we
  discard the messages array anyway, payload size is irrelevant.
- There is no "truncate without compact" option in OpenClaw's config surface.
  Even if there were, it would not help us — we never read past the last message.
- **Claude's native compaction** (SDK `compact_boundary` event) runs transparently
  inside the Agent SDK when a session grows too long. The session ID is preserved;
  our code captures it from both `system/init` and `result/success` events, so
  session stitching survives a compaction boundary automatically.

**Result:** Do not enable OpenClaw compaction for this provider. Leave
`maxActiveTranscriptBytes: 0`. Let the Agent SDK manage compaction natively.

---

## MCP servers

The HTTP server loads a static MCP config from `/config/.mcporter/mcporter.json`:

```json
{
  "mcpServers": {
    "HA": {
      "baseUrl": "http://localhost:8123/api/mcp",
      "headers": { "Authorization": "Bearer <long-lived-token>" }
    }
  }
}
```

Each server is re-expressed as `{ type: "http", url, headers }` for the Agent
SDK. Tool names exposed to Claude are `mcp__HA__*`.

**Why not OpenClaw's dynamic MCP?** OpenClaw's own MCP server uses a dynamic
port and per-session auth tokens (env vars set by OpenClaw before spawning a CLI
backend). These are not available in HTTP provider mode — the request arrives
without those env vars. The static HA MCP gives Claude full Home Assistant tool
access without needing the OpenClaw MCP.

---

## Authentication

On each request, credentials are read from disk in priority order:

1. `/run/claude-auth/oauth_token` — Docker test environment only (bind-mounted
   by `docker-e2e.sh`).
2. `/config/.claude/.credentials.json` — standard HA location for Claude OAuth.
   Reads `claudeAiOauth.accessToken` and `refreshToken`.

If the access token is **expired**, `CLAUDE_CODE_OAUTH_TOKEN` is not set.
Instead, `CLAUDE_CONFIG_DIR=/config/.claude` is set, allowing the claude binary
to perform the OAuth refresh itself from the stored refresh token.

---

## Requirements

- OpenClaw `>=2026.5.22`
- Node.js 22 (available at `/usr/bin/node` inside the HA addon)
- Claude authenticated inside the addon (`/config/.claude/.credentials.json` present)
- `@anthropic-ai/claude-agent-sdk ^0.3.142` (installed via `npm install`)

---

## Installation

### 1. Copy files to the HA addon config

From your local machine:

```bash
scp http-server.mjs index.mjs proxy.mjs package.json openclaw.plugin.json \
    start-http-server \
    root@<HA-IP>:/addon_configs/17e0cc66_openclaw_assistant/claude-sdk-proxy/
```

Or use the HA file editor / SSH.

### 2. Install dependencies

Inside the addon terminal (`/config/` = the addon config dir):

```bash
cd /config/claude-sdk-proxy && npm install
```

### 3. Register the plugin

```bash
openclaw plugins install /config/claude-sdk-proxy/
```

### 4. Patch openclaw.json

Apply the additions from `openclaw-config-patch.json`. The two required sections are:

**`models.providers`** — registers the HTTP provider and localService:

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

**`agents.defaults.model`** — routes all agents through the HTTP provider:

```json
"agents": {
  "defaults": {
    "model": { "primary": "claude-agent-sdk/claude-sonnet-4-6" }
  }
}
```

### 5. Restart OpenClaw

```bash
ha addons restart 17e0cc66_openclaw_assistant
```

Or restart from the HA UI.

### 6. Verify

Check the server started:

```bash
tail -f /addon_configs/17e0cc66_openclaw_assistant/claude-sdk-proxy/http-server.log
```

You should see `[http-server] ... ready on http://127.0.0.1:18791` within a few
seconds of the first message, followed by `INFO query start` and `INFO result`
lines on each turn.

---

## Files

| File | Purpose |
|---|---|
| `http-server.mjs` | **Active.** HTTP server — Agent SDK bridge, session stitching, HA MCP |
| `start-http-server` | Shell wrapper for `localService.command` (logs to `http-server.log`) |
| `index.mjs` | Plugin entry. Registers HTTP provider config. CLI backend code preserved but disabled. |
| `proxy.mjs` | **Dormant.** Original CLI backend subprocess. Kept for reference / easy reactivation. |
| `package.json` | npm metadata + `"openclaw"` extension field |
| `openclaw.plugin.json` | OpenClaw plugin manifest |
| `openclaw-config-patch.json` | Reference patch for the two `openclaw.json` additions |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `http-server.log` not created / empty after restart | `start-http-server` not executable or wrong path | `chmod +x /config/claude-sdk-proxy/start-http-server` |
| `[http-server] ready` appears but health check fails | Server bound to wrong address | Confirm `HOST = "127.0.0.1"` and `PORT = 18791` in `http-server.mjs` |
| `Cannot find module '@anthropic-ai/claude-agent-sdk'` | `npm install` not run | `cd /config/claude-sdk-proxy && npm install` |
| Requests return `I ran into an error` | OAuth token expired or missing | Check `http-server.log` for `WARN auth:` lines; re-run `claude auth login` inside the addon |
| Session never resumes | Wrong session key — each request gets a fresh key | Check `DIAG chatId:` in log; ensure system prompt is stable or that `body.user` is set |
| Double responses in Discord | Occurs when `localService` health check fails → restart loop | Ensure `healthUrl` is the full absolute URL `http://127.0.0.1:18791/health`, not a path |
| proxy.mjs still being called | Plugin install dir has old `index.mjs` | Copy new `index.mjs` to `/config/.openclaw/extensions/claude-agent-sdk/` and restart |
| `mcp__HA__*` tools not available | `mcporter.json` missing or wrong path | Check `/config/.mcporter/mcporter.json` exists and has `mcpServers.HA.baseUrl` |
| Log lines appear twice | Old `http-server.mjs` with `process.stderr.write` + shell redirect | Deploy updated `http-server.mjs` and restart the server |

---

## Reverting to CLI backend

To re-enable the original `proxy.mjs` path:

1. In `index.mjs`, replace the empty `register(_api)` body with:
   ```js
   api.registerCliBackend(buildBackend());
   ```
2. Remove the `models.providers["claude-agent-sdk"]` block from `openclaw.json`.
3. Change `agents.defaults.model.primary` back to `"claude-agent-sdk/claude-sonnet-4-6"`
   (same model ref; OpenClaw will now route it via the CLI backend, not HTTP).
4. Copy updated `index.mjs` to the plugin install dir and restart.

---

## Development / testing

Tests require Podman and a logged-in `claude` on the host (credentials extracted
from the macOS keychain). All tests make real API calls.

```bash
./docker-qa.sh    # plugin install + config checks (no API calls)
./docker-test.sh  # proxy.mjs integration tests (real API, per-turn mode)
./docker-e2e.sh   # full gateway end-to-end: POST /v1/chat/completions → PONG
```

Note: `docker-test.sh` tests `proxy.mjs` (the dormant CLI backend path), not
`http-server.mjs`. An `http-server` test suite is not yet implemented.
