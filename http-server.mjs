#!/usr/bin/env node
/**
 * claude-sdk-proxy / http-server.mjs
 *
 * HTTP bridge: OpenClaw HTTP provider → Anthropic Agent SDK
 *
 * OpenClaw's embedded runner (and HA's OpenAI conversation integration) calls
 * POST /v1/chat/completions with a standard OpenAI chat-completion request.
 * We call the Agent SDK, maintain per-conversation session continuity via the
 * same chat-sessions.json store that proxy.mjs uses, and return an OpenAI-
 * format response (non-streaming or SSE streaming depending on body.stream).
 *
 * Session key derivation (priority order):
 *   1. body.user field (set by OpenClaw per conversation)
 *   2. chat_id from fenced JSON block embedded in any message content
 *   3. Short MD5 of first 100 chars of system message (stable per agent config)
 *   4. "http:default"
 *
 * MCP: static HA config read from /config/.mcporter/mcporter.json
 * Auth: OAuth token from /config/.claude/.credentials.json
 * Claude binary: bundled linux-x64 binary in local node_modules
 */

import { createServer } from "http";
import { query }        from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, rename } from "fs/promises";
import { appendFileSync, statSync }    from "fs";
import { createHash }  from "crypto";

const PORT = 18791;
const HOST = "127.0.0.1";

const LOG_FILE           = "/config/claude-sdk-proxy/http-server.log";
const CHAT_SESSIONS_FILE = "/config/claude-sdk-proxy/chat-sessions.json";
const HA_CREDENTIALS     = "/config/.claude/.credentials.json";
const DOCKER_TOKEN_FILE  = "/run/claude-auth/oauth_token";
const MCPORTER_CONFIG    = "/config/.mcporter/mcporter.json";

const SESSION_MAX_AGE_MS       = 4  * 60 * 60 * 1000;  // 4 h  – text channels
const SESSION_MAX_AGE_SHORT_MS = 30 * 60 * 1000;        // 30 min – voice

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  try {
    const line = `[http-server] ${new Date().toISOString()} ${msg}\n`;
    process.stderr.write(line);
    appendFileSync(LOG_FILE, line);
  } catch { /* ignore write errors */ }
}

log("http-server.mjs starting");

// ── Claude binary resolution ──────────────────────────────────────────────────

function resolveClaudePath() {
  const __dir    = new URL(".", import.meta.url).pathname;
  const bundled  = `${__dir}node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`;
  try {
    statSync(bundled);
    log(`INFO claude: bundled binary at ${bundled}`);
    return bundled;
  } catch {
    log("WARN claude: bundled binary not found — falling back to PATH");
    return "claude";
  }
}

const CLAUDE_PATH = resolveClaudePath();

// ── OAuth credentials ─────────────────────────────────────────────────────────

async function readCredentials() {
  // Docker e2e mount takes precedence
  try {
    const tok = (await readFile(DOCKER_TOKEN_FILE, "utf8")).trim();
    if (tok) return { oauthToken: tok, refreshToken: undefined, tokenExpired: false };
  } catch { /* not present */ }

  // HA credentials file
  try {
    const raw   = JSON.parse(await readFile(HA_CREDENTIALS, "utf8"));
    const creds = raw?.claudeAiOauth;
    if (creds?.accessToken) {
      const expired = creds.expiresAt && (creds.expiresAt - Date.now()) <= 0;
      if (expired) {
        log(`WARN auth: token expired ${Math.round((Date.now() - creds.expiresAt) / 60000)}min ago — will use CLAUDE_CONFIG_DIR path`);
      }
      return {
        oauthToken:   creds.accessToken,
        refreshToken: creds.refreshToken ?? undefined,
        tokenExpired: !!expired,
      };
    }
    log("WARN auth: claudeAiOauth.accessToken missing in credentials file");
  } catch (err) {
    log(`WARN auth: cannot read credentials: ${err?.message ?? String(err)}`);
  }

  log("WARN auth: no OAuth token found — claude subprocess will likely fail");
  return { oauthToken: undefined, refreshToken: undefined, tokenExpired: false };
}

// ── MCP: load HA server list from mcporter.json ───────────────────────────────

let _mcpCache = null;

async function loadMcpServers() {
  if (_mcpCache) return _mcpCache;
  try {
    const raw     = JSON.parse(await readFile(MCPORTER_CONFIG, "utf8"));
    const servers = raw.mcpServers ?? {};
    const result  = {};
    for (const [name, cfg] of Object.entries(servers)) {
      // mcporter.json uses "baseUrl"; Agent SDK wants "url" with explicit type
      result[name] = {
        type:    "http",
        url:     cfg.url ?? cfg.baseUrl,
        ...(cfg.headers && { headers: cfg.headers }),
      };
    }
    _mcpCache = result;
    log(`INFO mcp: loaded [${Object.keys(result).join(", ")}] from mcporter.json`);
    return result;
  } catch (err) {
    log(`WARN mcp: cannot load mcporter.json: ${err?.message ?? String(err)}`);
    _mcpCache = {};
    return {};
  }
}

// ── Session store ─────────────────────────────────────────────────────────────

async function loadChatSession(chatId) {
  if (!chatId) return undefined;
  try {
    const store = JSON.parse(await readFile(CHAT_SESSIONS_FILE, "utf8"));
    const entry = store[chatId];
    if (!entry?.sessionId) return undefined;
    const maxAge = chatId.startsWith("voice:") ? SESSION_MAX_AGE_SHORT_MS : SESSION_MAX_AGE_MS;
    const ageMs  = Date.now() - (entry.ts ?? 0);
    if (ageMs > maxAge) {
      log(`INFO session: ${chatId} expired (${Math.round(ageMs / 60000)}min > ${Math.round(maxAge / 60000)}min), starting fresh`);
      return undefined;
    }
    log(`INFO session: ${chatId} → ${entry.sessionId.slice(0, 8)} (age ${Math.round(ageMs / 60000)}min)`);
    return entry.sessionId;
  } catch {
    return undefined;  // file absent on first run
  }
}

async function saveChatSession(chatId, sessionId) {
  if (!chatId || !sessionId) return;
  try {
    let store = {};
    try { store = JSON.parse(await readFile(CHAT_SESSIONS_FILE, "utf8")); } catch {}
    store[chatId] = { sessionId, ts: Date.now() };
    const tmp = CHAT_SESSIONS_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    await rename(tmp, CHAT_SESSIONS_FILE);
    log(`INFO session: saved ${chatId} → ${sessionId.slice(0, 8)}`);
  } catch (err) {
    log(`WARN session: save failed: ${err?.message ?? String(err)}`);
  }
}

async function deleteChatSession(chatId) {
  if (!chatId) return;
  try {
    let store = {};
    try { store = JSON.parse(await readFile(CHAT_SESSIONS_FILE, "utf8")); } catch {}
    if (!(chatId in store)) return;
    delete store[chatId];
    const tmp = CHAT_SESSIONS_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf8");
    await rename(tmp, CHAT_SESSIONS_FILE);
    log(`INFO session: deleted ${chatId}`);
  } catch (err) {
    log(`WARN session: delete failed: ${err?.message ?? String(err)}`);
  }
}

// ── Session key derivation ────────────────────────────────────────────────────

/**
 * Derive a stable conversation key from an OpenAI-format request body.
 *
 * Priority:
 *  1. body.user field (OpenClaw sets this to the conversation ID when known)
 *  2. chat_id in a fenced JSON block inside any message content
 *  3. Short hash of the first 100 chars of the system message (stable per agent)
 *  4. "http:default"
 */
function deriveChatId(body) {
  // 1. user field
  if (body.user && typeof body.user === "string" && body.user.trim()) {
    const key = `user:${body.user.trim()}`;
    log(`DIAG chatId: from body.user → ${key}`);
    return key;
  }

  // 2. Scan message content for embedded chat_id JSON block (CLI backend format)
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    const raw = typeof msg.content === "string" ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(c => c?.type === "text").map(c => c.text ?? "").join("\n")
        : "";
    const m = raw.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    if (m) {
      try {
        const chatId = JSON.parse(m[1])?.chat_id;
        if (chatId && typeof chatId === "string") {
          log(`DIAG chatId: from embedded JSON block → ${chatId}`);
          return chatId;
        }
      } catch {}
    }
  }

  // 3. Hash first 100 chars of system message (stable per agent/config)
  const sysMsg = messages.find(m => m.role === "system");
  if (sysMsg?.content) {
    const txt  = typeof sysMsg.content === "string" ? sysMsg.content
      : Array.isArray(sysMsg.content)
        ? sysMsg.content.filter(c => c?.type === "text").map(c => c.text ?? "").join("")
        : "";
    if (txt) {
      const hash = createHash("md5").update(txt.slice(0, 100)).digest("hex").slice(0, 8);
      const key  = `http:${hash}`;
      log(`DIAG chatId: from system-prompt hash → ${key}`);
      return key;
    }
  }

  log("DIAG chatId: fallback → http:default");
  return "http:default";
}

// ── Extract text from OpenAI content field ────────────────────────────────────

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c?.type === "text")
      .map(c => c.text ?? "")
      .join("\n");
  }
  return String(content ?? "");
}

// ── Core chat completion logic ────────────────────────────────────────────────

async function runChatCompletion(body, onChunk) {
  const messages     = Array.isArray(body.messages) ? body.messages : [];
  const sysMsg       = messages.find(m => m.role === "system");
  const userMessages = messages.filter(m => m.role === "user");
  const lastUser     = userMessages[userMessages.length - 1];

  if (!lastUser) throw new Error("No user message in request body");

  const promptText     = extractText(lastUser.content);
  const systemPromptTxt = sysMsg ? extractText(sysMsg.content) : undefined;

  const chatId   = deriveChatId(body);
  const resumeId = await loadChatSession(chatId);

  // Strip provider prefix from model name: "claude-agent-sdk/claude-haiku-4-5" → "claude-haiku-4-5"
  const rawModel = body.model ?? "claude-haiku-4-5";
  const model    = rawModel.includes("/") ? rawModel.split("/").pop() : rawModel;

  const { oauthToken, refreshToken, tokenExpired } = await readCredentials();
  const subprocessEnv = {
    ...process.env,
    ...(!tokenExpired && oauthToken   && { CLAUDE_CODE_OAUTH_TOKEN:         oauthToken }),
    ...(!tokenExpired && refreshToken && { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken }),
    ...(tokenExpired                  && { CLAUDE_CONFIG_DIR: "/config/.claude" }),
  };

  const mcpServers   = await loadMcpServers();
  const mcpNames     = Object.keys(mcpServers);
  const allowedTools = mcpNames.length > 0
    ? mcpNames.map(n => `mcp__${n}__*`)
    : [];

  const options = {
    pathToClaudeCodeExecutable: CLAUDE_PATH,
    model,
    permissionMode:  "acceptEdits",
    settingSources:  ["user"],
    env:             subprocessEnv,
    allowedTools,
    ...(resumeId           && { resume: resumeId }),
    ...(mcpNames.length    && { mcpServers }),
    ...(systemPromptTxt    && {
      systemPrompt: {
        type:   "preset",
        preset: "claude_code",
        append: systemPromptTxt,
      },
    }),
  };

  log(`INFO query start: chatId=${chatId} model=${model} resume=${resumeId?.slice(0, 8) ?? "none"} tools=[${allowedTools.join(",")}]`);

  let fullText     = "";
  let newSessionId = null;
  let queryError   = null;
  let retried      = false;
  let keepLooping  = true;

  while (keepLooping) {
    const runOpts = retried
      ? (({ resume: _r, ...rest }) => rest)(options)
      : options;

    try {
      for await (const msg of query({ prompt: promptText, options: runOpts })) {

        // Capture session ID from init event
        if (msg.type === "system" && msg.subtype === "init") {
          if (msg.session_id) {
            newSessionId = msg.session_id;
            log(`INFO session_id: ${msg.session_id.slice(0, 8)}`);
          }
        }

        // Accumulate assistant text and optionally stream chunks
        if (msg.type === "assistant") {
          const content = msg.content ?? msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "text" && block.text) {
                fullText += block.text;
                if (onChunk) onChunk(block.text);
                log(`DIAG text chunk: ${block.text.length} chars`);
              }
            }
          }
        }

        // Capture result session_id and text fallback
        if (msg.type === "result" && msg.subtype === "success") {
          if (msg.session_id) newSessionId = msg.session_id;
          const resultText = msg.result ?? msg.output ?? "";
          if (resultText && !fullText) {
            fullText = resultText;
            if (onChunk) onChunk(resultText);
          }
          log(`INFO result: stop=${msg.stop_reason ?? "?"} len=${fullText.length}`);
        }
      }
      keepLooping = false;

    } catch (err) {
      const errMsg = err?.message ?? String(err);
      log(`WARN query threw: ${errMsg.slice(0, 300)}`);

      const isCompaction =
        /compact/i.test(errMsg) ||
        (/404/.test(errMsg) && /mcp|session/i.test(errMsg));

      if (isCompaction && !retried) {
        log(`WARN compaction: clearing ${chatId} and retrying`);
        await deleteChatSession(chatId);
        fullText     = "";
        newSessionId = null;
        retried      = true;
        // keepLooping stays true → retries
      } else {
        queryError  = err;
        keepLooping = false;
        const friendly = isCompaction
          ? "My conversation history was reset. Please repeat your question."
          : "I ran into an error processing your request. Please try again.";
        fullText = friendly;
        if (onChunk) onChunk(friendly);
        log(`INFO query-error: returning friendly message (isCompaction=${isCompaction}, retried=${retried})`);
      }
    }
  }

  // Persist session (skip on error so we don't save a broken session)
  if (chatId && newSessionId && !queryError) {
    await saveChatSession(chatId, newSessionId);
  }

  return { text: fullText || "(no response)", model: body.model ?? model };
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const { method, url } = req;
  log(`REQ ${method} ${url}`);

  // ── GET /health ─────────────────────────────────────────────────────────────
  if (method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // ── GET /v1/models ──────────────────────────────────────────────────────────
  if (method === "GET" && (url === "/v1/models" || url === "/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        {
          id:         "claude-agent-sdk/claude-haiku-4-5",
          object:     "model",
          created:    0,
          owned_by:   "anthropic",
        },
        {
          id:         "claude-agent-sdk/claude-sonnet-4-6",
          object:     "model",
          created:    0,
          owned_by:   "anthropic",
        },
      ],
    }));
    return;
  }

  // ── POST /v1/chat/completions ───────────────────────────────────────────────
  if (method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
    // Parse request body
    let body;
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (err) {
      log(`ERROR parse body: ${err?.message ?? String(err)}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
      return;
    }

    const wantStream = body.stream === true;
    const reqId      = `chatcmpl-${Date.now()}`;
    const created    = Math.floor(Date.now() / 1000);

    log(`DIAG body: model=${body.model} msgs=${body.messages?.length ?? 0} stream=${wantStream} user=${body.user ?? "(unset)"}`);

    if (wantStream) {
      // ── SSE streaming response ─────────────────────────────────────────────
      res.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      });

      const sendChunk = (deltaContent, finishReason = null) => {
        const chunk = {
          id:      reqId,
          object:  "chat.completion.chunk",
          created,
          model:   body.model ?? "claude-haiku-4-5",
          choices: [{
            index:         0,
            delta:         finishReason ? {} : { role: "assistant", content: deltaContent },
            finish_reason: finishReason,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      // Opening role chunk
      sendChunk("", null);

      try {
        await runChatCompletion(body, (text) => sendChunk(text, null));
        sendChunk("", "stop");
      } catch (err) {
        log(`ERROR streaming completion: ${err?.message ?? String(err)}`);
        sendChunk("I ran into an error. Please try again.", "stop");
      }

      res.write("data: [DONE]\n\n");
      res.end();

    } else {
      // ── Non-streaming response ─────────────────────────────────────────────
      try {
        const { text, model } = await runChatCompletion(body, null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id:      reqId,
          object:  "chat.completion",
          created,
          model:   body.model ?? model,
          choices: [{
            index:         0,
            message:       { role: "assistant", content: text },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
      } catch (err) {
        log(`ERROR non-streaming completion: ${err?.stack ?? err?.message ?? String(err)}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: err?.message ?? "Internal server error",
            type:    "server_error",
          },
        }));
      }
    }
    return;
  }

  // ── 404 ────────────────────────────────────────────────────────────────────
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `Not found: ${method} ${url}`, type: "not_found_error" } }));
});

server.listen(PORT, HOST, () => {
  log(`ready on http://${HOST}:${PORT}`);
});

server.on("error", (err) => {
  log(`ERROR server crashed: ${err?.message ?? String(err)}`);
  process.exit(1);
});
