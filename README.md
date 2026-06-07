# openclaw-claude-agent-sdk-proxy

An OpenClaw plugin with two components:

1. **`proxy.mjs`** — a `CliBackendPlugin` that replaces the built-in `claude-cli` backend with the [Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). Used for Discord and other conversational channels.

2. **`http-server.mjs`** — an OpenAI-compatible HTTP bridge (`POST /v1/chat/completions`) that lets OpenClaw's embedded runner and HA's voice assistant reach the Agent SDK via the `claude-agent-sdk` HTTP provider at `http://127.0.0.1:18791`.

**What you get vs. the built-in backend:**

- Richer status events: `tool_use_start`, `tool_use_end`, and `session_start` alongside the standard stream
- Node.js-level error handling instead of shell watchdog restarts
- Direct Discord delivery with in-place message editing (responses grow in-place, no duplicate messages)
- Tool-use keepalive so OpenClaw's stdout reader never times out on long tool calls
- Automatic turn-timeout at 4.5 min with a clean cutoff notice instead of a silent SIGKILL
- OpenAI-compatible HTTP endpoint for voice assistant and embedded agent calls
- Self-managed session continuity via `chat-sessions.json` (survives addon restarts)

**What stays the same:**

- All OpenClaw session management, MCP bridge, model selection, and permission modes
- The JSONL output format OpenClaw already parses (`claude-stream-json` dialect)
- Auth: reuses the `claude` login already configured in the addon

---

## Architecture

```
Discord / voice assistant
        │
        ▼
┌─────────────────────────────────────────────────┐
│  OpenClaw gateway                               │
│                                                 │
│  For conversational channels (Discord, etc.):   │
│  CliBackendPlugin (index.mjs)                   │
│  - Registers backend id: "claude-agent-sdk"     │
│  - Declares CliBackendConfig:                   │
│      model, system-prompt, MCP config,          │
│      permission mode, session fields            │
└────────────────┬────────────────────────────────┘
                 │  spawns subprocess per turn
                 ▼
┌─────────────────────────────────────────────────┐
│  proxy.mjs  (Node.js 22, per-turn subprocess)  │
│                                                 │
│  - Calls query() from Agent SDK                 │
│  - Streams all SDK messages to stdout as JSONL  │
│  - Delivers Claude's text directly to Discord   │
│    via OpenClaw's edit-message API (in-place)   │
│  - Maintains session continuity via             │
│    chat-sessions.json (resume across turns)     │
│  - Tool keepalive: heartbeat every 8s during    │
│    long tool calls so OpenClaw doesn't time out │
│  - Turn-timeout at 4.5 min: edits Discord msg   │
│    with cutoff notice, emits NO_REPLY result    │
│    so OpenClaw suppresses raw-JSONL fallback    │
└────────────────┬────────────────────────────────┘
                 │  SDK internally spawns
                 ▼
┌─────────────────────────────────────────────────┐
│  @anthropic-ai/claude-agent-sdk                 │
│  - Manages the agent loop                       │
│  - Fires PreToolUse / PostToolUse hooks         │
└────────────────┬────────────────────────────────┘
                 │  spawns subprocess
                 ▼
┌─────────────────────────────────────────────────┐
│  claude  (bundled linux-x64 binary)             │
│  - Reads credentials from ~/.claude/            │
└─────────────────────────────────────────────────┘

For embedded runner / HA voice assistant:

OpenClaw HTTP provider ──POST /v1/chat/completions──▶ http-server.mjs
                                                           │
                                                           │  calls query()
                                                           ▼
                                                     Agent SDK → claude binary
```

---

## Components

### index.mjs — plugin entry point

Loaded by OpenClaw at startup via `"openclaw": { "extensions": ["./index.mjs"] }` in `package.json`. Calls `api.registerCliBackend()` with a full `CliBackendConfig`:

| Config field | What OpenClaw does |
|---|---|
| `modelArg: "--model"` | Appends `--model <value>` when the user selects a model |
| `systemPromptFileArg: "--append-system-prompt-file"` | Writes system prompt to a temp file, passes its path |
| `bundleMcp: true` + `bundleMcpMode: "claude-config-file"` | Generates a Claude-format MCP config JSON, passes path via `--mcp-config` |
| `sessionIdFields: ["session_id"]` | Extracts session ID from the JSONL stream |
| `input: "stdin"` | Delivers the prompt on stdin |
| `clearEnv: [...]` | Strips all OAuth/API-key env vars before spawning the subprocess |

Two hooks:

- **`normalizeConfig`**: upgrades `--permission-mode` to `bypassPermissions` when YOLO mode is active (`tools.exec.security: "full"` + `tools.exec.ask: "off"`).
- **`resolveExecutionArgs`**: maps OpenClaw's `thinkingLevel` to `--effort`.

### proxy.mjs — per-turn subprocess

Spawned by OpenClaw for each Discord/channel turn. It:

1. Reads the MCP config and system prompt files passed via flags
2. Loads its own session ID from `chat-sessions.json` for cross-restart continuity
3. Calls `query({ prompt, options })` from the Agent SDK
4. Streams all SDK messages to stdout as JSONL for OpenClaw
5. Delivers Claude's text directly to Discord via OpenClaw's edit-message API (growing in-place rather than posting new messages)
6. Sets `result: "NO_REPLY"` so OpenClaw suppresses its own Discord delivery
7. Emits tool keepalive heartbeats every 8s during tool execution to prevent OpenClaw stdout timeouts
8. On turn-timeout (4.5 min): edits the Discord message with a cutoff notice, then emits a synthetic `NO_REPLY` result — without this, OpenClaw falls back to dumping raw JSONL to Discord

### http-server.mjs — OpenAI-compatible HTTP bridge

A long-running HTTP server started by `start-http-server` and managed as a `localService` by OpenClaw. Listens on `http://127.0.0.1:18791`.

- Accepts `POST /v1/chat/completions` (OpenAI format, streaming or non-streaming)
- Runs the Agent SDK and returns an OpenAI-format response
- Used by OpenClaw's embedded runner and HA's voice assistant integration
- Maintains its own session continuity via `chat-sessions.json`
- Loads HA MCP servers from `/config/.mcporter/mcporter.json`

---

## Requirements

- OpenClaw `>=2026.5.12`
- Node.js 22 (installed inside the HA addon)
- `claude` CLI installed and authenticated inside the addon
- `@anthropic-ai/claude-agent-sdk ^0.3.142` (installed via `npm install`)

---

## Installation

See [INSTALL.md](./INSTALL.md) for step-by-step instructions.

---

## Updating

Once installed, pull the latest source files from GitHub and restart:

```bash
/config/claude-sdk-proxy/update-plugin.sh
```

This fetches from `main`, checks out the changed source files, and restarts the addon. Runtime files (`chat-sessions.json`, logs, `node_modules/`) are not touched.

---

## Configuration

### Model ref

```json
{
  "agents": {
    "defaults": {
      "model": "claude-agent-sdk/claude-sonnet-4-6"
    }
  }
}
```

### Permission modes

| `tools.exec.security` | `tools.exec.ask` | Resulting `--permission-mode` |
|---|---|---|
| `"full"` | `"off"` | `bypassPermissions` |
| anything else | any | `acceptEdits` (default) |

### Thinking levels and effort

| OpenClaw `thinkingLevel` | `--effort` value |
|---|---|
| `"minimal"` / `"low"` | `low` |
| `"medium"` | `medium` |
| `"high"` / `"adaptive"` | `high` |
| `"xhigh"` | `xhigh` |
| `"max"` | `max` |
| `"off"` | (no flag) |

---

## Extra JSONL events

Beyond the standard stream, `proxy.mjs` emits three additional events:

### `system/session_start`
```json
{ "type": "system", "subtype": "session_start", "session_id": "sess_01AbCdEf..." }
```

### `system/tool_use_start`
```json
{ "type": "system", "subtype": "tool_use_start", "tool_name": "Read", "tool_input": { "file_path": "/etc/hostname" } }
```

### `system/tool_use_end`
```json
{ "type": "system", "subtype": "tool_use_end", "tool_name": "Read", "is_error": false }
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find module '@anthropic-ai/claude-agent-sdk'` | `npm install` not run | `cd /config/claude-sdk-proxy && npm install` |
| `Cannot find package 'openclaw'` in index.mjs | OpenClaw peer symlink missing | Run `openclaw doctor --fix` |
| `claude: command not found` | `claude` not on PATH | Confirm the addon has `claude` installed |
| Session never resumes after restart | Backend not set as default | Confirm `openclaw.json` model uses `claude-agent-sdk/...` prefix |
| Raw JSON flooding Discord | Turn timed out without clean result | Fixed in v2.0+ — update via `update-plugin.sh` |
| OpenClaw fails to start with config error | Invalid key in `openclaw.json` browser profiles | Remove the invalid profile key; run `openclaw doctor --fix` |
| `zod` peer dependency warnings | `zod v4` not found | `npm install zod@^4` in `/config/claude-sdk-proxy/` |
| No extra events in addon log | Plugin not active | Check model ref uses `claude-agent-sdk/` prefix |
| `Not logged in` error | CLEAR_ENV stripped the token | Run `claude auth login` inside the addon terminal |

---

## Development and testing

All tests require Podman and a `claude` login on the host machine.

```bash
./docker-qa.sh      # integration and config checks (no API calls)
./docker-test.sh    # proxy JSONL tests (real API calls)
./docker-e2e.sh     # full gateway end-to-end test (real API calls)
```

---

## Rollback

```bash
openclaw plugins uninstall claude-agent-sdk
```

Restore your original model ref in `openclaw.json` and restart.
