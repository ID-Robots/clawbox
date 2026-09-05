import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { get, set } from "@/lib/config-store";
import { hasOwnerSession } from "@/lib/owner-session";
import { isSameOriginRequest } from "@/lib/same-origin";
import { startRootStep } from "@/lib/root-step-runner";
import {
  TIMEZONE_APPLIED_KEY,
  TIMEZONE_SOURCE_KEY,
  TIMEZONE_STORE_KEY,
  applyTimeZoneToHarness,
  canonicalTimeZone,
  readOsTimeZone,
  timezoneEnvPath,
} from "@/lib/timezone";

export const dynamic = "force-dynamic";

/**
 * The box's timezone. See src/lib/timezone.ts for why a ClawBox needed one and
 * which native key each harness already owns (TASK-514).
 *
 * The browser is the only source of truth available: the SERVER's own view of
 * the zone is the box's `Etc/UTC`, which is the thing being fixed. So the
 * desktop offers `Intl.DateTimeFormat().resolvedOptions().timeZone` from the
 * OWNER's browser and this route decides what to do with it.
 */
async function readState(): Promise<{
  timezone: string | null;
  source: string | null;
  applied: boolean;
}> {
  const [timezone, source, appliedZone] = await Promise.all([
    get(TIMEZONE_STORE_KEY) as Promise<string | undefined>,
    get(TIMEZONE_SOURCE_KEY) as Promise<string | undefined>,
    get(TIMEZONE_APPLIED_KEY) as Promise<string | undefined>,
  ]);
  return {
    timezone: timezone ?? null,
    source: source ?? null,
    applied: !!timezone && appliedZone === timezone,
  };
}

export async function GET() {
  const state = await readState();
  return NextResponse.json({
    ...state,
    os: await readOsTimeZone(),
    // Whether a browser's offer would be taken. A zone a PERSON chose is never
    // overridden by whoever happens to open the dashboard next.
    acceptsAdoption: state.source !== "explicit",
  });
}

export async function POST(request: Request) {
  // OWNER ONLY, both halves. `src/middleware.ts` admits any /setup-api/*
  // request carrying a valid MCP bearer, so without this the AGENT could move
  // the box's clock, both harness zones, OpenClaw's heartbeat active hours and
  // its cron — and a same-site proxied webapp under /apps/<id>/ carrying the
  // owner's cookie could do it too. Neither is the person whose day this
  // setting is about.
  if (!(await hasOwnerSession(request))) {
    return NextResponse.json(
      { error: "Changing the timezone needs a signed-in browser session.", kind: "owner_only" },
      { status: 403 },
    );
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json(
      { error: "The timezone can only be changed from this ClawBox's own pages.", kind: "cross_origin" },
      { status: 403 },
    );
  }

  // `request.json()` resolves for `null`, `"Europe/Sofia"`, `5` and `[]` just
  // as happily as for an object, so the declared type does not hold at runtime.
  // Reading `.timezone` off `null` throws, and the framework turns that into a
  // bare 500 where this route documents a 400.
  let body: { timezone?: unknown; adopt?: unknown };
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    body = parsed as { timezone?: unknown; adopt?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Canonical spelling only — see canonicalTimeZone. `europe/sofia` is accepted
  // by ICU and refused by the box's own zoneinfo, and the root step would then
  // discard it while every layer above reported success.
  const tz = canonicalTimeZone(body.timezone);
  if (!tz) {
    return NextResponse.json(
      { error: "Timezone must be an IANA zone name, for example Europe/Sofia." },
      { status: 400 },
    );
  }

  const state = await readState();
  const adopting = body.adopt === true;

  // ADOPTION is a repair, not a sync. The desktop offers the browser's zone on
  // every load so a box that shipped before this existed heals on the owner's
  // next visit; a zone a PERSON chose is never overwritten by it.
  //
  // It is deliberately NOT once-per-box. "First browser to open the desktop
  // wins, for ever" is the failure the one-time rule creates: a box QA'd in one
  // country and used in another would keep the wrong zone with no way back. An
  // adopted zone therefore follows the owner's browser, which means a support
  // engineer looking from elsewhere moves it — and the owner's next load moves
  // it back. Self-correcting beats permanently wrong.
  if (adopting && state.source === "explicit") {
    return NextResponse.json({ success: true, changed: false, timezone: state.timezone });
  }
  if (adopting && state.timezone === tz && state.applied) {
    return NextResponse.json({ success: true, changed: false, timezone: tz });
  }

  // PARSED by install.sh, never sourced: data/ is clawbox-writable and
  // step_set_timezone runs as root, so a `.` on this file would be arbitrary
  // root code execution for anything that can already run code as clawbox.
  // read_configured_timezone re-validates the value on the root side against
  // this device's own zoneinfo database. TASK-445.
  //
  // WRITTEN TO A TEMP FILE AND RENAMED, never opened in place. The same actor
  // that can write this file can replace it, and `open()` is the wrong verb for
  // every shape it might have been replaced with: on a FIFO it blocks for ever
  // — no timeout on this path, a libuv slot gone, and TimezoneAdopter fires
  // this route on every desktop load — and through a symlink it follows the
  // link, truncates whatever it points at and leaves the link in place.
  // `rename` replaces the node without opening it, is atomic against the root
  // reader, and heals the path so the next request is a normal one. `wx` on the
  // temp refuses to follow or reuse anything already sitting there, and a fresh
  // file is what makes `mode` apply at all (it is ignored when the destination
  // exists — see the same reasoning in src/lib/config-store.ts).
  //
  // A read-only, full or otherwise refusing `data/` used to escape as a bare
  // 500 with no shape and no log line. Nothing has been recorded and no root
  // step has run yet at this point, so the honest answer is that the zone was
  // not saved — and returning here keeps it that way.
  const envPath = timezoneEnvPath();
  const tmpPath = `${envPath}.tmp`;
  try {
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.rm(tmpPath, { force: true });
    await fs.writeFile(tmpPath, `TIMEZONE=${tz}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(tmpPath, envPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    console.error("[timezone] Failed to write the timezone env file:", err);
    return NextResponse.json(
      { error: "The timezone could not be saved on this device." },
      { status: 500 },
    );
  }

  // Recorded as REQUESTED before either half runs, and as APPLIED only after
  // the harness leg lands. The two keys are what stops a failed apply from
  // recording itself as done and silencing every later offer.
  await set(TIMEZONE_STORE_KEY, tz);
  await set(TIMEZONE_SOURCE_KEY, adopting ? "adopted" : "explicit");
  await set(TIMEZONE_APPLIED_KEY, undefined);

  // Two independent halves, reported independently. The OS half is what `date`,
  // the Terminal app and every log line read; the harness half is what the
  // assistant reads. One landing without the other is HALF a fix, and the owner
  // is told which half is outstanding rather than a flat success.
  let osFailure: string | undefined;
  try {
    await startRootStep("set_timezone");
  } catch (err) {
    console.warn("[timezone] Failed to trigger set_timezone service:", err);
    osFailure = "The assistant now uses this timezone, but the device clock could not be changed — "
      + "the Terminal and the logs stay on the old zone until the next reboot.";
  }

  const harness = await applyTimeZoneToHarness(tz);
  if (!harness.failure) await set(TIMEZONE_APPLIED_KEY, tz);

  const warning = harness.failure ?? osFailure ?? harness.pending;
  if (warning) {
    return NextResponse.json(
      {
        success: true,
        changed: true,
        timezone: tz,
        harness: harness.applied,
        applied: !harness.failure,
        warning,
      },
      // A leg that FAILED is a half-applied change the caller must be able to
      // see; a leg that is merely pending (Hermes picks the zone up when its
      // gateway restarts) is not an error, so it keeps the 200.
      { status: harness.failure || osFailure ? 502 : 200 },
    );
  }

  return NextResponse.json({
    success: true,
    changed: true,
    timezone: tz,
    harness: harness.applied,
    applied: true,
  });
}
