import crypto from "node:crypto";
import { generateSign, generateDeviceId } from "./sign.js";
import {
  loadSession,
  ZAI_REFRESH_URL,
  ZAI_CHAT_URL,
  ZAI_BASE_URL,
  ASSISTANT_ID_MAP,
  DEFAULT_ASSISTANT_ID,
  DEFAULT_USER_AGENT,
  saveSession,
} from "./config.js";

export class ZaiClient {
  constructor(session = null) {
    this.session = session || loadSession();
    this.accessToken = null;
    this.deviceId = generateDeviceId();
    this.conversationMap = new Map();
  }

  get isLoggedIn() {
    return this.session && this.session.cookie;
  }

  parseCookies() {
    if (!this.session?.cookie) return {};
    const map = {};
    this.session.cookie.split(";").forEach((c) => {
      const [name, ...valueParts] = c.trim().split("=");
      if (name) map[name.trim()] = valueParts.join("=").trim();
    });
    return map;
  }

  getRefreshToken() {
    if (this.session?.cookieMap) {
      const names = ["chatglm_refresh_token", "refresh_token", "auth_refresh_token", "glm_refresh_token", "zai_refresh_token"];
      for (const n of names) {
        if (this.session.cookieMap[n]) return this.session.cookieMap[n];
      }
    }
    const cookies = this.parseCookies();
    const names = ["chatglm_refresh_token", "refresh_token", "auth_refresh_token"];
    for (const n of names) {
      if (cookies[n]) return cookies[n];
    }
    return null;
  }

  getAccessTokenFromCookie() {
    if (this.session?.cookieMap) {
      const names = ["chatglm_token", "access_token", "auth_token", "glm_token", "zai_token", "token"];
      for (const n of names) {
        if (this.session.cookieMap[n]) return this.session.cookieMap[n];
      }
    }
    const cookies = this.parseCookies();
    const names = ["chatglm_token", "access_token", "auth_token", "token"];
    for (const n of names) {
      if (cookies[n]) return cookies[n];
    }
    return null;
  }

  async refreshAccessToken() {
    const cookieToken = this.getAccessTokenFromCookie();
    if (cookieToken) {
      this.accessToken = cookieToken;
      return this.accessToken;
    }

    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      throw new Error("No refresh token found. Please login first: zai login");
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

    const response = await fetch(ZAI_REFRESH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const accessToken = data?.result?.access_token || data?.result?.accessToken || data?.accessToken;
    
    if (!accessToken) {
      throw new Error(`No access token in response: ${JSON.stringify(data).substring(0, 300)}`);
    }

    this.accessToken = accessToken;
    console.log("[ZAI] Access token refreshed successfully");
    
    // Save the new access token
    if (this.session?.cookieMap) {
      this.session.cookieMap.chatglm_token = accessToken;
      this.session.cookie = Object.entries(this.session.cookieMap)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
      saveSession(this.session);
    }
    
    return this.accessToken;
  }

  async chat(params) {
    if (!this.isLoggedIn) {
      throw new Error("Not logged in. Please run: zai login");
    }

    const {
      message,
      model = "glm-4-plus",
      conversationId,
      stream = true,
      onChunk,
    } = params;

    if (!this.accessToken) {
      await this.refreshAccessToken();
    }

    const assistantId = ASSISTANT_ID_MAP[model] || DEFAULT_ASSISTANT_ID;
    const sign = generateSign();
    const requestId = crypto.randomUUID().replace(/-/g, "");

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
        {
          role: "user",
          content: [{ type: "text", text: message }],
        },
      ],
    };

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
    };

    if (this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    console.log(`[ZAI] Sending chat request... model=${model} assistantId=${assistantId}`);

    const response = await fetch(ZAI_CHAT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (response.status === 401) {
      console.log("[ZAI] Token expired, refreshing...");
      await this.refreshAccessToken();
      // Retry with new token
      headers["Authorization"] = `Bearer ${this.accessToken}`;
      return this.chat(params);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chat API error: ${response.status} - ${errorText.substring(0, 500)}`);
    }

    if (!stream) {
      // Non-streaming: collect all data
      const text = await response.text();
      return this.parseSSE(text);
    }

    // Streaming mode
    return this.handleStream(response, onChunk);
  }

  async handleStream(response, onChunk) {
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

            // Extract conversation ID
            if (data.conversation_id) {
              conversationId = data.conversation_id;
            }

            // Extract content delta
            let delta = "";
            if (data.text) {
              delta = data.text;
            } else if (data.content) {
              delta = data.content;
            } else if (data.delta) {
              delta = data.delta;
            } else if (data.message) {
              delta = data.message;
            } else if (data.parts && Array.isArray(data.parts)) {
              for (const part of data.parts) {
                if (part?.content && Array.isArray(part.content)) {
                  for (const c of part.content) {
                    if (c?.type === "text" && typeof c.text === "string") {
                      delta = c.text;
                      break;
                    }
                  }
                }
                if (delta) break;
              }
            }

            if (typeof delta === "string" && delta) {
              // GLM sends accumulated content — only emit the new portion
              if (delta.length > fullContent.length) {
                const newDelta = delta.slice(fullContent.length);
                fullContent = delta;
                if (onChunk) {
                  onChunk({ delta: newDelta, fullContent, conversationId, done: false });
                }
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { content: fullContent, conversationId };
  }

  parseSSE(text) {
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

        let delta = data.text || data.content || data.delta || data.message || "";
        if (typeof delta === "string" && delta.length > fullContent.length) {
          fullContent = delta;
        }
      } catch {
        // Ignore
      }
    }

    return { content: fullContent, conversationId };
  }

  async status() {
    if (!this.isLoggedIn) {
      return { loggedIn: false, message: "Not logged in. Run: zai login" };
    }

    try {
      const token = this.accessToken || await this.refreshAccessToken();
      return {
        loggedIn: true,
        hasAccessToken: !!this.accessToken,
        hasRefreshToken: !!this.getRefreshToken(),
        cookieCount: this.session.cookie.split(";").length,
        savedAt: this.session.savedAt,
      };
    } catch (e) {
      return {
        loggedIn: false,
        message: `Session invalid: ${e.message}`,
      };
    }
  }
}
