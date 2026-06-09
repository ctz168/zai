import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(os.homedir(), ".zai");
const SESSION_FILE = path.join(CONFIG_DIR, "session.json");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function saveSession(session) {
  ensureConfigDir();
  const data = { ...session, savedAt: new Date().toISOString() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
  console.log(`[ZAI] Session saved to ${SESSION_FILE}`);
}

export function loadSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
  } catch { return null; }
}

export function clearSession() {
  if (fs.existsSync(SESSION_FILE)) {
    fs.unlinkSync(SESSION_FILE);
    console.log("[ZAI] Session cleared");
  }
}

export async function login(options = {}) {
  const { headless = false } = options;
  console.log("[ZAI] Launching browser for login...");
  
  const browser = await chromium.launch({
    headless,
    channel: "chrome",
  });
  
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  });
  
  const page = await context.newPage();
  
  // Intercept API requests to discover endpoints and capture auth headers
  const apiRequests = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("chatglm") || url.includes("/api/") || url.includes("/v1/")) {
      apiRequests.push({ url, method: req.method() });
      if (apiRequests.length <= 30) {
        console.log(`[ZAI Intercept] ${req.method()} ${url}`);
      }
    }
  });

  console.log("[ZAI] Navigating to https://chat.z.ai/ ...");
  await page.goto("https://chat.z.ai/", { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForTimeout(2000);

  // Check current cookies (guest)
  const guestCookies = await context.cookies("https://chat.z.ai");
  console.log(`[ZAI] Guest mode: ${guestCookies.length} cookies`);
  for (const c of guestCookies) {
    console.log(`  Guest cookie: ${c.name} = ${c.value.substring(0, 30)}...`);
  }

  console.log("\n[ZAI] ==============================================");
  console.log("[ZAI]  Please LOGIN in the browser window NOW!");
  console.log("[ZAI]  Use your Z.AI account (email/password/Google)");
  console.log("[ZAI]  Waiting up to 10 minutes for login...");
  console.log("[ZAI] ==============================================\n");

  // Wait for REAL login - detect by:
  // 1. chatglm_token or chatglm_refresh_token cookies (real auth cookies)
  // 2. Token that is NOT a guest token (guest emails contain "guest-")
  // 3. URL change away from auth/login
  try {
    await page.waitForFunction(
      () => {
        const cookieStr = document.cookie;
        // These cookies only appear after REAL login (not guest)
        if (cookieStr.includes("chatglm_refresh_token") || 
            cookieStr.includes("chatglm_token")) {
          return true;
        }
        // Check if token changed from guest
        const tokenMatch = cookieStr.match(/token=([^;]+)/);
        if (tokenMatch) {
          try {
            const payload = JSON.parse(atob(tokenMatch[1].split('.')[1]));
            // If email doesn't contain "guest", it's a real login
            if (payload.email && !payload.email.includes("guest")) {
              return true;
            }
          } catch {}
        }
        return false;
      },
      { timeout: 600000, polling: 2000 },
    );
    console.log("[ZAI] REAL login detected!");
  } catch (err) {
    console.log("[ZAI] Login detection timeout, checking current state...");
    // Fallback: check what we have
    const currentUrl = page.url();
    const docCookies = await page.evaluate(() => document.cookie);
    console.log(`[ZAI] Current URL: ${currentUrl}`);
    console.log(`[ZAI] Cookies: ${docCookies.substring(0, 200)}`);
    
    // Check if the token is still a guest token
    const tokenMatch = docCookies.match(/token=([^;]+)/);
    if (tokenMatch) {
      try {
        const payload = JSON.parse(Buffer.from(tokenMatch[1].split('.')[1], 'base64').toString());
        if (payload.email && payload.email.includes("guest")) {
          console.log("[ZAI] ERROR: Still using guest token! Login did NOT succeed.");
          console.log(`[ZAI] Guest email: ${payload.email}`);
          await browser.close();
          throw new Error("Login failed - still using guest account. Please try again.");
        }
      } catch (e) {
        if (e.message.includes("Login failed")) throw e;
      }
    }
  }

  // Wait for cookies to settle
  await page.waitForTimeout(3000);

  // Capture final cookies
  const cookies = await context.cookies("https://chat.z.ai");
  console.log(`\n[ZAI] Final cookies (${cookies.length}):`);
  for (const c of cookies) {
    console.log(`  ${c.name}: ${c.value.substring(0, 50)}${c.value.length > 50 ? '...' : ''}`);
  }

  // Verify it's NOT a guest token
  const cookieMap = {};
  for (const c of cookies) {
    cookieMap[c.name] = c.value;
  }
  
  const tokenValue = cookieMap.token || cookieMap.chatglm_token || cookieMap.access_token;
  if (tokenValue && tokenValue.startsWith("eyJ")) {
    try {
      const payload = JSON.parse(Buffer.from(tokenValue.split('.')[1], 'base64').toString());
      console.log(`[ZAI] Token user: id=${payload.id}, email=${payload.email}`);
      if (payload.email && payload.email.includes("guest")) {
        console.log("[ZAI] WARNING: This is a GUEST token, not a real login!");
        await browser.close();
        throw new Error("Login failed - captured guest token instead of real user token. Please ensure you login with your actual account.");
      }
    } catch (e) {
      if (e.message.includes("Login failed")) throw e;
      console.log("[ZAI] Could not decode token");
    }
  }

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  
  const session = { cookie: cookieString, cookieMap, userAgent };
  saveSession(session);
  
  console.log("\n[ZAI] Login successful! Session saved.");
  console.log(`[ZAI] Cookies: ${cookies.length}, User-Agent captured`);

  // Print intercepted API requests
  if (apiRequests.length > 0) {
    console.log("\n[ZAI] API requests discovered during login:");
    const seen = new Set();
    for (const r of apiRequests) {
      const key = `${r.method} ${r.url}`;
      if (!seen.has(key)) {
        seen.add(key);
        console.log(`  ${r.method} ${r.url}`);
      }
    }
  }

  await browser.close();
  return session;
}
