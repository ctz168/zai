#!/usr/bin/env node
/**
 * Z.AI CLI - Command-line interface for Z.AI API
 *
 * Usage:
 *   zai login [--api-key KEY] [--base-url URL]
 *   zai logout
 *   zai status
 *   zai chat "Hello, who are you?"
 *   zai chat --stream "Tell me a joke"
 *   zai models
 *   zai serve [--port 3456]
 */

import { createInterface } from "node:readline";
import { ZaiClient, ZAI_GLOBAL_BASE_URL, ZAI_CN_BASE_URL, MODELS, isloggedIn, loadConfig, type ZaiModelId } from "./client.js";
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
  let apiKey = flags["api-key"] ?? flags["apikey"] ?? process.env.ZAI_API_KEY;

  if (!apiKey) {
    apiKey = await prompt("Enter your Z.AI API key: ");
  }

  if (!apiKey) {
    console.error("Error: API key is required.");
    process.exit(1);
  }

  const baseUrl = flags["base-url"] ?? flags["baseUrl"] ?? ZAI_GLOBAL_BASE_URL;

  console.log(`Logging in to ${baseUrl}...`);

  try {
    await ZaiClient.login(apiKey, baseUrl);
    console.log("✅ Login successful! API key saved.");
    console.log(`   Config saved to ~/.zai/config.json`);
    console.log(`   Base URL: ${baseUrl}`);
    console.log(`   Default model: glm-4.7-flash`);
  } catch (err) {
    console.error(
      `❌ Login failed: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

async function cmdLogout() {
  ZaiClient.logout();
  console.log("✅ Logged out. API key removed.");
}

async function cmdStatus() {
  const loggedIn = isloggedIn();
  const config = loadConfig();

  console.log(`Logged in: ${loggedIn ? "✅ Yes" : "❌ No"}`);
  if (config) {
    console.log(`Base URL:   ${config.baseUrl}`);
    console.log(`Model:      ${config.defaultModel}`);
    console.log(`API Key:    ${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}`);
  }
  if (!loggedIn) {
    console.log("\nRun `zai login` to authenticate.");
  }
}

async function cmdModels() {
  console.log("\nAvailable Z.AI Models:\n");
  console.log("  Model ID          Name                  Context    Max Tokens");
  console.log("  ───────────────── ───────────────────── ────────── ──────────");

  for (const [id, info] of Object.entries(MODELS)) {
    console.log(
      `  ${id.padEnd(18)} ${(info.name).padEnd(21)} ${String(info.contextWindow).padEnd(10)} ${info.maxTokens}`
    );
  }
  console.log();
}

async function cmdChat(positional: string[], flags: Record<string, string>) {
  const message = positional[0];
  if (!message) {
    console.error("Error: Please provide a message. Usage: zai chat \"your message\"");
    process.exit(1);
  }

  const client = new ZaiClient();
  const model = (flags["model"] ?? flags["m"]) as ZaiModelId | undefined;
  const stream = flags["stream"] === "true" || flags["s"] === "true";
  const system = flags["system"] ?? flags["sys"];

  if (stream) {
    process.stdout.write("\n");
    await client.chatStream(
      message,
      (chunk) => {
        process.stdout.write(chunk);
      },
      { model, system }
    );
    process.stdout.write("\n\n");
  } else {
    const text = await client.chat(message, { model, system });
    console.log(`\n${text}\n`);
  }
}

async function cmdServe(flags: Record<string, string>) {
  const port = parseInt(flags["port"] ?? flags["p"] ?? "3456", 10);
  const host = flags["host"] ?? flags["h"] ?? "127.0.0.1";

  startServer({ port, host });
}

async function cmdHelp() {
  console.log(`
Z.AI CLI - Standalone Z.AI API wrapper

Usage:
  zai <command> [options]

Commands:
  login     Save your Z.AI API key
  logout    Remove saved API key
  status    Check login status
  chat      Send a chat message
  models    List available models
  serve     Start HTTP API server
  help      Show this help

Options:
  --api-key KEY     API key for login
  --base-url URL    API base URL (default: https://api.z.ai/api/paas/v4)
  --model MODEL     Model to use (default: glm-4.7-flash)
  --stream          Stream response (for chat)
  --system PROMPT   System prompt (for chat)
  --port PORT       Server port (for serve, default: 3456)

Examples:
  zai login --api-key your_api_key_here
  zai chat "Hello, who are you?"
  zai chat --stream --model glm-5 "Explain quantum computing"
  zai serve --port 8080

Environment Variables:
  ZAI_API_KEY       API key (alternative to login)

API Server Endpoints (when using 'zai serve'):
  POST /login          Save API key
  POST /chat           Simple chat { "message": "..." }
  POST /chat/stream    Streaming chat (SSE)
  POST /completions    OpenAI-compatible API
  GET  /models         List available models
  GET  /status         Check login status
`);
}

// ─── Prompt Helper ────────────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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
