/**
 * Z.AI SDK - Main entry point
 *
 * Re-exports the client and utilities for programmatic use.
 *
 * Usage:
 *   import { ZaiClient } from "zai";
 *   const client = new ZaiClient();
 *   const text = await client.chat("Hello!");
 */

export {
  ZaiClient,
  ZAI_GLOBAL_BASE_URL,
  ZAI_CN_BASE_URL,
  MODELS,
  isloggedIn,
  loadConfig,
  saveConfig,
  getConfigDir,
} from "./client.js";

export { startServer } from "./server.js";

export type {
  ZaiConfig,
  ChatMessage,
  ChatCompletionOptions,
  ChatCompletionResponse,
  StreamChunk,
  ZaiTool,
  ZaiModelId,
} from "./client.js";

export type { ServerOptions } from "./server.js";
