import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { get, set } from "@/lib/config-store";

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
  return NextResponse.json({
    hostname,
    current,
    fqdn: `${hostname}.local`,
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

  try {
    await execFileAsync("/usr/bin/sudo", [
      "/usr/bin/systemctl",
      "start",
      "clawbox-root-update@set_hostname.service",
    ]);
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
