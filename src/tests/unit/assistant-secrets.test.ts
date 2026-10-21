/**
 * Which of the assistant's keys "Import from assistant" may offer
 * (src/lib/assistant-secrets.ts `isImportableSecretName`).
 *
 * The keys a run legitimately needs — a GitHub token, a search or docs API key
 * the owner pasted into a skill, a deploy token they added by hand — are
 * offered. The assistant's and the box's own wiring never is: the session
 * secret, the gateway, MCP, portal and local-AI tokens, every chat-channel and
 * mail credential, the model-provider keys, and a secret manager's master
 * token. The store's reserved names stay refused on top.
 */
import { describe, expect, it } from "vitest";
import { isImportableSecretName } from "@/lib/assistant-secrets";

describe("isImportableSecretName", () => {
  it("offers the keys a run may need", () => {
    for (const name of [
      "GITHUB_TOKEN", "NOTION_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY", "LINEAR_API_KEY",
      "DEPLOY_TOKEN", "STRIPE_TEST_KEY", "VERCEL_TOKEN",
    ]) {
      expect(isImportableSecretName(name), name).toBe(true);
    }
  });

  it("never offers the box's own wiring", () => {
    for (const name of [
      "SESSION_SECRET", "MCP_TOKEN", "LOCAL_AI_TOKEN", "GOOGLE_OAUTH_CLIENT_SECRET", "SUDO_PASSWORD",
      "OPENCLAW_GATEWAY_TOKEN", "CLAWAI_TOKEN", "PORTAL_TOKEN", "API_SERVER_KEY", "GATEWAY_PROXY_KEY",
      "HERMES_ANON_API_SECRET", "TOOL_GATEWAY_USER_TOKEN",
    ]) {
      expect(isImportableSecretName(name), name).toBe(false);
    }
  });

  it("never offers a chat-channel or mail credential", () => {
    for (const name of [
      "TELEGRAM_BOT_TOKEN", "DISCORD_BOT_TOKEN", "SLACK_BOT_TOKEN", "WHATSAPP_ENABLED", "EMAIL_PASSWORD",
      "MATRIX_ACCESS_TOKEN", "TWILIO_AUTH_TOKEN", "LINE_CHANNEL_SECRET", "WEBHOOK_SECRET", "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON",
    ]) {
      expect(isImportableSecretName(name), name).toBe(false);
    }
  });

  it("never offers the keys the assistant answers with", () => {
    for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "HF_TOKEN", "XAI_API_KEY"]) {
      expect(isImportableSecretName(name), name).toBe(false);
    }
  });

  it("never offers a secret manager's master token", () => {
    for (const name of ["BWS_ACCESS_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN", "OP_CONNECT_TOKEN"]) {
      expect(isImportableSecretName(name), name).toBe(false);
    }
  });

  it("keeps the store's reserved names and alphabet", () => {
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAWBOX_MCP_TOKEN", "PATH", "LD_PRELOAD", "lower_case", "2FA_TOKEN", ""]) {
      expect(isImportableSecretName(name), name).toBe(false);
    }
  });
});
