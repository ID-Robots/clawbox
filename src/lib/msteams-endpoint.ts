// Where on the box Microsoft Teams has to deliver, per edition — shown in the
// pane so the owner can point a public HTTPS endpoint at it.
//
//   * OpenClaw serves Bot Framework traffic on the gateway's own port, at the
//     plugin's documented path (channels/msteams/setup.md).
//   * Hermes' Teams adapter listens on TEAMS_PORT (Bot Framework's default,
//     3978, when unset).

import type { Harness } from "@/lib/harness";
import { GATEWAY_PORT, MSTEAMS_WEBHOOK_PATH } from "@/lib/openclaw-config";
import { getHermesEnvValue } from "@/lib/hermes-env";

const HERMES_TEAMS_DEFAULT_PORT = 3978;

export interface TeamsEndpoint {
  path: string;
  port: number;
}

export async function teamsEndpoint(harness: Harness): Promise<TeamsEndpoint> {
  if (harness !== "hermes") return { path: MSTEAMS_WEBHOOK_PATH, port: GATEWAY_PORT };
  let port = HERMES_TEAMS_DEFAULT_PORT;
  try {
    const raw = await getHermesEnvValue("TEAMS_PORT");
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) port = parsed;
  } catch {
    // an unreadable .env leaves Hermes on its default too
  }
  return { path: MSTEAMS_WEBHOOK_PATH, port };
}
