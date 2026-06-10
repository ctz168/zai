/**
 * Z.AI Zero-Token SDK - Main entry point
 *
 * Re-exports everything for programmatic use.
 *
 * Usage:
 *   import { loginViaBrowser, ZaiZeroTokenClient } from "zai";
 *   await loginViaBrowser();
 *   const client = new ZaiZeroTokenClient();
 *   const result = await client.chat("Hello!");
 *
 * Agent Mode:
 *   import { startAgent, ZaiAgentRuntime } from "zai";
 *   const runtime = await startAgent({ nickname: "My Bot" });
 */

export {
  loginViaBrowser,
  isLoggedIn,
  loadAuth,
  saveAuth,
  clearAuth,
  generateSign,
  extractRefreshToken,
  extractAccessToken,
  refreshAccessToken,
  getConfigDir,
  ZAI_CHAT_URL,
  ZAI_API_BASE,
  SIGN_SECRET,
  ASSISTANT_ID_MAP,
  DEFAULT_ASSISTANT_ID,
} from "./auth.js";

export { ZaiZeroTokenClient } from "./client.js";
export { startServer } from "./server.js";

export {
  startAgent,
  ZaiAgentRuntime,
  loadAgentConfig,
  saveAgentConfig,
  getDefaultAgentConfig,
} from "./agent.js";

export {
  launchDaemon,
  stopDaemon,
  restartDaemon,
  daemonStatus,
  daemonLogTail,
  getPidFile,
  getLogFile,
  RUN_DIR as DAEMON_RUN_DIR,
} from "./daemon.js";

export type {
  ZaiAuthState,
  LoginOptions,
} from "./auth.js";

export type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  StreamCallbacks,
} from "./client.js";

export type {
  AgentConfig,
  AgentStatus,
} from "./agent.js";

export type { ServerOptions } from "./server.js";
