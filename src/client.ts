/**
 * Z.AI API Client
 *
 * Wraps the Z.AI global endpoint (https://api.z.ai/api/paas/v4)
 * with OpenAI-compatible chat completions interface.
 *
 * Supports:
 *   - API Key authentication (login once, reuse)
 *   - Chat completions (sync & streaming)
 *   - Multiple GLM models
 *   - Automatic token persistence
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Constants ────────────────────────────────────────────────

export const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_CN_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

export const MODELS = {
  "glm-5": {
    name: "GLM-5",
    reasoning: true,
    contextWindow: 202800,
    maxTokens: 131100,
  },
  "glm-5-turbo": {
    name: "GLM-5 Turbo",
    reasoning: true,
    contextWindow: 202800,
    maxTokens: 131100,
  },
  "glm-4.7": {
    name: "GLM-4.7",
    reasoning: true,
    contextWindow: 204800,
    maxTokens: 131072,
  },
  "glm-4.7-flash": {
    name: "GLM-4.7 Flash",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 131072,
  },
  "glm-4.7-flashx": {
    name: "GLM-4.7 FlashX",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 128000,
  },
  "glm-4.5": {
    name: "GLM-4.5",
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 98304,
  },
  "glm-4.5-flash": {
    name: "GLM-4.5 Flash",
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 98304,
  },
} as const;

export type ZaiModelId = keyof typeof MODELS;

// ─── Types ────────────────────────────────────────────────────

export interface ZaiConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: ZaiModelId;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatCompletionOptions {
  model?: ZaiModelId;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: ZaiTool[];
  toolChoice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

export interface ZaiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
}

// ─── Config Persistence ───────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".zai");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function saveConfig(config: ZaiConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function loadConfig(): ZaiConfig | null {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as ZaiConfig;
  } catch {
    return null;
  }
}

export function isloggedIn(): boolean {
  const config = loadConfig();
  return config !== null && typeof config.apiKey === "string" && config.apiKey.length > 0;
}

// ─── API Client ───────────────────────────────────────────────

export class ZaiClient {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: ZaiModelId;

  constructor(config?: Partial<ZaiConfig>) {
    const saved = loadConfig();
    this.apiKey = config?.apiKey ?? saved?.apiKey ?? "";
    this.baseUrl = config?.baseUrl ?? saved?.baseUrl ?? ZAI_GLOBAL_BASE_URL;
    this.defaultModel = config?.defaultModel ?? saved?.defaultModel ?? "glm-4.7-flash";

    if (!this.apiKey) {
      throw new Error(
        "Z.AI API key not found. Run `zai login` or set ZAI_API_KEY environment variable."
      );
    }
  }

  /**
   * Login: validate API key and persist config
   */
  static async login(apiKey: string, baseUrl?: string): Promise<ZaiClient> {
    const url = baseUrl ?? ZAI_GLOBAL_BASE_URL;
    // Validate by listing models or making a simple request
    const response = await fetch(`${url}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Login failed (${response.status}): ${text}`);
    }

    const config: ZaiConfig = {
      apiKey,
      baseUrl: url,
      defaultModel: "glm-4.7-flash",
    };
    saveConfig(config);
    return new ZaiClient(config);
  }

  /**
   * Logout: remove persisted config
   */
  static logout(): void {
    if (existsSync(CONFIG_FILE)) {
      unlinkSync(CONFIG_FILE);
    }
  }

  /**
   * Chat completion (non-streaming)
   */
  async chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    const model = options.model ?? this.defaultModel;
    const url = `${this.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model,
      messages: options.messages,
      stream: false,
    };

    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.tools) body.tools = options.tools;
    if (options.toolChoice) body.tool_choice = options.toolChoice;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Chat completion failed (${response.status}): ${text}`);
    }

    return (await response.json()) as ChatCompletionResponse;
  }

  /**
   * Chat completion (streaming) - returns async generator of chunks
   */
  async *chatCompletionStream(
    options: ChatCompletionOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const model = options.model ?? this.defaultModel;
    const url = `${this.baseUrl}/chat/completions`;

    const body: Record<string, unknown> = {
      model,
      messages: options.messages,
      stream: true,
      tool_stream: true,
    };

    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.tools) body.tools = options.tools;
    if (options.toolChoice) body.tool_choice = options.toolChoice;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Stream failed (${response.status}): ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;

        try {
          const chunk = JSON.parse(data) as StreamChunk;
          yield chunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  }

  /**
   * Simple chat: send a message, get a text response
   */
  async chat(
    message: string,
    options?: {
      system?: string;
      model?: ZaiModelId;
      temperature?: number;
      history?: ChatMessage[];
    }
  ): Promise<string> {
    const messages: ChatMessage[] = [];

    if (options?.system) {
      messages.push({ role: "system", content: options.system });
    }

    if (options?.history) {
      messages.push(...options.history);
    }

    messages.push({ role: "user", content: message });

    const response = await this.chatCompletion({
      model: options?.model,
      messages,
      temperature: options?.temperature,
    });

    return response.choices[0]?.message?.content ?? "";
  }

  /**
   * Simple chat with streaming output
   */
  async chatStream(
    message: string,
    onChunk: (text: string) => void,
    options?: {
      system?: string;
      model?: ZaiModelId;
      temperature?: number;
      history?: ChatMessage[];
    }
  ): Promise<string> {
    const messages: ChatMessage[] = [];

    if (options?.system) {
      messages.push({ role: "system", content: options.system });
    }

    if (options?.history) {
      messages.push(...options.history);
    }

    messages.push({ role: "user", content: message });

    let fullText = "";

    for await (const chunk of this.chatCompletionStream({
      model: options?.model,
      messages,
      temperature: options?.temperature,
    })) {
      const delta = chunk.choices[0]?.delta;
      if (delta?.content) {
        fullText += delta.content;
        onChunk(delta.content);
      }
    }

    return fullText;
  }

  /**
   * Agent loop: LLM ↔ Tool calling cycle
   */
  async agentLoop(options: {
    messages: ChatMessage[];
    tools: ZaiTool[];
    model?: ZaiModelId;
    maxRounds?: number;
    onToolCall?: (toolName: string, args: string) => Promise<string>;
    onText?: (text: string) => void;
  }): Promise<ChatMessage[]> {
    const maxRounds = options.maxRounds ?? 10;
    const messages = [...options.messages];
    const conversation: ChatMessage[] = [...messages];

    for (let round = 0; round < maxRounds; round++) {
      let fullContent = "";
      let toolCalls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }> = [];

      // Collect response (streaming for text, but we need full tool_calls)
      for await (const chunk of this.chatCompletionStream({
        model: options.model,
        messages: conversation,
        tools: options.tools,
      })) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          fullContent += delta.content;
          options.onText?.(delta.content);
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = {
                  id: tc.id ?? "",
                  type: "function" as const,
                  function: { name: "", arguments: "" },
                };
              }
              if (tc.function?.name) {
                toolCalls[tc.index].function.name += tc.function.name;
              }
              if (tc.function?.arguments) {
                toolCalls[tc.index].function.arguments += tc.function.arguments;
              }
            }
          }
        }
      }

      // Build assistant message
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: fullContent || "",
      };
      conversation.push(assistantMessage);

      // No tool calls → done
      if (toolCalls.length === 0) {
        break;
      }

      // Execute tool calls
      for (const tc of toolCalls) {
        const result = await options.onToolCall?.(tc.function.name, tc.function.arguments) ?? "";
        conversation.push({
          role: "tool",
          content: result,
        });
      }
    }

    return conversation;
  }
}
