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
import { readFile }         from "fs/promises";

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Safely read a file, returning undefined on any error. */
async function tryReadFile(path) {
  if (!path) return undefined;
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
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
  } catch {
    return undefined;
  }
}

/** Write a single JSONL line to stdout. */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
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
  // Kick off file reads in parallel before we start consuming stdin.
  const [mcpServers, appendSystemPrompt] = await Promise.all([
    tryReadMcpConfig(mcpConfigFile),
    tryReadFile(syspromptFile),
  ]);

  // Re-inject the OAuth token if a token file is present.
  //
  // OpenClaw's CLEAR_ENV list strips CLAUDE_CODE_OAUTH_TOKEN before spawning
  // this process, so process.env has no auth credentials.  The Agent SDK
  // passes env: {...process.env} to the claude subprocess it spawns, which
  // means the subprocess also has no token and returns "Not logged in".
  //
  // The token file path is a well-known mount point set by docker-e2e.sh
  // (and should be set the same way in production HA installs).  If the file
  // is absent we leave process.env untouched; OpenClaw's own credential
  // management handles auth in normal operation.
  const TOKEN_FILE_PATH = "/run/claude-auth/oauth_token";
  const oauthTokenFromFile = await tryReadFile(TOKEN_FILE_PATH);
  const subprocessEnv = oauthTokenFromFile
    ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: oauthTokenFromFile }
    : { ...process.env };

  const options = {
    // Use the system `claude` binary that OpenClaw already installed.
    pathToClaudeCodeExecutable: "claude",

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
}

main().catch((err) => {
  // Write errors to stderr so they appear in OpenClaw's CLI backend log,
  // not in the JSONL stream that OpenClaw is parsing.
  process.stderr.write(
    `[claude-agent-sdk-proxy] ${err?.stack ?? err?.message ?? String(err)}\n`,
  );
  process.exit(1);
});
