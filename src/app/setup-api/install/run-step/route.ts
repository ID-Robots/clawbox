import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

// POST /setup-api/install/run-step  body: { step: "<step_name>" }
//
// Runs `install.sh --step <step>` via the clawbox-root-update@.service
// systemd template (root-privileged; the clawbox-setup web service runs as
// the unprivileged `clawbox` user). Synchronous — the request stays open
// until the install step finishes so the UI can chain a reboot or refresh
// on success.
//
// Steps are whitelisted here on top of install.sh's own DISPATCH_STEPS
// list. Only steps that are safe to invoke from a clicked button in the
// UI go in. Anything that would reboot, modify networking, or wipe state
// stays out — we don't want a one-tap escalation surface.
const ALLOWED_STEPS = new Set([
  "cloudflared_install",
  "vnc_install",
  "vnc_refresh",
  "chromium_install",
  "ai_tools_install",
  "ollama_install",
  "llamacpp_install",
  "ffmpeg_install",
  "openclaw_install",
  "openclaw_setup",
  "openclaw_patch",
  "openclaw_config",
  "clawkeep_install",
]);

// Most install steps complete in ~30-120s on a warm Jetson. vnc_install /
// chromium_install can take several minutes when apt has to fetch fresh.
// 10 min is the cap; longer than that the user should retry rather than
// stare at a stuck request.
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

async function getJournalTail(unit: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/journalctl",
      ["-u", unit, "-n", "60", "--no-pager", "-o", "cat"],
      { timeout: 10_000 },
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function POST(req: Request) {
  let step: string;
  try {
    const body = (await req.json()) as { step?: unknown };
    if (typeof body.step !== "string") {
      return NextResponse.json(
        { ok: false, error: "Body must include 'step' as a string." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    step = body.step;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!ALLOWED_STEPS.has(step)) {
    return NextResponse.json(
      { ok: false, error: `Step '${step}' is not allowed from the UI.` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const serviceName = `clawbox-root-update@${step}.service`;
  try {
    // reset-failed is best-effort: a previous failed run leaves the unit
    // in "failed" state and `systemctl start` would refuse without it.
    await execFileAsync("/usr/bin/systemctl", ["reset-failed", serviceName], {
      timeout: 10_000,
    }).catch(() => {});

    await execFileAsync("/usr/bin/systemctl", ["start", serviceName], {
      timeout: STEP_TIMEOUT_MS,
    });

    return NextResponse.json(
      { ok: true, step },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const tail = await getJournalTail(serviceName);
    // Persist a structured failure record so post-mortems don't have to
    // scrape the response body. journalctl is the source of truth, but
    // having the same tail in our service logs makes it discoverable
    // alongside surrounding requests.
    console.error(JSON.stringify({
      level: "error",
      source: "install/run-step",
      step,
      service: serviceName,
      message: err instanceof Error ? err.message : String(err),
      journalTail: tail.slice(-2000),
    }));
    return NextResponse.json(
      {
        ok: false,
        step,
        error: err instanceof Error ? err.message : `${step} failed`,
        journalTail: tail.slice(-2000),
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
