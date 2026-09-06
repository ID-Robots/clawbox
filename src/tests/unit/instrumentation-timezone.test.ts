import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { seedProcessTimeZone } from "@/instrumentation";
import { TIMEZONE_APPLIED_KEY, TIMEZONE_STORE_KEY, applyProcessTimeZone } from "@/lib/timezone";
import { saveEnv } from "@/tests/helpers/env";

/**
 * The boot half of F-B (Memory Shard sweep, 2026-09-06). The timezone route
 * moves the RUNNING web server's zone; a server that starts takes its zone
 * from the OS once. On a healthy boot the two agree and the seed is a no-op;
 * when the server comes up before the OS leg has landed — an update restarting
 * it while the `set_timezone` root step is still queued — the first schedule
 * armed at boot would be in the wrong zone until the next change. So boot
 * seeds the process from the zone the store records as APPLIED, and only that
 * one: a stored zone whose apply failed is exactly what the marker exists to
 * say, and seeding it would put the schedulers hours from the `date` the
 * Terminal shows.
 *
 * Driven here through the plain helper with its readers handed in; the wiring
 * into `register()` — that it runs, that it is awaited, and that it comes
 * BEFORE both schedulers arm — is pinned by reading the boot file, as the
 * other hooks are.
 */

const BOOT_FILE = path.join(process.cwd(), "src", "instrumentation.ts");
const source = fs.readFileSync(BOOT_FILE, "utf8");

const KEYS = { stored: TIMEZONE_STORE_KEY, applied: TIMEZONE_APPLIED_KEY };

/** A config store holding exactly these keys. */
function storeWith(values: Record<string, unknown>) {
  return vi.fn(async (key: string) => values[key]);
}

describe("seedProcessTimeZone", () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = saveEnv("TZ");
    process.env.TZ = "UTC";
  });

  afterEach(() => {
    restoreEnv();
  });

  it("seeds the process only when the marker says the stored zone was applied", async () => {
    const get = storeWith({ timezone: "Europe/Sofia", timezone_applied: "Europe/Sofia" });

    await expect(seedProcessTimeZone({ get, apply: applyProcessTimeZone, keys: KEYS })).resolves.toBe("Europe/Sofia");

    expect(process.env.TZ).toBe("Europe/Sofia");
    expect(get).toHaveBeenCalledWith(TIMEZONE_STORE_KEY);
    expect(get).toHaveBeenCalledWith(TIMEZONE_APPLIED_KEY);
  });

  it.each([
    ["the apply never landed", { timezone: "Europe/Sofia" }],
    ["the marker is an OLDER zone", { timezone: "Europe/Sofia", timezone_applied: "Europe/Berlin" }],
    ["nothing was ever stored", {}],
    ["only a stale marker is left", { timezone_applied: "Europe/Sofia" }],
    ["the store carries something that is not a zone", { timezone: 5, timezone_applied: 5 }],
  ])("leaves the process alone when %s", async (_label, values) => {
    const apply = vi.fn(applyProcessTimeZone);

    await expect(seedProcessTimeZone({ get: storeWith(values), apply, keys: KEYS })).resolves.toBeNull();

    expect(apply).not.toHaveBeenCalled();
    expect(process.env.TZ).toBe("UTC");
  });

  it("hands an applied zone through the validated setter, never straight to TZ", async () => {
    // A store written by hand with a zone Node does not know: the setter
    // refuses it and the process stays on the OS zone rather than falling
    // back to UTC silently.
    const get = storeWith({ timezone: "Not/A/Zone", timezone_applied: "Not/A/Zone" });

    await expect(seedProcessTimeZone({ get, apply: applyProcessTimeZone, keys: KEYS })).resolves.toBeNull();

    expect(process.env.TZ).toBe("UTC");
  });

  it("lets a failed store read reach the caller, which wraps it", async () => {
    const get = vi.fn(async () => {
      throw new Error("config.json unreadable");
    });

    await expect(seedProcessTimeZone({ get, apply: applyProcessTimeZone, keys: KEYS })).rejects.toThrow("unreadable");
    expect(process.env.TZ).toBe("UTC");
  });
});

describe("boot seeds the process timezone before the schedulers arm", () => {
  const call = source.indexOf("await seedProcessTimeZone(");

  it("runs the seed, awaited, from the real store and the real setter", () => {
    expect(call).toBeGreaterThan(-1);
    const tryStart = source.lastIndexOf("try {", call);
    const inside = source.slice(tryStart, call);
    expect(inside).toMatch(/require\(['"]\.\/lib\/timezone['"]\)/);
    expect(inside).toMatch(/require\(['"]\.\/lib\/config-store['"]\)/);
    // The keys are the timezone module's own, never a second spelling here.
    const block = source.slice(call, source.indexOf("})", call));
    expect(block).toMatch(/stored:\s*TIMEZONE_STORE_KEY/);
    expect(block).toMatch(/applied:\s*TIMEZONE_APPLIED_KEY/);
    expect(block).toMatch(/apply:\s*applyProcessTimeZone/);
  });

  it("comes before BOTH schedulers start", () => {
    const clawkeep = source.indexOf("require('./lib/clawkeep-scheduler')");
    const memory = source.indexOf("require('./lib/clawkeep-memory-scheduler')");
    expect(clawkeep).toBeGreaterThan(-1);
    expect(memory).toBeGreaterThan(-1);
    expect(call).toBeLessThan(clawkeep);
    expect(call).toBeLessThan(memory);
  });

  it("keeps it behind the Node-runtime guard and in its own catch", () => {
    const guard = source.indexOf("NEXT_RUNTIME === 'edge'");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);
    const tryStart = source.lastIndexOf("try {", call);
    const catchStart = source.indexOf("} catch (err) {", call);
    expect(tryStart).toBeGreaterThan(-1);
    expect(catchStart).toBeGreaterThan(call);
    expect(source.slice(catchStart, catchStart + 200)).toMatch(/Could not seed the process timezone/);
  });
});
