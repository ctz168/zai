/**
 * Z.AI Zero-Token Client
 *
 * Uses browser-captured cookies to call the chat.z.ai API directly,
 * without needing an API key. Supports streaming, token refresh,
 * and conversation management.
 */

import crypto from "node:crypto";
import {
  loadAuth,
  saveAuth,
  generateSign,
  extractRefreshToken,
  extractAccessToken,
  refreshAccessToken,
  ZAI_API_BASE,
  SIGN_SECRET,
  X_EXP_GROUPS,
  ASSISTANT_ID_MAP,
  DEFAULT_ASSISTANT_ID,
  type ZaiAuthState,
} from "./auth.js";

// ─── Proxy Configuration ──────────────────────────────────────
// When ZAI_PROXY_URL is set (e.g., http://aicq.online:9876),
// all API requests are routed through this proxy to bypass CDN blocking.
// The proxy runs on a remote Windows server that has access to chat.z.ai.

const ZAI_PROXY_URL = process.env.ZAI_PROXY_URL || "";

function getApiBase(): string {
  if (ZAI_PROXY_URL) {
    return ZAI_PROXY_URL.replace(/\/+$/, "");
  }
  return ZAI_API_BASE;
}

if (ZAI_PROXY_URL) {
  console.log(`[ZAI] Using proxy: ${ZAI_PROXY_URL} → ${ZAI_API_BASE}`);
}

// ─── Types ────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  conversationId?: string;
  systemPrompt?: string;
  history?: ChatMessage[];
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  conversationId: string;
  thinking?: string;
}

export interface StreamCallbacks {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onDone?: (fullText: string) => void;
  onError?: (error: string) => void;
}

// ─── Client ───────────────────────────────────────────────────

export class ZaiZeroTokenClient {
  private auth: ZaiAuthState;
  private accessToken: string | null;
  private deviceId: string;
  private conversationMap: Map<string, string> = new Map();

  constructor(auth?: ZaiAuthState) {
    this.auth = auth ?? loadAuth()!;
    if (!this.auth) {
      // Cookie-based API not available — will be used as fallback only
      // The SDK backend will be used instead
      console.log("[ZAI] No cookie auth available, cookie-based API disabled");
      this.auth = {} as ZaiAuthState;
    }
    this.accessToken = this.auth.accessToken || null;
    this.deviceId = crypto.randomUUID().replace(/-/g, "");
  }

  private async ensureAccessToken(): Promise<string> {
    // Try cached access token
    if (this.accessToken) {
      return this.accessToken;
    }

    // Try extracting from cookie
    const fromCookie = extractAccessToken(this.auth.cookie);
    if (fromCookie) {
      this.accessToken = fromCookie;
      return this.accessToken;
    }

    // Refresh using refresh token
    const refreshToken = extractRefreshToken(this.auth.cookie) ?? this.auth.refreshToken;
    if (!refreshToken) {
      throw new Error("No refresh token available. Please run `zai login` again.");
    }

    console.log("[ZAI] Refreshing access token...");
    this.accessToken = await refreshAccessToken(refreshToken);

    // Update persisted auth
    this.auth.accessToken = this.accessToken;
    saveAuth(this.auth);

    return this.accessToken;
  }

  /**
   * Build the request headers required by chat.z.ai
   */
  private buildHeaders(accessToken: string): Record<string, string> {
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");

    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${accessToken}`,
      "App-Name": "chatglm",
      Origin: ZAI_API_BASE,
      "X-App-Platform": "pc",
      "X-App-Version": "0.0.1",
      "X-App-fr": "default",
      "X-Device-Brand": "",
      "X-Device-Id": this.deviceId,
      "X-Device-Model": "",
      "X-Exp-Groups": X_EXP_GROUPS,
      "X-Lang": "zh",
      "X-Nonce": sign.nonce,
      "X-Request-Id": requestId,
      "X-Sign": sign.sign,
      "X-Timestamp": sign.timestamp,
      Cookie: this.auth.cookie,
    };
  }

  /**
   * Build the request body for Z.AI /api/v2/chat/completions API
   */
  private buildBodyV2(message: string, model: string, conversationId?: string): string {
    return JSON.stringify({
      model,
      messages: [
        { role: "user", content: message },
      ],
      signature_prompt: message,
      stream: true,
      chat_request_id: conversationId || crypto.randomUUID().replace(/-/g, ""),
    });
  }

  /**
   * Build request body for the old /chatglm/backend-api/assistant/stream API (deprecated)
   */
  private buildBodyLegacy(message: string, model: string, conversationId?: string): string {
    const assistantId = ASSISTANT_ID_MAP[model] ?? DEFAULT_ASSISTANT_ID;
    return JSON.stringify({
      assistant_id: assistantId,
      conversation_id: conversationId || "",
      project_id: "",
      chat_type: "user_chat",
      meta_data: {
        cogview: { rm_label_watermark: false },
        is_test: false,
        input_question_type: "xxxx",
        channel: "",
        draft_id: "",
        chat_mode: "zero",
        is_networking: false,
        quote_log_id: "",
        platform: "pc",
      },
      messages: [
        { role: "user", content: [{ type: "text", text: message }] },
      ],
    });
  }

  /**
   * Chat with streaming - real-time callbacks
   */
  async chatStream(
    message: string,
    callbacks: StreamCallbacks = {},
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    const accessToken = await this.ensureAccessToken();
    const model = options.model ?? "glm-4";
    const sessionKey = options.conversationId ?? "default";
    const conversationId = this.conversationMap.get(sessionKey);

    // Build prompt with history if provided
    let prompt = message;
    if (options.history && options.history.length > 0) {
      const parts: string[] = [];
      if (options.systemPrompt) {
        parts.push(`System: ${options.systemPrompt}`);
      }
      for (const msg of options.history) {
        const role = msg.role === "user" ? "User" : "Assistant";
        parts.push(`${role}: ${msg.content}`);
      }
      parts.push(`User: ${message}`);
      prompt = parts.join("\n\n");
    } else if (options.systemPrompt) {
      prompt = `${options.systemPrompt}\n\nUser: ${message}`;
    }

    const headers = this.buildHeaders(accessToken);

    // Try v2 API first (new Open WebUI-style endpoint)
    const bodyV2 = this.buildBodyV2(prompt, model, conversationId);
    console.log(`[ZAI] Sending request... model=${model} conversationId=${conversationId || "new"} (v2 API)`);

    let res = await fetch(`${getApiBase()}/api/v2/chat/completions`, {
      method: "POST",
      headers: {
        ...headers,
        "X-FE-Version": "prod-fe-1.1.45",
        "Accept-Language": "zh-CN",
      },
      body: bodyV2,
      signal: options.signal,
    });

    // If v2 fails with 404/405/500, fall back to legacy API
    if (!res.ok && (res.status === 404 || res.status === 405 || res.status === 500)) {
      console.log(`[ZAI] V2 API returned ${res.status}, trying legacy API...`);
      const bodyLegacy = this.buildBodyLegacy(prompt, model, conversationId);
      res = await fetch(`${getApiBase()}/chatglm/backend-api/assistant/stream`, {
        method: "POST",
        headers,
        body: bodyLegacy,
        signal: options.signal,
      });
    }

    if (!res.ok) {
      if (res.status === 401) {
        // Token expired, refresh and retry
        console.log("[ZAI] Token expired, refreshing...");
        this.accessToken = null;
        const newToken = await this.ensureAccessToken();
        const retryHeaders = this.buildHeaders(newToken);
        const retryBody = this.buildBodyV2(prompt, model, conversationId);
        const retryRes = await fetch(`${getApiBase()}/api/v2/chat/completions`, {
          method: "POST",
          headers: {
            ...retryHeaders,
            "X-FE-Version": "prod-fe-1.1.45",
            "Accept-Language": "zh-CN",
          },
          body: retryBody,
          signal: options.signal,
        });

        if (!retryRes.ok) {
          const errText = await retryRes.text();
          callbacks.onError?.(`API error after retry (${retryRes.status}): ${errText.substring(0, 200)}`);
          throw new Error(`API error (${retryRes.status}): ${errText.substring(0, 200)}`);
        }

        return this.processStreamResponse(retryRes, callbacks, sessionKey);
      }

      const errText = await res.text();
      callbacks.onError?.(`API error (${res.status}): ${errText.substring(0, 200)}`);
      throw new Error(`API error (${res.status}): ${errText.substring(0, 200)}`);
    }

    return this.processStreamResponse(res, callbacks, sessionKey);
  }

  private async processStreamResponse(
    res: Response,
    callbacks: StreamCallbacks,
    sessionKey: string,
  ): Promise<ChatResult> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let accumulatedContent = "";
    let currentMode: string = "text";
    let thinkingContent = "";
    let capturedConversationId = "";
    let tagBuffer = "";

    const emitDelta = (delta: string) => {
      tagBuffer += delta;

      const checkTags = () => {
        const thinkStart = tagBuffer.match(/<think\b[^<>]*>/i);
        const thinkEnd = tagBuffer.match(/<\/think\b[^<>]*>/i);

        const indices = [
          { type: "think_start", idx: thinkStart?.index ?? -1, len: thinkStart?.[0].length ?? 0 },
          { type: "think_end", idx: thinkEnd?.index ?? -1, len: thinkEnd?.[0].length ?? 0 },
        ]
          .filter((t) => t.idx !== -1)
          .toSorted((a, b) => a.idx - b.idx);

        if (indices.length > 0) {
          const first = indices[0];
          const before = tagBuffer.slice(0, first.idx);
          if (before) {
            if (currentMode === "thinking") {
              thinkingContent += before;
              callbacks.onThinking?.(before);
            } else {
              accumulatedContent += before;
              callbacks.onText?.(before);
            }
          }
          if (first.type === "think_start") {
            currentMode = "thinking";
          } else if (first.type === "think_end") {
            currentMode = "text";
          }
          tagBuffer = tagBuffer.slice(first.idx + first.len);
          checkTags();
        } else {
          const lastAngle = tagBuffer.lastIndexOf("<");
          if (lastAngle === -1) {
            if (currentMode === "thinking") {
              thinkingContent += tagBuffer;
              callbacks.onThinking?.(tagBuffer);
            } else {
              accumulatedContent += tagBuffer;
              callbacks.onText?.(tagBuffer);
            }
            tagBuffer = "";
          } else if (lastAngle > 0) {
            const safe = tagBuffer.slice(0, lastAngle);
            if (currentMode === "thinking") {
              thinkingContent += safe;
              callbacks.onThinking?.(safe);
            } else {
              accumulatedContent += safe;
              callbacks.onText?.(safe);
            }
            tagBuffer = tagBuffer.slice(lastAngle);
          }
        }
      };

      checkTags();
    };

    const processLine = (line: string) => {
      if (!line || !line.startsWith("data:")) return;

      const dataStr = line.slice(5).trim();
      if (dataStr === "[DONE]" || !dataStr) return;

      try {
        const data = JSON.parse(dataStr);

        // Capture conversation ID
        if (data.conversation_id) {
          capturedConversationId = data.conversation_id;
          this.conversationMap.set(sessionKey, data.conversation_id);
        }

        // Extract text delta
        let delta = "";

        if (data.parts && Array.isArray(data.parts)) {
          for (const part of data.parts) {
            if (part && typeof part === "object") {
              const content = (part as any).content;
              if (Array.isArray(content)) {
                for (const c of content) {
                  if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
                    delta = c.text;
                    break;
                  }
                }
              }
              if (delta) break;
            }
          }
        }

        if (!delta) {
          delta = data.text || data.content || data.delta || "";
        }

        if (typeof delta === "string" && delta) {
          // GLM sends full accumulated content — only emit new portion
          if (delta.length > accumulatedContent.length + thinkingContent.length) {
            // Need to figure out what's new
            const newDelta = delta.slice(accumulatedContent.length);
            if (newDelta) {
              emitDelta(newDelta);
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.trim()) processLine(buffer.trim());
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      const combined = buffer + chunk;
      const parts = combined.split("\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        processLine(part.trim());
      }
    }

    // Flush remaining tag buffer
    if (tagBuffer) {
      if (currentMode === "thinking") {
        thinkingContent += tagBuffer;
        callbacks.onThinking?.(tagBuffer);
      } else {
        accumulatedContent += tagBuffer;
        callbacks.onText?.(tagBuffer);
      }
    }

    callbacks.onDone?.(accumulatedContent);

    return {
      text: accumulatedContent,
      conversationId: capturedConversationId,
      thinking: thinkingContent || undefined,
    };
  }

  /**
   * Simple chat - returns full text (no streaming)
   */
  async chat(message: string, options: ChatOptions = {}): Promise<ChatResult> {
    return this.chatStream(message, {}, options);
  }
}
