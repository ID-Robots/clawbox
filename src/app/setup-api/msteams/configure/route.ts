import { NextResponse } from "next/server";
import { set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  EnvSecretProviderConflictError,
  isSafeGatewayEnvValue,
  setTeamsCredentials,
} from "@/lib/openclaw-config";
import { type ChannelPluginFailure, ensureChannelPlugin } from "@/lib/openclaw-channels";
import { setHermesChannelSecrets } from "@/lib/hermes-channels";
import { setHermesEnvValues } from "@/lib/hermes-env";
import {
  GUIDED_CHANNELS,
  applyChannelRestart,
  scrubSecrets,
  settleChannelSave,
} from "@/lib/guided-channels";
import { previewGate } from "@/lib/guided-channel-routes";
import {
  TeamsAuthError,
  TeamsUnavailableError,
  checkTeamsCredentials,
  isTeamsAppId,
  isTeamsTenantId,
} from "@/lib/msteams-api";
import { teamsEndpoint } from "@/lib/msteams-endpoint";

export const dynamic = "force-dynamic";

const LOG_TAG = "msteams/configure";

// Microsoft Teams (a preview channel) on either edition.
//
//   * The three values are checked with Microsoft (a Bot Framework token
//     request) before anything is written.
//   * OpenClaw: the official @openclaw/msteams plugin, then channels.msteams
//     with the client secret as an env SecretRef (data/msteams.env, 0600).
//   * Hermes: TEAMS_CLIENT_SECRET through `hermes config set` (a *_SECRET key,
//     which Hermes routes to .env itself); TEAMS_CLIENT_ID and TEAMS_TENANT_ID
//     through hermes-env.ts, since `config set` would send them to config.yaml.
//
// A webhook channel: `success` means the gateway is up and listening. Whether
// Teams reaches it depends on a public HTTPS endpoint the box does not open,
// and the response carries the local endpoint so the pane can say where to
// point it.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? (body[key] as string).trim() : "";
}

export async function POST(request: Request) {
  const gate = previewGate("msteams");
  if (gate) return gate;
  let secrets: string[] = [];
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    if (!isRecord(body)) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    const appId = field(body, "appId");
    const appPassword = field(body, "appPassword");
    const tenantId = field(body, "tenantId");
    if (!appId || !appPassword || !tenantId) {
      return NextResponse.json(
        { error: "The App ID, the client secret and the tenant ID are all required", code: "tokens_required" },
        { status: 400 },
      );
    }
    secrets = [appPassword];
    if (!isTeamsAppId(appId) || !isTeamsTenantId(tenantId)) {
      return NextResponse.json({ error: "The App ID and tenant ID are not valid", code: "id_format" }, { status: 400 });
    }
    if (!isSafeGatewayEnvValue(appPassword)) {
      return NextResponse.json({ error: "That does not look like a client secret", code: "token_format" }, { status: 400 });
    }

    try {
      await checkTeamsCredentials(appId, appPassword, tenantId, request.signal);
    } catch (err) {
      if (err instanceof TeamsAuthError) {
        return NextResponse.json({ error: err.message, code: err.problem }, { status: 400 });
      }
      if (err instanceof TeamsUnavailableError) {
        return NextResponse.json(
          { error: "Microsoft could not be reached to check the bot", code: "msteams_unavailable" },
          { status: 502 },
        );
      }
      throw err;
    }

    const harness = await getActiveHarness();
    // ClawBox's own store first; past here nothing takes the request's signal.
    await set("msteams_app_id", appId);
    await set("msteams_tenant_id", tenantId);
    await set("msteams_app_password", appPassword);

    let installFailure: ChannelPluginFailure | null = null;
    if (harness === "hermes") {
      await setHermesChannelSecrets({ TEAMS_CLIENT_SECRET: appPassword });
      await setHermesEnvValues({ TEAMS_CLIENT_ID: appId, TEAMS_TENANT_ID: tenantId });
    } else {
      const plugin = await ensureChannelPlugin(GUIDED_CHANNELS.msteams.openclawId);
      if (!plugin.ok) installFailure = plugin.reason;
      try {
        await setTeamsCredentials(appId, appPassword, tenantId);
      } catch (err) {
        if (err instanceof EnvSecretProviderConflictError) {
          console.error(`[${LOG_TAG}] refusing an unresolvable secret reference:`, err.message);
          return NextResponse.json({ success: false, code: "token_unresolved", restarted: false });
        }
        throw err;
      }
    }

    const restarted = await applyChannelRestart(harness, secrets, LOG_TAG);
    const blocking = await settleChannelSave(harness, "msteams", restarted, installFailure);

    return NextResponse.json({
      success: blocking === undefined,
      ...(blocking === undefined ? {} : { code: blocking }),
      restarted,
      endpoint: await teamsEndpoint(harness),
    });
  } catch (err) {
    console.error(`[${LOG_TAG}] failed:`, scrubSecrets(err, secrets));
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
