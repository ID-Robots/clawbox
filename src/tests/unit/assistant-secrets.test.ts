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
      // Platforms pinned Hermes v0.22.4 added to its `messaging` variables.
      "WEIXIN_TOKEN", "WEIXIN_ACCOUNT_ID", "YUANBAO_APP_SECRET", "YUANBAO_APP_ID",
      "WHATSAPP_CLOUD_ACCESS_TOKEN", "SIGNAL_HTTP_URL", "BLUEBUBBLES_WEBHOOK_PATH",
    ]) {
      expect(isImportableSecretName(name), name).toBe(false);
    }
  });

  it("never offers the keys the assistant answers with", () => {
    for (const name of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "HF_TOKEN", "XAI_API_KEY"]) {
      expect(isImportableSecretName(name), name).toBe(false);
    }
  });

  it("never offers any provider credential of the pinned Hermes", () => {
    // Every name pinned Hermes v0.22.4 (as v0.21.7) files under the `provider` category of
    // its env-var catalogue, taken from the pin rather than from memory. A pin
    // bump that adds a provider adds it here and to MODEL_PROVIDER_NAMES together.
    const pinned = [
      "ACTUAL_API_KEY", "AI_GATEWAY_API_KEY", "ALIBABA_CODING_PLAN_API_KEY", "ALIBABA_CODING_PLAN_BASE_URL", "ALIBABA_CODING_PLAN_CN_API_KEY",
      "ALIBABA_CODING_PLAN_CN_BASE_URL", "ALIBABA_TOKEN_PLAN_API_KEY", "ALIBABA_TOKEN_PLAN_BASE_URL", "ALIBABA_TOKEN_PLAN_CN_API_KEY", "ALIBABA_TOKEN_PLAN_CN_BASE_URL",
      "ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "ARCEEAI_API_KEY", "ARCEE_BASE_URL", "AWS_PROFILE",
      "AWS_REGION", "AZURE_FOUNDRY_API_KEY", "AZURE_FOUNDRY_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "COMMANDCODE_ANTHROPIC_BASE_URL",
      "COMMANDCODE_API_KEY", "COMMANDCODE_BASE_URL", "DASHSCOPE_API_KEY", "DASHSCOPE_BASE_URL", "DASHSCOPE_CN_BASE_URL",
      "DEEPINFRA_API_KEY", "DEEPINFRA_BASE_URL", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "FIREWORKS_API_KEY",
      "GEMINI_API_KEY", "GEMINI_BASE_URL", "GLM_API_KEY", "GLM_BASE_URL", "GMI_API_KEY",
      "GMI_BASE_URL", "GOOGLE_API_KEY", "HERMES_ANON_API_SECRET", "HERMES_QWEN_BASE_URL", "HF_BASE_URL",
      "HF_TOKEN", "KILOCODE_API_KEY", "KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_CN_API_KEY",
      "KIMI_CODING_API_KEY", "LM_API_KEY", "LM_BASE_URL", "META_API_KEY", "META_BASE_URL",
      "META_MODEL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_BASE_URL", "MINIMAX_CN_API_KEY", "MINIMAX_CN_BASE_URL",
      "MODEL_API_KEY", "NEBIUS_API_KEY", "NEBIUS_BASE_URL", "NEBIUS_TOKEN_FACTORY_API_KEY", "NOUS_BASE_URL",
      "NOVITA_API_KEY", "NOVITA_BASE_URL", "NVIDIA_API_KEY", "NVIDIA_BASE_URL", "OLLAMA_API_KEY",
      "OLLAMA_BASE_URL", "OPENCODE_GO_API_KEY", "OPENCODE_GO_BASE_URL", "OPENCODE_ZEN_API_KEY", "OPENCODE_ZEN_BASE_URL",
      "OPENROUTER_API_KEY", "RAMP_ROUTER_API_KEY", "RAMP_ROUTER_BASE_URL", "ROUTER_API_KEY", "STEPFUN_API_KEY",
      "STEPFUN_BASE_URL", "TOKENHUB_API_KEY", "TOKENHUB_BASE_URL", "UPSTAGE_API_KEY", "UPSTAGE_BASE_URL",
      "VERTEX_CREDENTIALS_PATH", "XAI_API_KEY", "XAI_BASE_URL", "XIAOMI_API_KEY", "XIAOMI_BASE_URL",
      "Z_AI_API_KEY", "ZAI_API_KEY",
    ];
    expect(pinned).toHaveLength(87);
    for (const name of pinned) expect(isImportableSecretName(name), name).toBe(false);
  });

  it("never offers an AWS credential, whichever AWS_ name it goes by", () => {
    // Bedrock reads the standard AWS chain, which is not in Hermes' provider
    // list; the whole prefix is the assistant's cloud account.
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]) {
      expect(isImportableSecretName(name), name).toBe(false);
    }
  });

  it("never offers one of the box's own CLAWBOX_ names", () => {
    // The store's reserved prefix is what refuses it, not a list of today's names.
    for (const name of ["CLAWBOX_AI_TOKEN", "CLAWBOX_MCP_TOKEN", "CLAWBOX_ANYTHING_NEW"]) {
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
