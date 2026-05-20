#!/usr/bin/env node
/**
 * openclaw-claude-agent-sdk-proxy / proxy.mjs
 *
 * Subprocess entry point for the "claude-agent-sdk" OpenClaw CliBackendPlugin.
 * Uses @anthropic-ai/claude-agent-sdk instead of the claude CLI, giving us:
 *   - Richer status/progress events (tool-use hooks, task updates)
 *   - Stable Node.js-level error handling instead of shell watchdogs
 *   - Native multi-turn streaming via the SDK's async-generator protocol
 *
 * ── How OpenClaw drives this process ─────────────────────────────────────────
 *
 * LIVE SESSION MODE  (triggered when OpenClaw detects claude-stdio liveSession):
 *   - Process is kept alive across turns (claude-stdio live session protocol)
 *   - Each user turn arrives as a JSON line on stdin:
 *       {"type":"user","session_id":"","parent_tool_use_id":null,
 *        "message":{"role":"user","content":"..."}}
 *   - We feed those directly into the SDK's streaming-input async generator
 *   - Output: continuous JSONL to stdout; each turn ends with a "result" line
 *
 * PER-TURN MODE  (fallback when not in live session):
 *   - A fresh process is spawned for every user turn
 *   - Prompt arrives as plain text on stdin (closed at EOF)
 *   - Session resumption via --resume <session-id>
 *   - Process exits after the result line
 *
 * ── Flags this proxy parses ───────────────────────────────────────────────────
 *
 * OpenClaw's CliBackendConfig (index.mjs) declares exactly what it passes here.
 * We only parse those declared flags; nothing else is accepted or silently ignored.
 *
 *   --model <model>                  SDK options.model
 *   --resume <sessionId>             SDK options.resume (resume an existing session)
 *   --allowed-tools <tools>          SDK options.allowedTools (comma or space separated)
 *   --append-system-prompt-file <p>  Loaded and appended to the system prompt
 *   --mcp-config <path>              Claude-format MCP config file (written by OpenClaw)
 *   --effort <level>                 SDK options.effort (low|medium|high|xhigh|max)
 *   --permission-mode <mode>         SDK options.permissionMode
 *   --input-format stream-json       Switches to live-session mode
 */

import { query }            from "@anthropic-ai/claude-agent-sdk";
import { createInterface }  from "readline";
import { readFile, writeFile, rename } from "fs/promises";
import { appendFileSync }   from "fs";

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

let model          = undefined;
let resumeId       = undefined;
let allowedTools   = ["mcp__openclaw__*"];
let syspromptFile  = undefined;
let permissionMode = undefined;
let effort         = undefined;
let mcpConfigFile  = undefined;
let isLiveSession  = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case "--model":
      model = argv[++i];
      break;
    case "--resume":
      resumeId = argv[++i];
      break;
    case "--allowed-tools":
      allowedTools = argv[++i].split(/[,\s]+/).filter(Boolean);
      break;
    case "--append-system-prompt-file":
      syspromptFile = argv[++i];
      break;
    case "--permission-mode":
      permissionMode = argv[++i];
      break;
    case "--effort":
      effort = argv[++i];
      break;
    case "--mcp-config":
      mcpConfigFile = argv[++i];
      break;
    case "--input-format":
      if (argv[i + 1] === "stream-json") {
        isLiveSession = true;
        i++;
      }
      break;
    // All other flags are intentionally rejected by being absent from the
    // switch. If OpenClaw passes an unexpected flag (e.g. due to a config
    // mismatch), it lands on an unknown key and is ignored. This is the
    // desired behaviour: fail loudly only when the SDK rejects a bad option,
    // not when an unrecognised flag appears in argv.
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

// OpenClaw doesn't forward subprocess stderr to its supervisor log, so we
// write to a file that can be tailed directly on the HA instance:
//   ssh root@rhome.local "tail -f /addon_configs/17e0cc66_openclaw_assistant/claude-sdk-proxy/proxy.log"
const LOG_FILE = "/config/claude-sdk-proxy/proxy.log";

/** Write a timestamped diagnostic line to stderr and the log file. Never throws. */
function log(msg) {
  try {
    const line = `[claude-agent-sdk-proxy] ${new Date().toISOString()} ${msg}\n`;
    process.stderr.write(line);
    appendFileSync(LOG_FILE, line);
  } catch { /* ignore write errors */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safely read a file, returning undefined on any error. */
async function tryReadFile(path) {
  if (!path) return undefined;
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (err) {
    log(`WARN tryReadFile("${path}"): ${err?.message ?? String(err)}`);
    return undefined;
  }
}

/**
 * Parse an MCP config file written by OpenClaw's bundleMcp mechanism.
 * Claude CLI format: { "mcpServers": { "name": { "command", "args", "env" } } }
 * Agent SDK mcpServers option uses the same shape.
 */
async function tryReadMcpConfig(path) {
  if (!path) return undefined;
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw.mcpServers ?? raw;
  } catch (err) {
    log(`WARN tryReadMcpConfig("${path}"): ${err?.message ?? String(err)}`);
    return undefined;
  }
}

/** Write a single JSONL line to stdout. */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ─── Session prune ────────────────────────────────────────────────────────────

const SESSIONS_FILE  = "/config/.openclaw/agents/main/sessions/sessions.json";
const PRUNE_STAMP    = "/config/claude-sdk-proxy/last-prune.txt";
const PRUNE_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
const HA_TOKEN_FILE  = "/config/secrets/homeassistant.token";
const HA_BASE_URL    = "http://172.30.32.1:8123";
const RESTART_AUTO   = "automation.openclaw_twice_daily_restart";

/**
 * Prune stale "agent:main:openai:<uuid>" entries from OpenClaw's sessions
 * file.  Runs at most once every 12 hours (guarded by a stamp file).  Writes
 * back atomically via a .tmp rename so OpenClaw never sees a torn file.
 *
 * After a successful prune, fires triggerAddonRestart() immediately
 * (fire-and-forget — does NOT wait for the current turn to finish).
 * We cannot wait for the turn: when sessions.list is degraded the turn
 * times out and the process is killed before the post-loop cleanup code
 * is ever reached.
 *
 * Called fire-and-forget at the start of each turn — never delays a request.
 */
async function pruneOldApiSessions() {
  try {
    // Throttle: skip if pruned recently.
    try {
      const stamp = await readFile(PRUNE_STAMP, "utf8");
      const last  = Number(stamp.trim());
      if (!Number.isNaN(last) && Date.now() - last < PRUNE_INTERVAL) return;
    } catch { /* stamp absent → first run */ }

    // Read and parse.
    let sessions;
    try {
      sessions = JSON.parse(await readFile(SESSIONS_FILE, "utf8"));
    } catch (err) {
      log(`WARN prune: could not read sessions file: ${err?.message ?? String(err)}`);
      return;
    }
    if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) {
      log("WARN prune: sessions file root is not a plain object — skipping");
      return;
    }

    // Delete all openai per-turn keys.
    const PREFIX = "agent:main:openai:";
    let removed = 0;
    for (const key of Object.keys(sessions)) {
      if (key.startsWith(PREFIX)) { delete sessions[key]; removed++; }
    }

    // Write back atomically.
    if (removed > 0) {
      const tmp = SESSIONS_FILE + ".tmp";
      try {
        await writeFile(tmp, JSON.stringify(sessions, null, 2) + "\n", "utf8");
        await rename(tmp, SESSIONS_FILE);
        log(`INFO prune: removed ${removed} openai session entries from sessions.json`);
        // Fire restart immediately — don't wait for the turn. When sessions.list
        // is degraded the turn times out and this process may be killed before
        // the post-loop cleanup block is ever reached.
        triggerAddonRestart(); // intentionally not awaited
      } catch (err) {
        log(`WARN prune: write failed: ${err?.message ?? String(err)}`);
        return; // Don't update stamp — prune didn't complete.
      }
    } else {
      log("INFO prune: no openai session entries found");
    }

    // Update stamp.
    try {
      await writeFile(PRUNE_STAMP, String(Date.now()), "utf8");
    } catch (err) {
      log(`WARN prune: could not update stamp file: ${err?.message ?? String(err)}`);
    }
  } catch (err) {
    log(`WARN prune: unexpected error: ${err?.message ?? String(err)}`);
  }
}

/**
 * Trigger the HA addon restart automation via the HA REST API.
 * Called fire-and-forget from pruneOldApiSessions() immediately after the
 * clean sessions file is written.  The automation handler calls
 * hassio.addon_restart, which takes a few seconds — by the time OpenClaw
 * actually stops it will have finished serving the current (or next) turn.
 */
async function triggerAddonRestart() {
  try {
    const token = (await readFile(HA_TOKEN_FILE, "utf8")).trim();
    const resp  = await fetch(`${HA_BASE_URL}/api/services/automation/trigger`, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ entity_id: RESTART_AUTO }),
    });
    log(`INFO prune: restart triggered (HTTP ${resp.status}) — clean sessions load on next startup`);
  } catch (err) {
    log(`WARN prune: could not trigger restart: ${err?.message ?? String(err)}`);
  }
}

// ─── Live-session stdin -> async generator ────────────────────────────────────
//
// OpenClaw writes user turns as JSON lines identical to SDKUserMessage:
//   {"type":"user","session_id":"","parent_tool_use_id":null,
//    "message":{"role":"user","content":"<text>"}}
//
// We yield these directly into the SDK's streaming-input generator.
// The SDK pauses between turns, so OpenClaw's JSONL turn-boundary
// detection (waiting for a "result" line) stays intact.

async function* liveSessionMessages() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t);
      if (msg?.type === "user") {
        yield msg;
      }
    } catch {
      // Skip malformed lines; don't crash the session.
    }
  }
}

// ─── Per-turn stdin: slurp until EOF ─────────────────────────────────────────

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Startup banner — visible in OpenClaw's CLI backend log on every turn.
  log(
    `starting: mode=${isLiveSession ? "live-session" : "per-turn"}` +
    ` model=${model ?? "(default)"}` +
    ` permissionMode=${permissionMode ?? "(default)"}` +
    ` effort=${effort ?? "(default)"}` +
    ` resume=${resumeId ?? "none"}`,
  );

  // Background maintenance: prune stale openai session keys from sessions.json.
  // Stored (not awaited yet) so it runs concurrently with the turn but we can
  // still await it after the response is streamed before checking the flag.
  const pruneTask = pruneOldApiSessions();

  // Kick off file reads in parallel before we start consuming stdin.
  const [mcpServers, appendSystemPrompt] = await Promise.all([
    tryReadMcpConfig(mcpConfigFile),
    tryReadFile(syspromptFile),
  ]);

  // Re-inject the OAuth token so the claude subprocess spawned by the Agent
  // SDK can authenticate.
  //
  // OpenClaw's CLEAR_ENV list strips CLAUDE_CODE_OAUTH_TOKEN (and
  // CLAUDE_CODE_OAUTH_REFRESH_TOKEN) before spawning this process, so
  // process.env has no auth credentials.  The Agent SDK passes
  // env: {...process.env} to the claude subprocess it spawns, which means
  // the subprocess also has no token and returns "Not logged in".
  //
  // We try two sources in order:
  //   1. /run/claude-auth/oauth_token  — well-known mount point used in
  //      docker-e2e.sh; takes precedence so docker tests still work.
  //   2. /config/.claude/.credentials.json — where OpenClaw stores the
  //      Claude OAuth credentials on Home Assistant.  We read accessToken,
  //      refreshToken, and expiresAt so the claude subprocess can
  //      auto-refresh an expired access token without needing a gateway
  //      restart.
  const TOKEN_FILE_PATH     = "/run/claude-auth/oauth_token";
  const HA_CREDENTIALS_PATH = "/config/.claude/.credentials.json";

  let oauthToken    = undefined;
  let refreshToken  = undefined;
  let tokenExpired  = false;
  let tokenSource   = "none";

  const dockerToken = await tryReadFile(TOKEN_FILE_PATH);
  if (dockerToken) {
    oauthToken  = dockerToken;
    tokenSource = "docker-mount";
  } else {
    try {
      const raw   = JSON.parse(await readFile(HA_CREDENTIALS_PATH, "utf8"));
      const creds = raw?.claudeAiOauth;
      if (creds?.accessToken) {
        oauthToken   = creds.accessToken;
        refreshToken = creds.refreshToken ?? undefined;
        tokenSource  = "ha-credentials";

        // Check expiry and flag for the env-building logic below.
        if (creds.expiresAt) {
          const msLeft = creds.expiresAt - Date.now();
          if (msLeft <= 0) {
            tokenExpired = true;
            log(`WARN auth: access token EXPIRED ${Math.round(-msLeft / 60000)} min ago — will use config-dir auth so claude can refresh`);
          } else if (msLeft < 10 * 60 * 1000) {
            log(`WARN auth: access token expires in ${Math.round(msLeft / 60000)} min`);
          }
        }

        if (!refreshToken) {
          log(`WARN auth: no refreshToken in credentials — cannot auto-refresh after expiry`);
        }
      } else {
        log(`WARN ha-credentials file parsed but claudeAiOauth.accessToken is missing or empty`);
      }
    } catch (err) {
      log(`WARN ha-credentials read failed ("${HA_CREDENTIALS_PATH}"): ${err?.message ?? String(err)}`);
    }
  }

  if (oauthToken) {
    log(`auth: token found via ${tokenSource} (length=${oauthToken.length})${refreshToken ? ", refreshToken present" : ""}${tokenExpired ? " [EXPIRED — falling back to config-dir auth]" : ""}`);
  } else {
    log(`WARN auth: no OAuth token found from any source — claude subprocess will likely fail to authenticate`);
  }

  // Build subprocess env.
  //
  // When the access token is valid: inject it directly so the subprocess
  // doesn't need to touch disk at all.
  //
  // When the access token is EXPIRED: do NOT inject it — passing a stale
  // CLAUDE_CODE_OAUTH_TOKEN causes a hard 401 even when CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  // is also present (the claude binary does not auto-refresh in that path).
  // Instead, point CLAUDE_CONFIG_DIR at the credentials file so the claude
  // binary reads the refresh token from disk and handles the OAuth refresh
  // flow itself.
  const subprocessEnv = {
    ...process.env,
    ...(!tokenExpired && oauthToken   && { CLAUDE_CODE_OAUTH_TOKEN:         oauthToken }),
    ...(!tokenExpired && refreshToken && { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken }),
    ...(tokenExpired                  && { CLAUDE_CONFIG_DIR: "/config/.claude" }),
  };

  // Prefer the claude binary bundled in our own node_modules by the
  // @anthropic-ai/claude-agent-sdk-linux-x64 optional dependency. This
  // avoids depending on PATH, which may resolve to an older/incompatible
  // system binary if the openclaw npm package is absent from
  // /config/.node_global. Fall back to "claude" (PATH) only if the
  // bundled binary is somehow missing.
  const __proxyDir = new URL(".", import.meta.url).pathname;
  const bundledClaudePath =
    `${__proxyDir}node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`;
  let resolvedClaudePath;
  try {
    const { statSync } = await import("fs");
    statSync(bundledClaudePath);
    resolvedClaudePath = bundledClaudePath;
    log(`INFO using bundled claude binary: ${bundledClaudePath}`);
  } catch {
    resolvedClaudePath = "claude";
    log(`WARN bundled claude binary not found, falling back to PATH`);
  }

  const options = {
    pathToClaudeCodeExecutable: resolvedClaudePath,

    allowedTools,
    settingSources: ["user"],
    env: subprocessEnv,

    ...(model             && { model }),
    ...(resumeId          && { resume:         resumeId }),
    ...(permissionMode    && { permissionMode }),
    ...(effort            && { effort }),
    ...(mcpServers        && { mcpServers }),
    ...(appendSystemPrompt && {
      systemPrompt: {
        type:   "preset",
        preset: "claude_code",
        append: appendSystemPrompt,
      },
    }),

    // ── Enriched status hooks ──────────────────────────────────────────────
    // These emit extra JSONL lines alongside the standard assistant/result
    // stream so OpenClaw can surface tool progress in its UI.
    hooks: {
      PreToolUse: [{
        matcher: ".*",
        hooks: [async (ctx) => {
          emit({
            type:       "system",
            subtype:    "tool_use_start",
            tool_name:  ctx?.tool_name  ?? ctx?.toolName  ?? "tool",
            tool_input: ctx?.tool_input ?? ctx?.toolInput ?? undefined,
          });
          return {};
        }],
      }],

      PostToolUse: [{
        matcher: ".*",
        hooks: [async (ctx) => {
          const isError = ctx?.response?.is_error ?? ctx?.response?.isError ?? false;
          emit({
            type:      "system",
            subtype:   "tool_use_end",
            tool_name: ctx?.tool_name ?? ctx?.toolName ?? "tool",
            is_error:  Boolean(isError),
          });
          return {};
        }],
      }],
    },
  };

  // NOTE: SessionStart JS hook callbacks are silently skipped by the SDK in
  // subprocess mode. They only fire for external shell-script hooks configured
  // in ~/.claude/settings.json. We emit the session_start event inline in the
  // message loop below when we observe the system/init message instead.

  // Choose prompt source based on mode.
  let prompt;

  if (isLiveSession) {
    // Live session: long-lived process, multiple turns fed via stdin JSON.
    prompt = liveSessionMessages();
  } else {
    // Per-turn: read stdin as plain text, exit after the result.
    prompt = await readAllStdin();
    if (!prompt) return;
  }

  // Run the agent and stream all SDK messages to stdout as JSONL.
  for await (const message of query({ prompt, options })) {
    emit(message);

    // Emit a session_start event on the first init message per session so
    // OpenClaw can log session lifecycle. The SessionStart JS hook callback
    // is silently skipped by the SDK in subprocess mode, so we derive the
    // event from the init message instead. In live-session mode the SDK
    // emits a fresh init line at the start of each turn; we emit a
    // session_start alongside each one so per-turn tracking stays consistent.
    if (message.type === "system" && message.subtype === "init") {
      emit({
        type:       "system",
        subtype:    "session_start",
        session_id: message.session_id ?? "",
      });
    }
  }

  // Ensure the prune task has finished (stamp file written, restart fired).
  // On fast turns it may still be running when the for-await loop exits.
  await pruneTask;

  log("done");
}

main().catch((err) => {
  // Write errors to stderr so they appear in OpenClaw's CLI backend log,
  // not in the JSONL stream that OpenClaw is parsing.
  log(`ERROR ${err?.stack ?? err?.message ?? String(err)}`);
  process.exit(1);
});
