#!/usr/bin/env node
import { ZaiClient } from "./client.js";
import { loadSession, clearSession } from "./config.js";
import { login } from "./auth.js";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "login": {
      console.log("[ZAI] Starting login flow...");
      console.log("[ZAI] A browser window will open. Please login to chat.z.ai");
      try {
        const session = await login({ headless: false });
        console.log("[ZAI] Login successful!");
        console.log(`[ZAI] Cookies captured: ${session.cookie.split(";").length}`);
        console.log(`[ZAI] User-Agent: ${session.userAgent?.substring(0, 60)}...`);
      } catch (err) {
        console.error("[ZAI] Login failed:", err.message);
        process.exit(1);
      }
      break;
    }

    case "chat": {
      const message = args.slice(1).join(" ");
      if (!message) {
        console.error("Usage: zai chat <message>");
        console.error("Example: zai chat Hello, how are you?");
        process.exit(1);
      }

      const client = new ZaiClient();
      if (!client.isLoggedIn) {
        console.error("[ZAI] Not logged in. Please run: zai login");
        process.exit(1);
      }

      try {
        process.stdout.write("[ZAI] Thinking... ");
        const result = await client.chat({
          message,
          model: "glm-4-plus",
          stream: true,
          onChunk: (chunk) => {
            process.stdout.write(chunk.delta);
          },
        });
        console.log("\n");
        console.log(`[ZAI] Conversation ID: ${result.conversationId}`);
      } catch (err) {
        console.error("\n[ZAI] Chat error:", err.message);
        process.exit(1);
      }
      break;
    }

    case "status": {
      const client = new ZaiClient();
      const status = await client.status();
      console.log("[ZAI] Status:", JSON.stringify(status, null, 2));
      break;
    }

    case "logout": {
      clearSession();
      console.log("[ZAI] Logged out. Session cleared.");
      break;
    }

    case "test": {
      const client = new ZaiClient();
      if (!client.isLoggedIn) {
        console.error("[ZAI] Not logged in. Please run: zai login first");
        process.exit(1);
      }

      console.log("[ZAI] Testing API connection...");
      try {
        const token = await client.refreshAccessToken();
        console.log(`[ZAI] Access token obtained: ${token.substring(0, 20)}...`);
        console.log("[ZAI] Connection test passed!");
      } catch (err) {
        console.error("[ZAI] Connection test failed:", err.message);
        process.exit(1);
      }
      break;
    }

    case "server": {
      const port = args[1] ? parseInt(args[1]) : 3210;
      process.env.ZAI_PORT = port.toString();
      console.log(`[ZAI] Starting API server on port ${port}...`);
      await import("./server.js");
      break;
    }

    default:
      console.log("ZAI - Zero-Token SDK for chat.z.ai");
      console.log("");
      console.log("Usage: zai <command> [options]");
      console.log("");
      console.log("Commands:");
      console.log("  login    Login to chat.z.ai via browser");
      console.log("  chat     Send a chat message");
      console.log("  status   Check login status");
      console.log("  logout   Clear saved session");
      console.log("  test     Test API connection");
      console.log("  server   Start HTTP API server (default port 3210)");
      console.log("");
      console.log("Examples:");
      console.log("  zai login");
      console.log("  zai chat Hello, how are you?");
      console.log("  zai server 3210");
  }
}

main().catch(console.error);
