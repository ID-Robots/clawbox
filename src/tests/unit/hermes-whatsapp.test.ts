import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { readHermesEnv, setHermesEnvValues } from "@/lib/hermes-env";
import {
  formatAllowedUsers,
  isWhatsappMode,
  normalizeWhatsappNumber,
  parseAllowedUsers,
  readHermesWhatsappStatus,
  setHermesWhatsappConfig,
  whatsappBridgeReady,
  whatsappPaired,
  whatsappSessionDirs,
  WhatsappNotPairedError,
} from "@/lib/hermes-whatsapp";

describe("normalizeWhatsappNumber", () => {
  it("strips everything that is not a digit", () => {
    // Hermes wants the country code with NO leading "+" — OpenClaw wants the
    // opposite, which is exactly why this lives in one named function.
    expect(normalizeWhatsappNumber("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizeWhatsappNumber("15551234567")).toBe("15551234567");
    expect(normalizeWhatsappNumber(" +359 88 123 4567 ")).toBe("359881234567");
  });

  it("rejects values that cannot be a phone number", () => {
    expect(normalizeWhatsappNumber("")).toBeNull();
    expect(normalizeWhatsappNumber("12345")).toBeNull();
    expect(normalizeWhatsappNumber("1234567890123456")).toBeNull();
    expect(normalizeWhatsappNumber("not a number")).toBeNull();
    // A value that would otherwise be read as a CLI flag has no digits left.
    expect(normalizeWhatsappNumber("--help")).toBeNull();
  });
});

describe("parseAllowedUsers", () => {
  it("splits, normalises and de-duplicates", () => {
    expect(parseAllowedUsers("15551234567, +1 555 123 4567 ,15559876543")).toEqual([
      "15551234567",
      "15559876543",
    ]);
  });

  it("returns an empty list for unset or empty values", () => {
    expect(parseAllowedUsers(null)).toEqual([]);
    expect(parseAllowedUsers(undefined)).toEqual([]);
    expect(parseAllowedUsers("  ")).toEqual([]);
  });

  it("drops the allow-everyone marker rather than treating it as a user", () => {
    expect(parseAllowedUsers("*")).toEqual([]);
    expect(parseAllowedUsers("*,15551234567")).toEqual(["15551234567"]);
  });
});

describe("formatAllowedUsers / isWhatsappMode", () => {
  it("joins with commas", () => {
    expect(formatAllowedUsers(["1", "2"])).toBe("1,2");
    expect(formatAllowedUsers([])).toBe("");
  });

  it("only accepts the two documented modes", () => {
    expect(isWhatsappMode("bot")).toBe(true);
    expect(isWhatsappMode("self-chat")).toBe(true);
    expect(isWhatsappMode("selfchat")).toBe(false);
    expect(isWhatsappMode(undefined)).toBe(false);
  });
});

describe("WhatsApp state on disk", () => {
  let dir: string;
  const originalHome = process.env.HERMES_HOME;
  const originalAgent = process.env.HERMES_AGENT_DIR;

  const writeCreds = async (which: 0 | 1) => {
    const sessionDir = whatsappSessionDirs()[which];
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "creds.json"), "{}");
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-whatsapp-"));
    process.env.HERMES_HOME = dir;
    process.env.HERMES_AGENT_DIR = path.join(dir, "hermes-agent");
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    if (originalAgent === undefined) delete process.env.HERMES_AGENT_DIR;
    else process.env.HERMES_AGENT_DIR = originalAgent;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("finds creds.json in either the current or the legacy session location", async () => {
    expect(await whatsappPaired()).toBe(false);
    await writeCreds(1); // legacy ~/.hermes/whatsapp/session
    expect(await whatsappPaired()).toBe(true);
  });

  it("finds creds.json in the current platforms/ location", async () => {
    await writeCreds(0);
    expect(await whatsappPaired()).toBe(true);
  });

  it("reports an absent bridge directory as unknown, not broken", async () => {
    expect(await whatsappBridgeReady()).toBeNull();
    await fs.mkdir(path.join(dir, "hermes-agent", "scripts", "whatsapp-bridge"), { recursive: true });
    expect(await whatsappBridgeReady()).toBe(false);
    await fs.mkdir(path.join(dir, "hermes-agent", "scripts", "whatsapp-bridge", "node_modules"));
    expect(await whatsappBridgeReady()).toBe(true);
  });

  it("reports not_configured when nothing is set", async () => {
    const status = await readHermesWhatsappStatus();
    expect(status.state).toBe("not_configured");
    expect(status.enabled).toBe(false);
    expect(status.paired).toBe(false);
    expect(status.allowedUsers).toEqual([]);
    expect(status.mode).toBeNull();
  });

  it("reports enabled_not_paired when the flag is on without a session", async () => {
    await setHermesEnvValues({ WHATSAPP_ENABLED: "true" });
    expect((await readHermesWhatsappStatus()).state).toBe("enabled_not_paired");
  });

  it("reports paired only when both the flag and the session exist", async () => {
    await setHermesEnvValues({ WHATSAPP_ENABLED: "true" });
    await writeCreds(0);
    const status = await readHermesWhatsappStatus();
    expect(status.state).toBe("paired");
    expect(status.paired).toBe(true);
  });

  it("treats a session without the flag as not configured", async () => {
    // Matching Hermes: an unpaired-but-present session is irrelevant while the
    // adapter is switched off, and the gateway skips the platform entirely.
    await writeCreds(0);
    expect((await readHermesWhatsappStatus()).state).toBe("not_configured");
  });

  it("recognises the allow-everyone flag in either spelling", async () => {
    await setHermesEnvValues({ WHATSAPP_ALLOW_ALL_USERS: "true" });
    expect((await readHermesWhatsappStatus()).allowAllUsers).toBe(true);
    await setHermesEnvValues({ WHATSAPP_ALLOW_ALL_USERS: "false", WHATSAPP_ALLOWED_USERS: "*" });
    expect((await readHermesWhatsappStatus()).allowAllUsers).toBe(true);
  });

  it("reads mode and allowlist back", async () => {
    await setHermesEnvValues({
      WHATSAPP_MODE: "self-chat",
      WHATSAPP_ALLOWED_USERS: "15551234567,15559876543",
    });
    const status = await readHermesWhatsappStatus();
    expect(status.mode).toBe("self-chat");
    expect(status.allowedUsers).toEqual(["15551234567", "15559876543"]);
  });

  it("ignores an unrecognised mode instead of surfacing it", async () => {
    await setHermesEnvValues({ WHATSAPP_MODE: "nonsense" });
    expect((await readHermesWhatsappStatus()).mode).toBeNull();
  });
});

describe("setHermesWhatsappConfig", () => {
  let dir: string;
  const originalHome = process.env.HERMES_HOME;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-whatsapp-w-"));
    process.env.HERMES_HOME = dir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("refuses to enable before a session exists", async () => {
    // An enabled-but-unpaired adapter starts the bridge, fails to find
    // creds.json, and errors on every gateway boot. ClawBox must not be what
    // puts a box into that state.
    await expect(setHermesWhatsappConfig({ enabled: true })).rejects.toBeInstanceOf(
      WhatsappNotPairedError,
    );
    expect(await readHermesEnv()).toEqual({});
  });

  it("always allows disabling, even when unpaired", async () => {
    const keys = await setHermesWhatsappConfig({ enabled: false });
    expect(keys).toEqual(["WHATSAPP_ENABLED"]);
    expect((await readHermesEnv()).WHATSAPP_ENABLED).toBe("false");
  });

  it("enables once creds.json is present", async () => {
    const sessionDir = path.join(dir, "platforms", "whatsapp", "session");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "creds.json"), "{}");
    await setHermesWhatsappConfig({ enabled: true });
    expect((await readHermesEnv()).WHATSAPP_ENABLED).toBe("true");
  });

  it("normalises and de-duplicates the allowlist it writes", async () => {
    await setHermesWhatsappConfig({ allowedUsers: ["+1 555 123 4567", "15551234567", "359881234567"] });
    expect((await readHermesEnv()).WHATSAPP_ALLOWED_USERS).toBe("15551234567,359881234567");
  });

  it("removes the key entirely when the allowlist is emptied", async () => {
    await setHermesWhatsappConfig({ allowedUsers: ["15551234567"] });
    await setHermesWhatsappConfig({ allowedUsers: [] });
    expect((await readHermesEnv()).WHATSAPP_ALLOWED_USERS).toBeUndefined();
  });

  it("clears a stale allow-everyone flag when an allowlist is set", async () => {
    // Otherwise the UI would show a two-name allowlist on a channel that is
    // still answering the entire world.
    await setHermesEnvValues({ WHATSAPP_ALLOW_ALL_USERS: "true" });
    await setHermesWhatsappConfig({ allowedUsers: ["15551234567"] });
    const env = await readHermesEnv();
    expect(env.WHATSAPP_ALLOW_ALL_USERS).toBe("false");
    expect(env.WHATSAPP_ALLOWED_USERS).toBe("15551234567");
  });

  it("leaves the allow-everyone flag alone when only the mode changes", async () => {
    await setHermesEnvValues({ WHATSAPP_ALLOW_ALL_USERS: "true" });
    await setHermesWhatsappConfig({ mode: "bot" });
    expect((await readHermesEnv()).WHATSAPP_ALLOW_ALL_USERS).toBe("true");
  });

  it("reports the keys it wrote and nothing else", async () => {
    const keys = await setHermesWhatsappConfig({ mode: "bot" });
    expect(keys).toEqual(["WHATSAPP_MODE"]);
  });

  it("is a no-op for an empty update", async () => {
    expect(await setHermesWhatsappConfig({})).toEqual([]);
    expect(await readHermesEnv()).toEqual({});
  });
});
