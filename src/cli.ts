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
 *   zai agent [--name "Bot"]     # Start AICQ Agent mode
 *   zai agent-config             # Configure agent settings
 *   zai logout                   # Clear saved auth
 *   zai help                     # Show help
 */

import { createInterface } from "node:readline";
import { loginViaBrowser, isLoggedIn, loadAuth, clearAuth, ASSISTANT_ID_MAP } from "./auth.js";
import { ZaiZeroTokenClient } from "./client.js";
import { startServer } from "./server.js";
import {
  startAgent,
  loadAgentConfig,
  saveAgentConfig,
  getDefaultAgentConfig,
  ZaiAgentRuntime,
  type AgentConfig,
} from "./agent.js";

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
  const agentConfig = loadAgentConfig();

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
  if (agentConfig) {
    console.log(`\nAgent:`);
    console.log(`  ID:             ${agentConfig.agentId}`);
    console.log(`  Nickname:       ${agentConfig.nickname}`);
    console.log(`  Server:         ${agentConfig.serverUrl}`);
    console.log(`  Model:          ${agentConfig.model}`);
    console.log(`  Masters:        ${agentConfig.masters.length > 0 ? agentConfig.masters.join(", ") : "none"}`);
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

// ─── Agent Commands ───────────────────────────────────────────

async function cmdAgent(flags: Record<string, string>) {
  if (!isLoggedIn()) {
    console.error("❌ Not logged in to Z.AI. Run `zai login` first.");
    process.exit(1);
  }

  console.log("\n🤖 Starting ZAI Agent...\n");

  let runtime: ZaiAgentRuntime;

  try {
    runtime = await startAgent({
      nickname: flags["name"] ?? flags["n"],
      serverUrl: flags["server"] ?? flags["s"],
      model: flags["model"] ?? flags["m"],
      systemPrompt: flags["prompt"],
    });
  } catch (err) {
    console.error(
      `❌ Agent startup failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  const status = runtime.getStatus();

  console.log("══════════════════════════════════════════════════════");
  console.log("  🤖 ZAI Agent is running!");
  console.log("══════════════════════════════════════════════════════");
  console.log(`  Agent ID:    ${status.agentId}`);
  console.log(`  Nickname:    ${status.nickname}`);
  console.log(`  Model:       ${status.model}`);
  console.log(`  AICQ Server: ${runtime.getConfig().serverUrl}`);
  console.log(`  Connected:   ${status.connected ? "✅" : "⏳ Connecting..."}`);
  console.log(`  Masters:     ${status.masters.length > 0 ? status.masters.join(", ") : "none (use /master add <id> in chat)"}`);
  console.log();
  console.log("  Send /help in chat to see admin commands.");
  console.log("  Press Ctrl+C to stop.");
  console.log("══════════════════════════════════════════════════════\n");

  // Keep running
  const shutdown = async () => {
    console.log("\n\n🛑 Shutting down agent...");
    await runtime.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Periodic status check
  setInterval(() => {
    const s = runtime.getStatus();
    if (!s.running) {
      console.error("[Agent] Agent is no longer running. Exiting...");
      process.exit(1);
    }
  }, 30000);
}

async function cmdAgentConfig(positional: string[], flags: Record<string, string>) {
  const subCommand = positional[0];

  if (!subCommand || subCommand === "show") {
    const config = loadAgentConfig();
    if (!config) {
      console.log("No agent configuration found. Run `zai agent` to create one.");
      return;
    }
    console.log("\n🤖 Agent Configuration:\n");
    console.log(`  Agent ID:          ${config.agentId}`);
    console.log(`  Nickname:          ${config.nickname}`);
    console.log(`  AICQ Server:       ${config.serverUrl}`);
    console.log(`  Model:             ${config.model}`);
    console.log(`  System Prompt:     ${config.systemPrompt.substring(0, 80)}...`);
    console.log(`  Masters:           ${config.masters.length > 0 ? config.masters.join(", ") : "none"}`);
    console.log(`  Auto Accept:       ${config.autoAcceptFriends}`);
    console.log(`  Max History:       ${config.maxHistoryPerChat}`);
    console.log(`  Stream Chunk Size: ${config.streamChunkSize}`);
    console.log(`  Stream Chunk Delay: ${config.streamChunkDelay}ms`);
    console.log();
    return;
  }

  if (subCommand === "init" || subCommand === "reset") {
    const config = getDefaultAgentConfig();
    // Apply flags
    if (flags["name"] || flags["n"]) config.nickname = flags["name"] || flags["n"];
    if (flags["server"] || flags["s"]) config.serverUrl = flags["server"] || flags["s"];
    if (flags["model"] || flags["m"]) config.model = flags["model"] || flags["m"];
    if (flags["prompt"]) config.systemPrompt = flags["prompt"];
    saveAgentConfig(config);
    console.log("✅ Agent configuration created/reset.");
    console.log(`   Agent ID: ${config.agentId}`);
    return;
  }

  if (subCommand === "set") {
    let config = loadAgentConfig();
    if (!config) {
      config = getDefaultAgentConfig();
    }

    if (flags["name"] || flags["n"]) config.nickname = flags["name"] || flags["n"];
    if (flags["server"] || flags["s"]) config.serverUrl = flags["server"] || flags["s"];
    if (flags["model"] || flags["m"]) config.model = flags["model"] || flags["m"];
    if (flags["prompt"]) config.systemPrompt = flags["prompt"];
    if (flags["auto-accept"]) config.autoAcceptFriends = flags["auto-accept"] === "true";
    if (flags["chunk-size"]) config.streamChunkSize = parseInt(flags["chunk-size"], 10);
    if (flags["chunk-delay"]) config.streamChunkDelay = parseInt(flags["chunk-delay"], 10);

    saveAgentConfig(config);
    console.log("✅ Agent configuration updated.");
    return;
  }

  if (subCommand === "master") {
    let config = loadAgentConfig();
    if (!config) {
      console.error("No agent configuration. Run `zai agent-config init` first.");
      process.exit(1);
    }

    const action = positional[1];
    const friendId = positional[2];

    if (action === "add" && friendId) {
      if (!config.masters.includes(friendId)) {
        config.masters.push(friendId);
        saveAgentConfig(config);
        console.log(`✅ Added master: ${friendId}`);
      } else {
        console.log(`${friendId} is already a master.`);
      }
    } else if (action === "remove" && friendId) {
      config.masters = config.masters.filter((m) => m !== friendId);
      saveAgentConfig(config);
      console.log(`✅ Removed master: ${friendId}`);
    } else if (action === "list" || !action) {
      console.log(`Masters: ${config.masters.length > 0 ? config.masters.join(", ") : "none"}`);
    } else {
      console.error("Usage: zai agent-config master [add|remove|list] [friend-id]");
    }
    return;
  }

  console.error(`Unknown subcommand: ${subCommand}`);
  console.error("Usage: zai agent-config [show|init|set|master] [options]");
}

async function cmdHelp() {
  console.log(`
Z.AI Zero-Token CLI - Use chat.z.ai without an API key

Usage:
  zai <command> [options]

Commands:
  login         Login via browser (opens chat.z.ai)
  logout        Clear saved authentication
  status        Check login status
  chat          Send a chat message
  models        List available models
  serve         Start HTTP API server
  agent         Start AICQ Agent mode (connect to aicq.online)
  agent-config  Configure agent settings
  help          Show this help

Login Options:
  --cdp-url URL     Connect to running Chrome via CDP
  --headless        Run browser in headless mode (not recommended for login)

Chat Options:
  --model MODEL     Model to use (default: glm-4)
  --stream          Stream response in real-time

Server Options:
  --port PORT       Server port (default: 3456)
  --host HOST       Server host (default: 127.0.0.1)

Agent Options:
  --name NAME       Agent display name
  --server URL      AICQ server URL (default: https://aicq.online)
  --model MODEL     LLM model to use (default: glm-4-plus)
  --prompt TEXT     System prompt for the agent

Agent Config Commands:
  zai agent-config show                      Show current config
  zai agent-config init [--name "My Bot"]    Initialize/reset config
  zai agent-config set [--model glm-4-plus]  Update config values
  zai agent-config master add <friend-id>    Add a master
  zai agent-config master remove <friend-id> Remove a master
  zai agent-config master list               List masters

Examples:
  zai login                                    # Opens browser, login to chat.z.ai
  zai login --cdp-url http://localhost:9222     # Use existing Chrome
  zai chat "Hello, who are you?"
  zai chat --stream --model glm-4-plus "Explain AI"
  zai serve --port 8080
  zai agent --name "My Bot"                     # Start AICQ agent
  zai agent --model glm-4-plus                  # Use specific model
  zai agent-config master add friend_abc123     # Set a master

Agent Mode:
  'zai agent' starts an AI agent that connects to aicq.online
  via the AICQ protocol. It can receive messages from friends
  and groups, process them with Z.AI's LLM, and send streaming
  replies back.

  Agent admin commands (from master users in chat):
    /help          Show all admin commands
    /status        View agent status
    /model NAME    Switch model
    /prompt TEXT   Set system prompt
    /master        Manage masters
    /clear         Clear conversation memory
    /friend add    Add friend by code
    /group list    List groups

How It Works:
  1. 'zai login' opens a real browser to chat.z.ai
  2. You login manually (Google, GitHub, email, etc.)
  3. Cookies are captured and saved to ~/.zai/auth.json
  4. 'zai chat' uses those cookies to call the API directly
  5. 'zai agent' connects to aicq.online and acts as an AI bot
  6. No API key needed — zero token!

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
    case "agent":
      await cmdAgent(flags);
      break;
    case "agent-config":
      await cmdAgentConfig(positional, flags);
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
