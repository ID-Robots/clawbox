/**
 * TASK-2501: a subscription linked to the box for its PLAN alone.
 *
 * What this suite pins is the separation the module exists for: the link has
 * its own keys and its own portal lookup, and never reads or writes the
 * ClawBox AI credential keys — `clawai_token` is what every cloud feature looks
 * for, and `clawai_tier` / `clawai_plan_tier` are what the boot scripts arm the
 * cloud voice on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => new Map<string, unknown>());
const failWrites = vi.hoisted(() => ({ on: false }));

vi.mock("@/lib/config-store", () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    if (failWrites.on) throw new Error("EACCES");
    if (value === undefined) store.delete(key);
    else store.set(key, value);
  }),
  setMany: vi.fn(async (entries: Record<string, unknown>) => {
    if (failWrites.on) throw new Error("EACCES");
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
    }
  }),
}));

import {
  SUBSCRIPTION_LINK_PLAN_KEY,
  SUBSCRIPTION_LINK_TOKEN_KEY,
  _resetSubscriptionLinkForTests,
  linkSubscription,
  linkedPaidTier,
  lookupLinkedPlan,
  readLinkedPaidTier,
  readSubscriptionLink,
  refreshSubscriptionLink,
  unlinkSubscription,
} from "@/lib/subscription-link";

// Placeholders in the portal's format — never a real credential.
const TOKEN = "claw_0123456789abcdef0123456789abcdef";
const OTHER_TOKEN = "claw_fedcba9876543210fedcba9876543210";
const DEVICE_INFO = "https://clawbox.com/api/clawbox-ai/device-info";

function deviceInfo(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The ClawBox AI keys, which no path in this module may touch. */
const CLAWAI_KEYS = ["clawai_token", "clawai_tier", "clawai_plan_tier"];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  failWrites.on = false;
  _resetSubscriptionLinkForTests();
  fetchMock = vi.fn(async () => deviceInfo({ tier: "max" }));
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.CLAWBOX_AI_DEVICE_INFO_URL;
});

describe("the keys", () => {
  it("are the link's own, and the heartbeat spells the token key the same way", async () => {
    expect(SUBSCRIPTION_LINK_TOKEN_KEY).toBe("subscription_link_token");
    expect(SUBSCRIPTION_LINK_PLAN_KEY).toBe("subscription_link_plan");
    // portal-heartbeat.ts keeps its own literal to stay out of this module's
    // graph; the two must not drift.
    const fs = await import("fs");
    const heartbeat = fs.readFileSync("src/lib/portal-heartbeat.ts", "utf8");
    expect(heartbeat).toContain(`const SUBSCRIPTION_LINK_TOKEN_KEY = "${SUBSCRIPTION_LINK_TOKEN_KEY}";`);
  });
});

describe("linkSubscription", () => {
  it("records the token and the plan the portal reports, and nothing else", async () => {
    const outcome = await linkSubscription(`  ${TOKEN}  `);

    expect(outcome).toEqual({ ok: true, plan: "pro" }); // the Max plan
    expect(store.get(SUBSCRIPTION_LINK_TOKEN_KEY)).toBe(TOKEN);
    expect(store.get(SUBSCRIPTION_LINK_PLAN_KEY)).toBe("pro");
    for (const key of CLAWAI_KEYS) expect(store.has(key), key).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DEVICE_INFO);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("asks the portal the box is pointed at", async () => {
    process.env.CLAWBOX_AI_DEVICE_INFO_URL = "http://127.0.0.1:9/device-info";
    await linkSubscription(TOKEN);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9/device-info");
  });

  it("leaves an existing ClawBox AI credential exactly as it was", async () => {
    store.set("clawai_token", OTHER_TOKEN);
    store.set("clawai_tier", "flash");
    store.set("clawai_plan_tier", "free");

    await linkSubscription(TOKEN);

    expect(store.get("clawai_token")).toBe(OTHER_TOKEN);
    expect(store.get("clawai_tier")).toBe("flash");
    expect(store.get("clawai_plan_tier")).toBe("free");
  });

  it("links a Free account too — the gate then offers the upgrade, not an error", async () => {
    fetchMock.mockResolvedValue(deviceInfo({ tier: "free" }));
    expect(await linkSubscription(TOKEN)).toEqual({ ok: true, plan: "free" });
    expect(store.get(SUBSCRIPTION_LINK_PLAN_KEY)).toBe("free");
    expect(await readLinkedPaidTier()).toBeNull();
  });

  it("links with the plan unknown when the portal does not answer, and unlocks nothing on it", async () => {
    fetchMock.mockRejectedValue(new Error("ENETUNREACH"));
    expect(await linkSubscription(TOKEN)).toEqual({ ok: true, plan: null });
    expect(store.get(SUBSCRIPTION_LINK_TOKEN_KEY)).toBe(TOKEN);
    expect(store.has(SUBSCRIPTION_LINK_PLAN_KEY)).toBe(false);
    expect(await readLinkedPaidTier()).toBeNull();
  });

  it("does not keep the previous account's plan beside a new token the portal has not answered for", async () => {
    await linkSubscription(TOKEN);
    expect(store.get(SUBSCRIPTION_LINK_PLAN_KEY)).toBe("pro");

    fetchMock.mockRejectedValue(new Error("timeout"));
    await linkSubscription(OTHER_TOKEN);

    expect(store.get(SUBSCRIPTION_LINK_TOKEN_KEY)).toBe(OTHER_TOKEN);
    expect(store.has(SUBSCRIPTION_LINK_PLAN_KEY)).toBe(false);
  });

  it("an answer it cannot read is a plan not known, never Free", async () => {
    fetchMock.mockResolvedValue(deviceInfo({ tier: "business" }));
    expect(await linkSubscription(TOKEN)).toEqual({ ok: true, plan: null });
    expect(store.has(SUBSCRIPTION_LINK_PLAN_KEY)).toBe(false);
  });

  it("refuses a token the portal itself refuses, and writes nothing", async () => {
    fetchMock.mockResolvedValue(deviceInfo({ error: { code: "invalid_token" } }, 401));
    const outcome = await linkSubscription(TOKEN);
    expect(outcome).toMatchObject({ ok: false, code: "token_rejected" });
    expect(store.size).toBe(0);
  });

  it("treats a 403 that is not the portal's own envelope as no answer, not a refusal", async () => {
    fetchMock.mockResolvedValue(new Response("<html>captive portal</html>", { status: 403 }));
    expect(await linkSubscription(TOKEN)).toEqual({ ok: true, plan: null });
  });

  it("refuses anything that is not a portal token without asking the portal", async () => {
    for (const token of ["", "   ", "sk-not-ours", 42 as unknown as string]) {
      expect(await linkSubscription(token)).toMatchObject({ ok: false, code: "invalid_token" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it("says so when the store cannot be written", async () => {
    failWrites.on = true;
    expect(await linkSubscription(TOKEN)).toMatchObject({ ok: false, code: "store_failed" });
  });

  it("does not land over an unlink that happened while the portal answered", async () => {
    let answer!: (res: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));

    const linking = linkSubscription(TOKEN);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await unlinkSubscription();
    answer(deviceInfo({ tier: "max" }));

    expect(await linking).toMatchObject({ ok: false, code: "superseded" });
    expect(store.size).toBe(0);
  });
});

describe("refreshSubscriptionLink", () => {
  it("is null on a box with no link, and asks nobody", async () => {
    expect(await refreshSubscriptionLink()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is null for a stored value that is not a portal token", async () => {
    store.set(SUBSCRIPTION_LINK_TOKEN_KEY, "not-a-token");
    store.set(SUBSCRIPTION_LINK_PLAN_KEY, "pro");
    expect(await refreshSubscriptionLink()).toBeNull();
    expect(await readLinkedPaidTier()).toBeNull();
  });

  it("records a plan that moved on the portal, once", async () => {
    store.set(SUBSCRIPTION_LINK_TOKEN_KEY, TOKEN);
    store.set(SUBSCRIPTION_LINK_PLAN_KEY, "free");
    fetchMock.mockResolvedValue(deviceInfo({ tier: "pro" }));

    expect(await refreshSubscriptionLink()).toEqual({ plan: "flash", rejected: false, changed: true });
    expect(store.get(SUBSCRIPTION_LINK_PLAN_KEY)).toBe("flash");
    // The next poll lands on the remembered answer: same plan, no change, no second ask.
    expect(await refreshSubscriptionLink()).toEqual({ plan: "flash", rejected: false, changed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const key of CLAWAI_KEYS) expect(store.has(key), key).toBe(false);
  });

  it("fills in the plan of a link made while the portal was away", async () => {
    store.set(SUBSCRIPTION_LINK_TOKEN_KEY, TOKEN);
    fetchMock.mockResolvedValue(deviceInfo({ tier: "max" }));
    expect(await refreshSubscriptionLink()).toEqual({ plan: "pro", rejected: false, changed: true });
    expect(await readLinkedPaidTier()).toBe("pro");
  });

  it("keeps the plan on record when the portal cannot tell — no answer, or words it cannot read", async () => {
    store.set(SUBSCRIPTION_LINK_TOKEN_KEY, TOKEN);
    store.set(SUBSCRIPTION_LINK_PLAN_KEY, "pro");

    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    expect(await refreshSubscriptionLink()).toEqual({ plan: "pro", rejected: false, changed: false });

    _resetSubscriptionLinkForTests();
    fetchMock.mockResolvedValueOnce(new Response("<html>proxy</html>", { status: 403 }));
    expect(await refreshSubscriptionLink()).toEqual({ plan: "pro", rejected: false, changed: false });

    _resetSubscriptionLinkForTests();
    fetchMock.mockResolvedValueOnce(deviceInfo({ tier: "enterprise" }));
    expect(await refreshSubscriptionLink()).toEqual({ plan: "pro", rejected: false, changed: false });

    expect(store.get(SUBSCRIPTION_LINK_PLAN_KEY)).toBe("pro");
  });

  it("forgets the plan of a token the portal refuses, so a revoked link unlocks nothing", async () => {
    // Kept, a token revoked on the portal would go on unlocking paid features
    // after the subscription behind it lapsed — the portal could no longer
    // tell the box otherwise.
    store.set(SUBSCRIPTION_LINK_TOKEN_KEY, TOKEN);
    store.set(SUBSCRIPTION_LINK_PLAN_KEY, "pro");
    // A fresh Response per ask: a body can be read once.
    fetchMock.mockImplementation(async () => deviceInfo({ error: { code: "invalid_token" } }, 401));

    expect(await refreshSubscriptionLink()).toEqual({ plan: null, rejected: true, changed: true });
    expect(store.has(SUBSCRIPTION_LINK_PLAN_KEY)).toBe(false);
    // The token stays, so the surfaces can say a re-link is due.
    expect(store.get(SUBSCRIPTION_LINK_TOKEN_KEY)).toBe(TOKEN);
    expect(await readLinkedPaidTier()).toBeNull();

    // Asked again later: still refused, nothing left to forget, no write.
    _resetSubscriptionLinkForTests();
    const configStore = await import("@/lib/config-store");
    vi.mocked(configStore.set).mockClear();
    expect(await refreshSubscriptionLink()).toEqual({ plan: null, rejected: true, changed: false });
    expect(configStore.set).not.toHaveBeenCalled();
  });

  it("answers about the store as it is now when another process re-linked meanwhile", async () => {
    store.set(SUBSCRIPTION_LINK_TOKEN_KEY, TOKEN);
    store.set(SUBSCRIPTION_LINK_PLAN_KEY, "free");
    let answer!: (res: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));

    const refreshing = refreshSubscriptionLink();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Another process re-links: the store changes under this one.
    store.set(SUBSCRIPTION_LINK_TOKEN_KEY, OTHER_TOKEN);
    store.set(SUBSCRIPTION_LINK_PLAN_KEY, "flash");
    answer(deviceInfo({ tier: "max" }));

    // Not the old account's Max: the new link's own plan, unchanged.
    expect(await refreshing).toEqual({ plan: "flash", rejected: false, changed: false });
    expect(store.get(SUBSCRIPTION_LINK_PLAN_KEY)).toBe("flash");
  });

  it("answers about the new link when this process re-links while the portal answers", async () => {
    store.set(SUBSCRIPTION_LINK_TOKEN_KEY, TOKEN);
    store.set(SUBSCRIPTION_LINK_PLAN_KEY, "free");
    let answerOld!: (res: Response) => void;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === `Bearer ${TOKEN}`) return new Promise<Response>((resolve) => { answerOld = resolve; });
      return Promise.resolve(deviceInfo({ tier: "max" }));
    });

    const refreshing = refreshSubscriptionLink();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await linkSubscription(OTHER_TOKEN)).toEqual({ ok: true, plan: "pro" });
    // The old account turns out to be on Pro; that is not this box's plan any more.
    answerOld(deviceInfo({ tier: "pro" }));

    expect(await refreshing).toEqual({ plan: "pro", rejected: false, changed: false });
    expect(store.get(SUBSCRIPTION_LINK_TOKEN_KEY)).toBe(OTHER_TOKEN);
    expect(store.get(SUBSCRIPTION_LINK_PLAN_KEY)).toBe("pro");
  });

  it("answers no link when the box was unlinked while the portal answered", async () => {
    store.set(SUBSCRIPTION_LINK_TOKEN_KEY, TOKEN);
    store.set(SUBSCRIPTION_LINK_PLAN_KEY, "flash");
    let answer!: (res: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));

    const refreshing = refreshSubscriptionLink();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await unlinkSubscription();
    answer(deviceInfo({ tier: "max" }));

    expect(await refreshing).toBeNull();
    expect(store.size).toBe(0);
  });

  it("answers null rather than throwing when the store cannot be read", async () => {
    const configStore = await import("@/lib/config-store");
    vi.mocked(configStore.get).mockRejectedValueOnce(new Error("EACCES"));
    expect(await refreshSubscriptionLink()).toBeNull();
  });
});

describe("unlinkSubscription", () => {
  it("removes the token and the plan together, and says whether there was a link", async () => {
    await linkSubscription(TOKEN);
    store.set("clawai_token", OTHER_TOKEN);

    expect(await unlinkSubscription()).toBe(true);
    expect(store.has(SUBSCRIPTION_LINK_TOKEN_KEY)).toBe(false);
    expect(store.has(SUBSCRIPTION_LINK_PLAN_KEY)).toBe(false);
    expect(store.get("clawai_token")).toBe(OTHER_TOKEN);
    expect(await readSubscriptionLink()).toBeNull();
    expect(await unlinkSubscription()).toBe(false);
  });
});

describe("linkedPaidTier", () => {
  it("vouches only for a paid plan with a link token beside it", () => {
    expect(linkedPaidTier("pro", TOKEN)).toBe("pro");
    expect(linkedPaidTier("flash", TOKEN)).toBe("flash");
    expect(linkedPaidTier("free", TOKEN)).toBeNull();
    expect(linkedPaidTier(undefined, TOKEN)).toBeNull();
    expect(linkedPaidTier("pro", undefined)).toBeNull();
    expect(linkedPaidTier("pro", "sk-not-ours")).toBeNull();
  });
});

describe("lookupLinkedPlan", () => {
  it("joins an ask already on its way for the same token", async () => {
    let answer!: (res: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const first = lookupLinkedPlan(TOKEN);
    const second = lookupLinkedPlan(TOKEN);
    answer(deviceInfo({ tier: "pro" }));
    expect(await first).toEqual({ source: "portal", plan: "flash" });
    expect(await second).toEqual({ source: "portal", plan: "flash" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks again for a different token instead of answering with another account's plan", async () => {
    await lookupLinkedPlan(TOKEN);
    fetchMock.mockResolvedValueOnce(deviceInfo({ tier: "free" }));
    expect(await lookupLinkedPlan(OTHER_TOKEN)).toEqual({ source: "portal", plan: "free" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
