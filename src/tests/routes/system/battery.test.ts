import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

/**
 * The /setup-api/system/battery contract — the desktop tray's battery.
 *
 * The reader is the real one (src/tests/unit/battery.test.ts covers its
 * sums); what this file guards is the HTTP surface: owner-only (401 signed
 * out, 403 owner_only for another ClawBox user, and middleware's non-owner
 * scope does not admit the path either), `no-store`, the body exactly as
 * `readBattery()` returns it, and a 200 `{ available: false }` — never a 500
 * — on a box with no battery, on arm64, and when the read itself fails.
 *
 * Neither the host's arch nor its sysfs takes part: `os.arch()` is pinned in
 * every test, and the power_supply tree is a temp dir or the suite's
 * nonexistent CLAWBOX_POWER_SUPPLY_DIR.
 */

vi.mock("@/lib/battery", async () => {
  const actual = await vi.importActual<typeof import("@/lib/battery")>("@/lib/battery");
  return { ...actual, readBattery: vi.fn(actual.readBattery) };
});

import { GET } from "@/app/setup-api/system/battery/route";
import { readBattery } from "@/lib/battery";
import { nonOwnerVerdict } from "@/lib/non-owner-scope";

const ROUTE = "/setup-api/system/battery";
const ALICE_SV = "a1b2c3d4e5f60718";

let session: SessionFixture;
let tmp: string;

beforeEach(() => {
  session = installSessionFixture();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-battery-route-"));
  fs.mkdirSync(path.join(tmp, "class"));
  // The owner's name decides who "alice" is not; never the host's $USER.
  vi.stubEnv("CLAWBOX_USER", "clawbox");
  vi.spyOn(os, "arch").mockReturnValue("x64");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(readBattery).mockClear();
  fs.rmSync(tmp, { recursive: true, force: true });
  session.cleanup();
});

/** A supply under `devices/`, linked from `class/` the way sysfs links /sys/class into /sys/devices. */
function supply(name: string, attrs: Record<string, string | number>): void {
  const dir = path.join(tmp, "devices", name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [key, value] of Object.entries(attrs)) fs.writeFileSync(path.join(dir, key), `${value}\n`);
  fs.symlinkSync(path.join("..", "devices", name), path.join(tmp, "class", name));
}

/** A discharging laptop at 64 %, 4 h from empty, charger unplugged — read from the temp tree. */
function laptopOnBattery(): void {
  supply("BAT0", {
    type: "Battery",
    present: 1,
    scope: "System",
    status: "Discharging",
    capacity: 64,
    energy_now: 32_000_000,
    energy_full: 50_000_000,
    power_now: 8_000_000,
  });
  supply("AC", { type: "Mains", online: 0 });
  vi.stubEnv("CLAWBOX_POWER_SUPPLY_DIR", path.join(tmp, "class"));
}

/** A valid session cookie for "alice", a ClawBox user who is not the owner. */
function nonOwnerCookie(): string {
  const config = path.join(session.root, "data", "config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(config, "utf8")),
      clawbox_users: [{ username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: ALICE_SV }],
    }),
  );
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, gen: 0, u: "alice", sv: ALICE_SV }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("hex");
  return `clawbox_session=${payload}.${sig}`;
}

function req(cookie: string | null = session.cookie): Request {
  return new Request(`http://localhost${ROUTE}`, { headers: cookie ? { Cookie: cookie } : {} });
}

describe("GET /setup-api/system/battery — who may ask", () => {
  it("is 401 without a session, and reads nothing", async () => {
    laptopOnBattery();
    const res = await GET(req(null));
    expect(res.status).toBe(401);
    expect(readBattery).not.toHaveBeenCalled();
  });

  it("is 401 during the first-boot window too — there is no bootstrap carve-out", async () => {
    session.cleanup();
    session = installSessionFixture({ passwordConfigured: false, setupComplete: false });
    const res = await GET(req(null));
    expect(res.status).toBe(401);
    expect(readBattery).not.toHaveBeenCalled();
  });

  it("answers a signed-in user who is not the owner — they get the owner's tray", async () => {
    laptopOnBattery();
    const res = await GET(req(nonOwnerCookie()));
    expect(res.status).toBe(200);
    expect(readBattery).toHaveBeenCalled();
  });

  it("is inside middleware's scope for another ClawBox user", () => {
    for (const intent of ["fetch", "unknown"] as const) {
      expect(
        nonOwnerVerdict({ pathname: ROUTE, method: "GET", searchParams: new URLSearchParams(), intent, username: "alice" }),
        intent,
      ).toBe("allow");
    }
  });
});

describe("GET /setup-api/system/battery — what the owner gets", () => {
  it("the laptop's battery, exactly as readBattery() returns it, with no-store", async () => {
    laptopOnBattery();
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      available: true,
      percent: 64,
      state: "discharging",
      acOnline: false,
      minutesLeft: 240,
    });
  });

  it("reads afresh on every poll — a charger plugged in shows on the next one", async () => {
    laptopOnBattery();
    expect(await (await GET(req())).json()).toMatchObject({ state: "discharging", acOnline: false });
    fs.writeFileSync(path.join(tmp, "devices", "BAT0", "status"), "Charging\n");
    fs.writeFileSync(path.join(tmp, "devices", "AC", "online"), "1\n");
    expect(await (await GET(req())).json()).toMatchObject({ state: "charging", acOnline: true, minutesLeft: 135 });
    expect(readBattery).toHaveBeenCalledTimes(2);
  });

  it("{ available: false } on a box with no battery — the suite's power_supply dir does not exist", async () => {
    expect(process.env.CLAWBOX_POWER_SUPPLY_DIR).toBe("/nonexistent/clawbox-test-power-supply");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ available: false });
  });

  it("{ available: false } on a desktop whose power_supply lists only a mouse and a charger", async () => {
    supply("hidpp_battery_0", { type: "Battery", scope: "Device", status: "Discharging", capacity: 80 });
    supply("AC", { type: "Mains", online: 1 });
    vi.stubEnv("CLAWBOX_POWER_SUPPLY_DIR", path.join(tmp, "class"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false });
  });

  it("{ available: false } on arm64 (a Jetson), even with a battery in the tree", async () => {
    laptopOnBattery();
    vi.mocked(os.arch).mockReturnValue("arm64");
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ available: false });
  });

  it("{ available: false }, never a 500, when the read itself fails", async () => {
    laptopOnBattery();
    vi.mocked(readBattery).mockRejectedValueOnce(new Error("EIO: i/o error, read"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ available: false });
  });
});
