import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { get, set } from "@/lib/config-store";
import { startRootStep } from "@/lib/root-step-runner";
import {
  TIMEZONE_STORE_KEY,
  applyTimeZoneToHarness,
  isValidTimeZone,
  readOsTimeZone,
  timezoneEnvPath,
} from "@/lib/timezone";

export const dynamic = "force-dynamic";

/**
 * The box's timezone. See src/lib/timezone.ts for why a ClawBox needed one and
 * which native key each harness already owns (TASK-514).
 *
 * The browser is the only source of truth available: the SERVER's
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` reads the box's own OS
 * zone, which is the `Etc/UTC` being fixed. So the wizard and the desktop offer
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` from the OWNER's browser,
 * and this route decides what to do with it.
 */
export async function GET() {
  const configured = (await get(TIMEZONE_STORE_KEY)) as string | undefined;
  return NextResponse.json({
    timezone: configured ?? null,
    os: readOsTimeZone(),
    adopted: !!configured,
  });
}

export async function POST(request: Request) {
  let body: { timezone?: unknown; adopt?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tz = typeof body.timezone === "string" ? body.timezone.trim() : "";
  if (!isValidTimeZone(tz)) {
    return NextResponse.json(
      { error: "Timezone must be an IANA zone name, for example Europe/Sofia." },
      { status: 400 },
    );
  }

  // ADOPTION is a one-time repair, not a sync. The desktop offers the browser's
  // zone on every load so a box that shipped before this existed heals on the
  // owner's next visit — but a support engineer opening the dashboard from
  // another country must not retarget a box whose owner has already answered.
  // Same rule as ensureVoiceAutoReplyMode: write only where the key is ABSENT.
  const existing = (await get(TIMEZONE_STORE_KEY)) as string | undefined;
  if (body.adopt === true && existing) {
    return NextResponse.json({ success: true, changed: false, timezone: existing });
  }
  if (existing === tz) {
    return NextResponse.json({ success: true, changed: false, timezone: existing });
  }

  await set(TIMEZONE_STORE_KEY, tz);

  // PARSED by install.sh, never sourced: data/ is clawbox-writable and
  // step_set_timezone runs as root, so a `.` on this file would be arbitrary
  // root code execution for anything that can already run code as clawbox.
  // read_configured_timezone re-validates the value on the root side. TASK-445.
  const envPath = timezoneEnvPath();
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(envPath, `TIMEZONE=${tz}\n`, { mode: 0o600 });

  // Two independent halves, reported independently. The OS half is what `date`,
  // the Terminal app and every log line read; the harness half is what the
  // assistant reads. One landing without the other is a HALF fix, and the owner
  // is told which half is outstanding rather than a flat success.
  let osFailure: string | undefined;
  try {
    await startRootStep("set_timezone");
  } catch (err) {
    console.warn("[timezone] Failed to trigger set_timezone service:", err);
    osFailure = "The assistant now uses this timezone, but the device clock could not be changed — the Terminal and the logs stay on the old zone until the next reboot.";
  }

  const harness = await applyTimeZoneToHarness(tz);

  const warning = harness.failure ?? osFailure;
  if (warning) {
    return NextResponse.json(
      { success: true, changed: true, timezone: tz, harness: harness.applied, warning },
      { status: 502 },
    );
  }

  return NextResponse.json({ success: true, changed: true, timezone: tz, harness: harness.applied });
}
