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
    // up to ~30s to come back. Exponential backoff (500 → 1000 → 2000 →
    // 4000ms cap) reduces the polling load while still giving a tight
    // recovery signal when the gateway comes back in the first few seconds.
    let available = false;
    let delay = 500;
    const maxDelay = 4000;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !available) {
      const result = await getGatewayHealth().catch(() => null);
      if (result?.available) {
        available = true;
        break;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
    expect(available).toBe(true);
  });

  test("ws-config returns token + model", async () => {
    const config = await getChatWsConfig();
    expect(config.token).toBeTruthy();
    expect(config.wsUrl).toContain(`:${CLAWBOX_PORT}`);
    expect(config.model).toBeTruthy();
  });

  test("WebSocket upgrade to gateway handshakes", async () => {
    const config = await getChatWsConfig();
    // ChatApp/ChatPopup open the gateway WS at the wsUrl root itself
    // (production-server.js proxies the upgrade to the gateway on 18789).
    // No sub-path is required — auth happens via the first message after
    // upgrade, not via query string.
    const result = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      const ws = new WebSocket(config.wsUrl);
      const timer = setTimeout(() => { ws.terminate(); resolve({ ok: false, reason: "timeout after 30s" }); }, 30_000);
      ws.on("open", () => { clearTimeout(timer); ws.close(); resolve({ ok: true }); });
      ws.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, reason: `error: ${(err as Error).message}` }); });
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: `HTTP ${res.statusCode} ${res.statusMessage ?? ""}`.trim() });
      });
    });
    if (!result.ok) throw new Error(`gateway WS did not upgrade: ${result.reason} (url=${config.wsUrl})`);
  });

  test("UI chat widget receives a streamed response", async ({ page }) => {
    test.setTimeout(180_000);

    // Playwright gives each test a fresh browser context with no cookies,
    // so the happy-path spec's session doesn't carry over. Re-POST to
    // /setup-api/setup/complete — the handler is idempotent (setup_complete
    // is already true) and always issues a fresh session cookie.
    const completeRes = await fetch(`${BASE_URL}/setup-api/setup/complete`, { method: "POST" });
    expect(completeRes.ok).toBe(true);
    const setCookie = completeRes.headers.get("set-cookie") ?? "";
    const match = setCookie.match(/clawbox_session=([^;]+)/);
    expect(match).not.toBeNull();
    await page.context().addCookies([
      { name: "clawbox_session", value: match![1], domain: "localhost", path: "/" },
    ]);

    // The desktop opens the chat panel based on the ui_chat_open pref.
    // Fresh-setup state leaves it closed; force it open so we don't have
    // to hunt for the mascot-click sequence that toggles it.
    await fetch(`${BASE_URL}/setup-api/preferences`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ui_chat_open: 1, ui_mascot_hidden: 1 }),
    });

    await page.goto("/");

    // ChatPopup auto-opens on the desktop shell — no launcher click needed.
    // The textbox has a stable placeholder "Type a message...". Use that
    // as the anchor rather than a data-testid, since the chat UI relies on
    // ARIA role + placeholder for accessibility.
    const input = page.getByRole("textbox", { name: /Type a message/i });
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill("Say the word 'pong' and nothing else.");

    // Submit via the Send button — pressing Enter sometimes inserts a
    // newline instead of submitting, depending on the textarea component.
    const sendButton = page.getByRole("button", { name: /^Send$/ });
    await expect(sendButton).toBeEnabled({ timeout: 5_000 });
    await sendButton.click();

    // Wait for any message that contains "pong" (case-insensitive) within
    // 90s. Models may prefix with whitespace or punctuation.
    await expect(page.locator("body")).toContainText(/pong/i, { timeout: 90_000 });
  });
});
