import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/setup-api/ai-models/clawai/slot`: what holds the ClawBox AI credential
 * slot, and the owner's removal of what does not belong there — kept first,
 * removed with core's own verb, its cooldown cleared, and read back.
 */

vi.mock("@/lib/owner-session", () => ({ hasPersonSession: vi.fn(async () => true) }));
vi.mock("@/lib/config-store", () => ({ get: vi.fn(async () => "claw_FAKE-stored-token") }));
vi.mock("@/lib/openclaw-config", () => ({
  openclawIsAbsent: vi.fn(() => false),
  spawnOpenclawCli: vi.fn(async () => ""),
}));
vi.mock("@/lib/clawai-profile-slot", () => ({
  CLAWAI_PROFILE_ID: "deepseek:default",
  inspectClawaiSlot: vi.fn(),
  backupClawaiSlot: vi.fn(() => ({ ok: true, file: "/backups/deepseek_default-1.json" })),
  clearClawaiSlotFailures: vi.fn(() => ({ ok: true, store: "shared" })),
  describeClawaiSlot: vi.fn(() => "a slot"),
}));

import { hasPersonSession } from "@/lib/owner-session";
import { openclawIsAbsent, spawnOpenclawCli } from "@/lib/openclaw-config";
import { backupClawaiSlot, clearClawaiSlotFailures, inspectClawaiSlot, type ClawaiSlot } from "@/lib/clawai-profile-slot";
import { GET, POST } from "@/app/setup-api/ai-models/clawai/slot/route";

const OWNER_KEY: ClawaiSlot = { kind: "owner-key", type: "api_key", rejected: null, evidence: null };

function removeRequest(body: unknown = { action: "remove" }) {
  return new Request("http://localhost/setup-api/ai-models/clawai/slot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The slot answers `first`, and after the logout `after`. */
function slotHolds(first: ClawaiSlot, after: ClawaiSlot = { kind: "free" }) {
  vi.mocked(inspectClawaiSlot).mockResolvedValueOnce(first).mockResolvedValue(after);
}

beforeEach(() => {
  vi.mocked(hasPersonSession).mockResolvedValue(true);
  vi.mocked(openclawIsAbsent).mockReturnValue(false);
  vi.mocked(spawnOpenclawCli).mockResolvedValue("");
  vi.mocked(backupClawaiSlot).mockReturnValue({ ok: true, file: "/backups/deepseek_default-1.json" });
  vi.mocked(clearClawaiSlotFailures).mockReturnValue({ ok: true, store: "shared" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /setup-api/ai-models/clawai/slot", () => {
  it.each([
    [{ kind: "free" }, "free"],
    [{ kind: "clawai", known: true }, "free"],
    [{ kind: "clawai", known: false }, "clawai"],
    [{ kind: "stale", reason: "oauth", type: "oauth", ours: true }, "stale"],
    [OWNER_KEY, "owner-key"],
  ] as Array<[ClawaiSlot, string]>)("answers %j as %s, and never asks DeepSeek", async (slot, state) => {
    vi.mocked(inspectClawaiSlot).mockResolvedValue(slot);

    const res = await GET();

    expect(await res.json()).toEqual({ state, profileId: "deepseek:default" });
    expect(vi.mocked(inspectClawaiSlot)).toHaveBeenCalledWith({ knownTokens: ["claw_FAKE-stored-token"] });
  });

  it("answers free on an edition without OpenClaw", async () => {
    vi.mocked(openclawIsAbsent).mockReturnValue(true);
    expect(await (await GET()).json()).toEqual({ state: "free", profileId: "deepseek:default" });
    expect(vi.mocked(inspectClawaiSlot)).not.toHaveBeenCalled();
  });
});

describe("POST /setup-api/ai-models/clawai/slot", () => {
  it("keeps a copy, removes the profile with core's own verb, clears its cooldown, and reads back", async () => {
    slotHolds(OWNER_KEY);

    const res = await POST(removeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true, state: "free", profileId: "deepseek:default" });
    expect(vi.mocked(spawnOpenclawCli)).toHaveBeenCalledWith(["models", "auth", "logout", "deepseek:default", "--yes"], expect.anything());
    const backup = vi.mocked(backupClawaiSlot).mock.invocationCallOrder[0];
    const logout = vi.mocked(spawnOpenclawCli).mock.invocationCallOrder[0];
    expect(backup).toBeLessThan(logout);
    expect(vi.mocked(clearClawaiSlotFailures)).toHaveBeenCalledTimes(1);
  });

  it("is the owner's alone: the agent's bearer gets a 403 and nothing is touched", async () => {
    vi.mocked(hasPersonSession).mockResolvedValue(false);

    const res = await POST(removeRequest());

    expect(res.status).toBe(403);
    expect(vi.mocked(backupClawaiSlot)).not.toHaveBeenCalled();
    expect(vi.mocked(spawnOpenclawCli)).not.toHaveBeenCalled();
  });

  it("removes nothing it could not back up", async () => {
    slotHolds(OWNER_KEY);
    vi.mocked(backupClawaiSlot).mockReturnValue({ ok: false, reason: "write-failed" });

    const res = await POST(removeRequest());

    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("clawai_slot_backup_failed");
    expect(vi.mocked(spawnOpenclawCli)).not.toHaveBeenCalled();
  });

  it("leaves this box's own ClawBox AI token alone", async () => {
    slotHolds({ kind: "clawai", known: true });

    const res = await POST(removeRequest());

    expect(await res.json()).toEqual({ removed: false, state: "free", profileId: "deepseek:default" });
    expect(vi.mocked(spawnOpenclawCli)).not.toHaveBeenCalled();
  });

  it("does not claim a removal the store does not show", async () => {
    slotHolds(OWNER_KEY, OWNER_KEY);

    const res = await POST(removeRequest());

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("clawai_slot_remove_failed");
  });

  it("refuses any other body", async () => {
    expect((await POST(removeRequest({ action: "wipe" }))).status).toBe(400);
  });
});
