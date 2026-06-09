/**
 * Z.AI HTTP Server
 *
 * Provides a local HTTP API server that wraps the Z.AI global endpoint.
 * After logging in once (POST /login), all subsequent requests use the
 * persisted API key automatically.
 *
 * Endpoints:
 *   POST /login          - Save API key
 *   GET  /status         - Check login status
 *   POST /chat           - Simple chat (returns full text)
 *   POST /chat/stream    - Streaming chat (SSE)
 *   POST /completions    - OpenAI-compatible chat completions
 *   GET  /models         - List available models
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { ZaiClient, ZAI_GLOBAL_BASE_URL, MODELS, isloggedIn, type ZaiModelId, type ChatMessage, type ZaiTool } from "./client.js";

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
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, { error: { message, status } });
}

function getCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ─── Server ───────────────────────────────────────────────────

export interface ServerOptions {
  port?: number;
  host?: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: ZaiModelId;
}

export function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 3456;
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    const corsHeaders = getCorsHeaders();

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const path = url.pathname;

    try {
      // ──── POST /login ──────────────────────────────
      if (path === "/login" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const apiKey = body.api_key ?? body.apiKey ?? body.token;
        const baseUrl = body.base_url ?? body.baseUrl ?? ZAI_GLOBAL_BASE_URL;

        if (!apiKey) {
          sendError(res, 400, "Missing api_key in request body");
          return;
        }

        try {
          await ZaiClient.login(apiKey, baseUrl);
          sendJson(res, 200, {
            ok: true,
            message: "Login successful. API key saved.",
            base_url: baseUrl,
          });
        } catch (err) {
          sendError(
            res,
            401,
            `Login failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }

      // ──── GET /status ──────────────────────────────
      if (path === "/status" && req.method === "GET") {
        sendJson(res, 200, {
          logged_in: isloggedIn(),
          base_url: ZAI_GLOBAL_BASE_URL,
          default_model: options.defaultModel ?? "glm-4.7-flash",
        });
        return;
      }

      // ──── POST /logout ─────────────────────────────
      if (path === "/logout" && req.method === "POST") {
        ZaiClient.logout();
        sendJson(res, 200, { ok: true, message: "Logged out" });
        return;
      }

      // ──── GET /models ──────────────────────────────
      if (path === "/models" && req.method === "GET") {
        const modelList = Object.entries(MODELS).map(([id, info]) => ({
          id,
          ...info,
        }));
        sendJson(res, 200, {
          object: "list",
          data: modelList,
        });
        return;
      }

      // ──── POST /chat ───────────────────────────────
      if (path === "/chat" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const client = new ZaiClient({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          defaultModel: options.defaultModel,
        });

        const message = body.message ?? body.prompt;
        if (!message) {
          sendError(res, 400, "Missing 'message' in request body");
          return;
        }

        const text = await client.chat(message, {
          system: body.system ?? body.system_prompt,
          model: body.model as ZaiModelId | undefined,
          temperature: body.temperature,
          history: body.history as ChatMessage[] | undefined,
        });

        res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
        res.end(
          JSON.stringify({
            message: { role: "assistant", content: text },
            model: body.model ?? options.defaultModel ?? "glm-4.7-flash",
          })
        );
        return;
      }

      // ──── POST /chat/stream ────────────────────────
      if (path === "/chat/stream" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const client = new ZaiClient({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          defaultModel: options.defaultModel,
        });

        const message = body.message ?? body.prompt;
        if (!message) {
          sendError(res, 400, "Missing 'message' in request body");
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders,
        });

        const sendSSE = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
          const fullText = await client.chatStream(
            message,
            (chunk) => {
              sendSSE("delta", { content: chunk });
            },
            {
              system: body.system ?? body.system_prompt,
              model: body.model as ZaiModelId | undefined,
              temperature: body.temperature,
              history: body.history as ChatMessage[] | undefined,
            }
          );
          sendSSE("done", { content: fullText });
        } catch (err) {
          sendSSE("error", {
            message: err instanceof Error ? err.message : String(err),
          });
        }

        res.end();
        return;
      }

      // ──── POST /completions (OpenAI-compatible) ────
      if (path === "/completions" && req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const client = new ZaiClient({
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          defaultModel: options.defaultModel,
        });

        const isStream = body.stream === true;

        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...corsHeaders,
          });

          for await (const chunk of client.chatCompletionStream({
            model: body.model as ZaiModelId | undefined,
            messages: body.messages as ChatMessage[],
            temperature: body.temperature,
            topP: body.top_p,
            maxTokens: body.max_tokens,
            tools: body.tools as ZaiTool[] | undefined,
          })) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          const result = await client.chatCompletion({
            model: body.model as ZaiModelId | undefined,
            messages: body.messages as ChatMessage[],
            temperature: body.temperature,
            topP: body.top_p,
            maxTokens: body.max_tokens,
            tools: body.tools as ZaiTool[] | undefined,
          });
          sendJson(res, 200, result);
        }
        return;
      }

      // ──── 404 ──────────────────────────────────────
      sendError(res, 404, `Not found: ${path}`);
    } catch (err) {
      console.error("Request error:", err);
      sendError(
        res,
        500,
        err instanceof Error ? err.message : "Internal server error"
      );
    }
  });

  server.listen(port, host, () => {
    console.log(`\n  🟢 Z.AI API Server running at http://${host}:${port}`);
    console.log(`\n  Endpoints:`);
    console.log(`    POST /login          - Save your API key`);
    console.log(`    GET  /status         - Check login status`);
    console.log(`    POST /chat           - Simple chat`);
    console.log(`    POST /chat/stream    - Streaming chat (SSE)`);
    console.log(`    POST /completions    - OpenAI-compatible API`);
    console.log(`    GET  /models         - List available models`);
    console.log(`    POST /logout         - Remove saved API key`);
    console.log();
  });

  return server;
}
