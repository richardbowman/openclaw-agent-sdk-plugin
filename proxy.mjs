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

// Log all raw argv immediately so we can see exactly what OpenClaw passed.
// appendFileSync is already imported above; this runs before main() is called.
try {
  appendFileSync(
    "/config/claude-sdk-proxy/proxy.log",
    `[claude-agent-sdk-proxy] ${new Date().toISOString()} RAW_ARGV: ${JSON.stringify(process.argv.slice(2))}\n`,
  );
} catch { /* ignore */ }

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
        // Await the restart so the HTTP call completes before this process exits.
        // In per-turn mode the process exits right after pruneTask resolves, so
        // a fire-and-forget call never gets a chance to make the network request.
        await triggerAddonRestart();
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

// ─── Self-managed session continuity ─────────────────────────────────────────
//
// OpenClaw's sessionIdFields / resumeArgs mechanism is not passing --resume
// back to us — RAW_ARGV confirms resume=none on every single turn.
// We implement session continuity ourselves:
//
//   1. extractChatId()   — parse the chat_id from OpenClaw's conversation-info
//                          JSON block embedded in per-turn stdin
//   2. loadChatSession() — look up the last session_id stored for this chat
//   3. saveChatSession() — persist the new session_id after each turn
//
// Store is keyed by chat_id (e.g. "channel:1505916556989693953") and entries
// expire after SESSION_MAX_AGE_MS so stale sessions don't cause SDK errors.

const CHAT_SESSIONS_FILE = "/config/claude-sdk-proxy/chat-sessions.json";
const SESSION_MAX_AGE_MS        = 4  * 60 * 60 * 1000; // 4 hours  (Discord channels)
const SESSION_MAX_AGE_VOICE_MS  = 30 * 60 * 1000;      // 30 minutes (voice turns)

/**
 * Extract the chat_id from OpenClaw's per-turn stdin prompt.
 * OpenClaw embeds a fenced JSON block:
 *
 *   Conversation info (untrusted metadata):
 *   ```json
 *   { "chat_id": "channel:...", ... }
 *   ```
 */
function extractChatId(promptStr) {
  if (typeof promptStr !== "string") return undefined;
  const m = promptStr.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1])?.chat_id ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Return the stored session_id for chatId, or undefined if absent or expired.
 * Voice sessions use a shorter TTL to prevent context accumulation across
 * unrelated queries (e.g. weather → lights control hours later).
 */
async function loadChatSession(chatId) {
  if (!chatId) return undefined;
  try {
    const store  = JSON.parse(await readFile(CHAT_SESSIONS_FILE, "utf8"));
    const entry  = store[chatId];
    if (!entry?.sessionId) return undefined;
    const maxAge = chatId.startsWith("voice:") ? SESSION_MAX_AGE_VOICE_MS : SESSION_MAX_AGE_MS;
    const ageMs  = Date.now() - (entry.ts ?? 0);
    if (ageMs > maxAge) {
      log(`INFO session: ${chatId} expired (age ${Math.round(ageMs / 60000)}min, max ${Math.round(maxAge / 60000)}min), starting fresh`);
      return undefined;
    }
    log(`INFO session: found ${chatId} → ${entry.sessionId} (age ${Math.round(ageMs / 60000)}min)`);
    return entry.sessionId;
  } catch {
    // File absent on first run — that's fine.
    return undefined;
  }
}

/**
 * Persist sessionId for chatId.  Atomic write via .tmp rename.
 */
async function saveChatSession(chatId, sessionId) {
  if (!chatId || !sessionId) return;
  try {
    let store = {};
    try { store = JSON.parse(await readFile(CHAT_SESSIONS_FILE, "utf8")); } catch {}
    store[chatId] = { sessionId, ts: Date.now() };
    const tmp = CHAT_SESSIONS_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    await rename(tmp, CHAT_SESSIONS_FILE);
    log(`INFO session: saved ${chatId} → ${sessionId}`);
  } catch (err) {
    log(`WARN session: could not save: ${err?.message ?? String(err)}`);
  }
}

/**
 * Remove chatId from the sessions store.  Called when a compaction error
 * is detected so the next turn starts a fresh session instead of trying
 * to resume a context that can no longer be hydrated.  Atomic write via .tmp rename.
 */
async function deleteChatSession(chatId) {
  if (!chatId) return;
  try {
    let store = {};
    try { store = JSON.parse(await readFile(CHAT_SESSIONS_FILE, "utf8")); } catch {}
    if (!(chatId in store)) {
      log(`INFO session: delete ${chatId} — not present, nothing to remove`);
      return;
    }
    delete store[chatId];
    const tmp = CHAT_SESSIONS_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    await rename(tmp, CHAT_SESSIONS_FILE);
    log(`INFO session: deleted ${chatId} from chat-sessions.json`);
  } catch (err) {
    log(`WARN session: could not delete ${chatId}: ${err?.message ?? String(err)}`);
  }
}

// ─── Assistant message enrichment ────────────────────────────────────────────
//
// OpenClaw labels a cli-backend response "empty" when the assistant message
// has no text content block — only tool_use.  This happens on resumed
// sessions where Claude goes straight to calling mcp__openclaw__message
// without any preceding text.
//
// Fix: before emitting, check if the assistant message has tool_use for
// mcp__openclaw__message but no text block.  If so, extract the message
// text from the tool input and inject it as a leading text block.
//
// Safe: by the time we see the message in the for-await loop, the SDK has
// already executed the MCP tool call and the Discord message is sent.
// We're only adjusting the JSONL representation for openclaw's parser.

function enrichAssistantMessage(message) {
  if (message.type !== "assistant") return message;
  // Content may live at message.content or message.message.content
  const isNested = !message.content && !!message.message?.content;
  const content  = message.content ?? message.message?.content;
  if (!Array.isArray(content)) return message;
  if (content.some((c) => c?.type === "text")) return message; // already has text
  const msgTool = content.find(
    (c) => c?.type === "tool_use" && c?.name === "mcp__openclaw__message",
  );
  if (!msgTool?.input) return message;
  const text = msgTool.input.text ?? msgTool.input.content
    ?? msgTool.input.message ?? msgTool.input.body ?? msgTool.input.msg
    ?? JSON.stringify(msgTool.input);
  if (!text) return message;
  const enriched = [{ type: "text", text }, ...content];
  if (isNested) {
    return { ...message, message: { ...message.message, content: enriched } };
  }
  return { ...message, content: enriched };
}

// ─── OpenClaw HTTP endpoint helpers ───────────────────────────────────────────
//
// OpenClaw's MCP server is HTTP-based (url: "http://127.0.0.1:<port>/mcp").
// We can call it directly from the proxy with fetch() — no Claude involvement.
// This lets us intercept Claude's text output and route it to Discord ourselves,
// keeping the model completely unaware of channels, tool names, or delivery.

// Stable file where the discovered OpenClaw MCP URL is persisted so
// http-server.mjs can read it without needing /tmp temp files.
// Updated on every CLI session start (fire-and-forget, never throws).
const OC_MCP_STABLE_FILE = "/config/claude-sdk-proxy/openclaw-mcp.json";

/**
 * Parse the MCP config file written by OpenClaw and return { url, headers }
 * with ${ENV_VAR} placeholders expanded from process.env.
 * Returns null if absent, not HTTP-based, or unreadable.
 * Side-effect: writes { url, headers } to OC_MCP_STABLE_FILE so the HTTP
 * server can read the current port without scanning ephemeral /tmp files.
 */
async function loadOpenClawEndpoint(cfgPath) {
  if (!cfgPath) return null;
  try {
    const raw     = JSON.parse(await readFile(cfgPath, "utf8"));
    const servers = raw.mcpServers ?? {};
    const server  = servers.openclaw ?? Object.values(servers)[0];
    if (!server?.url) { log("WARN loadOpenClawEndpoint: no url in mcp config"); return null; }
    const expand  = (s) => String(s).replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] ?? "");
    const url     = expand(server.url);
    const headers = {};
    for (const [k, v] of Object.entries(server.headers ?? {})) headers[k] = expand(v);
    log(`INFO openclaw-endpoint: ${url}`);

    // Persist the URL for http-server.mjs (fire-and-forget — never delays the turn).
    writeFile(OC_MCP_STABLE_FILE, JSON.stringify({ url, headers }, null, 2) + "\n", "utf8")
      .then(() => log(`INFO openclaw-endpoint: persisted to ${OC_MCP_STABLE_FILE}`))
      .catch((e) => log(`WARN openclaw-endpoint: could not persist: ${e?.message ?? String(e)}`));

    return { url, headers };
  } catch (err) {
    log(`WARN loadOpenClawEndpoint: ${err?.message ?? String(err)}`);
    return null;
  }
}

/**
 * List tools from OpenClaw's MCP server and return them in Claude Code's
 * mcp__openclaw__<name> format.  Returns null on any failure.
 */
async function fetchOpenClawToolNames(endpoint) {
  if (!endpoint) return null;
  try {
    const res = await fetch(endpoint.url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...endpoint.headers },
      body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) { log(`WARN fetchOpenClawToolNames HTTP ${res.status}`); return null; }
    const data  = await res.json();
    const tools = data?.result?.tools ?? [];
    const names = tools.map(t => `mcp__openclaw__${t.name}`);
    log(`INFO openclaw-tools: [${names.join(", ")}]`);
    return names;
  } catch (err) {
    log(`WARN fetchOpenClawToolNames: ${err?.message ?? String(err)}`);
    return null;
  }
}

/**
 * Send a new message to a Discord channel via OpenClaw's MCP server.
 * Returns { ok: boolean, messageId: string|null } — messageId is parsed from
 * the tool response if OpenClaw includes the Discord snowflake (17-19 digits).
 */
async function deliverToChannel(endpoint, channelId, text) {
  if (!endpoint || !channelId || !text?.trim()) return { ok: false, messageId: null };
  try {
    const res = await fetch(endpoint.url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...endpoint.headers },
      body:    JSON.stringify({
        jsonrpc: "2.0",
        id:      Date.now(),
        method:  "tools/call",
        params:  { name: "message", arguments: { action: "send", target: channelId, message: text.trim() } },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`WARN deliverToChannel HTTP ${res.status}: ${body.slice(0, 120)}`);
      return { ok: false, messageId: null };
    }
    const data     = await res.json().catch(() => null);
    const respText = String(data?.result?.content?.[0]?.text ?? data?.result?.content ?? "");
    log(`DIAG deliver-response: ${respText.slice(0, 300)}`);
    // OpenClaw returns its own envelope, not a raw Discord message object:
    //   { channel, to, result: { receipt: {
    //       primaryPlatformMessageId: "1509...",
    //       platformMessageIds: ["1509..."],
    //       ...
    //   } } }
    let messageId = null;
    try {
      const parsed  = JSON.parse(respText);
      const receipt = parsed?.result?.receipt;
      const raw     = receipt?.primaryPlatformMessageId
                   ?? receipt?.platformMessageIds?.[0]
                   // fallback paths in case OpenClaw changes shape
                   ?? parsed?.id ?? parsed?.message_id ?? parsed?.messageId;
      if (raw && /^\d{17,19}$/.test(String(raw))) messageId = String(raw);
    } catch { /* not JSON — no safe regex fallback, leave null */ }
    log(`DIAG deliver-messageId: ${messageId ?? "(none)"}`);
    return { ok: true, messageId };
  } catch (err) {
    log(`WARN deliverToChannel: ${err?.message ?? String(err)}`);
    return { ok: false, messageId: null };
  }
}

/**
 * Edit an existing Discord message in-place via OpenClaw's MCP server.
 * Tries action:"edit" with the message_id — returns true if the server accepted
 * it, false if edit isn't supported or the call failed.
 */
async function editChannelMessage(endpoint, channelId, messageId, fullText) {
  if (!endpoint || !channelId || !messageId || !fullText?.trim()) return false;
  try {
    const res = await fetch(endpoint.url, {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...endpoint.headers },
      body:    JSON.stringify({
        jsonrpc: "2.0",
        id:      Date.now(),
        method:  "tools/call",
        params:  {
          name:      "message",
          // Try both snake_case and camelCase for the message ID field name —
          // the winning variant will be clear from DIAG edit-response in the log.
          arguments: { action: "edit", target: channelId,
                       message_id: messageId, messageId, message: fullText.trim() },
        },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { log(`WARN editChannelMessage HTTP ${res.status}`); return false; }
    const data     = await res.json().catch(() => null);
    const respText = String(data?.result?.content?.[0]?.text ?? data?.result?.content ?? "");
    // OpenClaw returns { "ok": true, "message": { ... } } on success.
    // Do NOT use a keyword regex — the response embeds the message content,
    // which may legitimately contain words like "error" or "unknown".
    if (data?.result?.isError) {
      log(`WARN editChannelMessage: isError flag — ${respText.slice(0, 80)}`);
      return false;
    }
    try {
      const inner = JSON.parse(respText);
      if (inner?.ok === true) {
        log(`DIAG edit-response: ok=true`);
        return true;
      }
      // Has an ok field but it's not true (e.g. "Unknown Message" → ok:false or error field)
      log(`WARN editChannelMessage: ok!=true — ${respText.slice(0, 80)}`);
      return false;
    } catch {
      // Response isn't JSON — uncertain, treat as failure
      log(`WARN editChannelMessage: non-JSON response — ${respText.slice(0, 80)}`);
      return false;
    }
  } catch (err) {
    log(`WARN editChannelMessage: ${err?.message ?? String(err)}`);
    return false;
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
    // Do NOT set CLAUDE_CONFIG_DIR unconditionally.  OpenClaw's addon process
    // runs with HOME=/addon_configs/17e0cc66_openclaw_assistant/, so the claude
    // subprocess (inheriting HOME via process.env) stores session .jsonl files
    // in <HOME>/.claude/projects/.  OpenClaw's compaction reads from that same
    // directory via resolveClaudeCliSessionFilePath().  Overriding CLAUDE_CONFIG_DIR
    // to /config/.claude/ would redirect sessions to /config/.claude/projects/,
    // which OpenClaw cannot find → every compaction attempt 404s.
    //
    // Exception: when the access token is EXPIRED, we cannot inject it directly
    // (the claude binary ignores a stale CLAUDE_CODE_OAUTH_TOKEN even when
    // CLAUDE_CODE_OAUTH_REFRESH_TOKEN is present).  Instead, point CLAUDE_CONFIG_DIR
    // at the credentials file so the binary can read the refresh token and do
    // the OAuth refresh itself.
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

  // NOTE: SessionStart JS hook callbacks are silently skipped by the SDK in
  // subprocess mode. They only fire for external shell-script hooks configured
  // in ~/.claude/settings.json. We emit the session_start event inline in the
  // message loop below when we observe the system/init message instead.

  // Choose prompt source based on mode.  In per-turn mode we also do session
  // continuity lookup here, before building options, so resumeId is correct.
  let prompt;
  let chatId;  // chat_id from OpenClaw's conversation-info block (per-turn only)

  if (isLiveSession) {
    // Live session: long-lived process, multiple turns fed via stdin JSON.
    prompt = liveSessionMessages();
    log("DIAG stdin: live-session mode (generator — no preview)");
  } else {
    // Per-turn: read stdin as plain text, exit after the result.
    prompt = await readAllStdin();
    if (!prompt) return;
    // Log a preview of stdin so we can see if OpenClaw sends JSON or plain text.
    log(`DIAG stdin[0:300]: ${JSON.stringify(prompt.slice(0, 300))}`);

    // Self-managed session continuity: OpenClaw never passes --resume
    // (confirmed via RAW_ARGV — always none).  Look up the last session for
    // this chat and resume it ourselves so Claude keeps context across turns.
    chatId = extractChatId(prompt);

    // Voice assistant turns arrive as raw plain text with no Delivery: prefix
    // and no embedded chat_id JSON block.  Detect them by exclusion: not a cron
    // job (which start with "[cron:"), not a Discord/channel turn (which start
    // with "Delivery:").  Assign a stable synthetic chat_id so voice gets the
    // same persistent-session treatment as Discord channels.
    if (!chatId && !prompt.startsWith("[cron:") && !prompt.startsWith("Delivery:")) {
      // Log the system prompt and MCP config so we can check whether OpenClaw
      // hides any per-conversation identifier (e.g. HA conversation_id) in those
      // files that we could use instead of the fallback "voice:ha-assist" key.
      log(`DIAG voice sysprompt[0:500]: ${JSON.stringify((appendSystemPrompt ?? "").slice(0, 500))}`);
      try {
        const rawMcp = mcpConfigFile ? JSON.stringify(JSON.parse(await readFile(mcpConfigFile, "utf8")), null, 0) : "(none)";
        log(`DIAG voice mcp[0:500]: ${rawMcp.slice(0, 500)}`);
      } catch { log("DIAG voice mcp: (read failed)"); }
      // Log OpenClaw env vars that might carry a per-conversation identifier
      log(`DIAG voice env: AGENT_ID=${process.env.OPENCLAW_MCP_AGENT_ID ?? "(unset)"} CHANNEL=${process.env.OPENCLAW_MCP_MESSAGE_CHANNEL ?? "(unset)"} EVENT_KIND=${process.env.OPENCLAW_MCP_INBOUND_EVENT_KIND ?? "(unset)"} SESSION_KEY=${(process.env.OPENCLAW_MCP_SESSION_KEY ?? "(unset)").slice(0, 16)}`);
      // Derive a stable key from OpenClaw's per-instance env vars.
      // Confirmed via DIAG: CHANNEL=voice, AGENT_ID=main for HA Assist turns.
      // Both are constant for the addon lifetime but would differ if a second
      // voice agent or channel type were added.
      const ocChannel = process.env.OPENCLAW_MCP_MESSAGE_CHANNEL || "voice";
      const ocAgent   = process.env.OPENCLAW_MCP_AGENT_ID        || "main";
      chatId = `${ocChannel}:${ocAgent}`;
      log(`INFO session: no chat_id in stdin — treating as voice turn, chatId=${chatId}`);
    }

    // For voice turns, override the model to haiku regardless of what OpenClaw
    // configured.  OpenClaw's channel binding targets "openai" but HA Assist
    // actually uses the "voice" channel, so voice requests always fall through
    // to the main agent (sonnet).  We enforce the faster haiku model here as a
    // reliable proxy-side override that does not depend on OpenClaw routing.
    // If the binding is later fixed so OpenClaw routes to ha-voice and passes
    // haiku itself, this block becomes a no-op.
    if (chatId?.startsWith("voice:")) {
      const VOICE_MODEL = "claude-haiku-4-5";
      if (model !== VOICE_MODEL) {
        log(`INFO voice: overriding model ${model ?? "(default)"} → ${VOICE_MODEL} (OpenClaw routes voice to main/sonnet; ha-voice binding not matched)`);
        model = VOICE_MODEL;
      }
    }

    if (!resumeId && chatId) {
      const storedSession = await loadChatSession(chatId);
      if (storedSession) {
        resumeId = storedSession;
        log(`INFO session: self-managed resume=${resumeId} for chat=${chatId}`);
      }
    }
  }

  // ── Proxy-injected system prompt addition ────────────────────────────────
  // For Discord channel turns, instruct Claude to send a brief status message
  // via the message tool before starting any tool-heavy work so the user sees
  // immediate activity rather than silence.
  //
  // Voice turns return text directly — there is no message tool to route
  // status through, and cron jobs never interact with users, so we skip both.
  // Extract the raw channel ID so we can tell Claude the exact target to use
  // in the ack mcp__openclaw__message call.  Falls back to the full chatId if
  // the chatId is already in "channel:ID" form; otherwise empty string.
  const channelTarget = chatId?.startsWith("channel:") ? chatId : "";

  // ── OpenClaw endpoint + tool list (Discord turns only) ─────────────────────
  // The proxy auto-delivers Claude's text output to Discord directly — Claude
  // never sees mcp__openclaw__message and needs no channel-routing knowledge.
  const openClawEndpoint = channelTarget ? await loadOpenClawEndpoint(mcpConfigFile) : null;

  // Build the effective allowed-tools list.  For Discord turns, fetch the real
  // tool list from OpenClaw and remove mcp__openclaw__message so Claude can't
  // call it (proxy handles all delivery).  Falls back to the wildcard from argv
  // if the fetch fails, keeping the turn alive even if tools/list is slow.
  let effectiveAllowedTools = allowedTools;
  if (channelTarget && openClawEndpoint) {
    const toolNames = await fetchOpenClawToolNames(openClawEndpoint);
    if (toolNames) {
      effectiveAllowedTools = toolNames.filter(t => t !== "mcp__openclaw__message");
      log(`INFO tools: Discord turn — removed mcp__openclaw__message → [${effectiveAllowedTools.join(", ")}]`);
    } else {
      log("WARN tools: tools/list failed — keeping wildcard allowedTools (mcp__openclaw__message visible)");
    }
  }

  const combinedAppend = appendSystemPrompt || undefined;

  // Build options after stdin / session lookup so resumeId is final.
  const options = {
    pathToClaudeCodeExecutable: resolvedClaudePath,

    allowedTools: effectiveAllowedTools,
    settingSources: ["user"],
    env: subprocessEnv,

    ...(model             && { model }),
    ...(resumeId          && { resume:         resumeId }),
    ...(permissionMode    && { permissionMode }),
    ...(effort            && { effort }),
    ...(mcpServers        && { mcpServers }),
    ...(combinedAppend && {
      systemPrompt: {
        type:   "preset",
        preset: "claude_code",
        append: combinedAppend,
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

  // Run the agent and stream all SDK messages to stdout as JSONL.
  let emittedSessionId;    // captured from first system/init — saved after loop
  let capturedMsgText;     // last text delivered to Discord — for result.result fix
  let firstAssistantSeen = false; // whether proxy has seen any assistant message yet
  let ackSent            = false; // whether a proxy-generated ack was sent this turn

  // ── Edit-in-place Discord message state ────────────────────────────────────
  // Instead of sending many separate Discord messages, we maintain one active
  // message that grows as Claude narrates its work.  Tool status is appended as
  // an ephemeral italic suffix (not included in baseContent) so it disappears
  // naturally when the next text block arrives.
  let activeMessageId    = null;  // Discord snowflake of the live message (if we got one)
  let baseContent        = "";    // Accumulated delivered text (without tool-status suffix)
  let toolCallCount      = 0;     // # of tool_use_end events this turn
  let textSinceToolCount = 0;     // toolCallCount at last text delivery (for watchdog)

  // Helper: compute the full message text to edit into Discord.
  const fullMsg = (suffix = "") =>
    suffix ? `${baseContent}\n\n${suffix}` : baseContent;

  // Helper: deliver or update the Discord message with new text appended.
  // Tries edit-in-place first (if we have a messageId); falls back to send.
  async function pushText(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const separator  = baseContent ? "\n" : "";
    const newBase    = baseContent + separator + trimmed;
    // Discord hard limit is 2000 chars — start a new message if we'd overflow.
    if (activeMessageId && newBase.length <= 1900) {
      const ok = await editChannelMessage(openClawEndpoint, channelTarget, activeMessageId, newBase);
      if (ok) { baseContent = newBase; capturedMsgText = newBase; return; }
      // Edit failed (tool doesn't support it, or message was deleted) — fall through.
      activeMessageId = null;
    }
    const result = await deliverToChannel(openClawEndpoint, channelTarget,
      // If accumulated too long, send only the new piece as a fresh message.
      newBase.length <= 1900 ? newBase : trimmed);
    if (result.ok) {
      activeMessageId = result.messageId ?? null;
      baseContent     = newBase.length <= 1900 ? newBase : trimmed;
      capturedMsgText = baseContent;
    }
  }

  // Helper: edit the current message to show a tool-status suffix without
  // changing baseContent (the suffix is ephemeral; next pushText call removes it).
  async function showToolStatus(suffix) {
    if (!activeMessageId || !baseContent) return;
    await editChannelMessage(openClawEndpoint, channelTarget, activeMessageId, fullMsg(suffix));
  }

  // ── Proxy-side turn timeout ────────────────────────────────────────────────
  // OpenClaw kills the subprocess after ~7-8 minutes with SIGKILL (no SIGTERM),
  // so the process dies silently with no way to send a cutoff message.
  // Instead, we fire our OWN timeout at 4.5 minutes, edit the Discord message
  // with a "reached my limit" notice, then break the loop and exit cleanly.
  // This runs entirely inside the proxy with no dependency on OpenClaw signals.
  let turnTimedOut = false;
  const TURN_TIMEOUT_MS = channelTarget ? 4.5 * 60 * 1000 : 0;
  const turnTimer = TURN_TIMEOUT_MS
    ? setTimeout(async () => {
        turnTimedOut = true;
        log(`WARN turn-timeout: ${TURN_TIMEOUT_MS / 60_000} min limit reached — stopping turn`);
        if (activeMessageId && channelTarget && openClawEndpoint && baseContent) {
          try {
            await editChannelMessage(
              openClawEndpoint, channelTarget, activeMessageId,
              baseContent + "\n\n_⏰ I've hit my research time limit. Reply to ask me to continue._",
            );
            log("INFO turn-timeout: edited message with cutoff notice");
          } catch { /* best-effort */ }
        }
      }, TURN_TIMEOUT_MS)
    : null;

  // SIGTERM handler — belt-and-suspenders in case OpenClaw ever does send SIGTERM.
  const onSigterm = async () => {
    if (turnTimer) clearTimeout(turnTimer);
    try {
      if (activeMessageId && channelTarget && openClawEndpoint && baseContent) {
        await editChannelMessage(
          openClawEndpoint, channelTarget, activeMessageId,
          baseContent + "\n\n_⚠️ Response was cut off — please ask me to continue._",
        );
        log("INFO sigterm: edited active message with cutoff notice");
      }
    } catch { /* best-effort */ }
    emit({ type: "result", subtype: "success", result: "NO_REPLY", session_id: emittedSessionId ?? "" });
    log("INFO sigterm: emitted synthetic NO_REPLY result to suppress OpenClaw fallback delivery");
    process.exit(0);
  };
  process.once("SIGTERM", onSigterm);

  // ── Tool-use keepalive ────────────────────────────────────────────────────
  // OpenClaw's stdout reader can time out during long tool executions since the
  // SDK emits nothing between tool_use and tool_result.  We:
  //   (a) immediately emit system/tool_use_start ourselves (JS hooks don't fire
  //       in subprocess mode — confirmed by absence in STDOUT log), and
  //   (b) fire a heartbeat every 8 s via setInterval while the tool is running
  //       so OpenClaw's read timeout never triggers.
  let activeToolName  = null;
  let keepaliveTimer  = null;

  function startToolKeepalive(toolName) {
    activeToolName = toolName;
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      emit({ type: "system", subtype: "heartbeat", tool_name: toolName,
             session_id: emittedSessionId ?? "" });
      log(`KEEPALIVE heartbeat tool=${toolName}`);
    }, 8_000);
  }

  function stopToolKeepalive() {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    activeToolName = null;
  }

  // ── SDK error / session-resume guard ─────────────────────────────────────
  // The Agent SDK auto-compacts long sessions transparently during an active
  // turn (emitting a compact_boundary system event) — this is the expected
  // mechanism for CLI backends.  However, if a session cannot be resumed
  // (stale session_id, corrupt session file, unexpected SDK error), the SDK
  // throws before any messages are emitted.  That error would propagate to
  // main().catch → process.exit(1), causing OpenClaw to TTS the raw error.
  //
  // Safety net: catch any SDK throw from the query loop.  On the first error
  // in per-turn mode, clear the cached session and retry immediately with a
  // fresh session so this turn still completes.  Emit a friendly result on
  // unrecoverable errors so OpenClaw/voice TTS says something clean.
  let queryError   = null;
  let retried      = false;
  let keepLooping  = true;

  while (keepLooping) {
  // On the retry pass, drop the resume option so the SDK starts a fresh
  // session (the stale one was already cleared from chat-sessions.json).
  const runOptions = retried
    ? (({ resume: _r, ...rest }) => rest)(options)
    : options;

  try {

  for await (const message of query({ prompt, options: runOptions })) {
    // Check proxy-side turn timeout — break cleanly before OpenClaw kills us.
    if (turnTimedOut) { log("INFO turn-timeout: breaking message loop"); break; }

    // ── Auto-deliver Claude's text to Discord (edit-in-place) ────────────────
    // Every assistant text block is delivered immediately via pushText(), which
    // edits the existing Discord message in-place (growing it) rather than
    // spamming new messages.  Tool status is shown as an ephemeral italic suffix.
    //
    // Auto-ack: if Claude's first move is pure tool-use with no opening text,
    // the proxy injects "⏳ On it..." so the user sees activity immediately.
    if (message.type === "assistant" && channelTarget && openClawEndpoint) {
      const content    = message.content ?? message.message?.content;
      if (Array.isArray(content)) {
        const textBlocks = content.filter(c => c?.type === "text" && c.text?.trim());
        const toolBlocks = content.filter(c => c?.type === "tool_use");

        // Auto-ack on first pure-tool message (no text to deliver yet).
        if (!firstAssistantSeen && textBlocks.length === 0 && toolBlocks.length > 0 && !ackSent) {
          const result = await deliverToChannel(openClawEndpoint, channelTarget, "⏳ On it...");
          if (result.ok) {
            ackSent         = true;
            activeMessageId = result.messageId ?? null;
            baseContent     = "⏳ On it...";
            capturedMsgText = baseContent;
            log(`INFO proxy-ack: sent to ${channelTarget} (msgId=${activeMessageId ?? "none"})`);
          } else {
            log(`WARN proxy-ack: delivery failed for ${channelTarget}`);
          }
        }

        // Deliver each text block — edit the existing message or send new.
        for (const block of textBlocks) {
          await pushText(block.text);
          textSinceToolCount = toolCallCount;
          log(`INFO auto-deliver: ${block.text.length} chars → ${channelTarget}: ${block.text.slice(0, 60).replace(/\n/g, "↵")}`);
        }

        // Show ephemeral tool-status suffix for the tools about to run.
        if (toolBlocks.length > 0) {
          const names  = toolBlocks.map(b => b.name ?? "tool").join(", ");
          await showToolStatus(`_⚙️ ${names}…_`);
          log(`INFO tool-status: ${names}`);
        }

        firstAssistantSeen = true;
      }
    }

    // ── Emit tool_use_start events + keepalive ────────────────────────────────
    if (message.type === "assistant") {
      const content = message.content ?? message.message?.content;
      if (Array.isArray(content)) {
        // Emit tool_use_start for every tool_use block (hooks don't fire in
        // subprocess mode so we do it here from the message stream).
        for (const block of content) {
          if (block?.type === "tool_use") {
            const tname = block.name ?? "tool";
            emit({ type: "system", subtype: "tool_use_start", tool_name: tname,
                   session_id: emittedSessionId ?? "" });
            log(`STDOUT system/tool_use_start tool=${tname}`);
            startToolKeepalive(tname);
          }
        }
      }
    }

    // ── Tool result received — stop keepalive, emit tool_use_end ─────────────
    if (message.type === "user") {
      const content = message.content ?? message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_result") {
            const isErr = block.is_error === true;
            if (isErr) {
              const errText = Array.isArray(block.content)
                ? block.content.map((c) => c?.text ?? "").join(" ").slice(0, 200)
                : String(block.content ?? "").slice(0, 200);
              log(`WARN tool_result ERROR id=${block.tool_use_id?.slice(0, 8) ?? "?"}: ${errText}`);
            } else if (activeToolName === "mcp__openclaw__message") {
              // Log success for the message tool so we know delivery worked
              const okText = Array.isArray(block.content)
                ? block.content.map((c) => c?.text ?? "").join(" ").slice(0, 100)
                : String(block.content ?? "").slice(0, 100);
              log(`INFO tool_result mcp__openclaw__message OK: ${okText || "(empty)"}`);
            }
          }
        }
        if (content.some((c) => c?.type === "tool_result")) {
          const tname = activeToolName ?? "tool";
          stopToolKeepalive();
          emit({ type: "system", subtype: "tool_use_end", tool_name: tname,
                 session_id: emittedSessionId ?? "" });
          log(`STDOUT system/tool_use_end tool=${tname}`);
          toolCallCount++;

          // Watchdog: every 5 tool calls without new text, edit the Discord message
          // so the user knows the bot is still alive (not just hung silently).
          const callsSinceText = toolCallCount - textSinceToolCount;
          if (channelTarget && openClawEndpoint && callsSinceText > 0 && callsSinceText % 5 === 0) {
            await showToolStatus(`_⏳ Still working… (${toolCallCount} tool calls so far)_`);
            log(`INFO watchdog: updated Discord message at ${toolCallCount} tool calls`);
          }
        }
      }
    }

    // ── Fix empty result/success.output ──────────────────────────────────────
    // OpenClaw checks result.output to decide if the response is "empty".
    // On resumed sessions Claude only calls the tool (no final text), leaving
    // output empty → openclaw falls back to openai.  Inject the captured
    // Discord message text so openclaw sees a non-empty response.
    let outgoing = enrichAssistantMessage(message);
    if (message.type === "result" && message.subtype === "success") {
      stopToolKeepalive(); // belt-and-suspenders — clear any lingering timer
      log(`DIAG result_msg: ${JSON.stringify(message).slice(0, 300)}`);
      const stopReason = message.stop_reason ?? message.stopReason ?? "";
      if (stopReason === "max_turns") {
        log(`WARN result: max_turns stop_reason — Claude may not have finished (no hard cap set; this came from the SDK itself)`);
      }
      const curOutput = message.result ?? message.output ?? "";
      if (capturedMsgText) {
        // proxy.mjs already delivered the response to Discord via deliverToChannel /
        // editChannelMessage.  Set result → NO_REPLY so OpenClaw does NOT re-deliver
        // the same text as a second Discord message (which would double every response).
        outgoing = { ...message, result: "NO_REPLY" };
        log(`INFO result-fix: proxy delivered ${capturedMsgText.length} chars to Discord; result=NO_REPLY to suppress OpenClaw re-delivery`);
      } else if (!curOutput) {
        log(`WARN result: empty output and no captured Discord delivery (channel=${channelTarget || "none"})`);
      }
    }
    if (outgoing !== message && message.type === "assistant") {
      log(`INFO enrich: injected text block into assistant message`);
    }
    emit(outgoing);

    // Log every message we emit so we can trace the exact JSONL openclaw sees.
    {
      const mtype = [outgoing.type, outgoing.subtype].filter(Boolean).join("/");
      const parts = [mtype];
      if (outgoing.session_id) parts.push(`sid=${outgoing.session_id.slice(0, 8)}`);
      if (outgoing.role)       parts.push(`role=${outgoing.role}`);
      if (outgoing.stop_reason) parts.push(`stop=${outgoing.stop_reason}`);
      if (outgoing.result !== undefined) parts.push(`result=${String(outgoing.result).slice(0, 40)}`);
      if (outgoing.output !== undefined) parts.push(`output=${String(outgoing.output).slice(0, 40)}`);
      const content = outgoing.content ?? outgoing.message?.content;
      if (Array.isArray(content)) {
        const summary = content.map((c) => {
          if (c?.type === "text")        return `text(${String(c.text ?? "").slice(0, 40).replace(/\n/g, "↵")})`;
          if (c?.type === "tool_use")    return `tool_use(${c.name ?? "?"})`;
          if (c?.type === "tool_result") return `tool_result(${c.tool_use_id?.slice(0, 8) ?? "?"})`;
          return c?.type ?? "?";
        }).join(",");
        parts.push(`content=[${summary}]`);
      } else if (outgoing.type === "assistant") {
        parts.push(`raw=${JSON.stringify(outgoing).slice(0, 300)}`);
      }
      log(`STDOUT ${parts.join(" ")}`);
    }

    // Emit a session_start event on the first init message per session so
    // OpenClaw can log session lifecycle.
    if (message.type === "system" && message.subtype === "init") {
      if (!emittedSessionId) emittedSessionId = message.session_id;
      log(`DIAG session_id from SDK: ${message.session_id ?? "(none)"}`);
      emit({
        type:       "system",
        subtype:    "session_start",
        session_id: message.session_id ?? "",
      });
      log(`STDOUT system/session_start sid=${(message.session_id ?? "").slice(0, 8)}`);
    }
  }

  keepLooping = false; // for-await completed successfully — exit the while loop

  } catch (err) {
    // ── SDK error / compaction-retry handler ────────────────────────────────
    const errMsg = err?.message ?? String(err);
    log(`WARN query-loop threw: ${errMsg.slice(0, 300)}`);

    // Classify: is this a compaction / stale-MCP-port error?
    // Compaction errors look like: "404 ... /mcp" or "compaction failed" or
    // "error 404 from openclaw".  We cast a reasonably wide net.
    const isCompaction =
      /compact/i.test(errMsg) ||
      (/404/.test(errMsg) && /mcp|openclaw|session/i.test(errMsg));

    // On the first compaction error in per-turn mode: clear the stale session
    // and retry immediately with a fresh session so this turn completes
    // successfully — the user gets their answer without having to repeat
    // themselves.  keepLooping stays true so the while loop re-enters.
    if (isCompaction && !isLiveSession && !retried) {
      log(`WARN compaction: clearing session ${chatId ?? "(unknown)"}, retrying turn without resume`);
      await deleteChatSession(chatId);
      retried            = true;
      emittedSessionId   = undefined;     // fresh session will have a new id
      firstAssistantSeen = false;         // allow auto-ack to re-fire if needed
      ackSent            = !!baseContent; // preserve ack state if Discord already got content
      toolCallCount      = 0;
      textSinceToolCount = 0;
      // keepLooping stays true — the while loop will retry immediately
    } else {
      // Non-compaction error, already retried once, or live-session mode —
      // emit a friendly result so OpenClaw/voice TTS's something clean.
      queryError  = err;
      keepLooping = false;
      const friendlyMsg = isCompaction
        ? "My conversation history was reset. Please repeat your question."
        : "I ran into an error processing your request. Please try again.";
      emit({
        type:       "result",
        subtype:    "success",
        result:     friendlyMsg,
        session_id: emittedSessionId ?? "",
      });
      log(`INFO query-error: emitted friendly result (isCompaction=${isCompaction}, retried=${retried})`);
    }
  }
  } // end while (keepLooping)

  // Emit synthetic NO_REPLY result on turn-timeout — without this, OpenClaw
  // receives EOF with no result event and dumps all raw JSONL to Discord.
  if (turnTimedOut) {
    emit({ type: "result", subtype: "success", result: "NO_REPLY", session_id: emittedSessionId ?? "" });
    log("INFO turn-timeout: emitted synthetic NO_REPLY result to suppress OpenClaw fallback delivery");
  }

  // ── Post-loop cleanup (runs on both clean exit and error path) ────────────
  stopToolKeepalive(); // ensure timer is cleared if loop exits early
  if (turnTimer) clearTimeout(turnTimer); // cancel timeout — turn finished cleanly
  process.off("SIGTERM", onSigterm); // normal exit — no cutoff notice needed

  // Persist the session_id so the next per-turn message for this chat
  // can resume it (self-managed continuity, bypassing openclaw's broken
  // sessionIdFields tracking).
  //   - Clean exit:          saves current session
  //   - Compaction + retry:  saves the NEW session from the retry (emittedSessionId
  //                          was reset in the retry setup, then re-captured from the
  //                          fresh system/init event)
  //   - Unrecoverable error: queryError is set, so we skip — session was deleted
  //                          (compaction) or may be in an unknown state
  if (!isLiveSession && chatId && emittedSessionId && !queryError) {
    await saveChatSession(chatId, emittedSessionId);
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
