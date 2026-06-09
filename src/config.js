import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_DIR = path.join(os.homedir(), ".zai");
const SESSION_FILE = path.join(CONFIG_DIR, "session.json");

export function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function saveSession(session) {
  ensureConfigDir();
  const data = {
    ...session,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
  console.log(`[ZAI] Session saved to ${SESSION_FILE}`);
}

export function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    return data;
  } catch {
    return null;
  }
}

export function clearSession() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    console.log("[ZAI] Session cleared");
  }
}

export const ZAI_BASE_URL = "https://chat.z.ai";
export const ZAI_REFRESH_URL = "https://chat.z.ai/chatglm/user-api/user/refresh";
export const ZAI_CHAT_URL = "https://chat.z.ai/chatglm/backend-api/assistant/stream";
export const ZAI_MODELS_URL = "https://chat.z.ai/chatglm/backend-api/assistant/model/list";

export const ASSISTANT_ID_MAP = {
  "glm-4-plus": "65940acff94777010aa6b796",
  "glm-4": "65940acff94777010aa6b796",
  "glm-4-think": "676411c38945bbc58a905d31",
  "glm-4-zero": "676411c38945bbc58a905d31",
};
export const DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796";

export const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
