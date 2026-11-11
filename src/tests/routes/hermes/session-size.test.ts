import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /setup-api/hermes/session-size (TASK-2127): how large a Hermes conversation
 * is, for the chat's long-chat check on Local AI — the live history in
 * `state.db` estimated in tokens, the window llama-server serves while Hermes
 * runs, and the line where Hermes compresses first.
 */
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "hermes") }));
// The store a read opens is the turn's scope: recorded here, so a case can say whose.
const scope = vi.hoisted(() => ({ homes: [] as Array<string | null | undefined> }));
vi.mock("@/lib/harness/hermes-turn-record", () => ({
  readHermesSessionBytes: vi.fn(),
  withHermesStateHome: (home: string | null | undefined, fn: () => unknown) => {
    scope.homes.push(home);
    return fn();
  },
}));
vi.mock("@/lib/org-mode-server", () => ({ orgMemberStrictOf: vi.fn(async () => null) }));
vi.mock("@/lib/hermes-config-yaml", () => ({ readHermesConfigValue: vi.fn() }));

import { GET } from "@/app/setup-api/hermes/session-size/route";
import { requireSession } from "@/lib/route-auth";
import { getActiveHarness } from "@/lib/harness";
import { readHermesSessionBytes } from "@/lib/harness/hermes-turn-record";
import { readHermesConfigValue } from "@/lib/hermes-config-yaml";
import { orgMemberStrictOf } from "@/lib/org-mode-server";
import { staffHermesProfilePaths } from "@/lib/hermes-staff-profile";

const SESSION = "20260810_221825_609d1e";
const ask = (id = SESSION) => GET(new Request(`http://localhost/setup-api/hermes/session-size?sessionId=${encodeURIComponent(id)}`));

const config = (values: Record<string, string>) =>
  vi.mocked(readHermesConfigValue).mockImplementation(async (key: string) => values[key] ?? null);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSession).mockResolvedValue(null);
  vi.mocked(getActiveHarness).mockResolvedValue("hermes");
  vi.mocked(readHermesSessionBytes).mockResolvedValue(401840);
  vi.mocked(orgMemberStrictOf).mockResolvedValue(null);
  scope.homes.length = 0;
  config({ "compression.enabled": "true", "compression.threshold": "0.5" });
});

describe("GET /setup-api/hermes/session-size", () => {
  it("estimates the live history, a token per four bytes, against Hermes' own compression line", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tokens: 100460, window: 65536, limit: 32768 });
    expect(readHermesSessionBytes).toHaveBeenCalledWith(SESSION);
  });

  it("takes the lower of the ratio and an absolute cap, and the shipped ratio when none is set", async () => {
    config({ "compression.threshold": "0.75", "compression.threshold_tokens": "20000" });
    expect((await (await ask()).json()).limit).toBe(20000);
    config({});
    expect((await (await ask()).json()).limit).toBe(32768);
  });

  it("names no limit with compression off, and no tokens for a store it could not read", async () => {
    config({ "compression.enabled": "false" });
    vi.mocked(readHermesSessionBytes).mockResolvedValue(null);
    expect(await (await ask()).json()).toEqual({ tokens: null, window: 65536, limit: null });
  });

  it("measures the owner's conversation in the box's own store", async () => {
    await ask();
    expect(scope.homes).toEqual([undefined]);
  });

  it("measures a member of staff's conversation in their own profile's store, and nothing when the switch cannot be read", async () => {
    vi.mocked(orgMemberStrictOf).mockResolvedValue({ username: "maria" });
    expect((await (await ask()).json()).tokens).toBe(100460);
    expect(scope.homes).toEqual([staffHermesProfilePaths("maria")!.home]);
    vi.mocked(orgMemberStrictOf).mockResolvedValue("unknown");
    scope.homes.length = 0;
    expect((await (await ask()).json()).tokens).toBeNull();
    expect(readHermesSessionBytes).toHaveBeenCalledTimes(1);
    expect(scope.homes).toEqual([]);
  });

  it("refuses anything that is not a Hermes session id", async () => {
    const res = await ask("../state.db");
    expect(res.status).toBe(400);
    expect(readHermesSessionBytes).not.toHaveBeenCalled();
  });

  it("answers nothing on an OpenClaw box, and nothing to a caller without a session", async () => {
    vi.mocked(getActiveHarness).mockResolvedValue("openclaw");
    expect(await (await ask()).json()).toEqual({ tokens: null, window: null, limit: null });
    vi.mocked(requireSession).mockResolvedValue(new Response("{}", { status: 403 }) as never);
    expect((await ask()).status).toBe(403);
  });
});
