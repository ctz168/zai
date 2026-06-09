#!/usr/bin/env node
import { ZaiClient } from "./client.js";
import { loadSession, clearSession } from "./auth.js";
import { login } from "./auth.js";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "login": {
      console.log("[ZAI] Starting login flow...");
      console.log("[ZAI] A browser window will open. Please login to chat.z.ai with your REAL account");
      console.log("[ZAI] (NOT as guest - use email/password or Google login)");
      try {
        const session = await login({ headless: false });
        console.log("[ZAI] Login successful!");
        // Verify it's not a guest
        const token = session.cookieMap?.token;
        if (token && token.startsWith("eyJ")) {
          try {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
            console.log(`[ZAI] Logged in as: ${payload.email || 'unknown'}`);
          } catch {}
        }
        console.log(`[ZAI] Cookies captured: ${session.cookie.split(";").length}`);
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
        process.exit(1);
      }
      const client = new ZaiClient();
      if (!client.isLoggedIn) {
        console.error("[ZAI] Not logged in or using guest token. Please run: zai login");
        process.exit(1);
      }
      try {
        process.stdout.write("[ZAI] ");
        const result = await client.chat({
          message,
          model: "glm-4-plus",
          stream: true,
          onChunk: (chunk) => process.stdout.write(chunk.delta),
        });
        console.log("\n");
        if (result.conversationId) console.log(`[ZAI] Conversation: ${result.conversationId}`);
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
        console.log(`[ZAI] Access token: ${token.substring(0, 30)}...`);
        // Decode token to show user info
        if (token.startsWith("eyJ")) {
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
          console.log(`[ZAI] User ID: ${payload.id || 'N/A'}`);
          console.log(`[ZAI] Email: ${payload.email || 'N/A'}`);
          const isGuest = payload.email?.includes("guest");
          console.log(`[ZAI] Is guest: ${isGuest ? "YES (NOT REAL LOGIN!)" : "NO (Real user)"}`);
        }
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
      console.log("  login    Login to chat.z.ai via browser (use real account!)");
      console.log("  chat     Send a chat message");
      console.log("  status   Check login status");
      console.log("  logout   Clear saved session");
      console.log("  test     Test API connection (shows if guest or real user)");
      console.log("  server   Start HTTP API server (default port 3210)");
  }
}

main().catch(console.error);
