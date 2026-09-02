import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "module";
import os from "os";
import path from "path";
import fs from "fs/promises";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

// OpenClaw 2 (2026.8) keeps Telegram pairing state in `state/openclaw.sqlite`
// and reads ONLY from it; the `credentials/telegram-*.json` files are the
// pre-migration store. A v2 box therefore has an empty credentials dir and
// one allow-entry row per approved sender. These cases pin the sqlite path;
// telegram-pairing.test.ts keeps covering the legacy files (v1 boxes).

vi.mock("@/lib/config-store", () => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/hermes-telegram", () => ({
  approveHermesPairing: vi.fn(),
  listHermesPairing: vi.fn(),
  readHermesApprovedUsers: vi.fn(async () => []),
  readHermesPairingRequests: vi.fn(async () => []),
  notifyHermesTelegramUser: vi.fn(),
}));

import { get } from "@/lib/config-store";

// The lib reaches node:sqlite lazily (vite cannot bundle the builtin); so do
// the fixtures.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

// OpenClaw 2026.8.1's own DDL for the two pairing tables, verbatim (STRICT).
const PAIRING_DDL = `
CREATE TABLE IF NOT EXISTS channel_pairing_requests (
  channel_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  meta_json TEXT,
  PRIMARY KEY (channel_key, account_id, request_id)
) STRICT;
CREATE TABLE IF NOT EXISTS channel_pairing_allow_entries (
  channel_key TEXT NOT NULL,
  account_id TEXT NOT NULL,
  entry TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (channel_key, account_id, entry)
) STRICT;`;

const OWNER_ID = "1234567890";

let tmpHome: string;
const origHome = process.env.OPENCLAW_HOME;
const origStateDir = process.env.OPENCLAW_STATE_DIR;
const origUserHome = process.env.HOME;

function statePath(root = tmpHome): string {
  return path.join(root, "state", "openclaw.sqlite");
}

function withDb<T>(fn: (db: DatabaseSyncType) => T, readOnly = false, root = tmpHome): T {
  const db = new DatabaseSync(statePath(root), { readOnly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

type AllowRow = [channel: string, account: string, entry: string];
type RequestRow = {
  channel?: string;
  account?: string;
  id: string;
  code: string;
  createdAt: string;
  meta?: Record<string, unknown> | null;
};

async function makeStateDb(allow: AllowRow[], requests: RequestRow[] = [], root = tmpHome): Promise<void> {
  await fs.mkdir(path.dirname(statePath(root)), { recursive: true });
  withDb((db) => {
    db.exec(PAIRING_DDL);
    const insAllow = db.prepare(
      "INSERT INTO channel_pairing_allow_entries (channel_key, account_id, entry, sort_order, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    allow.forEach(([channel, account, entry], i) => insAllow.run(channel, account, entry, i, Date.now()));
    const insReq = db.prepare(
      "INSERT INTO channel_pairing_requests (channel_key, account_id, request_id, code, created_at, last_seen_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of requests) {
      insReq.run(
        r.channel ?? "telegram",
        r.account ?? "default",
        r.id,
        r.code,
        r.createdAt,
        r.createdAt,
        r.meta == null ? null : JSON.stringify(r.meta),
      );
    }
  }, false, root);
}

function countRows(table: string, channel: string, account: string): number {
  return withDb(
    (db) =>
      (db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE channel_key = ? AND account_id = ?`)
        .get(channel, account) as { n: number }).n,
    true,
  );
}

async function writeLegacyAllow(ids: string[]): Promise<void> {
  await fs.writeFile(
    path.join(tmpHome, "credentials", "telegram-default-allowFrom.json"),
    JSON.stringify({ version: 1, allowFrom: ids }),
    "utf-8",
  );
}

beforeEach(async () => {
  vi.resetModules();
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oc-home-v2-"));
  process.env.OPENCLAW_HOME = tmpHome;
  delete process.env.OPENCLAW_STATE_DIR;
  // A v2 box: the credentials dir exists but holds no pairing files.
  await fs.mkdir(path.join(tmpHome, "credentials"), { recursive: true });
});

afterEach(async () => {
  if (origHome === undefined) delete process.env.OPENCLAW_HOME;
  else process.env.OPENCLAW_HOME = origHome;
  if (origStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = origStateDir;
  if (origUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = origUserHome;
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("readTelegramAllowFrom on an OpenClaw 2 box", () => {
  it("returns the approved sender from state/openclaw.sqlite when the credentials dir is empty", async () => {
    await makeStateDb([["telegram", "default", OWNER_ID]]);
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual([OWNER_ID]);
  });

  it("keeps OpenClaw's order and ignores other channels and accounts", async () => {
    await makeStateDb([
      ["telegram", "default", "222"],
      ["discord", "default", "999"],
      ["telegram", "work", "888"],
      ["telegram", "default", "111"],
    ]);
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual(["222", "111"]);
    expect(await readTelegramAllowFrom("work")).toEqual(["888"]);
  });

  it("prefers the sqlite store over a stale pre-migration JSON file", async () => {
    await makeStateDb([["telegram", "default", OWNER_ID]]);
    await writeLegacyAllow(["555"]);
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual([OWNER_ID]);
  });

  it("returns [] when the store exists but nobody is approved yet", async () => {
    await makeStateDb([]);
    await writeLegacyAllow(["555"]);
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual([]);
  });

  it("looks the account id up the way OpenClaw stores it (lowercased)", async () => {
    await makeStateDb([["telegram", "work", "888"]]);
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom("Work")).toEqual(["888"]);
  });

  it("honours OPENCLAW_STATE_DIR, where OpenClaw itself resolves the store", async () => {
    const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "oc-state-dir-"));
    try {
      process.env.OPENCLAW_STATE_DIR = stateHome;
      await makeStateDb([["telegram", "default", OWNER_ID]], [], stateHome);
      const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
      expect(await readTelegramAllowFrom()).toEqual([OWNER_ID]);
    } finally {
      await fs.rm(stateHome, { recursive: true, force: true });
    }
  });

  it("expands a leading ~ in OPENCLAW_STATE_DIR the way OpenClaw does", async () => {
    // OpenClaw resolves the override through resolveUserPath, so `~/x` is the
    // user's home; statting the literal `~/x` would miss the store the gateway
    // writes and silently fall back to the (empty) legacy file.
    const userHome = await fs.mkdtemp(path.join(os.tmpdir(), "oc-user-home-"));
    try {
      process.env.HOME = userHome;
      process.env.OPENCLAW_STATE_DIR = "~/oc-state";
      await makeStateDb([["telegram", "default", OWNER_ID]], [], path.join(userHome, "oc-state"));
      const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
      expect(await readTelegramAllowFrom()).toEqual([OWNER_ID]);
    } finally {
      await fs.rm(userHome, { recursive: true, force: true });
    }
  });

  it("still reads the legacy file on a box without the v2 store", async () => {
    await writeLegacyAllow(["555"]);
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual(["555"]);
  });

  it("falls back to the legacy file when the store cannot be read", async () => {
    await fs.mkdir(path.dirname(statePath()), { recursive: true });
    await fs.writeFile(statePath(), "this is not a database", "utf-8");
    await writeLegacyAllow(["555"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    await expect(readTelegramAllowFrom()).resolves.toEqual(["555"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("logs a store that stays unreadable once, not on every poll, and again after it recovers", async () => {
    await fs.mkdir(path.dirname(statePath()), { recursive: true });
    await fs.writeFile(statePath(), "this is not a database", "utf-8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    await readTelegramAllowFrom();
    await readTelegramAllowFrom();
    await readTelegramAllowFrom();
    expect(warn).toHaveBeenCalledTimes(1);

    // Recovery (the store rewritten as a real database) wipes the slate...
    await fs.rm(statePath());
    await makeStateDb([["telegram", "default", OWNER_ID]]);
    expect(await readTelegramAllowFrom()).toEqual([OWNER_ID]);
    // ...so a relapse is reported again.
    await fs.writeFile(statePath(), "this is not a database", "utf-8");
    await readTelegramAllowFrom();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("readTelegramPairingRequests on an OpenClaw 2 box", () => {
  it("lists the pending requests with id, code, createdAt and a derived name", async () => {
    await makeStateDb([], [
      {
        id: "42",
        code: "ABCD2345",
        createdAt: "2026-09-01T10:00:00.000Z",
        meta: { firstName: "Krasi", lastName: "K", username: "krasi" },
      },
      { id: "43", code: "EFGH6789", createdAt: "2026-09-01T09:00:00.000Z", meta: null },
      { channel: "discord", id: "44", code: "ZZZZ0000", createdAt: "2026-09-01T08:00:00.000Z" },
    ]);
    const { readTelegramPairingRequests } = await import("@/lib/openclaw-config");
    const requests = await readTelegramPairingRequests();
    expect(requests.map((r) => r.id)).toEqual(["43", "42"]);
    expect(requests[1]).toMatchObject({
      id: "42",
      code: "ABCD2345",
      createdAt: "2026-09-01T10:00:00.000Z",
      meta: { firstName: "Krasi", lastName: "K", username: "krasi" },
      name: "Krasi K",
    });
    expect(requests[0].name).toBeUndefined();
  });

  it("returns [] from an empty v2 store even when a stale legacy file lingers", async () => {
    await makeStateDb([]);
    await fs.writeFile(
      path.join(tmpHome, "credentials", "telegram-pairing.json"),
      JSON.stringify({ version: 1, requests: [{ code: "OLDCODE1", id: "1" }] }),
      "utf-8",
    );
    const { readTelegramPairingRequests } = await import("@/lib/openclaw-config");
    expect(await readTelegramPairingRequests()).toEqual([]);
  });
});

describe("clearTelegramPairingState on an OpenClaw 2 box", () => {
  it("deletes the telegram allow entries and pending requests, leaving other channels alone", async () => {
    await makeStateDb(
      [
        ["telegram", "default", OWNER_ID],
        ["telegram", "default", "222"],
        ["discord", "default", "999"],
      ],
      [
        { id: "42", code: "ABCD2345", createdAt: "2026-09-01T10:00:00.000Z" },
        { channel: "discord", id: "44", code: "ZZZZ0000", createdAt: "2026-09-01T08:00:00.000Z" },
      ],
    );
    const { clearTelegramPairingState, readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    await clearTelegramPairingState();

    expect(countRows("channel_pairing_allow_entries", "telegram", "default")).toBe(0);
    expect(countRows("channel_pairing_requests", "telegram", "default")).toBe(0);
    expect(countRows("channel_pairing_allow_entries", "discord", "default")).toBe(1);
    expect(countRows("channel_pairing_requests", "discord", "default")).toBe(1);
    expect(await readTelegramAllowFrom()).toEqual([]);
  });

  it("also removes the legacy files so a later migration cannot resurrect old approvals", async () => {
    await makeStateDb([["telegram", "default", OWNER_ID]]);
    const allowFile = path.join(tmpHome, "credentials", "telegram-default-allowFrom.json");
    await writeLegacyAllow(["555"]);
    const { clearTelegramPairingState } = await import("@/lib/openclaw-config");
    await clearTelegramPairingState();
    await expect(fs.access(allowFile)).rejects.toThrow();
    expect(countRows("channel_pairing_allow_entries", "telegram", "default")).toBe(0);
  });

  it("does not throw when the store cannot be opened for writing", async () => {
    await fs.mkdir(path.dirname(statePath()), { recursive: true });
    await fs.writeFile(statePath(), "this is not a database", "utf-8");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { clearTelegramPairingState } = await import("@/lib/openclaw-config");
    await expect(clearTelegramPairingState()).resolves.toBeUndefined();
    err.mockRestore();
    warn.mockRestore();
  });
});

describe("GET /setup-api/telegram/pairing on an OpenClaw 2 box", () => {
  it("lists the approved sender read from the sqlite store", async () => {
    await makeStateDb([["telegram", "default", OWNER_ID]]);
    vi.mocked(get).mockImplementation(async (key: string) =>
      key === "telegram_bot_token" ? "123:abc" : key === "telegram_approved_names" ? { [OWNER_ID]: "Owner" } : null,
    );
    const { GET } = await import("@/app/setup-api/telegram/pairing/route");
    const res = await GET(new Request("http://localhost/setup-api/telegram/pairing"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.approved).toEqual([{ id: OWNER_ID, name: "Owner" }]);
  });

  it("?poll=1 lists the pending request from the sqlite store", async () => {
    await makeStateDb([], [
      { id: "42", code: "ABCD2345", createdAt: "2026-09-01T10:00:00.000Z", meta: { firstName: "Krasi" } },
    ]);
    vi.mocked(get).mockImplementation(async (key: string) => (key === "telegram_bot_token" ? "123:abc" : null));
    const { GET } = await import("@/app/setup-api/telegram/pairing/route");
    const res = await GET(new Request("http://localhost/setup-api/telegram/pairing?poll=1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]).toMatchObject({ id: "42", code: "ABCD2345", name: "Krasi" });
  });
});
