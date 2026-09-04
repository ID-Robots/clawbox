import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The approval popup. On a Hermes device the pending list and the approve
 * action have to reach `hermes pairing`, not OpenClaw's allowlist stores —
 * otherwise a request that Hermes is holding never appears in ClawBox, and
 * "Approve" in ClawBox approves nothing.
 */

vi.mock("@/lib/config-store", () => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn() }));
vi.mock("@/lib/openclaw-config", () => ({
  readTelegramAllowFrom: vi.fn(),
  listTelegramPairingRequests: vi.fn(),
  readTelegramPairingRequests: vi.fn(),
  approveTelegramPairing: vi.fn(),
}));
// Hermes keeps its own bot token in ~/.hermes/.env; the route asks for its
// PRESENCE, never its value.
vi.mock("@/lib/hermes-skill-secrets", () => ({ hermesSecretsPresent: vi.fn() }));
vi.mock("@/lib/hermes-telegram", () => ({
  approveHermesPairing: vi.fn(),
  listHermesPairing: vi.fn(),
  readHermesApprovedUsers: vi.fn(),
  readHermesPairingRequests: vi.fn(),
  notifyHermesTelegramUser: vi.fn(),
}));

import { get, set } from "@/lib/config-store";
import { getActiveHarness } from "@/lib/harness";
import {
  readTelegramAllowFrom,
  listTelegramPairingRequests,
  readTelegramPairingRequests,
  approveTelegramPairing,
} from "@/lib/openclaw-config";
import { hermesSecretsPresent } from "@/lib/hermes-skill-secrets";
import {
  approveHermesPairing,
  listHermesPairing,
  readHermesApprovedUsers,
  readHermesPairingRequests,
  notifyHermesTelegramUser,
} from "@/lib/hermes-telegram";

const mockGet = vi.mocked(get);
const mockSet = vi.mocked(set);
const mockHarness = vi.mocked(getActiveHarness);
const mockReadAllow = vi.mocked(readTelegramAllowFrom);
const mockOpenclawList = vi.mocked(listTelegramPairingRequests);
const mockOpenclawRead = vi.mocked(readTelegramPairingRequests);
const mockOpenclawApprove = vi.mocked(approveTelegramPairing);
const mockHermesApprove = vi.mocked(approveHermesPairing);
const mockHermesList = vi.mocked(listHermesPairing);
const mockHermesApproved = vi.mocked(readHermesApprovedUsers);
const mockHermesRead = vi.mocked(readHermesPairingRequests);
const mockNotify = vi.mocked(notifyHermesTelegramUser);
const mockSecrets = vi.mocked(hermesSecretsPresent);

const REQUEST_ID = "a1b2c3d4e5f60718";

describe("/setup-api/telegram/pairing on Hermes", () => {
  let GET: (req: Request) => Promise<Response>;
  let POST: (req: Request) => Promise<Response>;

  const url = "http://localhost/setup-api/telegram/pairing";
  const postReq = (body: unknown) =>
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGet.mockImplementation(async (key: string) =>
      key === "telegram_bot_token" ? "123:abc" : undefined,
    );
    mockSet.mockResolvedValue();
    mockHarness.mockResolvedValue("hermes");
    mockReadAllow.mockResolvedValue([]);
    mockOpenclawList.mockResolvedValue([]);
    mockOpenclawRead.mockResolvedValue([]);
    mockOpenclawApprove.mockResolvedValue();
    mockHermesApproved.mockResolvedValue([{ id: "555000111", name: "Yanko" }]);
    mockHermesRead.mockResolvedValue([
      { code: REQUEST_ID, id: "123456789", name: "Krasimir Kralev" },
    ]);
    mockHermesList.mockResolvedValue({
      pending: [{ code: REQUEST_ID, id: "123456789", name: "Krasimir Kralev" }],
      approved: [{ id: "555000111", name: "Yanko" }],
    });
    mockHermesApprove.mockResolvedValue({ userId: "123456789", userName: "Krasimir Kralev" });
    mockNotify.mockResolvedValue(true);
    mockSecrets.mockResolvedValue({ TELEGRAM_BOT_TOKEN: true });

    const mod = await import("@/app/setup-api/telegram/pairing/route");
    GET = mod.GET;
    POST = mod.POST;
  });

  it("surfaces a pending Hermes request to the desktop poll", async () => {
    const body = await (await GET(new Request(`${url}?poll=1`))).json();

    expect(body.configured).toBe(true);
    expect(body.pending).toEqual([
      { code: REQUEST_ID, id: "123456789", name: "Krasimir Kralev" },
    ]);
    expect(mockHermesRead).toHaveBeenCalled();
    expect(mockOpenclawRead).not.toHaveBeenCalled();
  });

  it("answers for a bot ClawBox has no token for — the harness holds its own", async () => {
    // `hermes config set TELEGRAM_BOT_TOKEN` writes ~/.hermes/.env and nothing
    // else; ClawBox'"'"'s copy is a side effect of /setup-api/telegram/configure.
    // Asking for that copy answered `configured: false` for a working bot, and
    // this GET returns an empty pairing state on that answer — so the desktop
    // poll that raises the "someone wants to talk to your bot" popup was told
    // there was nothing to show.
    mockGet.mockResolvedValue(undefined);

    const body = await (await GET(new Request(`${url}?poll=1`))).json();

    expect(body.configured).toBe(true);
    expect(body.pending).toHaveLength(1);
  });

  it("still says not configured when the harness has no bot either", async () => {
    mockGet.mockResolvedValue(undefined);
    mockSecrets.mockResolvedValue({ TELEGRAM_BOT_TOKEN: false });

    const body = await (await GET(new Request(`${url}?poll=1`))).json();

    expect(body.configured).toBe(false);
    expect(body.pending).toEqual([]);
  });

  it("uses the authoritative CLI for the Settings check", async () => {
    const body = await (await GET(new Request(`${url}?pending=1`))).json();

    expect(body.pending).toHaveLength(1);
    expect(mockHermesList).toHaveBeenCalled();
    expect(mockOpenclawList).not.toHaveBeenCalled();
  });

  it("lists approved senders from Hermes' own store, not OpenClaw's allowlist", async () => {
    const body = await (await GET(new Request(url))).json();

    expect(body.approved).toEqual([{ id: "555000111", name: "Yanko" }]);
    expect(mockReadAllow).not.toHaveBeenCalled();
  });

  it("approves through Hermes and tells the requester", async () => {
    const res = await POST(postReq({ code: REQUEST_ID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockHermesApprove).toHaveBeenCalledWith(REQUEST_ID, expect.anything());
    expect(mockOpenclawApprove).not.toHaveBeenCalled();
    // Hermes' `pairing approve` has no --notify, so the notice is ours to send.
    expect(mockNotify).toHaveBeenCalledWith("123456789", expect.any(String));
  });

  it("accepts a request id the client uppercased", async () => {
    await POST(postReq({ code: REQUEST_ID.toUpperCase() }));
    expect(mockHermesApprove).toHaveBeenCalledWith(REQUEST_ID, expect.anything());
  });

  it("still accepts the 8-char code the bot DM'd", async () => {
    await POST(postReq({ code: "fql2a98k" }));
    expect(mockHermesApprove).toHaveBeenCalledWith("FQL2A98K", expect.anything());
  });

  it("remembers the requester's display name for the approved list", async () => {
    await POST(postReq({ code: REQUEST_ID }));
    expect(mockSet).toHaveBeenCalledWith(
      "telegram_approved_names",
      expect.objectContaining({ "123456789": "Krasimir Kralev" }),
    );
  });

  it("reports an expired request as user-recoverable, not as a server fault", async () => {
    mockHermesApprove.mockRejectedValue(new Error("Pairing request not found or expired"));
    const res = await POST(postReq({ code: REQUEST_ID }));

    expect(res.status).toBe(400);
  });

  it("reports an unreachable CLI as a server fault", async () => {
    mockHermesApprove.mockRejectedValue(new Error("hermes timed out"));
    const res = await POST(postReq({ code: REQUEST_ID }));

    expect(res.status).toBe(500);
  });

  it("does not fail an approval that Hermes completed if the notice fails", async () => {
    mockNotify.mockResolvedValue(false);
    const res = await POST(postReq({ code: REQUEST_ID }));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it("rejects a token that is neither a code nor a request id", async () => {
    const res = await POST(postReq({ code: "../../etc/passwd" }));

    expect(res.status).toBe(400);
    expect(mockHermesApprove).not.toHaveBeenCalled();
  });

  it("leaves the OpenClaw path untouched on an OpenClaw device", async () => {
    mockHarness.mockResolvedValue("openclaw");
    mockReadAllow.mockResolvedValue(["6057319791"]);

    const listed = await (await GET(new Request(`${url}?pending=1`))).json();
    expect(listed.approved).toEqual([{ id: "6057319791", name: undefined }]);
    expect(mockOpenclawList).toHaveBeenCalled();
    expect(mockHermesList).not.toHaveBeenCalled();

    await POST(postReq({ code: "FQL2A98K" }));
    expect(mockOpenclawApprove).toHaveBeenCalledWith("FQL2A98K");
    expect(mockHermesApprove).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
