/**
 * GET/POST /setup-api/whats-new — the "What's new in 4.1" card (TASK-1059,
 * re-keyed for 4.1 by TASK-1195).
 *
 * What is pinned here:
 *  - the card is for a box RUNNING 4.1, read from the checkout's package.json;
 *  - a dismissal is recorded in the box's config store, so a fresh module (a
 *    second browser asking) sees it too;
 *  - a box that dismissed the 4.0 card is shown the 4.1 card, and a tab still
 *    showing the 4.0 card cannot dismiss 4.1;
 *  - the plan section offers only what the plan on record does not cover, by
 *    the same predicates the features' own gates use: Pro or Max for the Coding
 *    Agent and Memory Shard, Max for the edition switch;
 *  - the free-month hook answers null, because the portal publishes no code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { EditionSource } from "@/lib/edition-source";

// The real edition lock is /etc/clawbox/edition.env, which differs per machine.
// Everything else in the module is the real one.
vi.mock("@/lib/edition-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edition-source")>()),
  readEditionSource: vi.fn(),
}));

type Handler = (request: Request) => Promise<Response>;
let GET: () => Promise<Response>;
let POST: Handler;
let root: string;
let edition: EditionSource;

const ORIGIN = "http://clawbox.local";

function writeVersion(version: string | null): void {
  const file = path.join(root, "package.json");
  if (version === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, JSON.stringify({ name: "clawbox", version }));
}

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(config));
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf-8"));
}

/** A fresh module graph, as a second browser (or a restarted server) would get. */
async function load(): Promise<void> {
  vi.resetModules();
  const source = await import("@/lib/edition-source");
  vi.mocked(source.readEditionSource).mockImplementation(() => edition);
  const mod = await import("@/app/setup-api/whats-new/route");
  GET = mod.GET;
  POST = mod.POST;
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(new Request(`${ORIGIN}/setup-api/whats-new`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "clawbox.local", origin: ORIGIN, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

async function state(): Promise<Record<string, unknown>> {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res.json();
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-whats-new-"));
  process.env.CLAWBOX_ROOT = root;
  delete process.env.NEXT_PUBLIC_APP_VERSION;
  edition = { edition: "openclaw", defaulted: false };
  writeVersion("4.1.0");
  writeConfig({});
  await load();
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.NEXT_PUBLIC_APP_VERSION;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /setup-api/whats-new: when the card shows", () => {
  it("shows on a box running 4.1.0 that has not dismissed it", async () => {
    expect(await state()).toEqual({
      show: true,
      release: "4.1",
      version: "4.1.0",
      edition: "openclaw",
      cta: { paidFeatures: true, editionSwitch: "hermes" },
      freeMonthCode: null,
    });
  });

  it.each(["4.1.3", "v4.1.0"])("shows on %s, which is on the 4.1 line", async (version) => {
    writeVersion(version);
    expect((await state()).show).toBe(true);
  });

  // "What's new in 4.1" above "This box now runs ClawBox 4.0.0" would name two
  // releases at once, so a box that reports another line gets no card at all.
  it.each(["4.0.0", "4.0.3", "4.2.0", "3.9.0", "3.9.12", "5.0.0", "not-a-version"])("does not show on %s", async (version) => {
    writeVersion(version);
    const body = await state();
    expect(body.show).toBe(false);
    expect(body.version).toBe(version);
  });

  it("falls back to the build-time version when package.json is unreadable", async () => {
    writeVersion(null);
    process.env.NEXT_PUBLIC_APP_VERSION = "v4.1.0";
    const body = await state();
    expect(body.version).toBe("v4.1.0");
    expect(body.show).toBe(true);
  });

  it("reads a git-describe style build version on the same line", async () => {
    writeVersion(null);
    process.env.NEXT_PUBLIC_APP_VERSION = "v4.1.0-12-gabc1234";
    expect((await state()).show).toBe(true);
  });

  it("shows nothing when no version can be read at all", async () => {
    writeVersion(null);
    const body = await state();
    expect(body.version).toBeNull();
    expect(body.show).toBe(false);
  });

  it("stays hidden once this release's card is dismissed on record", async () => {
    writeConfig({ whats_new_dismissed: "4.1" });
    expect((await state()).show).toBe(false);
  });

  // TASK-1195: the regression. The card used to be keyed "4.0", so an owner who
  // closed it on a 4.0 build would never have been shown 4.1's.
  it("a box that dismissed the 4.0 card is shown the 4.1 card", async () => {
    writeConfig({ whats_new_dismissed: "4.0" });
    const body = await state();
    expect(body.show).toBe(true);
    expect(body.release).toBe("4.1");
  });

  it.each(["3.9", "4.0.0", "4"])("a dismissal of %j does not hide this one", async (dismissed) => {
    writeConfig({ whats_new_dismissed: dismissed });
    expect((await state()).show).toBe(true);
  });
});

describe("GET /setup-api/whats-new: the plan section", () => {
  it("offers both lines on a box with no ClawBox AI plan", async () => {
    expect((await state()).cta).toEqual({ paidFeatures: true, editionSwitch: "hermes" });
  });

  it("offers both lines when the portal says the plan is unpaid", async () => {
    writeConfig({ clawai_plan_tier: "free", clawai_tier: "pro" });
    expect((await state()).cta).toEqual({ paidFeatures: true, editionSwitch: "hermes" });
  });

  it("on Pro (internal `flash`) drops the paid features and keeps the Max-only switch", async () => {
    writeConfig({ clawai_plan_tier: "flash" });
    expect((await state()).cta).toEqual({ paidFeatures: false, editionSwitch: "hermes" });
  });

  it("on Max (internal `pro`) offers nothing, so the card draws no plan section", async () => {
    writeConfig({ clawai_plan_tier: "pro" });
    expect((await state()).cta).toEqual({ paidFeatures: false, editionSwitch: null });
  });

  it("reads the device badge when the portal has not reported a plan yet", async () => {
    writeConfig({ clawai_tier: "pro" });
    expect((await state()).cta).toEqual({ paidFeatures: false, editionSwitch: null });
  });

  it("on the Hermes edition offers the switch back to OpenClaw", async () => {
    edition = { edition: "hermes", defaulted: false };
    await load();
    const body = await state();
    expect(body.edition).toBe("hermes");
    expect(body.cta).toEqual({ paidFeatures: true, editionSwitch: "openclaw" });
  });

  it("a dual box has both harnesses, so there is no switch to sell", async () => {
    edition = { edition: "dual", defaulted: false };
    await load();
    const body = await state();
    expect(body.edition).toBe("dual");
    expect(body.cta).toEqual({ paidFeatures: true, editionSwitch: null });
  });

  it("a box with no edition lock is not offered a switch it cannot make", async () => {
    edition = { edition: "openclaw", defaulted: true };
    await load();
    expect((await state()).cta).toEqual({ paidFeatures: true, editionSwitch: null });
  });
});

describe("POST /setup-api/whats-new: dismissal", () => {
  it("records the dismissal in the box's config store, for every browser", async () => {
    writeConfig({ keep: "me" });
    const res = await post({ release: "4.1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, show: false });
    expect(readConfig()).toEqual({ keep: "me", whats_new_dismissed: "4.1" });

    // Another browser, another module graph: still dismissed.
    await load();
    expect((await state()).show).toBe(false);
  });

  it("dismissing 4.1 on a box that dismissed 4.0 records 4.1", async () => {
    writeConfig({ whats_new_dismissed: "4.0" });
    expect((await post({ release: "4.1" })).status).toBe(200);
    expect(readConfig()).toEqual({ whats_new_dismissed: "4.1" });
    expect((await state()).show).toBe(false);
  });

  it("refuses a dismissal for a release other than the one on the card", async () => {
    const res = await post({ release: "5.0" });
    expect(res.status).toBe(400);
    expect(readConfig()).toEqual({});
  });

  it("a tab still showing the 4.0 card cannot dismiss 4.1 unseen", async () => {
    const res = await post({ release: "4.0" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'release must be "4.1"' });
    expect(readConfig()).toEqual({});
    expect((await state()).show).toBe(true);
  });

  it.each([
    ["no release", {}],
    ["a non-string release", { release: 4 }],
  ])("refuses %s", async (_label, body) => {
    expect((await post(body)).status).toBe(400);
    expect(readConfig()).toEqual({});
  });

  it("refuses a body that is not JSON", async () => {
    expect((await post("{not json")).status).toBe(400);
  });

  it("refuses a body far larger than a dismissal", async () => {
    const res = await post({ release: "4.1", padding: "x".repeat(4096) });
    expect(res.status).toBe(413);
    expect(readConfig()).toEqual({});
  });

  it("refuses a dismissal fired from another site's page", async () => {
    const res = await post({ release: "4.1" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(readConfig()).toEqual({});
  });

  it("answers 500 when the store cannot be written", async () => {
    fs.writeFileSync(path.join(root, "data", "config.json"), "{ corrupt");
    const res = await post({ release: "4.1" });
    expect(res.status).toBe(500);
  });
});
