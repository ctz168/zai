import crypto from "node:crypto";
import { generateSign, generateDeviceId } from "./sign.js";
import {
  loadSession,
  saveSession,
} from "./auth.js";

const ZAI_BASE_URL = "https://chat.z.ai";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

export class ZaiClient {
  constructor(session = null) {
    this.session = session || loadSession();
    this.accessToken = null;
    this.deviceId = generateDeviceId();
  }

  get isLoggedIn() {
    if (!this.session?.cookie) return false;
    // Check it's NOT a guest token
    const token = this.session.cookieMap?.token;
    if (token && token.startsWith("eyJ")) {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        if (payload.email && payload.email.includes("guest")) return false;
      } catch {}
    }
    return true;
  }

  getRefreshToken() {
    const cm = this.session?.cookieMap || {};
    const names = ["chatglm_refresh_token", "refresh_token", "auth_refresh_token", "glm_refresh_token", "zai_refresh_token"];
    for (const n of names) {
      if (cm[n]) return cm[n];
    }
    return null;
  }

  getAccessTokenFromCookie() {
    const cm = this.session?.cookieMap || {};
    const names = ["chatglm_token", "access_token", "auth_token", "token"];
    for (const n of names) {
      if (cm[n]) return cm[n];
    }
    return null;
  }

  buildHeaders(extra = {}) {
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "App-Name": "chatglm",
      Origin: ZAI_BASE_URL,
      "X-App-Platform": "pc",
      "X-App-Version": "0.0.1",
      "X-App-fr": "default",
      "X-Device-Brand": "",
      "X-Device-Id": this.deviceId,
      "X-Device-Model": "",
      "X-Exp-Groups": "na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable",
      "X-Lang": "en",
      "X-Nonce": sign.nonce,
      "X-Request-Id": requestId,
      "X-Sign": sign.sign,
      "X-Timestamp": sign.timestamp,
      "User-Agent": this.session?.userAgent || DEFAULT_USER_AGENT,
      Cookie: this.session.cookie,
      ...extra,
    };
    return headers;
  }

  async refreshAccessToken() {
    const cookieToken = this.getAccessTokenFromCookie();
    if (cookieToken) {
      this.accessToken = cookieToken;
      return this.accessToken;
    }

    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      // No refresh token - use the token cookie directly
      const tokenCookie = this.session?.cookieMap?.token;
      if (tokenCookie) {
        this.accessToken = tokenCookie;
        return this.accessToken;
      }
      throw new Error("No token found. Please login first: zai login");
    }

    console.log("[ZAI] Refreshing access token...");
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${refreshToken}`,
      "App-Name": "chatglm",
      "X-App-Platform": "pc",
      "X-App-Version": "0.0.1",
      "X-Device-Id": this.deviceId,
      "X-Request-Id": requestId,
      "X-Sign": sign.sign,
      "X-Nonce": sign.nonce,
      "X-Timestamp": sign.timestamp,
      "User-Agent": this.session?.userAgent || DEFAULT_USER_AGENT,
      Cookie: this.session.cookie,
    };

    const response = await fetch(`${ZAI_BASE_URL}/chatglm/user-api/user/refresh`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      // If refresh fails, try using existing token
      const tokenCookie = this.session?.cookieMap?.token;
      if (tokenCookie) {
        this.accessToken = tokenCookie;
        return this.accessToken;
      }
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const data = await response.json();
    const accessToken = data?.result?.access_token || data?.result?.accessToken || data?.accessToken;
    if (accessToken) {
      this.accessToken = accessToken;
      console.log("[ZAI] Access token refreshed successfully");
      return this.accessToken;
    }

    // Fallback
    const tokenCookie = this.session?.cookieMap?.token;
    if (tokenCookie) {
      this.accessToken = tokenCookie;
      return this.accessToken;
    }
    throw new Error("No access token available");
  }

  async chat(params) {
    if (!this.isLoggedIn) {
      throw new Error("Not logged in (or using guest token). Please run: zai login");
    }

    const { message, model = "glm-4-plus", conversationId, stream = true, onChunk } = params;

    if (!this.accessToken) {
      await this.refreshAccessToken();
    }

    // Try the OpenAI-compatible endpoint first (chat.z.ai supports /v1/chat/completions)
    // Then fall back to the internal backend-api endpoint
    
    const assistantId = "65940acff94777010aa6b796"; // default
    const sign = generateSign();

    const body = {
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
    };

    const headers = this.buildHeaders();
    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    // Try internal API endpoint
    const chatUrl = `${ZAI_BASE_URL}/chatglm/backend-api/assistant/stream`;
    console.log(`[ZAI] Sending chat to ${chatUrl}...`);

    const response = await fetch(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (response.status === 401) {
      console.log("[ZAI] 401 Unauthorized, refreshing token...");
      await this.refreshAccessToken();
      headers["Authorization"] = `Bearer ${this.accessToken}`;
      const retryResponse = await fetch(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!retryResponse.ok) {
        const errText = await retryResponse.text();
        throw new Error(`Chat API error after retry: ${retryResponse.status} - ${errText.substring(0, 500)}`);
      }
      return this.handleResponse(retryResponse, stream, onChunk);
    }

    if (response.status === 405) {
      // 405 = endpoint doesn't accept this method, try alternative endpoints
      console.log("[ZAI] 405 Not Allowed on backend-api, trying alternative endpoints...");
      return this.tryAlternativeChat(params, headers);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chat API error: ${response.status} - ${errorText.substring(0, 500)}`);
    }

    return this.handleResponse(response, stream, onChunk);
  }

  async tryAlternativeChat(params, headers) {
    const { message, model = "glm-4-plus", stream = true, onChunk } = params;
    
    // Try OpenAI-compatible format
    const openaiBody = {
      model: model,
      messages: [{ role: "user", content: message }],
      stream: stream,
    };

    const altHeaders = { ...headers };
    altHeaders["Content-Type"] = "application/json";
    if (this.accessToken) {
      altHeaders["Authorization"] = `Bearer ${this.accessToken}`;
    }

    // Try /v1/chat/completions
    console.log("[ZAI] Trying /v1/chat/completions...");
    let response = await fetch(`${ZAI_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: altHeaders,
      body: JSON.stringify(openaiBody),
    });

    if (response.status === 405 || response.status === 404) {
      // Try /api/v1/chat/completions
      console.log("[ZAI] Trying /api/v1/chat/completions...");
      response = await fetch(`${ZAI_BASE_URL}/api/v1/chat/completions`, {
        method: "POST",
        headers: altHeaders,
        body: JSON.stringify(openaiBody),
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`All chat endpoints failed. Last: ${response.status} - ${errorText.substring(0, 500)}`);
    }

    return this.handleResponse(response, stream, onChunk);
  }

  async handleResponse(response, stream, onChunk) {
    if (!stream) {
      const text = await response.text();
      return this.parseResponse(text);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    let conversationId = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]" || !dataStr) continue;
          try {
            const data = JSON.parse(dataStr);
            if (data.conversation_id) conversationId = data.conversation_id;
            // Handle OpenAI format
            if (data.choices?.[0]?.delta?.content) {
              const delta = data.choices[0].delta.content;
              fullContent += delta;
              if (onChunk) onChunk({ delta, fullContent, conversationId, done: false });
            }
            // Handle GLM format
            let delta = data.text || data.content || data.delta || data.message || "";
            if (typeof delta === "string" && delta.length > fullContent.length) {
              const newDelta = delta.slice(fullContent.length);
              fullContent = delta;
              if (onChunk) onChunk({ delta: newDelta, fullContent, conversationId, done: false });
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { content: fullContent, conversationId };
  }

  parseResponse(text) {
    let fullContent = "";
    let conversationId = null;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]" || !dataStr) continue;
      try {
        const data = JSON.parse(dataStr);
        if (data.conversation_id) conversationId = data.conversation_id;
        if (data.choices?.[0]?.message?.content) {
          fullContent = data.choices[0].message.content;
        }
        let delta = data.text || data.content || data.delta || data.message || "";
        if (typeof delta === "string" && delta.length > fullContent.length) fullContent = delta;
      } catch {}
    }
    return { content: fullContent, conversationId };
  }

  async status() {
    if (!this.isLoggedIn) {
      return { loggedIn: false, message: "Not logged in or using guest token. Run: zai login" };
    }
    try {
      const token = this.accessToken || await this.refreshAccessToken();
      let userEmail = "unknown";
      if (token && token.startsWith("eyJ")) {
        try {
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
          userEmail = payload.email || "unknown";
        } catch {}
      }
      return {
        loggedIn: true,
        hasAccessToken: !!this.accessToken,
        hasRefreshToken: !!this.getRefreshToken(),
        cookieCount: this.session.cookie.split(";").length,
        userEmail,
        savedAt: this.session.savedAt,
      };
    } catch (e) {
      return { loggedIn: false, message: `Session invalid: ${e.message}` };
    }
  }
}
