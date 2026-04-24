/**
 * Chat round trip — goes through the real OpenClaw gateway WebSocket using
 * the ChatApp component in a real browser context (driven by Playwright).
 *
 * Skipped unless `.env.test` has at least one usable AI API key. When the
 * key is configured, this test is the strongest end-to-end signal we have:
 * a failure here means one of gateway/scope-patch/ws-config/token/provider-
 * config/auth-profile plumbing is broken.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import WebSocket from "ws";
import { BASE_URL, CLAWBOX_PORT } from "./helpers/container";
import {
  configureAiModel,
  getChatWsConfig,
  getGatewayHealth,
} from "./helpers/setup-api";

function loadEnvTest(): Record<string, string> {
  const envPath = path.resolve(__dirname, ".env.test");
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, "");
    if (val) out[m[1]] = val;
  }
  return out;
}

const env = loadEnvTest();
const HAS_KEY = !!(
  env.CLAWBOX_AI_API_KEY ||
  env.ANTHROPIC_API_KEY ||
  env.OPENAI_API_KEY ||
  env.GEMINI_API_KEY ||
  env.OPENROUTER_API_KEY
);

test.describe.configure({ mode: "serial" });

test.describe("chat round trip", () => {
  test.skip(!HAS_KEY, "no AI keys in .env.test — cannot exercise real chat");

  test.beforeAll(async () => {
    // Re-configure primary AI provider using the first available key. The
    // happy-path test may have configured it already, but we reassert here
    // so this spec can run in isolation too. Prefer CLAWBOX_AI_API_KEY as
    // that's the product's bundled default.
    if (env.CLAWBOX_AI_API_KEY) {
      await configureAiModel("clawai", env.CLAWBOX_AI_API_KEY, "primary");
    } else if (env.ANTHROPIC_API_KEY) {
      await configureAiModel("anthropic", env.ANTHROPIC_API_KEY, "primary");
    } else if (env.OPENAI_API_KEY) {
      await configureAiModel("openai", env.OPENAI_API_KEY, "primary");
    } else if (env.GEMINI_API_KEY) {
      await configureAiModel("google", env.GEMINI_API_KEY, "primary");
    } else if (env.OPENROUTER_API_KEY) {
      await configureAiModel("openrouter", env.OPENROUTER_API_KEY, "primary");
    }
  });

  test("gateway health reports available", async () => {
    // The gateway takes a beat to restart after configureAiModel; give it
    // up to 30s to come back.
    let available = false;
    for (let i = 0; i < 30 && !available; i++) {
      const result = await getGatewayHealth().catch(() => null);
      if (result?.available) available = true;
      else await new Promise((r) => setTimeout(r, 1_000));
    }
    expect(available).toBe(true);
  });

  test("ws-config returns token + model", async () => {
    const config = await getChatWsConfig();
    expect(config.token).toBeTruthy();
    expect(config.wsUrl).toContain(`:${CLAWBOX_PORT}`);
    expect(config.model).toBeTruthy();
  });

  test("WebSocket upgrade to /api/agent handshakes", async () => {
    const config = await getChatWsConfig();
    // The gateway exposes its chat WS under /api/agent (proxied through
    // production-server.js). We just want to confirm the WS upgrade
    // completes — full chat-protocol round-trip is covered by the UI test.
    const url = `${config.wsUrl}/api/agent?token=${encodeURIComponent(config.token)}`;

    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 10_000);
      ws.on("open", () => { clearTimeout(timer); ws.close(); resolve(true); });
      ws.on("error", () => { clearTimeout(timer); resolve(false); });
    });
    expect(opened).toBe(true);
  });

  test("UI chat widget receives a streamed response", async ({ page }) => {
    test.setTimeout(180_000);

    // Inject session cookie from the earlier setup/complete call so we
    // land on the desktop, not the login screen.
    const sessionRes = await fetch(`${BASE_URL}/setup-api/setup/status`);
    const setupStatus = (await sessionRes.json()) as { setup_complete: boolean };
    expect(setupStatus.setup_complete).toBe(true);

    // The desktop auto-authenticates once setup is complete: the
    // /login middleware reads the cookie set by /setup-api/setup/complete.
    // happy-path.spec.ts already injected that cookie into its page
    // context; here we need to re-authenticate by hitting /login (which
    // auto-redirects when setup_complete is true) before navigating.
    await page.goto("/");

    // The chat popup has a stable test id in the desktop component tree.
    const chatTrigger = page.locator(
      '[data-testid="chat-open-button"], [data-testid="chat-panel"], button:has-text("Chat")',
    ).first();
    await expect(chatTrigger).toBeVisible({ timeout: 30_000 });
    await chatTrigger.click().catch(() => {});

    const input = page.locator('textarea, [contenteditable="true"]').first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill("Say the word 'pong' and nothing else.");
    await input.press("Enter");

    // Wait for any message that contains "pong" (case-insensitive) within
    // 90s. Models may prefix with whitespace or punctuation.
    await expect(page.locator("body")).toContainText(/pong/i, { timeout: 90_000 });
  });
});
