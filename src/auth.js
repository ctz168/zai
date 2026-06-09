import { chromium } from "playwright";
import { saveSession } from "./config.js";

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
  
  console.log("[ZAI] Navigating to https://chat.z.ai/ ...");
  await page.goto("https://chat.z.ai/", { waitUntil: "domcontentloaded", timeout: 120000 });
  
  const userAgent = await page.evaluate(() => navigator.userAgent);
  
  console.log("[ZAI] Please login in the browser window...");
  console.log("[ZAI] Waiting for authentication (checking for login cookies)...");
  
  try {
    await page.waitForFunction(
      () => {
        const cookieStr = document.cookie;
        const hasAuthCookie =
          cookieStr.includes("chatglm_refresh_token") ||
          cookieStr.includes("refresh_token") ||
          cookieStr.includes("auth_token") ||
          cookieStr.includes("access_token") ||
          cookieStr.includes("token");
        const hasChatElements =
          document.querySelector('textarea, [contenteditable="true"], .chat-input, .message-input') !== null;
        return hasAuthCookie || hasChatElements;
      },
      { timeout: 600000, polling: 1000 },
    );
    console.log("[ZAI] Login detected!");
  } catch (error) {
    console.log("[ZAI] Login detection timed out, checking current page state...");
    const cookies = await context.cookies("https://chat.z.ai");
    if (cookies.length === 0) {
      throw new Error("Login timeout. Please ensure you've logged in to chat.z.ai in the browser window.");
    }
    console.log("[ZAI] Proceeding with available cookies...");
  }
  
  console.log("[ZAI] Capturing cookies...");
  const cookies = await context.cookies("https://chat.z.ai");
  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  
  // Parse individual cookies for structured storage
  const cookieMap = {};
  for (const c of cookies) {
    cookieMap[c.name] = c.value;
  }
  
  const session = {
    cookie: cookieString,
    cookieMap,
    userAgent,
  };
  
  saveSession(session);
  console.log("[ZAI] Authentication captured and saved successfully!");
  console.log(`[ZAI] Found ${cookies.length} cookies`);
  
  await browser.close();
  return session;
}

export async function loginWithExistingBrowser(cdpUrl = "http://127.0.0.1:9222") {
  console.log(`[ZAI] Connecting to existing browser at ${cdpUrl}...`);
  
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  const pages = context.pages();
  
  let page = pages.find((p) => p.url().includes("chat.z.ai"));
  if (!page) {
    page = await context.newPage();
    await page.goto("https://chat.z.ai/", { waitUntil: "domcontentloaded", timeout: 120000 });
  }
  
  const userAgent = await page.evaluate(() => navigator.userAgent);
  
  console.log("[ZAI] Please login in the browser window...");
  console.log("[ZAI] Waiting for authentication...");
  
  try {
    await page.waitForFunction(
      () => {
        const cookieStr = document.cookie;
        return cookieStr.includes("chatglm_refresh_token") ||
               cookieStr.includes("refresh_token") ||
               cookieStr.includes("token");
      },
      { timeout: 600000, polling: 1000 },
    );
  } catch {
    console.log("[ZAI] Timeout, checking available cookies...");
  }
  
  const cookies = await context.cookies("https://chat.z.ai");
  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const cookieMap = {};
  for (const c of cookies) {
    cookieMap[c.name] = c.value;
  }
  
  const session = { cookie: cookieString, cookieMap, userAgent };
  saveSession(session);
  console.log("[ZAI] Authentication captured and saved!");
  
  await browser.close();
  return session;
}
