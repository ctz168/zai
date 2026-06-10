/**
 * ZAI Agent Mode — AI Agent powered by Z.AI Zero-Token
 *
 * Connects to aicq.online via the AICQ protocol, receives messages
 * from friends/groups, processes them with Z.AI's LLM, and sends
 * streaming replies back through the AICQ channel.
 *
 * Features:
 *   - Friend management (add, accept, list, remove)
 *   - Group chat support
 *   - Streaming output (chunk-by-chunk via AICQ stream_chunk)
 *   - Master/owner control (set master, admin commands)
 *   - Conversation memory per peer/group
 *
 * Usage:
 *   zai agent                    # Start agent with defaults
 *   zai agent --name "My Bot"    # Set agent display name
 *   zai agent --server URL       # Use custom AICQ server
 */

import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { isLoggedIn, loadAuth, saveAuth } from "./auth.js";
import { ZaiZeroTokenClient, type StreamCallbacks, type ChatResult } from "./client.js";

// ─── AICQ Protocol: Crypto, Identity, ServerClient ──────────
// We import the CJS modules from aicq-chat-plugin via dynamic import
// or direct require (they are CommonJS).

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// ─── Types ────────────────────────────────────────────────────

export interface AgentConfig {
  agentId: string;
  nickname: string;
  serverUrl: string;
  dataDir: string;
  model: string;
  systemPrompt: string;
  masters: string[]; // master friend IDs who can issue admin commands
  autoAcceptFriends: boolean;
  maxHistoryPerChat: number;
  streamChunkSize: number; // chars per stream_chunk
  streamChunkDelay: number; // ms between chunks
}

export interface AgentStatus {
  running: boolean;
  agentId: string;
  nickname: string;
  connected: boolean;
  friends: number;
  groups: number;
  masters: string[];
  model: string;
}

// ─── Config Persistence ───────────────────────────────────────

const AGENT_CONFIG_FILE = "agent.json";

function getAgentConfigPath(dataDir: string): string {
  return join(dataDir, AGENT_CONFIG_FILE);
}

export function loadAgentConfig(dataDir?: string): AgentConfig | null {
  const dir = dataDir ?? join(homedir(), ".zai");
  const p = getAgentConfigPath(dir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as AgentConfig;
  } catch {
    return null;
  }
}

export function saveAgentConfig(config: AgentConfig, dataDir?: string): void {
  const dir = dataDir ?? join(homedir(), ".zai");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getAgentConfigPath(dir), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getDefaultAgentConfig(): AgentConfig {
  return {
    agentId: "zai-agent-" + crypto.randomUUID().slice(0, 8),
    nickname: "ZAI Agent",
    serverUrl: "https://aicq.online",
    dataDir: join(homedir(), ".zai"),
    model: "glm-4-plus",
    systemPrompt: `你是 ZAI Agent，一个由 Z.AI 驱动的智能助手。你可以流畅地与用户对话，回答问题，提供建议。
当你收到消息时，请用友好、专业的方式回复。如果不确定，请诚实说明。
支持中文和英文对话。`,
    masters: [],
    autoAcceptFriends: true,
    maxHistoryPerChat: 50,
    streamChunkSize: 20,
    streamChunkDelay: 50,
  };
}

// ─── Conversation Memory ──────────────────────────────────────

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

class ConversationMemory {
  private history: Map<string, ConversationMessage[]> = new Map();
  private maxPerChat: number;

  constructor(maxPerChat = 50) {
    this.maxPerChat = maxPerChat;
  }

  add(peerId: string, role: "user" | "assistant", content: string): void {
    if (!this.history.has(peerId)) {
      this.history.set(peerId, []);
    }
    const h = this.history.get(peerId)!;
    h.push({ role, content });
    // Trim if too long
    if (h.length > this.maxPerChat) {
      this.history.set(peerId, h.slice(-this.maxPerChat));
    }
  }

  get(peerId: string): ConversationMessage[] {
    return this.history.get(peerId) || [];
  }

  clear(peerId: string): void {
    this.history.delete(peerId);
  }

  clearAll(): void {
    this.history.clear();
  }
}

// ─── Master Command Handler ───────────────────────────────────

const ADMIN_COMMANDS: Record<string, string> = {
  "/help": "显示所有管理员命令",
  "/status": "查看 Agent 状态",
  "/model": "查看/切换模型 (例: /model glm-4-plus)",
  "/prompt": "查看/设置系统提示词 (例: /prompt 你是一个翻译助手)",
  "/master": "查看主人列表",
  "/master add <id>": "添加主人",
  "/master remove <id>": "移除主人",
  "/clear": "清除当前对话记忆",
  "/clearall": "清除所有对话记忆",
  "/friend list": "列出好友",
  "/friend add <code>": "通过好友码添加好友",
  "/group list": "列出群组",
  "/group silent <id>": "切换群组静默模式",
  "/nickname": "查看/设置昵称 (例: /nickname My Bot)",
};

function handleMasterCommand(
  command: string,
  config: AgentConfig,
  memory: ConversationMemory,
  agentRuntime: ZaiAgentRuntime,
): string | null {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/help": {
      const lines = Object.entries(ADMIN_COMMANDS).map(
        ([k, v]) => `  ${k.padEnd(25)} ${v}`,
      );
      return `📋 管理员命令:\n${lines.join("\n")}`;
    }

    case "/status": {
      const friendCount = agentRuntime.getFriendCount();
      const groupCount = agentRuntime.getGroupCount();
      return [
        `🟢 Agent 状态:`,
        `  ID:       ${config.agentId}`,
        `  昵称:     ${config.nickname}`,
        `  模型:     ${config.model}`,
        `  好友:     ${friendCount}`,
        `  群组:     ${groupCount}`,
        `  主人:     ${config.masters.length > 0 ? config.masters.join(", ") : "未设置"}`,
        `  系统提示: ${config.systemPrompt.substring(0, 50)}...`,
      ].join("\n");
    }

    case "/model": {
      if (parts[1]) {
        config.model = parts[1];
        saveAgentConfig(config);
        return `✅ 模型已切换为: ${config.model}`;
      }
      return `当前模型: ${config.model}`;
    }

    case "/prompt": {
      if (parts.length > 1) {
        config.systemPrompt = parts.slice(1).join(" ");
        saveAgentConfig(config);
        return `✅ 系统提示已更新`;
      }
      return `当前系统提示:\n${config.systemPrompt}`;
    }

    case "/master": {
      const sub = parts[1];
      if (sub === "add" && parts[2]) {
        if (!config.masters.includes(parts[2])) {
          config.masters.push(parts[2]);
          saveAgentConfig(config);
          return `✅ 已添加主人: ${parts[2]}`;
        }
        return `该用户已是主人`;
      }
      if (sub === "remove" && parts[2]) {
        config.masters = config.masters.filter((m) => m !== parts[2]);
        saveAgentConfig(config);
        return `✅ 已移除主人: ${parts[2]}`;
      }
      return `主人列表: ${config.masters.length > 0 ? config.masters.join(", ") : "未设置"}`;
    }

    case "/clear": {
      // Clear memory for the current chat — need peer ID from context
      return `⚠️ 请在对话中使用 /clear，或指定 /clear <peerId>`;
    }

    case "/clearall": {
      memory.clearAll();
      return `✅ 所有对话记忆已清除`;
    }

    case "/nickname": {
      if (parts.length > 1) {
        config.nickname = parts.slice(1).join(" ");
        saveAgentConfig(config);
        return `✅ 昵称已更新为: ${config.nickname}`;
      }
      return `当前昵称: ${config.nickname}`;
    }

    default:
      return null; // Not a command
  }
}

// ─── ZAI Agent Runtime ────────────────────────────────────────

export class ZaiAgentRuntime {
  private config: AgentConfig;
  private memory: ConversationMemory;
  private zaiClient: ZaiZeroTokenClient;

  // AICQ runtime components (loaded from aicq-chat-plugin)
  private _db: any = null;
  private _identity: any = null;
  private _serverClient: any = null;
  private _handshake: any = null;
  private _chat: any = null;

  private _initialized = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this.memory = new ConversationMemory(config.maxHistoryPerChat);
    this.zaiClient = new ZaiZeroTokenClient();
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;

    console.log("[Agent] Initializing ZAI Agent...");

    // Verify ZAI login
    if (!isLoggedIn()) {
      throw new Error("Not logged in to Z.AI. Run `zai login` first.");
    }

    // Initialize AICQ components
    await this._initAicqComponents();

    // Create agent identity if needed
    await this._ensureIdentity();

    // Connect to AICQ server
    await this._connectServer();

    // Register inbound message handlers
    this._registerMessageHandlers();

    this._initialized = true;
    console.log("[Agent] ✅ ZAI Agent initialized successfully");
  }

  private async _initAicqComponents(): Promise<void> {
    console.log("[Agent] Loading AICQ components...");

    const dataDir = this.config.dataDir;
    const aicqDataDir = join(dataDir, "aicq");

    if (!existsSync(aicqDataDir)) {
      mkdirSync(aicqDataDir, { recursive: true });
    }

    // Load AICQ modules — try from aicq-chat-plugin first, then bundled
    let PluginDatabase: any, IdentityManager: any, ServerClient: any,
        HandshakeManager: any, ChatManager: any;

    try {
      // Try to load from installed aicq-chat-plugin
      const pluginPath = require.resolve("aicq-chat-plugin");
      const pluginDir = join(pluginPath, "..");
      PluginDatabase = require(join(pluginDir, "lib/database"));
      IdentityManager = require(join(pluginDir, "lib/identity"));
      ServerClient = require(join(pluginDir, "lib/server-client"));
      HandshakeManager = require(join(pluginDir, "lib/handshake"));
      ChatManager = require(join(pluginDir, "lib/chat"));
      console.log("[Agent] Using aicq-chat-plugin modules from npm");
    } catch {
      // Fallback: try local lib path
      try {
        const libDir = join(homedir(), ".aicq-plugin");
        PluginDatabase = require("./aicq-libs/database");
        IdentityManager = require("./aicq-libs/identity");
        ServerClient = require("./aicq-libs/server-client");
        HandshakeManager = require("./aicq-libs/handshake");
        ChatManager = require("./aicq-libs/chat");
        console.log("[Agent] Using local AICQ lib modules");
      } catch {
        // Last resort: use the extracted modules
        console.log("[Agent] ⚠️  aicq-chat-plugin not found, using standalone mode");
        this._initStandaloneMode();
        return;
      }
    }

    // Initialize database
    this._db = new PluginDatabase(aicqDataDir);
    await this._db.init();
    console.log("[Agent] AICQ database initialized");

    // Initialize managers
    this._identity = new IdentityManager(this._db);
    this._serverClient = new ServerClient(this._identity, this._db, this.config.serverUrl);
    this._handshake = new HandshakeManager(this._identity, this._serverClient, this._db);
    this._chat = new ChatManager(this._identity, this._serverClient, this._db, join(aicqDataDir, "uploads"));

    console.log("[Agent] AICQ managers initialized");
  }

  private _initStandaloneMode(): void {
    // Standalone mode: use WebSocket directly without the full AICQ plugin
    // This is a lightweight mode that connects to the AICQ server directly
    console.log("[Agent] Running in standalone mode (direct WebSocket)");
  }

  private async _ensureIdentity(): Promise<void> {
    if (!this._identity) {
      // Standalone mode: will create identity on first connect
      return;
    }

    const agents = this._identity.listAgents();
    if (agents.length === 0) {
      this._identity.createAgent(this.config.agentId, this.config.nickname);
      console.log(`[Agent] Created identity: ${this.config.agentId}`);
    } else {
      // Use first existing identity
      const existing = agents[0];
      this.config.agentId = existing.agent_id;
      if (existing.nickname) {
        this.config.nickname = existing.nickname;
      }
      console.log(`[Agent] Using existing identity: ${this.config.agentId}`);
    }
  }

  private async _connectServer(): Promise<void> {
    if (!this._serverClient) {
      // Standalone mode: connect directly via WebSocket
      await this._connectStandalone();
      return;
    }

    try {
      await this._serverClient.start(this.config.agentId);
      console.log("[Agent] Connected to AICQ server");
    } catch (e: any) {
      console.error(`[Agent] Failed to connect to AICQ server: ${e.message}`);
      console.log("[Agent] Will retry in background...");
    }
  }

  // ─── Standalone WebSocket Connection ──────────────────────

  private _ws: any = null;
  private _standaloneConnected = false;
  private _jwtToken: string | null = null;
  private _serverAccountId: string | null = null;
  private _identityKeys: any = null;
  private _reconnectTimer: any = null;
  private _backoff = 1000;

  private async _connectStandalone(): Promise<void> {
    // Create identity if needed
    await this._ensureStandaloneIdentity();

    const wsUrl = this.config.serverUrl
      .replace("https://", "wss://")
      .replace("http://", "ws://") + "/ws";

    console.log(`[Agent] Connecting to ${wsUrl}...`);

    try {
      const WebSocket = (await import("ws")).default;
      this._ws = new WebSocket(wsUrl);

      this._ws.on("open", () => {
        console.log("[Agent] WS connected, authenticating...");
        this._ws.send(JSON.stringify({
          type: "online",
          nodeId: this._serverAccountId || this.config.agentId,
          token: this._jwtToken,
        }));
      });

      this._ws.on("message", (raw: Buffer) => {
        try {
          const data = JSON.parse(raw.toString());
          this._handleStandaloneMessage(data);
        } catch (e: any) {
          console.error("[Agent] WS parse error:", e.message);
        }
      });

      this._ws.on("close", () => {
        console.log("[Agent] WS disconnected");
        this._standaloneConnected = false;
        this._scheduleReconnect();
      });

      this._ws.on("error", (err: Error) => {
        console.error("[Agent] WS error:", err.message);
        this._standaloneConnected = false;
      });
    } catch (e: any) {
      console.error("[Agent] WS connect error:", e.message);
      this._scheduleReconnect();
    }
  }

  private async _ensureStandaloneIdentity(): Promise<void> {
    // Try to load or create identity for standalone mode
    const identityPath = join(this.config.dataDir, "aicq", "identity.json");

    if (existsSync(identityPath)) {
      try {
        this._identityKeys = JSON.parse(readFileSync(identityPath, "utf-8"));
        this._serverAccountId = this._identityKeys.serverAccountId || null;
        this._jwtToken = this._identityKeys.jwtToken || null;
      } catch {
        this._identityKeys = null;
      }
    }

    if (!this._identityKeys) {
      // Generate new identity using NaCl
      try {
        const nacl = require("tweetnacl");
        const signing = nacl.sign.keyPair();
        const exchange = nacl.box.keyPair();

        this._identityKeys = {
          agentId: this.config.agentId,
          signing_public_key: Buffer.from(signing.publicKey).toString("hex"),
          signing_secret_key: Buffer.from(signing.secretKey).toString("hex"),
          exchange_public_key: Buffer.from(exchange.publicKey).toString("hex"),
          exchange_secret_key: Buffer.from(exchange.secretKey).toString("hex"),
        };

        // Register with AICQ server
        const apiUrl = `${this.config.serverUrl}/api/v1`;
        const registerRes = await fetch(`${apiUrl}/auth/register/ai`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            public_key: this._identityKeys.signing_public_key,
            agent_name: this.config.nickname,
          }),
        });

        if (registerRes.ok) {
          const data = await registerRes.json() as any;
          this._jwtToken = data.access_token || data.accessToken;
          this._serverAccountId = data.account?.id || null;
          this._identityKeys.jwtToken = this._jwtToken;
          this._identityKeys.serverAccountId = this._serverAccountId;

          // Save identity
          if (!existsSync(join(this.config.dataDir, "aicq"))) {
            mkdirSync(join(this.config.dataDir, "aicq"), { recursive: true });
          }
          writeFileSync(identityPath, JSON.stringify(this._identityKeys, null, 2));

          console.log("[Agent] ✅ Registered with AICQ server");
        } else {
          // Try login instead (already registered)
          const errText = await registerRes.text();
          console.log("[Agent] Register returned:", errText.substring(0, 100));
          await this._loginStandalone();
        }
      } catch (e: any) {
        console.error("[Agent] Identity creation error:", e.message);
        // Try login if we have an existing identity
        await this._loginStandalone();
      }
    } else {
      // Existing identity - try to login
      if (!this._jwtToken) {
        await this._loginStandalone();
      }
    }
  }

  private async _loginStandalone(): Promise<void> {
    if (!this._identityKeys) return;

    try {
      const nacl = require("tweetnacl");
      const naclUtil = require("tweetnacl-util");
      const apiUrl = `${this.config.serverUrl}/api/v1`;

      // Get challenge
      const challengeRes = await fetch(`${apiUrl}/auth/challenge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          public_key: this._identityKeys.signing_public_key,
        }),
      });

      if (!challengeRes.ok) {
        console.error("[Agent] Challenge request failed:", challengeRes.status);
        return;
      }

      const challengeData = await challengeRes.json() as any;
      const challenge = challengeData.challenge;

      // Sign challenge
      const secretKey = Buffer.from(this._identityKeys.signing_secret_key, "hex");
      let messageBytes: Uint8Array;
      if (/^[0-9a-fA-F]{64}$/.test(challenge)) {
        messageBytes = Buffer.from(challenge, "hex");
      } else {
        messageBytes = naclUtil.decodeUTF8(challenge);
      }
      const signature = nacl.sign.detached(messageBytes, secretKey);
      const signatureHex = Buffer.from(signature).toString("hex");

      // Login
      const loginRes = await fetch(`${apiUrl}/auth/login/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          public_key: this._identityKeys.signing_public_key,
          signature: signatureHex,
          challenge,
        }),
      });

      if (loginRes.ok) {
        const loginData = await loginRes.json() as any;
        this._jwtToken = loginData.access_token || loginData.accessToken;
        this._serverAccountId = loginData.account?.id || null;

        // Save
        this._identityKeys.jwtToken = this._jwtToken;
        this._identityKeys.serverAccountId = this._serverAccountId;
        const identityPath = join(this.config.dataDir, "aicq", "identity.json");
        writeFileSync(identityPath, JSON.stringify(this._identityKeys, null, 2));

        console.log("[Agent] ✅ Logged in to AICQ server");
      } else {
        console.error("[Agent] Login failed:", loginRes.status);
      }
    } catch (e: any) {
      console.error("[Agent] Login error:", e.message);
    }
  }

  private _handleStandaloneMessage(data: any): void {
    const type = data.type;

    if (type === "online_ack") {
      this._standaloneConnected = true;
      this._backoff = 1000;
      console.log("[Agent] WS authenticated as", data.nodeId);
      return;
    }

    if (type === "error") {
      console.error("[Agent] WS server error:", data.message || data.code);
      return;
    }

    // Handle incoming messages
    if (type === "relay" || type === "message") {
      this._processIncomingMessage(data, false);
    } else if (type === "group_message") {
      this._processIncomingMessage(data, true);
    } else if (type === "handshake_initiate") {
      this._handleIncomingFriendRequest(data);
    } else if (type === "presence") {
      // Presence update - ignore for now
    }
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      console.log(`[Agent] Reconnecting (backoff ${this._backoff}ms)...`);
      this._backoff = Math.min(this._backoff * 2, 60000);
      this._connectStandalone();
    }, this._backoff);
  }

  private _sendWS(data: any): boolean {
    if (this._ws && this._ws.readyState === 1) { // WebSocket.OPEN
      this._ws.send(JSON.stringify(data));
      return true;
    }
    if (this._serverClient) {
      return this._serverClient.sendWS(data);
    }
    return false;
  }

  // ─── Message Handlers ─────────────────────────────────────

  private _registerMessageHandlers(): void {
    if (!this._serverClient) return;

    this._serverClient.onMessage("relay", (data: any) => {
      this._processIncomingMessage(data, false);
    });

    this._serverClient.onMessage("message", (data: any) => {
      this._processIncomingMessage(data, false);
    });

    this._serverClient.onMessage("group_message", (data: any) => {
      this._processIncomingMessage(data, true);
    });

    this._serverClient.onMessage("handshake_initiate", (data: any) => {
      this._handleIncomingFriendRequest(data);
    });

    console.log("[Agent] Message handlers registered");
  }

  private async _processIncomingMessage(data: any, isGroup: boolean): Promise<void> {
    const inner = data.data || data;
    const fromId = inner.from || inner.fromId || data.from || data.fromId;
    const groupId = inner.groupId || data.groupId;
    const content = inner.content || inner.payload || inner.text || data.content || data.payload || "";

    if (!fromId) return;

    // Skip own messages
    if (fromId === this._serverAccountId || fromId === this.config.agentId) return;

    const chatId = isGroup ? groupId : fromId;
    const displayFrom = isGroup ? `群组 ${groupId}` : fromId;

    console.log(`[Agent] 📩 Message from ${displayFrom}: ${(content || "").substring(0, 80)}`);

    if (!content || !content.trim()) return;

    // Check if this is a master command
    if (this.config.masters.includes(fromId) && content.startsWith("/")) {
      const reply = handleMasterCommand(content, this.config, this.memory, this);
      if (reply) {
        await this._sendReply(chatId, reply, isGroup);
        return;
      }
    }

    // Add to conversation memory
    this.memory.add(chatId, "user", content);

    // Get conversation history
    const history = this.memory.get(chatId);

    // Generate AI response with streaming
    try {
      await this._generateStreamingReply(chatId, content, history, isGroup, fromId);
    } catch (e: any) {
      console.error(`[Agent] Error generating reply: ${e.message}`);
      // Try to send error message
      try {
        await this._sendReply(chatId, `抱歉，处理消息时出错: ${e.message.substring(0, 100)}`, isGroup);
      } catch {
        // Give up
      }
    }
  }

  private async _handleIncomingFriendRequest(data: any): Promise<void> {
    console.log(`[Agent] 🤝 Friend request from: ${data.requesterId || data.from}`);

    if (this.config.autoAcceptFriends) {
      if (this._handshake) {
        try {
          const sessionId = data.sessionId || crypto.randomUUID();
          await this._handshake.acceptRequest(this.config.agentId, sessionId);
          console.log("[Agent] ✅ Auto-accepted friend request");
        } catch (e: any) {
          console.error("[Agent] Failed to accept friend request:", e.message);
        }
      }
    }
  }

  // ─── AI Reply Generation with Streaming ───────────────────

  private async _generateStreamingReply(
    chatId: string,
    userMessage: string,
    history: ConversationMessage[],
    isGroup: boolean,
    fromId: string,
  ): Promise<void> {
    // Check for @mention in group chat
    if (isGroup) {
      const mentionPattern = new RegExp(`@${this.config.nickname}|@${this.config.agentId}`, "i");
      if (!mentionPattern.test(userMessage) && !userMessage.includes(this.config.agentId)) {
        // In group chat, only respond if mentioned (or if it's the master)
        if (!this.config.masters.includes(fromId)) {
          return; // Skip unmentioned messages in groups
        }
      }
    }

    let fullReply = "";

    const streamCallbacks: StreamCallbacks = {
      onText: (delta) => {
        fullReply += delta;
      },
      onThinking: (delta) => {
        // We don't stream thinking to users, but we could
        // console.log(`[Agent] [think] ${delta.substring(0, 50)}`);
      },
      onDone: async (fullText) => {
        // Add to memory
        this.memory.add(chatId, "assistant", fullText);

        // Send the complete reply via AICQ
        // For short replies, send as single message
        // For longer replies, use stream_chunk protocol
        if (fullText.length <= this.config.streamChunkSize * 3) {
          await this._sendReply(chatId, fullText, isGroup);
        } else {
          // Stream the reply in chunks via AICQ protocol
          await this._streamReplyChunks(chatId, fullText, isGroup);
        }
      },
      onError: (error) => {
        console.error(`[Agent] Stream error: ${error}`);
      },
    };

    try {
      await this.zaiClient.chatStream(userMessage, streamCallbacks, {
        model: this.config.model,
        systemPrompt: this.config.systemPrompt,
        history,
      });
    } catch (e: any) {
      // If streaming fails, try non-streaming
      console.log("[Agent] Stream failed, trying non-streaming...");
      try {
        const result = await this.zaiClient.chat(userMessage, {
          model: this.config.model,
          systemPrompt: this.config.systemPrompt,
          history,
        });
        this.memory.add(chatId, "assistant", result.text);
        await this._sendReply(chatId, result.text, isGroup);
      } catch (e2: any) {
        throw new Error(`Chat failed: ${e2.message} / ${e2.message}`);
      }
    }
  }

  private async _streamReplyChunks(
    chatId: string,
    fullText: string,
    isGroup: boolean,
  ): Promise<void> {
    const chunkSize = this.config.streamChunkSize;
    const delay = this.config.streamChunkDelay;
    const totalChunks = Math.ceil(fullText.length / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fullText.length);
      const chunk = fullText.slice(start, end);

      // Send stream_chunk via AICQ protocol
      const sent = this._sendWS({
        type: "stream_chunk",
        to: chatId,
        chunkType: "text",
        data: chunk,
      });

      if (!sent) {
        // Fallback: send as regular message
        await this._sendReply(chatId, fullText.slice(start), isGroup);
        return;
      }

      // Small delay between chunks
      if (i < totalChunks - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // Send stream_end
    const msgId = "msg_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex");
    this._sendWS({
      type: "stream_end",
      to: chatId,
      messageId: msgId,
    });
  }

  // ─── Send Reply ────────────────────────────────────────────

  private async _sendReply(chatId: string, text: string, isGroup: boolean): Promise<void> {
    if (this._chat) {
      // Use the full AICQ chat manager
      try {
        await this._chat.sendMessage(this.config.agentId, chatId, text, { isGroup });
        console.log(`[Agent] 📤 Reply sent to ${chatId}: ${text.substring(0, 50)}...`);
        return;
      } catch (e: any) {
        console.error("[Agent] Chat send failed:", e.message);
      }
    }

    // Fallback: direct WebSocket relay
    if (isGroup) {
      const sent = this._sendWS({
        type: "group_message",
        groupId: chatId,
        from: this.config.agentId,
        content: text,
        msgType: "text",
        timestamp: Date.now(),
      });
      if (sent) {
        console.log(`[Agent] 📤 Group reply sent to ${chatId}`);
      }
    } else {
      const sent = this._sendWS({
        type: "relay",
        targetId: chatId,
        payload: text,
      });
      if (sent) {
        console.log(`[Agent] 📤 DM reply sent to ${chatId}`);
      } else {
        // Try REST API fallback
        try {
          const apiUrl = `${this.config.serverUrl}/api/v1`;
          await fetch(`${apiUrl}/messages/send`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(this._jwtToken ? { Authorization: `Bearer ${this._jwtToken}` } : {}),
            },
            body: JSON.stringify({ targetId: chatId, payload: text }),
          });
          console.log(`[Agent] 📤 Reply sent via REST to ${chatId}`);
        } catch (e: any) {
          console.error("[Agent] REST fallback also failed:", e.message);
        }
      }
    }
  }

  // ─── Public API ────────────────────────────────────────────

  getFriendCount(): number {
    if (!this._db) return 0;
    try {
      return this._db.listFriends(this.config.agentId).length;
    } catch {
      return 0;
    }
  }

  getGroupCount(): number {
    if (!this._db) return 0;
    try {
      return this._db.listGroups(this.config.agentId).length;
    } catch {
      return 0;
    }
  }

  getStatus(): AgentStatus {
    const connected = this._standaloneConnected ||
      (this._serverClient?.connected ?? false);

    return {
      running: this._initialized,
      agentId: this.config.agentId,
      nickname: this.config.nickname,
      connected,
      friends: this.getFriendCount(),
      groups: this.getGroupCount(),
      masters: this.config.masters,
      model: this.config.model,
    };
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  // ─── Friend/Group Management via Gateway ──────────────────

  async addFriend(friendCode: string): Promise<any> {
    if (this._handshake) {
      try {
        return await this._handshake.addFriendByCode(this.config.agentId, friendCode);
      } catch {
        // Fallback to REST API
      }
    }

    // Standalone: use REST API
    try {
      const apiUrl = `${this.config.serverUrl}/api/v1`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(this._jwtToken ? { Authorization: `Bearer ${this._jwtToken}` } : {}),
      };

      // Try friend request endpoint (by account ID)
      const frRes = await fetch(`${apiUrl}/friends/request`, {
        method: "POST",
        headers,
        body: JSON.stringify({ to_id: friendCode }),
      });

      if (frRes.ok || frRes.status === 201) {
        return await frRes.json();
      }

      // Fallback: try temp-number + handshake
      const resolved = await fetch(`${apiUrl}/temp-number/${friendCode}`, {
        headers: this._jwtToken ? { Authorization: `Bearer ${this._jwtToken}` } : {},
      });
      if (resolved.ok) {
        return await fetch(`${apiUrl}/handshake/initiate`, {
          method: "POST",
          headers,
          body: JSON.stringify({ temp_number: friendCode }),
        });
      }

      throw new Error(`Could not add friend ${friendCode}: ${frRes.status}`);
    } catch (e: any) {
      throw new Error(`Add friend failed: ${e.message}`);
    }
  }

  async listFriends(): Promise<any[]> {
    if (this._db) {
      return this._db.listFriends(this.config.agentId);
    }
    try {
      const apiUrl = `${this.config.serverUrl}/api/v1`;
      const res = await fetch(`${apiUrl}/friends`, {
        headers: this._jwtToken ? { Authorization: `Bearer ${this._jwtToken}` } : {},
      });
      const data = await res.json() as any;
      return data.friends || [];
    } catch {
      return [];
    }
  }

  async listGroups(): Promise<any[]> {
    if (this._db) {
      return this._db.listGroups(this.config.agentId);
    }
    try {
      const apiUrl = `${this.config.serverUrl}/api/v1`;
      const res = await fetch(`${apiUrl}/groups`, {
        headers: this._jwtToken ? { Authorization: `Bearer ${this._jwtToken}` } : {},
      });
      const data = await res.json() as any;
      return data.groups || [];
    } catch {
      return [];
    }
  }

  async setMaster(friendId: string): Promise<string> {
    if (!this.config.masters.includes(friendId)) {
      this.config.masters.push(friendId);
      saveAgentConfig(this.config);
      return `✅ 已设置 ${friendId} 为主人`;
    }
    return `${friendId} 已经是主人`;
  }

  async removeMaster(friendId: string): Promise<string> {
    this.config.masters = this.config.masters.filter((m) => m !== friendId);
    saveAgentConfig(this.config);
    return `✅ 已移除主人 ${friendId}`;
  }

  // ─── Shutdown ─────────────────────────────────────────────

  async shutdown(): Promise<void> {
    console.log("[Agent] Shutting down...");

    if (this._serverClient) {
      this._serverClient.stop();
    }

    if (this._ws) {
      try {
        this._ws.send(JSON.stringify({ type: "offline" }));
        this._ws.close();
      } catch {
        // Ignore
      }
    }

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
    }

    if (this._db) {
      this._db.close();
    }

    this._initialized = false;
    console.log("[Agent] ✅ Shutdown complete");
  }
}

// ─── Start Agent ──────────────────────────────────────────────

export async function startAgent(options: Partial<AgentConfig> = {}): Promise<ZaiAgentRuntime> {
  // Load or create config
  let config = loadAgentConfig(options.dataDir);
  if (!config) {
    config = getDefaultAgentConfig();
  }

  // Apply overrides
  if (options.agentId) config.agentId = options.agentId;
  if (options.nickname) config.nickname = options.nickname;
  if (options.serverUrl) config.serverUrl = options.serverUrl;
  if (options.model) config.model = options.model;
  if (options.systemPrompt) config.systemPrompt = options.systemPrompt;
  if (options.autoAcceptFriends !== undefined) config.autoAcceptFriends = options.autoAcceptFriends;
  if (options.masters) config.masters = options.masters;
  if (options.dataDir) config.dataDir = options.dataDir;

  // Save config
  saveAgentConfig(config);

  // Create and initialize runtime
  const runtime = new ZaiAgentRuntime(config);
  await runtime.initialize();

  return runtime;
}
