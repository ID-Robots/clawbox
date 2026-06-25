import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs/promises";

// readTelegramAllowFrom resolves its file from OPENCLAW_HOME, which the module
// captures at import time — so each test sets the env, resets modules, then
// imports a fresh copy pointed at a throwaway home dir.
describe("readTelegramAllowFrom", () => {
  let tmpHome: string;
  const origHome = process.env.OPENCLAW_HOME;

  beforeEach(async () => {
    vi.resetModules();
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oc-home-"));
    process.env.OPENCLAW_HOME = tmpHome;
    await fs.mkdir(path.join(tmpHome, "credentials"), { recursive: true });
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = origHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  async function writeAllow(content: string): Promise<void> {
    await fs.writeFile(
      path.join(tmpHome, "credentials", "telegram-default-allowFrom.json"),
      content,
      "utf-8",
    );
  }

  it("returns the approved sender ids", async () => {
    await writeAllow(JSON.stringify({ version: 1, allowFrom: ["111", "222"] }));
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual(["111", "222"]);
  });

  it("returns [] when the file is missing", async () => {
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual([]);
  });

  it("returns [] on malformed JSON", async () => {
    await writeAllow("{not json");
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual([]);
  });

  it("returns [] when allowFrom is not an array", async () => {
    await writeAllow(JSON.stringify({ version: 1, allowFrom: "nope" }));
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual([]);
  });

  it("filters out non-string entries", async () => {
    await writeAllow(JSON.stringify({ version: 1, allowFrom: ["111", 222, null, "333"] }));
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom()).toEqual(["111", "333"]);
  });

  it("reads the account-specific file when an account is given", async () => {
    await fs.writeFile(
      path.join(tmpHome, "credentials", "telegram-work-allowFrom.json"),
      JSON.stringify({ version: 1, allowFrom: ["abc"] }),
      "utf-8",
    );
    const { readTelegramAllowFrom } = await import("@/lib/openclaw-config");
    expect(await readTelegramAllowFrom("work")).toEqual(["abc"]);
  });
});

describe("approveTelegramPairing", () => {
  it("rejects an invalid code format before spawning the CLI", async () => {
    const { approveTelegramPairing } = await import("@/lib/openclaw-config");
    await expect(approveTelegramPairing("bad")).rejects.toThrow("Invalid pairing code format");
    await expect(approveTelegramPairing("FQL2A98")).rejects.toThrow(); // 7 chars
    await expect(approveTelegramPairing("fql2a98k!")).rejects.toThrow(); // 9 + symbol
  });
});

describe("readTelegramPairingRequests", () => {
  let tmpHome: string;
  const origHome = process.env.OPENCLAW_HOME;

  beforeEach(async () => {
    vi.resetModules();
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oc-home-"));
    process.env.OPENCLAW_HOME = tmpHome;
    await fs.mkdir(path.join(tmpHome, "credentials"), { recursive: true });
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = origHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  async function writePairing(content: string): Promise<void> {
    await fs.writeFile(
      path.join(tmpHome, "credentials", "telegram-pairing.json"),
      content,
      "utf-8",
    );
  }

  it("returns the pending requests from the store file", async () => {
    await writePairing(JSON.stringify({ version: 1, requests: [{ code: "ABCD2345", id: "42" }] }));
    const { readTelegramPairingRequests } = await import("@/lib/openclaw-config");
    expect(await readTelegramPairingRequests()).toEqual([{ code: "ABCD2345", id: "42" }]);
  });

  it("derives a display name from meta.firstName/lastName", async () => {
    await writePairing(JSON.stringify({ version: 1, requests: [{ code: "ABCD2345", id: "42", meta: { firstName: "Krasi", lastName: "K" } }] }));
    const { readTelegramPairingRequests } = await import("@/lib/openclaw-config");
    const [req] = await readTelegramPairingRequests();
    expect(req.name).toBe("Krasi K");
  });

  it("returns [] when the file is missing", async () => {
    const { readTelegramPairingRequests } = await import("@/lib/openclaw-config");
    expect(await readTelegramPairingRequests()).toEqual([]);
  });

  it("returns [] on malformed JSON", async () => {
    await writePairing("{not json");
    const { readTelegramPairingRequests } = await import("@/lib/openclaw-config");
    expect(await readTelegramPairingRequests()).toEqual([]);
  });
});

describe("clearTelegramPairingState", () => {
  let tmpHome: string;
  const origHome = process.env.OPENCLAW_HOME;

  beforeEach(async () => {
    vi.resetModules();
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oc-home-"));
    process.env.OPENCLAW_HOME = tmpHome;
    await fs.mkdir(path.join(tmpHome, "credentials"), { recursive: true });
  });

  afterEach(async () => {
    if (origHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = origHome;
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("removes the allowlist + pending store files", async () => {
    const creds = path.join(tmpHome, "credentials");
    const allowFile = path.join(creds, "telegram-default-allowFrom.json");
    const pairingFile = path.join(creds, "telegram-pairing.json");
    await fs.writeFile(allowFile, JSON.stringify({ version: 1, allowFrom: ["111"] }), "utf-8");
    await fs.writeFile(pairingFile, JSON.stringify({ version: 1, requests: [] }), "utf-8");

    const { clearTelegramPairingState } = await import("@/lib/openclaw-config");
    await clearTelegramPairingState();

    await expect(fs.access(allowFile)).rejects.toThrow();
    await expect(fs.access(pairingFile)).rejects.toThrow();
  });

  it("is a no-op when the files are already absent", async () => {
    const { clearTelegramPairingState } = await import("@/lib/openclaw-config");
    await expect(clearTelegramPairingState()).resolves.toBeUndefined();
  });
});
