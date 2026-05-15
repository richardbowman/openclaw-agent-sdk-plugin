#!/usr/bin/env node
/**
 * test-harness.mjs
 *
 * Runs a series of integration tests against proxy.mjs by spawning it as a
 * subprocess and verifying its JSONL stdout output.
 *
 * Requires a valid Claude OAuth session in /root/.claude (mounted from the host).
 * Tests make real Claude API calls — expect a few seconds per test.
 */

import { spawn } from "child_process";

const PROXY = "/config/claude-sdk-proxy/proxy.mjs";
const TIMEOUT_MS = 120_000; // 2 minutes per test

// Standard per-turn args as assembled by the CliBackendPlugin (index.mjs).
// OpenClaw no longer passes the old claude-CLI flags; only the args declared
// in CliBackendConfig reach proxy.mjs.
const BASE_ARGS = [
  "--allowed-tools", "mcp__openclaw__*",
];

// Extra args for live-session mode
const LIVE_ARGS = [...BASE_ARGS, "--input-format", "stream-json"];

// ─── Helper: build a live-session user message JSON line ──────────────────────

function liveUserLine(text, sessionId = "") {
  return JSON.stringify({
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  }) + "\n";
}

// ─── Helper: run the proxy, collect output ────────────────────────────────────

/**
 * @param {string[]} args       - Extra args after "node PROXY"
 * @param {string}   stdinPayload - Full string to write to stdin (then close it)
 * @returns {{ lines: any[], exitCode: number }}
 */
async function runProxy(args, stdinPayload) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [PROXY, ...args], {
      env: {
        ...process.env,
        // HOME is set by docker-test.sh via -e HOME.  Fall back to /home/claude
        // (the non-root container user) so the claude CLI finds its config.
        HOME: process.env.HOME ?? "/home/claude",
        PATH: `${process.env.HOME ?? "/home/claude"}/.npm-global/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutBuf = [];
    const stderrBuf = [];

    child.stdout.on("data", (d) => stdoutBuf.push(d));
    child.stderr.on("data", (d) => stderrBuf.push(d));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Proxy timed out after " + TIMEOUT_MS + "ms"));
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const raw = Buffer.concat(stdoutBuf).toString("utf8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return l; // keep raw string if not JSON
          }
        });

      if (stderrBuf.length > 0) {
        const errText = Buffer.concat(stderrBuf).toString("utf8").trim();
        if (errText) process.stderr.write(`  [stderr] ${errText}\n`);
      }

      resolve({ lines, exitCode: code ?? 0 });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Write payload to stdin, then close it so the proxy knows we're done.
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

/**
 * Like runProxy but sends multiple stdin chunks without closing between them.
 * Useful for multi-turn live-session tests where we need the process to stay
 * alive until all turns are sent.
 *
 * @param {string[]} args
 * @param {string[]} turns - Array of stdin strings to send sequentially.
 *                           Stdin is closed after the last turn.
 * @param {number}   pauseMs - Time to wait between turns (ms).
 * @returns {{ lines: any[], exitCode: number }}
 */
async function runProxyMultiTurn(args, turns, pauseMs = 500) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [PROXY, ...args], {
      env: {
        ...process.env,
        // HOME is set by docker-test.sh via -e HOME.  Fall back to /home/claude
        // (the non-root container user) so the claude CLI finds its config.
        HOME: process.env.HOME ?? "/home/claude",
        PATH: `${process.env.HOME ?? "/home/claude"}/.npm-global/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutBuf = [];
    const stderrBuf = [];

    child.stdout.on("data", (d) => stdoutBuf.push(d));
    child.stderr.on("data", (d) => stderrBuf.push(d));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Proxy timed out after " + TIMEOUT_MS + "ms"));
    }, TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      const raw = Buffer.concat(stdoutBuf).toString("utf8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return l;
          }
        });

      if (stderrBuf.length > 0) {
        const errText = Buffer.concat(stderrBuf).toString("utf8").trim();
        if (errText) process.stderr.write(`  [stderr] ${errText}\n`);
      }

      resolve({ lines, exitCode: code ?? 0 });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Send turns sequentially with a short pause between each so the proxy can
    // finish processing the previous turn before receiving the next one.
    (async () => {
      for (let i = 0; i < turns.length; i++) {
        child.stdin.write(turns[i]);
        if (i < turns.length - 1) {
          // Wait for the proxy to process this turn before sending the next.
          // We detect the "result" line for the current turn in the output buffer.
          await waitForResult(stdoutBuf, pauseMs);
        }
      }
      child.stdin.end();
    })().catch(reject);
  });
}

/**
 * Wait until the accumulated stdout contains a "result" line or until
 * maxWaitMs elapses. Used to sequence multi-turn live session tests.
 */
function waitForResult(bufArr, maxWaitMs = 60_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const text = Buffer.concat(bufArr).toString("utf8");
      const hasResult = text
        .split("\n")
        .some((l) => {
          try {
            return JSON.parse(l.trim())?.type === "result";
          } catch {
            return false;
          }
        });
      if (hasResult || Date.now() - start > maxWaitMs) {
        clearInterval(interval);
        resolve();
      }
    }, 200);
  });
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  process.stdout.write(`Running: ${name} ... `);
  try {
    const reason = await fn();
    if (reason) {
      console.log(`FAIL — ${reason}`);
      failed++;
    } else {
      console.log("PASS");
      passed++;
    }
  } catch (err) {
    console.log(`FAIL — threw: ${err.message}`);
    failed++;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// 1. Per-turn basic
await runTest("per-turn basic", async () => {
  const { lines, exitCode } = await runProxy(
    BASE_ARGS,
    "Hello, please reply with just the word PONG",
  );
  if (exitCode !== 0) return `exit code ${exitCode}`;
  const hasResult = lines.some((l) => l?.type === "result");
  if (!hasResult) return `no result line found (got ${lines.length} lines)`;
  return null;
});

// 2. Live session single turn
await runTest("live session single turn", async () => {
  const { lines, exitCode } = await runProxy(
    LIVE_ARGS,
    liveUserLine("Hello, please reply with just the word PONG"),
  );
  if (exitCode !== 0) return `exit code ${exitCode}`;
  const hasResult = lines.some((l) => l?.type === "result");
  if (!hasResult) return `no result line found (got ${lines.length} lines)`;
  return null;
});

// 3. Live session two turns
await runTest("live session two turns", async () => {
  const { lines, exitCode } = await runProxyMultiTurn(
    LIVE_ARGS,
    [
      liveUserLine("Hello, please reply with just the word PONG"),
      liveUserLine("What is 2+2?"),
    ],
  );
  if (exitCode !== 0) return `exit code ${exitCode}`;
  const resultLines = lines.filter((l) => l?.type === "result");
  if (resultLines.length < 2) {
    return `expected 2 result lines, got ${resultLines.length}`;
  }
  return null;
});

// 4. session_start emitted
await runTest("session_start emitted", async () => {
  const { lines, exitCode } = await runProxy(
    BASE_ARGS,
    "Hello, please reply with just the word PONG",
  );
  if (exitCode !== 0) return `exit code ${exitCode}`;
  const sessionStart = lines.find(
    (l) => l?.type === "system" && l?.subtype === "session_start",
  );
  if (!sessionStart) return "no system/session_start line found";
  if (!sessionStart.session_id) return "session_id is empty or missing";
  return null;
});

// 5. Tool hooks emitted
// Run with bypassPermissions so the Read tool actually executes and
// PostToolUse fires.  Without permission bypass the SDK blocks the tool
// before completion and PostToolUse never fires.
await runTest("tool hooks emitted", async () => {
  const { lines, exitCode } = await runProxy(
    [...BASE_ARGS, "--permission-mode", "bypassPermissions"],
    "Use the Read tool to read /etc/hostname",
  );
  if (exitCode !== 0) return `exit code ${exitCode}`;
  const toolStart = lines.find(
    (l) => l?.type === "system" && l?.subtype === "tool_use_start",
  );
  const toolEnd = lines.find(
    (l) => l?.type === "system" && l?.subtype === "tool_use_end",
  );
  if (!toolStart) return "no system/tool_use_start line found";
  if (!toolEnd) return "no system/tool_use_end line found";
  return null;
});

// 6. Permission mode passthrough
await runTest("permission mode passthrough", async () => {
  const { lines, exitCode } = await runProxy(
    [...BASE_ARGS, "--permission-mode", "acceptEdits"],
    "Say hello",
  );
  if (exitCode !== 0) return `exit code ${exitCode}`;
  const hasResult = lines.some((l) => l?.type === "result");
  if (!hasResult) return `no result line found (got ${lines.length} lines)`;
  return null;
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log("");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
