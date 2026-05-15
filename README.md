# openclaw-claude-agent-sdk-proxy

An OpenClaw `CliBackendPlugin` that replaces the built-in `claude-cli` backend
with the [Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview).
OpenClaw treats it as a first-class backend called `claude-agent-sdk`: it handles
all arg assembly, session management, MCP config, system prompt delivery, and
permission mode declaratively, while `proxy.mjs` is the thin subprocess that calls
the Agent SDK and streams JSONL back.

**What you get vs. the built-in backend:**

- Richer status events: `tool_use_start`, `tool_use_end`, and `session_start` alongside the standard stream
- Node.js-level error handling instead of shell watchdog restarts
- Native multi-turn streaming via the SDK's async-generator protocol
- Clean arg assembly via OpenClaw's `CliBackendConfig` - no manual CLI flag lists in `openclaw.json`

**What stays the same:**

- All OpenClaw session management, live sessions, MCP bridge, model selection, permission modes, and watchdogs
- The JSONL output format OpenClaw already parses (`claude-stream-json` dialect)
- The `claude-stdio` live session protocol
- Auth: reuses the `claude` login already configured in the addon

---

## How it works

```
┌─────────────────────────────────────────────────┐
│  OpenClaw gateway                                │
│                                                  │
│  CliBackendPlugin (index.mjs)                   │
│  - Registers backend id: "claude-agent-sdk"     │
│  - Declares CliBackendConfig:                   │
│      command, args, resumeArgs,                 │
│      modelArg, sessionIdFields,                 │
│      systemPromptFileArg, bundleMcp, ...        │
│  - normalizeConfig: injects --permission-mode   │
│  - resolveExecutionArgs: maps thinkingLevel     │
│    to --effort                                  │
└────────────────────┬────────────────────────────┘
                     │  spawns subprocess with
                     │  assembled CLI flags
                     v
┌─────────────────────────────────────────────────┐
│  proxy.mjs  (Node.js 22)                        │
│  - Parses 8 declared flags from argv            │
│  - Reads MCP config file (OpenClaw-generated)   │
│  - Reads system prompt file                     │
│  - Calls query() from Agent SDK                 │
│  - Streams all SDK messages to stdout as JSONL  │
│  - Emits extra system events (see below)        │
└────────────────────┬────────────────────────────┘
                     │  SDK internally spawns
                     v
┌─────────────────────────────────────────────────┐
│  @anthropic-ai/claude-agent-sdk                 │
│  - Manages the agent loop                       │
│  - Fires PreToolUse / PostToolUse hooks         │
└────────────────────┬────────────────────────────┘
                     │  spawns subprocess
                     v
┌─────────────────────────────────────────────────┐
│  claude  (CLI binary, already installed)        │
│  - Reads credentials from ~/.claude/            │
└─────────────────────────────────────────────────┘
```

### index.mjs - the plugin entry point

Loaded by OpenClaw at startup via the `"openclaw": { "extensions": ["./index.mjs"] }`
key in `package.json`. It calls `api.registerCliBackend()` with a full
`CliBackendConfig` so OpenClaw handles everything declaratively:

| Config field | What OpenClaw does |
|---|---|
| `modelArg: "--model"` | Appends `--model <value>` when the user selects a model |
| `systemPromptFileArg: "--append-system-prompt-file"` | Writes the system prompt to a temp file, passes its path |
| `bundleMcp: true` + `bundleMcpMode: "claude-config-file"` | Generates a Claude-format MCP config JSON file, passes its path via `--mcp-config` |
| `sessionIdFields: ["session_id"]` | Extracts the session ID from the JSONL stream |
| `sessionMode: "existing"` | Always attempts to resume; falls back to a fresh session |
| `liveSession: "claude-stdio"` | Keeps the process alive across turns |
| `input: "stdin"` | Delivers the prompt on stdin, not as a positional arg |
| `clearEnv: [...]` | Strips all OAuth/API-key env vars before spawning the subprocess |

Two hooks are also declared on the backend object:

- `normalizeConfig`: called once per session start. Reads `context.config.tools.exec`
  (the already-resolved permission settings from `openclaw.json`) and appends
  `--permission-mode bypassPermissions` or `--permission-mode acceptEdits` to `args`
  as appropriate.
- `resolveExecutionArgs`: called per turn. Maps the OpenClaw `thinkingLevel` setting
  to an `--effort` value and appends it to the args for that turn.

### proxy.mjs - the subprocess

Spawned by OpenClaw for each session (kept alive in live-session mode). It:

1. Parses exactly the 8 flags that `index.mjs` declares it will receive
2. Reads the MCP config file and system prompt file in parallel
3. Re-injects the OAuth token from `/run/claude-auth/oauth_token` if the file
   exists (Docker test environment only)
4. Calls `query({ prompt, options })` from the Agent SDK
5. Streams every SDK message to stdout as a JSONL line
6. Emits three extra system events (see [Extra events](#extra-events))

In **live-session mode** (`--input-format stream-json`), stdin is an async
generator of user-turn JSON lines that feeds directly into the SDK's
streaming-input protocol. The process stays alive until stdin closes.

In **per-turn mode** (the fallback), stdin is read to EOF as plain text, and the
process exits after the `result` line.

---

## Requirements

- OpenClaw `>=2026.5.12` (the `CliBackendPlugin` API)
- Node.js 22 (required by the Agent SDK; installed inside the HA addon)
- `claude` CLI installed and authenticated inside the addon (`claude auth login`)
- `@anthropic-ai/claude-agent-sdk ^0.3.142` (installed via `npm install`)

---

## Installation

### 1. Open the terminal

In Home Assistant: OpenClaw addon > Web UI terminal (default port 7681).

### 2. Copy the plugin files

From your local machine, in the `openclaw-claude-agent-sdk-proxy/` directory:

```bash
scp proxy.mjs index.mjs package.json openclaw.plugin.json \
    root@<HA-IP>:/config/claude-sdk-proxy/
```

Or use the HA file editor or SSH to create `/config/claude-sdk-proxy/` and paste
each file.

### 3. Install dependencies (inside the addon terminal)

```bash
cd /config/claude-sdk-proxy && npm install
```

This installs `@anthropic-ai/claude-agent-sdk` and `zod` into
`/config/claude-sdk-proxy/node_modules/`. The `/config/` directory persists
across addon updates, so this only needs to be done once.

### 4. Register the plugin with OpenClaw

```bash
openclaw plugins install /config/claude-sdk-proxy/
```

OpenClaw reads `package.json` for the `"openclaw"` extension field, loads
`index.mjs`, and registers the `claude-agent-sdk` CLI backend.

### 5. Update your model ref

```bash
nano /config/.openclaw/openclaw.json
```

Set (or add) the default model:

```json
{
  "agents": {
    "defaults": {
      "model": "claude-agent-sdk/claude-sonnet-4-6"
    }
  }
}
```

The format is `<backendId>/<modelName>`. Replace `claude-sonnet-4-6` with
whichever model you have access to. No `cliBackends` override is needed.

### 6. Restart OpenClaw

```bash
openclaw restart
```

Or restart the addon from the HA UI.

### 7. Verify

Send a message in the OpenClaw chat. You should see extra JSONL events in the
addon log (Supervisor > OpenClaw > Log):

```
{"type":"system","subtype":"session_start","session_id":"..."}
{"type":"system","subtype":"tool_use_start","tool_name":"Read","tool_input":{...}}
{"type":"system","subtype":"tool_use_end","tool_name":"Read","is_error":false}
```

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

That is the only required config change. OpenClaw injects `--model claude-sonnet-4-6`
into the subprocess args automatically via the `modelArg` declaration.

### Permission modes

Controlled by `tools.exec` in `openclaw.json`, same as the built-in backend.
The `normalizeConfig` hook maps these to `--permission-mode` flags:

| `tools.exec.security` | `tools.exec.ask` | Resulting flag |
|---|---|---|
| `"full"` | `"off"` | `--permission-mode bypassPermissions` |
| `"edits"` | any | `--permission-mode acceptEdits` |
| anything else | any | (no flag; claude handles permission prompting itself) |

### Thinking levels and effort

The `resolveExecutionArgs` hook maps OpenClaw's `thinkingLevel` setting to the
`--effort` flag passed to `proxy.mjs`:

| OpenClaw `thinkingLevel` | `--effort` value |
|---|---|
| `"minimal"` | `low` |
| `"low"` | `low` |
| `"medium"` | `medium` |
| `"high"` | `high` |
| `"xhigh"` | `xhigh` |
| `"adaptive"` | `high` |
| `"max"` | `max` |
| `"off"` | (no flag; SDK uses default reasoning budget) |

### MCP servers

MCP is configured via OpenClaw's standard MCP settings. Because `bundleMcp: true`
and `bundleMcpMode: "claude-config-file"` are set, OpenClaw generates a
Claude-format config file at runtime and passes its path to `proxy.mjs` via
`--mcp-config`. The proxy reads it and passes the `mcpServers` map directly to the
Agent SDK. No separate MCP configuration is needed in this plugin.

---

## Extra events

Beyond the standard `assistant` / `result` / `system` stream that the Agent SDK
produces, `proxy.mjs` emits three additional JSONL events:

### session_start

Emitted once per session (and once per turn in live-session mode) when the SDK's
`system/init` message is observed. The SDK's `SessionStart` JS hook callback is
silently skipped in subprocess mode, so this event is derived from the init message
instead.

```json
{
  "type": "system",
  "subtype": "session_start",
  "session_id": "sess_01AbCdEf..."
}
```

### tool_use_start

Emitted by the `PreToolUse` hook before each tool call.

```json
{
  "type": "system",
  "subtype": "tool_use_start",
  "tool_name": "Read",
  "tool_input": { "file_path": "/etc/hostname" }
}
```

### tool_use_end

Emitted by the `PostToolUse` hook after each tool call completes.

```json
{
  "type": "system",
  "subtype": "tool_use_end",
  "tool_name": "Read",
  "is_error": false
}
```

---

## Credential flow

OpenClaw's `CLEAR_ENV` list (declared in `index.mjs`) strips all OAuth and
API-key environment variables before spawning `proxy.mjs`. This mirrors the
behaviour of the built-in `claude-cli` backend and prevents stale ambient
credentials from shadowing OpenClaw-managed auth.

The Agent SDK then spawns the `claude` binary, which finds its credentials in
`~/.claude/` (file-based storage, the default on Linux/Home Assistant). No extra
credential plumbing is needed in a normal HA install.

**Docker test environment only:** `docker-e2e.sh` mounts the OAuth token at
`/run/claude-auth/oauth_token`. When `proxy.mjs` detects that file at startup, it
re-injects the token into the subprocess environment before calling the SDK. This
path is never reached in normal HA operation.

---

## Development and testing

All tests require Podman. On macOS, the test scripts read Claude credentials from
the macOS keychain (`security find-generic-password -s "Claude Code-credentials"`),
so `claude` must be logged in on the host before running them. Tests make real
Claude API calls.

### Build the image

The `Dockerfile` builds a `debian:bookworm-slim` image with Node.js 22 (via
NodeSource), the `claude` CLI, OpenClaw, and the plugin files. All three test
scripts build this image automatically.

### docker-qa.sh - integration and config checks

Runs six checks inside a single container, none of which require real API calls:

1. `openclaw plugins install /config/claude-sdk-proxy/` - verifies the plugin
   installs without errors
2. `import openclaw/plugin-sdk/plugin-entry` - verifies the OpenClaw peer
   dependency is loadable from Node
3. `tools.exec` key names - greps the compiled OpenClaw source to confirm the
   `context.config.tools.exec.security` and `.ask` field paths used in
   `normalizeConfig`
4. `normalizeConfig` context shape - greps `normalizeClaudeBackendConfig` from the
   built-in backend for comparison
5. Valid model IDs - greps the compiled constants for the model allowlist
6. `openclaw plugins list` - confirms `claude-agent-sdk` appears after install

```bash
./docker-qa.sh
```

### docker-test.sh - proxy integration tests (real API calls)

Extracts the OAuth token from the macOS keychain, builds the image, and runs
`test-harness.mjs` inside the container. The harness spawns `proxy.mjs` as a
subprocess and verifies its JSONL output for six test cases:

1. **per-turn basic**: sends a plain-text prompt, expects a `result` line
2. **live session single turn**: sends one `stream-json` turn, expects a `result` line
3. **live session two turns**: sends two turns sequentially, expects two `result` lines
4. **session_start emitted**: verifies `system/session_start` with a non-empty `session_id`
5. **tool hooks emitted**: sends a `Read /etc/hostname` prompt with `--permission-mode bypassPermissions`, verifies both `tool_use_start` and `tool_use_end`
6. **permission mode passthrough**: verifies the proxy accepts `--permission-mode acceptEdits` without error

```bash
./docker-test.sh
```

### docker-e2e.sh - full gateway end-to-end test

The most complete test. Builds the image, starts the OpenClaw gateway inside a
container, installs the plugin, sets the model to `claude-agent-sdk/claude-sonnet-4-6`,
and sends a `POST /v1/chat/completions` request asking Claude to reply with
`PONG`. The test passes if `PONG` appears in the response body.

Credential flow for this test: the OAuth token is extracted from the macOS keychain
and written to a temp file. That file is bind-mounted into the container at
`/run/claude-auth/oauth_token`. A wrapper script is also mounted at
`/usr/local/bin/claude` (earlier in `PATH` than the real binary) that reads the
token and re-exports it before exec-ing the real binary. This is necessary because
`CLEAR_ENV` strips the token from the subprocess environment.

```bash
./docker-e2e.sh
```

Exit code 0 means Claude responded via the Agent SDK. Non-zero means failure;
full container logs are printed.

---

## Rollback

Uninstall the plugin:

```bash
openclaw plugins uninstall claude-agent-sdk
```

Restore your original model ref in `/config/.openclaw/openclaw.json` (e.g.
`"claude-cli/claude-sonnet-4-6"`) and restart:

```bash
openclaw restart
```

No other files need to be changed.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Cannot find module '@anthropic-ai/claude-agent-sdk'` | `npm install` not run | `cd /config/claude-sdk-proxy && npm install` |
| `Cannot find package 'openclaw'` in index.mjs | OpenClaw peer symlink missing | Run `openclaw doctor --fix`; the gateway creates this symlink at startup |
| `claude: command not found` at startup | `claude` not on PATH when Node spawns the subprocess | Confirm the addon has `claude` installed; or set `pathToClaudeCodeExecutable` to an absolute path in `proxy.mjs` |
| Session never resumes after restart | Backend not selected as default model | Confirm `openclaw.json` `agents.defaults.model` uses `claude-agent-sdk/...` |
| Plugin not appearing in `openclaw plugins list` | `package.json` missing `"openclaw"` key | Verify the file has `"openclaw": { "extensions": ["./index.mjs"] }` |
| `zod` peer dependency warnings | `zod v4` not found | `npm install zod@^4` in `/config/claude-sdk-proxy/` |
| No extra events in addon log | Plugin not active | Check that the model ref uses `claude-agent-sdk/` prefix, not `claude-cli/` |
| `Not logged in` error from claude binary | CLEAR_ENV stripped the token and no token file present | On HA: run `claude auth login` inside the addon terminal. For Docker tests: confirm `/run/claude-auth/oauth_token` is mounted |
| `bypassPermissions` not taking effect | `normalizeConfig` not receiving the right `tools.exec` shape | Verify `openclaw.json` has `tools.exec.security` and `tools.exec.ask` set at the top level (or per-agent); check the addon log for the resolved config |

---

## How it differs from the built-in claude-cli backend

| Aspect | Built-in `claude-cli` | This plugin (`claude-agent-sdk`) |
|---|---|---|
| Subprocess management | OpenClaw shells out to the `claude` binary directly | OpenClaw shells out to `proxy.mjs`, which calls the Agent SDK, which then spawns `claude` |
| Error handling | Shell watchdog restarts the process on failure | Node.js async error propagation; the SDK manages the agent loop |
| Status events | Standard `assistant` / `result` / `system` stream | Same stream, plus `tool_use_start`, `tool_use_end`, `session_start` |
| Arg assembly | `openclaw.json` `cliBackends` array (manual flag list) | Declared in `CliBackendConfig` fields; OpenClaw assembles args automatically |
| Permission mode | Passed via `cliBackends` args list | Injected by `normalizeConfig` hook based on `tools.exec` settings |
| Thinking / effort | Passed via `cliBackends` args list | Mapped by `resolveExecutionArgs` hook from `thinkingLevel` |
| MCP config | OpenClaw generates the file; path passed via configured arg | `bundleMcp: true` + `bundleMcpMode: "claude-config-file"` declare this declaratively |
| Node.js version required | None (binary is standalone) | Node.js 22 |
| Additional dependency | None | `@anthropic-ai/claude-agent-sdk`, `zod` |
