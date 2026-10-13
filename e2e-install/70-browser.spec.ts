/**
 * Browser automation — launches real Chromium on Xvfb :99 inside the
 * container, connects over CDP on port 18800, navigates to a real website,
 * and captures a screenshot. Also verifies the VNC stack is serving.
 *
 * Requirements (all satisfied by install.sh under CLAWBOX_TEST_MODE=1):
 *   - x11vnc + Xvfb + websockify installed, clawbox-vnc.service running
 *   - Playwright-managed Chromium in ~/.cache/ms-playwright
 *   - clawbox-browser.service unit installed (started and kept running by
 *     the web server: it is the one browser the owner and the assistant share)
 *
 * Timing note: under qemu arm64 emulation, Chromium cold start can take
 * ~20-30s — well beyond the default 30s action timeout. The individual
 * steps below use explicit longer timeouts.
 */
import { test, expect } from "@playwright/test";
import { dockerExec } from "./helpers/container";
import {
  HttpError,
  browserClose,
  browserLaunch,
  browserManage,
  browserNavigate,
  browserScreenshot,
  getBrowserManage,
} from "./helpers/setup-api";

test.describe.configure({ mode: "serial" });

test.describe("browser + VNC happy path", () => {
  let sessionId: string | null = null;

  test.afterAll(async () => {
    if (sessionId) {
      await browserClose(sessionId).catch(() => {});
    }
  });

  test("VNC services are active", async () => {
    // Check each service independently so a failure message identifies
    // which one is down instead of reporting "one of them isn't active".
    const vncStatus = await dockerExec(
      ["systemctl", "is-active", "clawbox-vnc.service"],
      { user: "root" },
    );
    expect(vncStatus.trim()).toBe("active");

    const wsStatus = await dockerExec(
      ["systemctl", "is-active", "clawbox-websockify.service"],
      { user: "root" },
    );
    expect(wsStatus.trim()).toBe("active");
  });

  test("Xvfb :99 has actually started", async () => {
    const out = await dockerExec(
      ["bash", "-c", "DISPLAY=:99 xset q >/dev/null && echo ok"],
      { user: "clawbox" },
    );
    expect(out.trim()).toBe("ok");
  });

  test("Chromium is installed + discoverable", async () => {
    const state = await getBrowserManage();
    expect(state.chromium.installed).toBe(true);
  });

  test("open-browser starts Chromium CDP", async () => {
    test.setTimeout(180_000);
    // The `open-browser` POST returns a flat shape ({ ok, cdpReady, browser }).
    // Re-query via GET for the nested {chromium, browser, enabled} state.
    await browserManage("open-browser");
    const state = await getBrowserManage();
    expect(state.browser.running).toBe(true);
    expect(state.browser.cdpReady).toBe(true);
  });

  /**
   * `<pid> <profile dir>` per top-level browser process serving a DevTools
   * port. The command line is read as ONE string: a running Chromium rewrites
   * its children's into a single space-joined argument, so a per-argument
   * match would miss their `--type=` and count every renderer.
   */
  async function devtoolsBrowsers(): Promise<string[]> {
    const out = await dockerExec(
      ["bash", "-c", `
        for d in /proc/[0-9]*; do
          [ -r "$d/cmdline" ] || continue
          args=" $(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null)"
          case "$args" in *" --remote-debugging-port="*) ;; *) continue ;; esac
          case "$args" in *" --type="*) continue ;; esac
          prof=$(grep -o -- '--user-data-dir=[^ ]*' <<<"$args" | head -n 1)
          echo "\${d#/proc/} \${prof#--user-data-dir=}"
        done`],
      { user: "clawbox" },
    );
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  test("it is the box's one browser: one process, one profile, shared with the assistant", async () => {
    const state = await getBrowserManage();
    expect(state.sharedWithAssistant).toBe(true);
    expect(state.browser.shared).toBe(true);

    const browsers = await devtoolsBrowsers();
    expect(browsers).toHaveLength(1);
    expect(browsers[0].split(" ")[1]).toBe(state.profileDir);
  });

  test("Close is refused for the shared browser and it keeps running", async () => {
    const before = await devtoolsBrowsers();
    const refusal = await browserManage("close-browser").then(
      () => null,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(HttpError);
    expect((refusal as HttpError).status).toBe(409);
    expect(String((refusal as HttpError).message)).toContain("shared_browser");

    expect(await devtoolsBrowsers()).toEqual(before);
    const state = await getBrowserManage();
    expect(state.browser.running).toBe(true);
  });

  test("launch session and navigate to clawbox.com", async () => {
    test.setTimeout(180_000);
    // clawbox.com is used instead of youtube.com to avoid flakiness
    // from YouTube's bot detection / region gating. It's also the site this
    // product ships with, so a navigation failure here points at something
    // genuinely broken in ClawBox rather than the target site.
    const launched = await browserLaunch("https://clawbox.com/");
    sessionId = launched.sessionId;
    expect(new URL(launched.url).hostname).toBe("clawbox.com");
    expect(launched.title.length).toBeGreaterThan(0);
    expect(launched.screenshot).toBeTruthy();
  });

  test("navigate to youtube.com in the same session", async () => {
    test.setTimeout(120_000);
    expect(sessionId).not.toBeNull();
    const result = await browserNavigate(sessionId!, "https://www.youtube.com/");
    // YouTube may redirect to a consent page, a cookie page, or a regional
    // variant (www, m, or cc.youtube.com, plus /consent paths). Parse the
    // URL and check the hostname ends with youtube.com — that's the real
    // invariant, not a loose substring match that could collide with
    // anti-bot interstitials hosted on arbitrary domains.
    const host = new URL(result.url).hostname;
    expect(host === "youtube.com" || host.endsWith(".youtube.com")).toBe(true);
    expect(result.screenshot).toBeTruthy();
  });

  test("screenshot returns fresh PNG", async () => {
    test.setTimeout(120_000);
    expect(sessionId).not.toBeNull();
    // Go back to clawbox.com before capturing. The previous test leaves the
    // session on youtube.com, which in CI is often a near-blank consent or
    // bot-check page — a 1280×720 PNG of that compresses to ~6 KB and fails
    // the size floor below (seen on PR #938). clawbox.com renders real
    // content deterministically, so the floor measures our screenshot path,
    // not YouTube's mood.
    const back = await browserNavigate(sessionId!, "https://clawbox.com/");
    expect(new URL(back.url).hostname).toBe("clawbox.com");
    const shot = await browserScreenshot(sessionId!);
    expect(shot.screenshot).toBeTruthy();
    // Decode enough to check the PNG magic.
    const png = Buffer.from(shot.screenshot!, "base64");
    expect(png.slice(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    // A 1280×720 capture of a real page will be well over 10 KB.
    expect(png.byteLength).toBeGreaterThan(10_000);
  });
});
