/**
 * Z.AI Zero-Token Auth
 *
 * Opens a real browser via Playwright/CDP, navigates to chat.z.ai,
 * waits for user to login manually, then captures the cookies
 * (chatglm_refresh_token, chatglm_token, etc.) and persists them.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import crypto from "node:crypto";
import { chromium } from "playwright-core";

// ─── Constants ────────────────────────────────────────────────

export const ZAI_CHAT_URL = "https://chat.z.ai";
export const ZAI_API_BASE = "https://chat.z.ai";

/** Fixed signing secret extracted from chat.z.ai frontend JS */
export const SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb";

export const X_EXP_GROUPS =
  "na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a," +
  "na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a," +
  "desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4," +
  "app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add," +
  "mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A," +
  "homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A," +
  "memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user," +
  "app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5," +
  "ai_wallet:exp:ai_wallet_enable";

/** Model ID -> assistant_id mapping for the web API */
export const ASSISTANT_ID_MAP: Record<string, string> = {
  "glm-4-plus": "65940acff94777010aa6b796",
  "glm-4": "65940acff94777010aa6b796",
  "glm-4-think": "676411c38945bbc58a905d31",
  "glm-4-zero": "676411c38945bbc58a905d31",
};
export const DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796";

// ─── Types ────────────────────────────────────────────────────

export interface ZaiAuthState {
  cookie: string;
  userAgent: string;
  refreshToken: string | null;
  accessToken: string | null;
  capturedAt: number;
}

export interface LoginOptions {
  headless?: boolean;
  cdpUrl?: string;
  onProgress?: (message: string) => void;
}

// ─── Config Persistence ───────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".zai");
const AUTH_FILE = join(CONFIG_DIR, "auth.json");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function saveAuth(state: ZaiAuthState): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function loadAuth(): ZaiAuthState | null {
  if (!existsSync(AUTH_FILE)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as ZaiAuthState;
  } catch {
    return null;
  }
}

export function clearAuth(): void {
  if (existsSync(AUTH_FILE)) {
    unlinkSync(AUTH_FILE);
  }
}

export function isLoggedIn(): boolean {
  const auth = loadAuth();
  return auth !== null && !!auth.cookie;
}

// ─── Sign Generation ──────────────────────────────────────────

export function generateSign(): { timestamp: string; nonce: string; sign: string } {
  const e = Date.now();
  const A = e.toString();
  const t = A.length;
  const o = A.split("").map((c) => Number(c));
  const i = o.reduce((acc, v) => acc + v, 0) - o[t - 2];
  const a = i % 10;
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sign = crypto
    .createHash("md5")
    .update(`${timestamp}-${nonce}-${SIGN_SECRET}`)
    .digest("hex");
  return { timestamp, nonce, sign };
}

// ─── Cookie Parsing ───────────────────────────────────────────

export function parseCookieString(cookie: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      map.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
    }
  }
  return map;
}

export function extractRefreshToken(cookie: string): string | null {
  const cookies = parseCookieString(cookie);
  const names = [
    "chatglm_refresh_token",
    "refresh_token",
    "auth_refresh_token",
    "glm_refresh_token",
    "zai_refresh_token",
  ];
  for (const name of names) {
    const val = cookies.get(name);
    if (val) return val;
  }
  return null;
}

export function extractAccessToken(cookie: string): string | null {
  const cookies = parseCookieString(cookie);
  const names = [
    "chatglm_token",
    "access_token",
    "auth_token",
    "glm_token",
    "zai_token",
    "token",
  ];
  for (const name of names) {
    const val = cookies.get(name);
    if (val) return val;
  }
  return null;
}

// ─── Token Refresh ────────────────────────────────────────────

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const sign = generateSign();
  const deviceId = crypto.randomUUID().replace(/-/g, "");
  const requestId = crypto.randomUUID().replace(/-/g, "");

  const res = await fetch(`${ZAI_API_BASE}/chatglm/user-api/user/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${refreshToken}`,
      "App-Name": "chatglm",
      "X-App-Platform": "pc",
      "X-App-Version": "0.0.1",
      "X-Device-Id": deviceId,
      "X-Request-Id": requestId,
      "X-Sign": sign.sign,
      "X-Nonce": sign.nonce,
      "X-Timestamp": sign.timestamp,
    },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  }

  const data = await res.json() as any;
  const accessToken = data?.result?.access_token ?? data?.result?.accessToken ?? data?.accessToken;

  if (!accessToken) {
    throw new Error(`No accessToken in refresh response: ${JSON.stringify(data).substring(0, 300)}`);
  }

  return accessToken;
}

// ─── Browser Login ────────────────────────────────────────────

export async function loginViaBrowser(options: LoginOptions = {}): Promise<ZaiAuthState> {
  const { onProgress = console.log, headless = false, cdpUrl } = options;

  let browser;
  let context;
  let didLaunch = false;

  try {
    if (cdpUrl) {
      // Connect to existing Chrome via CDP
      onProgress(`Connecting to Chrome at ${cdpUrl}...`);
      let wsEndpoint: string | null = null;

      // Try to get WebSocket URL from CDP
      try {
        const resp = await fetch(`${cdpUrl}/json/version`);
        const info = await resp.json() as any;
        wsEndpoint = info.webSocketDebuggerUrl;
      } catch {
        // Try direct ws:// URL
        wsEndpoint = cdpUrl;
      }

      if (!wsEndpoint) {
        throw new Error(`Failed to get Chrome WebSocket URL from ${cdpUrl}`);
      }

      browser = await chromium.connectOverCDP(wsEndpoint);
      context = browser.contexts()[0];
      onProgress("Connected to existing Chrome.");
    } else {
      // Launch a new browser
      onProgress("Launching browser...");
      browser = await chromium.launch({
        headless,
        channel: "chrome",
      });
      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      });
      didLaunch = true;
      onProgress("Browser launched.");
    }

    const page = await context.newPage();

    onProgress(`Navigating to ${ZAI_CHAT_URL}...`);
    await page.goto(ZAI_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 120000 });

    const userAgent = await page.evaluate(() => navigator.userAgent);

    onProgress("");
    onProgress("════════════════════════════════════════════════════");
    onProgress("  Please login to Z.AI (chat.z.ai) in the browser window.");
    onProgress("  Waiting for authentication...");
    onProgress("════════════════════════════════════════════════════");

    // Wait for login - check for auth cookies or chat UI elements
    await page.waitForFunction(
      () => {
        const cookieStr = document.cookie;
        const currentUrl = window.location.href;

        // Check for auth cookies
        const hasAuthCookie =
          cookieStr.includes("chatglm_refresh_token") ||
          cookieStr.includes("refresh_token") ||
          cookieStr.includes("auth_token") ||
          cookieStr.includes("access_token") ||
          cookieStr.includes("token");

        // Check if URL indicates logged-in state
        const isLoggedInUrl =
          currentUrl.includes("chat") ||
          currentUrl.includes("conversation") ||
          currentUrl.includes("dashboard") ||
          (!currentUrl.includes("login") && !currentUrl.includes("auth"));

        // Check for chat interface elements
        const hasChatElements =
          document.querySelector(
            'textarea, [contenteditable="true"], .chat-input, .message-input',
          ) !== null;

        return hasAuthCookie || (isLoggedInUrl && hasChatElements);
      },
      { timeout: 600000, polling: 1000 }, // 10 minutes, check every second
    );

    onProgress("Login detected! Capturing cookies...");

    // Capture cookies
    const cookies = await context.cookies(ZAI_CHAT_URL);
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const refreshToken = extractRefreshToken(cookieString);
    const accessToken = extractAccessToken(cookieString);

    const authState: ZaiAuthState = {
      cookie: cookieString,
      userAgent,
      refreshToken,
      accessToken,
      capturedAt: Date.now(),
    };

    saveAuth(authState);
    onProgress("✅ Authentication captured and saved!");
    onProgress(`   Cookie length: ${cookieString.length}`);
    onProgress(`   Refresh token: ${refreshToken ? "✓" : "✗"}`);
    onProgress(`   Access token:  ${accessToken ? "✓" : "✗"}`);
    onProgress(`   Saved to: ${AUTH_FILE}`);

    return authState;
  } finally {
    if (didLaunch && browser) {
      await browser.close();
    }
  }
}
