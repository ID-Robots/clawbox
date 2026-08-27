import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { get, set } from "@/lib/config-store";
import { gatewayIsAbsent, restartGateway, setControlUiAllowedOrigins } from "@/lib/openclaw-config";
import { getReachableIpv4 } from "@/lib/system-info";
import { startRootStep } from "@/lib/root-step-runner";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

const HOSTNAME_ENV_PATH = path.join(
  process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox",
  "data",
  "hostname.env"
);

const DEFAULT_HOSTNAME = "clawbox";
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function normalize(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().toLowerCase().replace(/\.local$/, "");
  if (!HOSTNAME_RE.test(trimmed)) return null;
  return trimmed;
}

export async function GET() {
  const configured = (await get("hostname")) as string | undefined;
  const current = os.hostname();
  const hostname = configured || current || DEFAULT_HOSTNAME;
  const ipv4 = await getReachableIpv4();
  return NextResponse.json({
    hostname,
    current,
    fqdn: `${hostname}.local`,
    ipv4,
    default: DEFAULT_HOSTNAME,
  });
}

export async function POST(request: Request) {
  let body: { hostname?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = normalize(body.hostname);
  if (!name) {
    return NextResponse.json(
      {
        error:
          "Hostname must be 1-63 characters, lowercase letters, digits, or hyphens, and cannot start or end with a hyphen.",
      },
      { status: 400 }
    );
  }

  await set("hostname", name);
  await fs.mkdir(path.dirname(HOSTNAME_ENV_PATH), { recursive: true });
  await fs.writeFile(HOSTNAME_ENV_PATH, `HOSTNAME=${name}\n`, { mode: 0o600 });

  // Update OpenClaw gateway control-UI allowed origins so the chat / control
  // UI keeps working at http://<name>.local. Restart the gateway so it picks
  // up the new origin list. Both are best-effort: if either fails the
  // hostname change still proceeds (a reboot will reconcile).
  // Skipped entirely on Hermes. `setControlUiAllowedOrigins` ends in
  // `writeConfig`, which MKDIRs `~/.openclaw` and writes an
  // `openclaw.json` carrying a `gateway.controlUi.allowedOrigins` block —
  // manufacturing OpenClaw state on the one SKU whose defining property is not
  // having any, for a gateway that is removed and masked there and will never
  // read it. `restartGateway()` then no-ops. The hostname change itself is
  // unaffected either way, so this was never a false success — just litter,
  // and litter that makes `~/.openclaw` exist is the kind that misleads the
  // next person debugging an edition question.
  if (!gatewayIsAbsent()) {
    try {
      await setControlUiAllowedOrigins(name);
      await restartGateway();
    } catch (err) {
      console.warn("[hostname] Failed to update OpenClaw allowed origins:", err);
    }
  }

    // Clear a previous failure first. clawbox-root-update@.service does not
    // set StartLimitIntervalSec=0, so a step that failed a few times hits
    // systemd's start limit and every later start is refused until something
    // resets it — which used to be nothing on this path. The chpasswd and
    // llamacpp hand-offs already did this; these did not. TASK-445.
  try {
    await startRootStep("set_hostname");
  } catch (err) {
    console.warn("[hostname] Failed to trigger set_hostname service:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to apply hostname. It will be applied on next reboot.",
        hostname: name,
        fqdn: `${name}.local`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    hostname: name,
    fqdn: `${name}.local`,
  });
}
