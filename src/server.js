import http from "node:http";
import { ZaiClient } from "./client.js";
import { loadSession, clearSession } from "./config.js";
import { login } from "./auth.js";

const PORT = process.env.ZAI_PORT || 3210;

export async function startServer() {
  const client = new ZaiClient();
  
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);
    
    try {
      // GET /status - Check login status
      if (req.method === "GET" && url.pathname === "/status") {
        const status = await client.status();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
        return;
      }

      // POST /login - Start login flow (launches browser)
      if (req.method === "POST" && url.pathname === "/login") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Login started. Please complete login in the browser window." }));
        
        // Start login in background
        login({ headless: false })
          .then((session) => {
            client.session = session;
            client.accessToken = null;
            console.log("[ZAI Server] Login completed and session updated");
          })
          .catch((err) => {
            console.error("[ZAI Server] Login failed:", err.message);
          });
        return;
      }

      // POST /logout - Clear session
      if (req.method === "POST" && url.pathname === "/logout") {
        clearSession();
        client.session = null;
        client.accessToken = null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Logged out successfully" }));
        return;
      }

      // POST /chat - Send chat message
      if (req.method === "POST" && url.pathname === "/chat") {
        const body = await readBody(req);
        const params = JSON.parse(body);
        
        if (!params.message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "message is required" }));
          return;
        }

        if (!client.isLoggedIn) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not logged in. POST /login first" }));
          return;
        }

        // Reload session if client doesn't have it but file exists
        if (!client.session) {
          client.session = loadSession();
        }

        const stream = params.stream !== false;

        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const result = await client.chat({
            message: params.message,
            model: params.model || "glm-4-plus",
            conversationId: params.conversation_id,
            stream: true,
            onChunk: (chunk) => {
              const sseData = JSON.stringify({
                delta: chunk.delta,
                conversation_id: chunk.conversationId,
              });
              res.write(`data: ${sseData}\n\n`);
            },
          });

          res.write(`data: ${JSON.stringify({ done: true, content: result.content, conversation_id: result.conversationId })}\n\n`);
          res.end();
        } else {
          const result = await client.chat({
            message: params.message,
            model: params.model || "glm-4-plus",
            conversationId: params.conversation_id,
            stream: false,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }
        return;
      }

      // GET / - API info
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          name: "ZAI Zero-Token API Server",
          version: "1.0.0",
          endpoints: {
            "GET /": "API info",
            "GET /status": "Check login status",
            "POST /login": "Start browser login",
            "POST /logout": "Clear session",
            "POST /chat": "Send chat message (body: {message, model?, stream?, conversation_id?})",
          },
        }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      console.error("[ZAI Server] Error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(PORT, () => {
    console.log(`[ZAI] Server running at http://localhost:${PORT}`);
    console.log(`[ZAI] Endpoints:`);
    console.log(`  GET  /        - API info`);
    console.log(`  GET  /status  - Check login status`);
    console.log(`  POST /login   - Start browser login`);
    console.log(`  POST /logout  - Clear session`);
    console.log(`  POST /chat    - Send chat message`);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// Run if called directly
startServer().catch(console.error);
