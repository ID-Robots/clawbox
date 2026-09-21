/**
 * TASK-1014 / CodeQL alert 330 (js/file-system-race, middleware.ts:57).
 *
 * `readConfigCached` decides, per request, whether the first-boot bootstrap
 * window is open, whether a session cookie is still in generation, and whether
 * an update owns the box. It used to take the cache key from
 * `statSync(CONFIG_PATH)` and the contents from a separate
 * `readFileSync(CONFIG_PATH)` — two lookups of the same NAME, where the config
 * store writes a temp file and RENAMES it over that name. A rename landing
 * between the two gives the old file's mtime with the new file's contents, and
 * the pair is then cached under that key: the snapshot stays wrong until some
 * later write moves the mtime again. On the file that answers "has this device
 * an owner", a stale cached answer is an auth decision made on the wrong data.
 *
 * It reads through ONE descriptor now — `openSync`, `fstatSync`, `readFileSync(fd)`
 * — so the key and the contents cannot come from two versions. These pin the
 * behaviour that rewrite has to keep: the cache still saves the re-read, a
 * change is still picked up, and a config swapped wholesale is never seen
 * half-applied.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

describe("middleware config snapshot", () => {
  let middleware: typeof import("@/middleware").middleware;
  let tmpRoot: string;

  const configPath = () => path.join(tmpRoot, "data", "config.json");

  /** Write config.json, and move its mtime so a re-read is not masked by clock granularity. */
  function writeConfig(fields: Record<string, unknown>, mtimeSeconds?: number) {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(fields));
    if (mtimeSeconds !== undefined) fs.utimesSync(configPath(), mtimeSeconds, mtimeSeconds);
  }

  const request = (pathname: string) => new NextRequest(new URL(`http://localhost${pathname}`));

  /**
   * `/setup` is the cheapest probe of the snapshot: the wizard page is public
   * only while the bootstrap window is open, so the answer is a direct read of
   * `setup_complete` / `password_configured`.
   */
  async function wizardIsPublic(): Promise<boolean> {
    const res = await middleware(request("/setup"));
    return !res.headers.get("location");
  }

  beforeEach(async () => {
    vi.resetModules();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-cfgsnap-"));
    process.env.CLAWBOX_ROOT = tmpRoot;
    process.env.SESSION_SECRET = "test-secret";
    delete process.env.PORTAL_URL;
    delete process.env.CLAWBOX_TEST_MODE;
    middleware = (await import("@/middleware")).middleware;
  });

  afterEach(() => {
    delete process.env.CLAWBOX_ROOT;
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("reads the device's state from the file", async () => {
    writeConfig({});
    expect(await wizardIsPublic()).toBe(true);
  });

  it("shuts the bootstrap window once a password exists", async () => {
    writeConfig({ password_configured: true });
    expect(await wizardIsPublic()).toBe(false);
  });

  it("picks up a change to the file rather than serving the first answer forever", async () => {
    writeConfig({}, 1_000_000);
    expect(await wizardIsPublic()).toBe(true);

    // The owner sets a password: the window has to shut on the next request.
    writeConfig({ password_configured: true }, 2_000_000);
    expect(await wizardIsPublic()).toBe(false);

    // …and back, so the test is about the re-read and not about one direction.
    writeConfig({}, 3_000_000);
    expect(await wizardIsPublic()).toBe(true);
  });

  it("does not re-read the file when nothing has moved", async () => {
    writeConfig({}, 1_000_000);
    await wizardIsPublic();

    const read = vi.spyOn(fs, "readFileSync");
    try {
      await wizardIsPublic();
      await wizardIsPublic();
      // The mtime is unchanged, so the cached snapshot answers both.
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it("never serves one version's flags with another version's contents", async () => {
    // The shape the race produced: a rename lands under the read. Replayed
    // here as a swap between requests, with the mtime moved, because what the
    // fix guarantees is that whatever mtime is cached belongs to the bytes
    // cached beside it — so a swapped file is seen whole or not at all.
    writeConfig({ password_configured: true, setup_complete: true }, 1_000_000);
    expect(await wizardIsPublic()).toBe(false);

    const swapped = path.join(tmpRoot, "data", "config.swap");
    fs.writeFileSync(swapped, JSON.stringify({}));
    fs.utimesSync(swapped, 2_000_000, 2_000_000);
    fs.renameSync(swapped, configPath());

    expect(await wizardIsPublic()).toBe(true);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("{}");
  });

  it("fails CLOSED on a config.json that exists but will not parse", async () => {
    // A corrupt file on a provisioned box must not read as "pre-setup" and
    // hand back the whole unauthenticated window (TASK-446). The rewrite kept
    // the ENOENT-vs-unparseable distinction, which is what that rests on.
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), "{ truncated");
    expect(await wizardIsPublic()).toBe(false);
  });

  it("opens the window on a device that has no config.json at all", async () => {
    // Genuinely absent is a first-boot device: the wizard has to be reachable
    // or it can never run.
    expect(fs.existsSync(configPath())).toBe(false);
    expect(await wizardIsPublic()).toBe(true);
  });

  it("leaves no descriptor behind after many reads", async () => {
    // The read is on the per-request path, so a handle leaked on any branch —
    // cache hit, parse failure, missing file — exhausts the process in minutes.
    writeConfig({}, 1_000_000);
    const before = fs.readdirSync("/proc/self/fd").length;
    for (let i = 0; i < 200; i++) await wizardIsPublic();
    fs.writeFileSync(configPath(), "{ truncated");
    for (let i = 0; i < 200; i++) await wizardIsPublic();
    const after = fs.readdirSync("/proc/self/fd").length;
    expect(after).toBeLessThanOrEqual(before + 5);
  });
});
