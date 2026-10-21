/**
 * The Prime Radiant core block through the settings route and the vault: only
 * the owner turns it on (the assistant and another signed-in user get 403
 * `owner_only`); turning it on builds the block from the vault at once and the
 * answer says what it costs; turning it off removes it; and once on, the block
 * follows every change to `main` that notifies (a nightly merge, a
 * verification, a revert) with no restart of anything.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ requireSession: vi.fn(async () => null) }));
vi.mock("@/lib/route-auth", () => auth);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn(async () => true), hasOwnerSession: vi.fn(async () => true) }));
vi.mock("@/lib/owner-session", () => owner);
vi.mock("@/lib/mcp-token", () => ({ verifyMcpBearer: (h: string | null) => h === "Bearer test-assistant-bearer" }));
vi.mock("@/lib/prime-radiant/opus-source", () => ({ detectOpusSource: async () => ({ source: "none" }) }));
vi.mock("@/lib/prime-radiant/nightly-scheduler", () => ({ nextRunAtMs: () => null, refresh: async () => undefined }));
vi.mock("@/lib/prime-radiant/shard-index", () => ({
  scheduleReindexAfterCommit: () => undefined,
  reindexPrimeRadiantPaths: async () => null,
  vaultIndexLimitChanged: async () => null,
}));

import { GET as settingsGET, PUT as settingsPUT } from "@/app/setup-api/prime-radiant/settings/route";
import { readCoreContextFile } from "@/lib/prime-radiant/core-context-file";
import { coreContextPath } from "@/lib/prime-radiant/paths";
import { notifyVaultChanged, setVaultReindexHook } from "@/lib/prime-radiant/reindex-hook";
import { readSettings } from "@/lib/prime-radiant/settings";
import { vaultOperation } from "@/lib/prime-radiant/vault";
import { pageText } from "../helpers/prime-radiant-fixtures";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "prime-radiant-core-route-"));
const prevDir = process.env.PRIME_RADIANT_DIR;
let n = 0;

const ORIGIN = "http://clawbox.local";
const ASSISTANT = { authorization: "Bearer test-assistant-bearer" };

function put(body: unknown, headers: Record<string, string> = {}) {
  return settingsPUT(new Request(`${ORIGIN}/setup-api/prime-radiant/settings`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
  }));
}

async function get() {
  return (await settingsGET(new Request(`${ORIGIN}/setup-api/prime-radiant/settings`, { headers: { origin: ORIGIN } }))).json();
}

const stable = (title: string, extra: Record<string, unknown> = {}) => ({ title, status: "stable" as const, ...extra });

async function seed() {
  await vaultOperation("seed", async (tx) => {
    await tx.write("concepts/hub.md", pageText(stable("Hub", { summary: "The hub every other page hangs off." }), "See [[concepts/alpha]] and [[concepts/vault-keys]].\n"));
    await tx.write("concepts/alpha.md", pageText(stable("Alpha", { privacy: "public", summary: "Alpha is the first product." }), "Back to [[concepts/hub]].\n"));
    await tx.write("concepts/vault-keys.md", pageText(stable("Vault keys", { privacy: "secret-ref", summary: "Where the keys are." }), "Kept elsewhere.\n"));
  });
}

beforeEach(() => {
  process.env.PRIME_RADIANT_DIR = path.join(base, `case-${++n}`);
  owner.hasPersonSession.mockResolvedValue(true);
  owner.hasOwnerSession.mockResolvedValue(true);
  setVaultReindexHook(async () => undefined);
});

afterAll(() => {
  setVaultReindexHook(null);
  if (prevDir === undefined) delete process.env.PRIME_RADIANT_DIR;
  else process.env.PRIME_RADIANT_DIR = prevDir;
  fs.rmSync(base, { recursive: true, force: true });
});

describe("the context switch", () => {
  it("is the owner's alone: the assistant and another signed-in user are refused, nothing written", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    owner.hasOwnerSession.mockResolvedValue(false);
    for (const body of [{ context: { enabled: true } }, { context: { n: 10 } }, { context: null }]) {
      const r = await put(body, ASSISTANT);
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe("owner_only");
    }
    // The assistant still changes what it may.
    expect((await put({ nightly: { time: "02:15" } }, ASSISTANT)).status).toBe(200);

    owner.hasPersonSession.mockResolvedValue(true);
    const user = await put({ context: { enabled: true } });
    expect(user.status).toBe(403);
    expect((await user.json()).code).toBe("owner_only");
    expect(readSettings().context.enabled).toBe(false);
  });

  it("builds the block when the owner turns it on, says what it costs, and removes it when turned off", async () => {
    await seed();
    expect((await get()).contextBlock).toBeNull();

    const on = await put({ context: { enabled: true } });
    expect(on.status).toBe(200);
    const body = await on.json();
    expect(body.settings.context).toEqual({ enabled: true, n: 100, maxChars: 30_000 });
    expect(body.limits.contextPages).toEqual({ min: 1, max: 300 });
    expect(body.limits.contextMaxChars).toEqual({ min: 2_000, max: 60_000 });
    expect(body.contextBlock).toMatchObject({ pages: 2 });
    expect(body.contextBlock.estTokens).toBe(Math.ceil(body.contextBlock.chars / 4));
    expect(body.contextBlock).not.toHaveProperty("text");

    const block = readCoreContextFile()!;
    expect(block.chars).toBe(body.contextBlock.chars);
    expect(block.text).toContain("- Hub — The hub every other page hangs off.");
    expect(block.text).toContain("- Alpha — Alpha is the first product.");
    expect(block.text).not.toContain("Vault keys");
    expect((await get()).contextBlock).toEqual(body.contextBlock);
    expect(fs.statSync(coreContextPath()).mode & 0o777).toBe(0o600);

    const off = await (await put({ context: { enabled: false } })).json();
    expect(off.contextBlock).toBeNull();
    expect(fs.existsSync(coreContextPath())).toBe(false);
  });

  it("writes no block for a vault that is not there", async () => {
    const on = await (await put({ context: { enabled: true } })).json();
    expect(on.settings.context.enabled).toBe(true);
    expect(on.contextBlock).toBeNull();
    expect(fs.existsSync(coreContextPath())).toBe(false);
  });
});

describe("the block follows main", () => {
  it("is rebuilt after a change to main is notified — no restart", async () => {
    await seed();
    await put({ context: { enabled: true } });
    expect(readCoreContextFile()!.text).not.toContain("Gamma");

    await vaultOperation("add gamma", async (tx) => {
      await tx.write("concepts/gamma.md", pageText(stable("Gamma", { summary: "Gamma is new tonight." }), "Part of [[concepts/hub]] and [[concepts/alpha]].\n"));
    });
    await notifyVaultChanged(["concepts/gamma.md"]);
    await vi.waitFor(() => expect(readCoreContextFile()?.text).toContain("- Gamma — Gamma is new tonight."), { timeout: 10_000 });
    expect(readCoreContextFile()!.pages).toBe(3);
  });

  it("takes away a block left on disk once the setting is off", async () => {
    await seed();
    fs.mkdirSync(path.dirname(coreContextPath()), { recursive: true });
    fs.writeFileSync(coreContextPath(), JSON.stringify({ format: 1, text: "stale", pages: 1 }));
    await notifyVaultChanged(["concepts/hub.md"]);
    await vi.waitFor(() => expect(fs.existsSync(coreContextPath())).toBe(false), { timeout: 10_000 });
  });
});
