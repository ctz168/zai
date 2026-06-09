/**
 * Z.AI Zero-Token HTTP Server
 *
 * Local HTTP API that wraps chat.z.ai via browser-captured cookies.
 * After logging in once (`zai login`), all requests use the persisted
 * cookie state — no API key needed.
 *
 * Endpoints:
 *   GET  /status         - Check login status
 *   POST /chat           - Simple chat
 *   POST /chat/stream    - Streaming chat (SSE)
 *   GET  /models         - List available models
 *   POST /logout         - Clear saved auth
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { isLoggedIn, loadAuth, clearAuth, ASSISTANT_ID_MAP } from "./auth.js";
import { ZaiZeroTokenClient } from "./client.js";

// ─── Helpers ──────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, { error: { message, status } });
}

// ─── Server ───────────────────────────────────────────────────

export interface ServerOptions {
  port?: number;
  host?: string;
}

export function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 3456;
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const path = url.pathname;

    try {
      // ──── GET /status ──────────────────────────────
      if (path === "/status" && req.method === "GET") {
        const auth = loadAuth();
        sendJson(res, 200, {
          logged_in: isLoggedIn(),
          has_refresh_token: auth?.refreshToken ? true : false,
          has_access_token: auth?.accessToken ? true : false,
          captured_at: auth?.capturedAt,
          cookie_length: auth?.cookie?.length ?? 0,
        });
        return;
      }

      // ──── POST /logout ─────────────────────────────
      if (path === "/logout" && req.method === "POST") {
        clearAuth();
        sendJson(res, 200, { ok: true, message: "Logged out" });
        return;
      }

      // ──── GET /models ──────────────────────────────
      if (path === "/models" && req.method === "GET") {
        sendJson(res, 200, {
          object: "list",
          data: Object.entries(ASSISTANT_ID_MAP).map(([id, assistantId]) => ({
            id,
            assistant_id: assistantId,
          })),
        });
        return;
      }

      // ──── POST /chat ───────────────────────────────
      if (path === "/chat" && req.method === "POST") {
        if (!isLoggedIn()) {
          sendError(res, 401, "Not logged in. Run `zai login` first.");
          return;
        }

        const body = JSON.parse(await readBody(req));
        const client = new ZaiZeroTokenClient();

        const message = body.message ?? body.prompt;
        if (!message) {
          sendError(res, 400, "Missing 'message' in request body");
          return;
        }

        const result = await client.chat(message, {
          model: body.model,
          conversationId: body.conversation_id,
          systemPrompt: body.system ?? body.system_prompt,
          history: body.history,
        });

        sendJson(res, 200, {
          message: { role: "assistant", content: result.text },
          conversation_id: result.conversationId,
          thinking: result.thinking,
        });
        return;
      }

      // ──── POST /chat/stream ────────────────────────
      if (path === "/chat/stream" && req.method === "POST") {
        if (!isLoggedIn()) {
          sendError(res, 401, "Not logged in. Run `zai login` first.");
          return;
        }

        const body = JSON.parse(await readBody(req));
        const client = new ZaiZeroTokenClient();

        const message = body.message ?? body.prompt;
        if (!message) {
          sendError(res, 400, "Missing 'message' in request body");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        const sendSSE = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
          const result = await client.chatStream(
            message,
            {
              onText: (delta) => sendSSE("delta", { content: delta }),
              onThinking: (delta) => sendSSE("thinking", { content: delta }),
              onDone: (fullText) => sendSSE("done", {
                content: fullText,
                conversation_id: result.conversationId,
              }),
            },
            {
              model: body.model,
              conversationId: body.conversation_id,
              systemPrompt: body.system ?? body.system_prompt,
              history: body.history,
            }
          );

          sendSSE("done", {
            content: result.text,
            conversation_id: result.conversationId,
            thinking: result.thinking,
          });
        } catch (err) {
          sendSSE("error", {
            message: err instanceof Error ? err.message : String(err),
          });
        }

        res.end();
        return;
      }

      // ──── 404 ──────────────────────────────────────
      sendError(res, 404, `Not found: ${path}`);
    } catch (err) {
      console.error("Request error:", err);
      sendError(res, 500, err instanceof Error ? err.message : "Internal server error");
    }
  });

  server.listen(port, host, () => {
    console.log(`\n  🟢 Z.AI Zero-Token Server running at http://${host}:${port}`);
    console.log(`\n  Endpoints:`);
    console.log(`    GET  /status         - Check login status`);
    console.log(`    POST /chat           - Simple chat`);
    console.log(`    POST /chat/stream    - Streaming chat (SSE)`);
    console.log(`    GET  /models         - List models`);
    console.log(`    POST /logout         - Clear saved auth`);
    console.log();
  });

  return server;
}
