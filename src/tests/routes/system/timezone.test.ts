import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";

/**
 * The /setup-api/system/timezone contract (TASK-514).
 *
 * Same shape as the power-profile route's test — the library is mocked, the
 * auth gate is not — plus the two things this route does that its siblings
 * don't: it answers with the state read back from the OS rather than an echo of
 * the request, and it tells the assistant about the change.
 */

vi.mock("@/lib/timezone", async () => {
  const actual = await vi.importActual<typeof import("@/lib/timezone")>("@/lib/timezone");
  return { ...actual, readTimezone: vi.fn(), listTimezones: vi.fn(), setTimezone: vi.fn() };
});

vi.mock("@/lib/timezone-agent", () => ({ announceTimezoneToAgent: vi.fn() }));

const store = new Map<string, unknown>();
vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
}));

import { GET, POST } from "@/app/setup-api/system/timezone/route";
import {
  DEFAULT_TIMEZONE,
  TIMEZONE_SYNCED_KEY,
  InvalidTimezoneError,
  TimezoneUnavailableError,
  listTimezones,
  readTimezone,
  setTimezone,
} from "@/lib/timezone";
import { announceTimezoneToAgent } from "@/lib/timezone-agent";

const mockRead = vi.mocked(readTimezone);
const mockList = vi.mocked(listTimezones);
const mockSet = vi.mocked(setTimezone);
const mockAnnounce = vi.mocked(announceTimezoneToAgent);

/** A box nobody ever asked: the systemd default. */
const UTC = {
  supported: true,
  timezone: DEFAULT_TIMEZONE,
  localTime: "2026-09-03 10:11:38",
  utcOffset: "+0000",
  ntpSynchronized: true,
};

/** The same box after Sofia was applied — note the DIFFERENT wall clock. */
const SOFIA = {
  supported: true,
  timezone: "Europe/Sofia",
  localTime: "2026-09-03 13:11:38",
  utcOffset: "+0300",
  ntpSynchronized: true,
};

const AGENT = { configWritten: true, personaWritten: true, harnessRestarted: true };

let session: SessionFixture;

beforeEach(() => {
  store.clear();
  session = installSessionFixture();
  mockRead.mockResolvedValue({ ...UTC });
  mockList.mockResolvedValue(["Etc/UTC", "Europe/Sofia", "America/New_York"]);
  mockSet.mockResolvedValue({ ...SOFIA });
  mockAnnounce.mockResolvedValue({ ...AGENT });
});

afterEach(() => session.cleanup());

function req(init: RequestInit & { auth?: boolean; url?: string } = {}) {
  const { auth = true, url = "http://localhost/setup-api/system/timezone", ...rest } = init;
  return new Request(url, {
    ...rest,
    headers: auth ? { Cookie: session.cookie, ...(rest.headers ?? {}) } : rest.headers,
  });
}

describe("GET /setup-api/system/timezone", () => {
  it("is 401 without a session, and does not read the clock", async () => {
    expect((await GET(req({ auth: false }))).status).toBe(401);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("returns the live status from the OS", async () => {
    mockRead.mockResolvedValue({ ...SOFIA });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(SOFIA);
  });

  it("reports isDefault only while the box is still on Etc/UTC", async () => {
    expect((await (await GET(req())).json()).isDefault).toBe(true);

    mockRead.mockResolvedValue({ ...SOFIA });
    expect((await (await GET(req())).json()).isDefault).toBe(false);
  });

  it("asks the desktop's one-shot to run on an untouched box", async () => {
    const body = await (await GET(req())).json();
    expect(body.autoSyncPending).toBe(true);
  });

  it("stops asking once a zone has been applied, even if it was UTC", async () => {
    // The marker, not the zone, is what ends the one-shot: an owner who really
    // does want UTC must not be asked again on every reload.
    store.set(TIMEZONE_SYNCED_KEY, true);
    const body = await (await GET(req())).json();
    expect(body.timezone).toBe(DEFAULT_TIMEZONE);
    expect(body.isDefault).toBe(true);
    expect(body.autoSyncPending).toBe(false);
  });

  it("never asks on a box that is already off the default", async () => {
    mockRead.mockResolvedValue({ ...SOFIA });
    expect((await (await GET(req())).json()).autoSyncPending).toBe(false);
  });

  it("adds the picker's list only when it is asked for", async () => {
    const plain = await (await GET(req())).json();
    expect(plain.zones).toBeUndefined();
    expect(mockList).not.toHaveBeenCalled();

    const url = "http://localhost/setup-api/system/timezone?zones=1";
    const withZones = await (await GET(req({ url }))).json();
    expect(withZones.zones).toContain("Europe/Sofia");
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when the root-owned helper is not installed", async () => {
    mockRead.mockRejectedValue(new TimezoneUnavailableError("Timezone helper is not installed."));
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("not installed");
  });

  it("answers 500 when the helper fails for any other reason", async () => {
    mockRead.mockRejectedValue(new Error("timedatectl: command not found"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("timedatectl");
  });
});

describe("POST /setup-api/system/timezone", () => {
  function post(body: unknown, opts: { auth?: boolean } = {}) {
    return POST(req({ ...opts, method: "POST", body: JSON.stringify(body) }));
  }

  it("is 401 without a session, and does not move the clock", async () => {
    const res = await post({ timezone: "Europe/Sofia" }, { auth: false });
    expect(res.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockAnnounce).not.toHaveBeenCalled();
  });

  it("is 401 during the first-boot window too", async () => {
    session.cleanup();
    session = installSessionFixture({ passwordConfigured: false });
    const res = await POST(new Request("http://localhost/setup-api/system/timezone", {
      method: "POST",
      body: JSON.stringify({ timezone: "Europe/Sofia" }),
    }));
    expect(res.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("applies the zone and answers with the box's own clock, not the request", async () => {
    const res = await post({ timezone: "Europe/Sofia", localTime: "1999-01-01 00:00:00" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, ...SOFIA, agent: AGENT });
    // The confirmation is read back from the OS: nothing in the request could
    // have produced 13:11:38.
    expect(body.localTime).toBe(SOFIA.localTime);
    expect(mockSet).toHaveBeenCalledWith("Europe/Sofia");
  });

  it("records that the box has been asked, so the one-shot stops", async () => {
    await post({ timezone: "Europe/Sofia" });
    expect(store.get(TIMEZONE_SYNCED_KEY)).toBe(true);
    expect((await (await GET(req())).json()).autoSyncPending).toBe(false);
  });

  it("tells the assistant, restarting the harness so a live agent agrees", async () => {
    await post({ timezone: "Europe/Sofia" });
    // The zone read back from the OS, not the string that was posted.
    expect(mockAnnounce).toHaveBeenCalledWith(SOFIA.timezone, { restartHarness: true });
  });

  it("rejects every shape that is not a plain IANA zone name", async () => {
    const junk: unknown[] = [
      "../../etc",
      "/etc/passwd",
      "Europe/Sofia; id",
      "Europe/Sofia\\u0000",
      "",
      "e".repeat(200),
      "europe/sofia ",
      123,
      true,
      null,
      undefined,
      ["Europe/Sofia"],
      {},
    ];
    for (const bad of junk) {
      const res = await post({ timezone: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).error, JSON.stringify(bad)).toBeTruthy();
    }
    // Nothing junk-shaped reached the system, or the agent.
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockAnnounce).not.toHaveBeenCalled();
    expect(store.has(TIMEZONE_SYNCED_KEY)).toBe(false);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await POST(req({ method: "POST", body: "timezone=Europe/Sofia" }));
    expect(res.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockAnnounce).not.toHaveBeenCalled();
  });


  // Regression, found on the device: a shape-valid zone the tz database does
  // not have came back 500 with `Command failed: /usr/bin/sudo -n
  // /usr/local/libexec/clawbox/clawbox-timezone.sh --set Europe/Nowhere`.
  // Wrong status, and the box's sudo command line in a string the UI renders.
  it("answers 400 for a well-formed zone the box does not have", async () => {
    mockSet.mockRejectedValue(new InvalidTimezoneError("unknown timezone: Europe/Nowhere"));
    const res = await post({ timezone: "Europe/Nowhere" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unknown timezone: Europe/Nowhere");
    expect(body.error).not.toMatch(/sudo|libexec/);
    expect(mockAnnounce).not.toHaveBeenCalled();
    expect(store.has(TIMEZONE_SYNCED_KEY)).toBe(false);
  });

  it("answers 503 when the root-owned helper is not installed", async () => {
    mockSet.mockRejectedValue(new TimezoneUnavailableError("Timezone helper is not installed."));
    const res = await post({ timezone: "Europe/Sofia" });
    expect(res.status).toBe(503);
    expect(mockAnnounce).not.toHaveBeenCalled();
    expect(store.has(TIMEZONE_SYNCED_KEY)).toBe(false);
  });

  it("answers 500 when timedatectl refuses the zone", async () => {
    mockSet.mockRejectedValue(new Error("timedatectl set-timezone failed for Europe/Sofia"));
    const res = await post({ timezone: "Europe/Sofia" });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("set-timezone failed");
    expect(mockAnnounce).not.toHaveBeenCalled();
  });
});
