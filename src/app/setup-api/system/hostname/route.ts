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
  //
  // Hermes needs no equivalent of its own either — TASK-553 asked, and the
  // answer is no: neither Hermes nor its ClawBox proxy holds a list a rename
  // could invalidate. The reasoning and the proof are in
  // src/tests/unit/hermes-dashboard-proxy-renamed-host.test.ts.

  // Which half of the gateway leg failed, if either — the two need different
  // words, and one try around both would have blamed a gateway that was never
  // restarted for a failed origins write. `null` means nothing is outstanding:
  // both halves worked, or this edition has no gateway to have a leg at all.
  let gatewayGap: "origins" | "restart" | null = null;
  if (!gatewayIsAbsent()) {
    try {
      await setControlUiAllowedOrigins(name);
    } catch (err) {
      console.warn("[hostname] Failed to update OpenClaw allowed origins:", err);
      gatewayGap = "origins";
    }
    // Only when there is a new origin list to pick up. Bouncing the gateway
    // onto the same config it already has would cost the owner a restart and
    // tell them nothing.
    if (!gatewayGap) {
      try {
        // `awaitReady: false`: the caller's next act on a success is to REBOOT
        // the box (SettingsApp posts /setup-api/system/power, and the wizard
        // does not even read this response), and the reboot restarts the
        // gateway anyway. Waiting up to 30 s here would delay that reboot —
        // worst on a cold first boot, which is exactly when it is slowest — to
        // learn something nothing consumes. A restart that is REFUSED is still
        // reported; only "has it finished coming back" is not asked.
        await restartGateway({ awaitReady: false });
      } catch (err) {
        console.warn("[hostname] Failed to restart the OpenClaw gateway:", err);
        gatewayGap = "restart";
      }
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

  // The rename happened and the root step is running, so this is never an
  // error — but it is not a plain success either while the control UI is still
  // configured for the old name. 502 says a half is outstanding without
  // retracting the half that worked; SettingsApp reads it that way and still
  // reboots the box, which is what actually completes the rename.
  if (gatewayGap) {
    return NextResponse.json(
      {
        success: true,
        hostname: name,
        fqdn: `${name}.local`,
        gatewayRestarted: false,
        warning: gatewayGap === "origins"
          ? `Renamed, but the chat UI's allowed-origin list could not be updated — it reaches ${name}.local after the reboot.`
          : `Renamed, but the OpenClaw gateway could not be restarted — the chat UI reaches ${name}.local after the reboot.`,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    hostname: name,
    fqdn: `${name}.local`,
  });
}
