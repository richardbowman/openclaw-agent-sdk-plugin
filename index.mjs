/**
 * openclaw-claude-agent-sdk-proxy / index.mjs
 *
 * OpenClaw CliBackendPlugin entry point.
 *
 * Registers "claude-agent-sdk" as a first-class CLI backend so OpenClaw
 * assembles subprocess args declaratively rather than having proxy.mjs parse
 * a wall of flags it doesn't need.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Environment variables cleared before spawning proxy.mjs.
// Mirrors the list used by OpenClaw's built-in anthropic/claude-cli backend
// (cli-shared.ts CLAUDE_CLI_CLEAR_ENV) so that stale ambient credentials
// don't shadow the OpenClaw-managed auth.
const CLEAR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_COWORK_PLUGINS",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
];

function buildBackend() {
  return {
    id: "claude-agent-sdk",

    // Tell OpenClaw to generate a Claude-format MCP config file and pass its
    // path to the subprocess via --mcp-config <path>.
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",

    config: {
      command: "node",

      // Fresh-session args. OpenClaw prepends "node" and appends:
      //   --model <model>  (via modelArg)
      //   --append-system-prompt-file <path>  (via systemPromptFileArg)
      //   --mcp-config <path>  (via bundleMcp)
      // plus prompt on stdin  (via input: "stdin")
      args: [
        "/config/claude-sdk-proxy/proxy.mjs",
        "--allowed-tools", "mcp__openclaw__*",
        "--permission-mode", "acceptEdits",
      ],

      // Resume args. Same as args plus the session ID substitution token.
      resumeArgs: [
        "/config/claude-sdk-proxy/proxy.mjs",
        "--allowed-tools", "mcp__openclaw__*",
        "--permission-mode", "acceptEdits",
        "--resume", "{sessionId}",
      ],

      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      liveSession: "claude-stdio",

      // Prompt is delivered on stdin, not as a positional arg.
      input: "stdin",

      // OpenClaw appends "--model <value>" when the user selects a model.
      modelArg: "--model",

      // Field in the JSONL stream that carries the session ID.
      sessionIdFields: ["session_id"],

      // "existing" means OpenClaw always attempts to resume an in-progress
      // session; a missing session just starts fresh.
      sessionMode: "existing",

      // OpenClaw writes the system prompt to a temp file and passes its path
      // via this flag.
      systemPromptFileArg: "--append-system-prompt-file",

      clearEnv: CLEAR_ENV,
    },

    /**
     * Override --permission-mode when OpenClaw YOLO mode is active.
     * Called once per session start before OpenClaw builds the subprocess
     * command line.
     *
     * acceptEdits is already in the base args above and applies to all
     * sessions by default.  This hook only upgrades to bypassPermissions
     * for YOLO mode.
     *
     * Field names verified against OpenClaw source (cli-shared.ts
     * isOpenClawRequestedYolo): context.config.tools.exec.security and
     * context.config.tools.exec.ask are the real keys.  Per-agent overrides
     * live at context.config.agents.list[agentId].tools.exec — OpenClaw
     * handles that lookup itself before calling normalizeConfig, so we read
     * the already-resolved top-level tools.exec here.
     */
    normalizeConfig(config, context) {
      // Override to bypassPermissions if OpenClaw YOLO mode is active.
      // Verified against OpenClaw source (isOpenClawRequestedYolo in cli-shared):
      //   tools.exec.security === "full" && tools.exec.ask === "off"
      // In all other cases acceptEdits is already in the base args above.
      const args = [...(config.args ?? [])];
      const exec = context?.config?.tools?.exec;
      if (exec?.security === "full" && exec?.ask === "off") {
        // Replace acceptEdits with bypassPermissions
        const idx = args.indexOf("acceptEdits");
        if (idx !== -1) args[idx] = "bypassPermissions";
        else args.push("--permission-mode", "bypassPermissions");
      }
      return { ...config, args };
    },

    /**
     * Map OpenClaw thinking levels to --effort values understood by proxy.mjs.
     * Called per-turn; ctx.baseArgs already contains the merged args from config.
     *
     * "off" is omitted intentionally: no --effort flag means the SDK uses its
     * default reasoning budget.
     */
    resolveExecutionArgs(ctx) {
      const effortMap = {
        minimal:  "low",
        low:      "low",
        medium:   "medium",
        high:     "high",
        xhigh:    "xhigh",
        adaptive: "high",
        max:      "max",
      };
      const effort = effortMap[ctx.thinkingLevel];
      if (!effort) return [...ctx.baseArgs];
      return [...ctx.baseArgs, "--effort", effort];
    },
  };
}

export default definePluginEntry({
  id: "claude-agent-sdk",
  name: "Claude Agent SDK",
  description:
    "Claude Code via the Anthropic Agent SDK — richer status events and stable multi-turn streaming",
  register(api) {
    api.registerCliBackend(buildBackend());
  },
});
