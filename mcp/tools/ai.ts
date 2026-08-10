// Hermes provider / model configuration — "what model are you using" and
// "switch to OpenAI".
//
// DELIBERATELY ABSENT:
//   - a ClawBox AI plan switch. It changes what the customer is BILLED, and
//     "switch to pro for better results" is a one-line prompt-injection payload
//     with a direct financial outcome. The READ lives in device_status; the
//     write stays one click away in Settings -> AI.
//   - a thinking/reasoning setter. POST /setup-api/hermes/models does not yet
//     accept { reasoning }, and the only alternative is a fourth uncoordinated
//     writer of ~/.hermes/config.yaml, which would silently drop the provider
//     key or the mcp_servers block. The read is in device_status.

import { isPlausibleHermesProviderId, isSafeHermesModelId } from "../../src/lib/hermes-providers";
import { apiGet, apiPost } from "../lib/api";
import { ToolError, type ErrorRule } from "../lib/errors";
import { json, text, type Registrar } from "../lib/register";
import { zEnumOf, zText } from "../lib/schema";
import type { McpContext } from "../lib/context";

interface ModelRow {
  id: string;
  description?: string;
  /** Per-million-token prices, already formatted by the route. */
  pricing?: { input?: string; output?: string; free?: boolean };
}

interface ProviderRow {
  id: string;
  name?: string;
  authenticated?: boolean;
  total?: number;
}

interface ModelsBody {
  models?: ModelRow[];
  current?: string;
  provider?: string;
  reasoning?: string;
  providers?: ProviderRow[];
  stale?: boolean;
}

const MODEL_LIMIT = 40;

const SET_RULES: ErrorRule[] = [
  {
    status: 409,
    match: /provider_unauthenticated/,
    code: "CONFLICT",
    message: "That provider has no credentials on this ClawBox.",
    next: "Tell the user to add a key for it in Settings -> AI. Do not retry.",
  },
  {
    status: 409,
    match: /catalog_unavailable/,
    code: "ENDPOINT_DOWN",
    message: "The model catalogue could not be loaded.",
    next: "Call wifi_status, then retry once.",
  },
  {
    status: 409,
    code: "CONFLICT",
    message: "The device has no provider configured yet.",
    next: "Tell the user to choose an AI provider in Settings -> AI. Do not retry.",
  },
  {
    status: 400,
    match: /Unknown provider/i,
    code: "BAD_ARGUMENT",
    message: "That is not a provider on this device.",
    next: "Call ai_list_models and use a provider id from its providers list.",
  },
  {
    status: 400,
    code: "BAD_ARGUMENT",
    message: "That model is not available from the current provider.",
    next: "Call ai_list_models to see which models this provider serves, then pick one of those.",
  },
  {
    status: 502,
    code: "ENDPOINT_DOWN",
    message: "The device could not save the change.",
    next: "Call ai_list_models to see what is configured now, then tell the user.",
  },
];

export function registerAiTools(reg: Registrar, ctx: McpContext): void {
  reg.tool(
    "ai_list_models",
    "List the AI providers configured on this device and the models each one serves, plus which provider and model are in use right now. Call this before ai_set_provider or ai_set_model so you use ids that exist here.",
    {
      provider: zText(64, "Show only this provider's models. Omit to list every configured provider.").optional(),
    },
    { editions: ["hermes"], readOnly: true, profile: "core", maxChars: 6_000 },
    async ({ provider }: { provider?: string }) => {
      if (provider !== undefined && !isPlausibleHermesProviderId(provider)) {
        throw new ToolError(
          "BAD_ARGUMENT",
          "That is not a valid provider id.",
          "Call ai_list_models with no arguments and use one of the ids it lists.",
        );
      }
      const body = await apiGet<ModelsBody>("/setup-api/hermes/models", {
        query: provider ? { provider } : undefined,
        timeoutMs: 20_000,
        rules: [
          {
            status: 400,
            code: "BAD_ARGUMENT",
            message: "That is not a provider on this device.",
            next: "Call ai_list_models with no arguments to see the provider ids that exist here.",
          },
          {
            status: 502,
            code: "ENDPOINT_DOWN",
            message: "The model catalogue could not be loaded.",
            next: "Call wifi_status, then retry once.",
          },
        ],
      });
      // Price is what a customer's "which model should I use" question is
      // actually about, so it travels with the id rather than being dropped.
      const models = (body.models ?? []).slice(0, MODEL_LIMIT).map((m) =>
        m.pricing
          ? { id: m.id, price_per_million: `in ${m.pricing.input ?? "?"} / out ${m.pricing.output ?? "?"}` }
          : { id: m.id },
      );
      return json({
        in_use: { provider: body.provider ?? "unknown", model: body.current ?? "unknown" },
        thinking: body.reasoning ?? "unknown",
        providers: (body.providers ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          has_credentials: p.authenticated !== false,
          model_count: p.total,
        })),
        models,
        models_truncated: (body.models ?? []).length > MODEL_LIMIT,
        catalogue_stale: body.stale === true,
      });
    },
  );

  // The enum IS the validation when the catalogue answered at startup. When it
  // did not, degrade to a text parameter with a runtime allowlist check rather
  // than dropping the tool — a temporarily unreachable dashboard must not cost
  // the agent the ability to switch provider for the rest of the session.
  const providerParam =
    ctx.providers.length > 0
      ? zEnumOf(ctx.providers, "Provider id to switch to.")
      : zText(64, "Provider id to switch to, exactly as ai_list_models reports it.");

  reg.tool(
    "ai_set_provider",
    "Switch which AI provider this device uses. Only call it when the user names a provider. The model resets to that provider's own default, so call ai_set_model afterwards if the user also named a model. Use ai_list_models first to see which providers have credentials here.",
    { provider: providerParam },
    { editions: ["hermes"], readOnly: false },
    async ({ provider }: { provider: string }) => {
      if (!isPlausibleHermesProviderId(provider)) {
        throw new ToolError(
          "BAD_ARGUMENT",
          "That is not a valid provider id.",
          "Call ai_list_models and use one of the ids in its providers list.",
        );
      }
      if (ctx.providers.length > 0 && !ctx.providers.includes(provider)) {
        throw new ToolError(
          "BAD_ARGUMENT",
          "That provider is not set up on this device.",
          `Use one of: ${ctx.providers.join(", ")}`,
        );
      }
      const body = await apiPost<{ provider?: string; model?: string }>(
        "/setup-api/hermes/models",
        { provider },
        { timeoutMs: 30_000, rules: SET_RULES },
      );
      return text(`Now using provider "${body.provider ?? provider}" with model "${body.model ?? "its default"}".`);
    },
  );

  reg.tool(
    "ai_set_model",
    "Switch which model this device's AI uses, keeping the current provider. Only call it when the user names a model. To change provider instead, use ai_set_provider. Call ai_list_models first so you pass a model id this provider actually serves.",
    { model: zText(128, "Model id exactly as ai_list_models reports it") },
    { editions: ["hermes"], readOnly: false },
    async ({ model }: { model: string }) => {
      if (!isSafeHermesModelId(model)) {
        throw new ToolError(
          "BAD_ARGUMENT",
          "That is not a valid model id.",
          "Call ai_list_models and copy one of the ids from its models list.",
        );
      }
      const body = await apiPost<{ provider?: string; model?: string }>(
        "/setup-api/hermes/models",
        { model },
        { timeoutMs: 30_000, rules: SET_RULES },
      );
      return text(`Now using model "${body.model ?? model}" from provider "${body.provider ?? "the current provider"}".`);
    },
  );
}
