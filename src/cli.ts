#!/usr/bin/env node
/**
 * Z.AI Zero-Token CLI
 *
 * Login via browser (zero token), then chat freely.
 *
 * Usage:
 *   zai login                    # Open browser, login to chat.z.ai
 *   zai login --cdp-url URL      # Connect to running Chrome
 *   zai status                   # Check login status
 *   zai chat "Hello!"            # Chat
 *   zai chat --stream "Hello!"   # Streaming chat
 *   zai serve [--port 3456]      # Start HTTP API server
 *   zai logout                   # Clear saved auth
 *   zai help                     # Show help
 */

import { createInterface } from "node:readline";
import { loginViaBrowser, isLoggedIn, loadAuth, clearAuth, ASSISTANT_ID_MAP } from "./auth.js";
import { ZaiZeroTokenClient } from "./client.js";
import { startServer } from "./server.js";

// ─── Parse Args ───────────────────────────────────────────────

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string>;
} {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else if (arg) {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

// ─── Commands ─────────────────────────────────────────────────

async function cmdLogin(flags: Record<string, string>) {
  const cdpUrl = flags["cdp-url"] ?? flags["cdpUrl"];
  const headless = flags["headless"] === "true";

  try {
    await loginViaBrowser({
      headless,
      cdpUrl,
    });
    console.log("\n✅ You can now use `zai chat` to chat without an API key!");
  } catch (err) {
    console.error(
      `\n❌ Login failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

async function cmdLogout() {
  clearAuth();
  console.log("✅ Logged out. Auth state cleared.");
}

async function cmdStatus() {
  const loggedIn = isLoggedIn();
  const auth = loadAuth();

  console.log(`Logged in:       ${loggedIn ? "✅ Yes" : "❌ No"}`);
  if (auth) {
    const age = Date.now() - auth.capturedAt;
    const hours = Math.floor(age / 3600000);
    const minutes = Math.floor((age % 3600000) / 60000);
    console.log(`Captured:        ${hours}h ${minutes}m ago`);
    console.log(`Refresh token:   ${auth.refreshToken ? "✓" : "✗"}`);
    console.log(`Access token:    ${auth.accessToken ? "✓" : "✗"}`);
    console.log(`Cookie length:   ${auth.cookie.length}`);
  }
  if (!loggedIn) {
    console.log("\nRun `zai login` to authenticate via browser.");
  }
}

async function cmdChat(positional: string[], flags: Record<string, string>) {
  const message = positional[0];
  if (!message) {
    console.error("Error: Please provide a message. Usage: zai chat \"your message\"");
    process.exit(1);
  }

  if (!isLoggedIn()) {
    console.error("Error: Not logged in. Run `zai login` first.");
    process.exit(1);
  }

  const client = new ZaiZeroTokenClient();
  const model = flags["model"] ?? flags["m"];
  const stream = flags["stream"] === "true" || flags["s"] === "true";

  if (stream) {
    process.stdout.write("\n");
    const result = await client.chatStream(
      message,
      {
        onText: (delta) => process.stdout.write(delta),
        onThinking: (delta) => process.stderr.write(`[think] ${delta}`),
      },
      { model }
    );
    process.stdout.write("\n\n");
    if (result.conversationId) {
      console.log(`(conversation: ${result.conversationId})`);
    }
  } else {
    const result = await client.chat(message, { model });
    console.log(`\n${result.text}\n`);
    if (result.thinking) {
      console.log(`[thinking]: ${result.thinking.substring(0, 200)}...`);
    }
  }
}

async function cmdModels() {
  console.log("\nAvailable Models (via chat.z.ai web API):\n");
  console.log("  Model ID          Assistant ID");
  console.log("  ───────────────── ──────────────────────────────");
  for (const [id, assistantId] of Object.entries(ASSISTANT_ID_MAP)) {
    console.log(`  ${id.padEnd(18)} ${assistantId}`);
  }
  console.log();
}

async function cmdServe(flags: Record<string, string>) {
  const port = parseInt(flags["port"] ?? flags["p"] ?? "3456", 10);
  const host = flags["host"] ?? flags["h"] ?? "127.0.0.1";
  startServer({ port, host });
}

async function cmdHelp() {
  console.log(`
Z.AI Zero-Token CLI - Use chat.z.ai without an API key

Usage:
  zai <command> [options]

Commands:
  login     Login via browser (opens chat.z.ai)
  logout    Clear saved authentication
  status    Check login status
  chat      Send a chat message
  models    List available models
  serve     Start HTTP API server
  help      Show this help

Login Options:
  --cdp-url URL     Connect to running Chrome via CDP
  --headless        Run browser in headless mode (not recommended for login)

Chat Options:
  --model MODEL     Model to use (default: glm-4)
  --stream          Stream response in real-time

Server Options:
  --port PORT       Server port (default: 3456)
  --host HOST       Server host (default: 127.0.0.1)

Examples:
  zai login                          # Opens browser, login to chat.z.ai
  zai login --cdp-url http://localhost:9222  # Use existing Chrome
  zai chat "Hello, who are you?"
  zai chat --stream --model glm-4-plus "Explain AI"
  zai serve --port 8080

How It Works:
  1. 'zai login' opens a real browser to chat.z.ai
  2. You login manually (Google, GitHub, email, etc.)
  3. Cookies are captured and saved to ~/.zai/auth.json
  4. 'zai chat' uses those cookies to call the API directly
  5. No API key needed — zero token!

API Server Endpoints (when using 'zai serve'):
  GET  /status         Check login status
  POST /chat           Simple chat { "message": "..." }
  POST /chat/stream    Streaming chat (SSE)
  GET  /models         List available models
  POST /logout         Clear saved auth
`);
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const { command, positional, flags } = parseArgs(process.argv);

  switch (command) {
    case "login":
      await cmdLogin(flags);
      break;
    case "logout":
      await cmdLogout();
      break;
    case "status":
      await cmdStatus();
      break;
    case "chat":
      await cmdChat(positional, flags);
      break;
    case "models":
      await cmdModels();
      break;
    case "serve":
    case "server":
      await cmdServe(flags);
      break;
    case "help":
    case "--help":
    case "-h":
      await cmdHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'zai help' for usage information.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
