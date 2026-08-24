import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { readHermesEnv, setHermesEnvValues } from "@/lib/hermes-env";
import {
  allowlistAuthorizes,
  formatAllowedUsers,
  isWhatsappMode,
  markWhatsappPaired,
  mergeAllowlistEntries,
  normalizeWhatsappIdentifier,
  normalizeWhatsappNumber,
  pairedIdentityAllowlistEntries,
  parseAllowedUsers,
  readHermesWhatsappStatus,
  readPairedWhatsappIdentity,
  whatsappAllowlistForms,
  resetWhatsappBridgeDirForTests,
  resolveWhatsappBridgeDir,
  setHermesWhatsappConfig,
  whatsappBridgeDir,
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
    const { changedKeys } = await setHermesWhatsappConfig({ enabled: false });
    expect(changedKeys).toEqual(["WHATSAPP_ENABLED"]);
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
    const { changedKeys } = await setHermesWhatsappConfig({ mode: "bot" });
    expect(changedKeys).toEqual(["WHATSAPP_MODE"]);
  });

  it("is a no-op for an empty update", async () => {
    expect((await setHermesWhatsappConfig({})).changedKeys).toEqual([]);
    expect(await readHermesEnv()).toEqual({});
  });
});

/*
 * Read-only install trees.
 *
 * Upstream never uses the install path directly — gateway/platforms/
 * whatsapp_common.py resolve_whatsapp_bridge_dir() probes it for writability
 * and mirrors the bridge into HERMES_HOME when it is read-only (Docker's
 * /opt/hermes). That mattered little while pairing was terminal-only; it
 * matters now, because enabling the channel from the panel runs `npm install`
 * in whatever directory this returns.
 */
describe("resolveWhatsappBridgeDir", () => {
  let dir: string;
  const originalHome = process.env.HERMES_HOME;
  const originalAgent = process.env.HERMES_AGENT_DIR;

  const installDir = () => path.join(dir, "hermes-agent", "scripts", "whatsapp-bridge");
  const mirrorDir = () => path.join(dir, "scripts", "whatsapp-bridge");

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-wa-bridge-"));
    process.env.HERMES_HOME = dir;
    process.env.HERMES_AGENT_DIR = path.join(dir, "hermes-agent");
    resetWhatsappBridgeDirForTests();
    await fs.mkdir(installDir(), { recursive: true });
    await fs.writeFile(path.join(installDir(), "bridge.js"), "// bridge");
    await fs.writeFile(path.join(installDir(), "package.json"), "{}");
  });

  afterEach(async () => {
    resetWhatsappBridgeDirForTests();
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    if (originalAgent === undefined) delete process.env.HERMES_AGENT_DIR;
    else process.env.HERMES_AGENT_DIR = originalAgent;
    // Top-down: a 0555 parent forbids chmod'ing what is inside it, and rm
    // cannot unlink an entry out of a directory it may not write.
    await fs.chmod(installDir(), 0o755).catch(() => {});
    await fs.chmod(path.join(installDir(), "node_modules"), 0o755).catch(() => {});
    await fs.chmod(path.join(installDir(), "node_modules", "dep"), 0o755).catch(() => {});
    await fs.chmod(mirrorDir(), 0o755).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("uses the install tree when it can be written", async () => {
    expect(await resolveWhatsappBridgeDir()).toBe(installDir());
    expect(whatsappBridgeDir()).toBe(installDir());
  });

  it("leaves no probe file behind", async () => {
    await resolveWhatsappBridgeDir();
    expect(await fs.readdir(installDir())).toEqual(["bridge.js", "package.json"]);
  });

  it("mirrors the bridge into HERMES_HOME when the install tree is read-only", async () => {
    // Nested read-only content, not just a read-only top directory. `fs.cp`
    // copies the mode of EVERY entry, so a single chmod of the mirror root
    // left each subdirectory unwritable and `npm install` still failed the
    // moment npm wrote inside one — node_modules/ is exactly such a
    // subdirectory. Making only installDir() 0555 never caught that.
    const nested = path.join(installDir(), "node_modules", "dep");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "index.js"), "// dep");
    await fs.chmod(nested, 0o555);
    await fs.chmod(path.join(installDir(), "node_modules"), 0o555);
    await fs.chmod(installDir(), 0o555);

    const resolved = await resolveWhatsappBridgeDir();

    expect(resolved).toBe(mirrorDir());
    // The mirror has to be a usable bridge, not an empty directory: this is
    // where `npm install` and `node bridge.js` are about to run.
    expect(await fs.readFile(path.join(mirrorDir(), "bridge.js"), "utf8")).toBe("// bridge");
    expect(whatsappBridgeDir()).toBe(mirrorDir());
    // Writable, or the copy solved nothing: `npm install` runs in here next.
    await fs.writeFile(path.join(mirrorDir(), "probe"), "");
    // ...and writable all the way down, which is where the install actually
    // writes. The copy of the read-only subtree has to accept a new file.
    const mirroredNested = path.join(mirrorDir(), "node_modules", "dep");
    expect(await fs.readFile(path.join(mirroredNested, "index.js"), "utf8")).toBe("// dep");
    await fs.writeFile(path.join(mirroredNested, "probe"), "");
  });

  it("reuses an existing mirror instead of copying over it", async () => {
    await fs.mkdir(mirrorDir(), { recursive: true });
    await fs.writeFile(path.join(mirrorDir(), "bridge.js"), "// already mirrored");
    await fs.chmod(installDir(), 0o555);

    expect(await resolveWhatsappBridgeDir()).toBe(mirrorDir());
    expect(await fs.readFile(path.join(mirrorDir(), "bridge.js"), "utf8")).toBe("// already mirrored");
  });
});


/*
 * The gateway's OWN authorization gate.
 *
 * Everything below concerns WHATSAPP_ALLOWED_USERS, which is a second gate the
 * pairing flow never used to fill in: a box could link perfectly and then have
 * the gateway drop every message with "Unauthorized user: <id> on whatsapp".
 *
 * No real account identifiers appear here. This repo is public, and a LID or a
 * phone number in a fixture is exactly as personal as it looks. The shapes are
 * copied from a live device; the digits are invented.
 */

/** A stand-in for the linked account: a LID and a phone JID, both with a device suffix. */
const OWNER = {
  id: "15550001111:7@s.whatsapp.net",
  lid: "100000000000001:7@lid",
  name: "Bench Box",
};

describe("normalizeWhatsappIdentifier", () => {
  it("reduces every JID shape to the bare id the gateway compares", () => {
    // Hermes' normalize_whatsapp_identifier: trim, drop the first "+", cut at
    // ":", cut at "@". Verified against gateway/whatsapp_identity.py on a device.
    expect(normalizeWhatsappIdentifier("100000000000001@lid")).toBe("100000000000001");
    expect(normalizeWhatsappIdentifier("100000000000001:7@lid")).toBe("100000000000001");
    expect(normalizeWhatsappIdentifier("15550001111:7@s.whatsapp.net")).toBe("15550001111");
    expect(normalizeWhatsappIdentifier("+15550001111")).toBe("15550001111");
    expect(normalizeWhatsappIdentifier("  15550001111  ")).toBe("15550001111");
  });

  it("is empty for values that carry no id", () => {
    expect(normalizeWhatsappIdentifier("")).toBe("");
    expect(normalizeWhatsappIdentifier(null)).toBe("");
    expect(normalizeWhatsappIdentifier(undefined)).toBe("");
    expect(normalizeWhatsappIdentifier("@lid")).toBe("");
  });
});

describe("whatsappAllowlistForms", () => {
  it("writes the qualified and the bare spelling of a JID", () => {
    expect(whatsappAllowlistForms("100000000000001:7@lid")).toEqual([
      "100000000000001@lid",
      "100000000000001",
    ]);
    expect(whatsappAllowlistForms("15550001111:7@s.whatsapp.net")).toEqual([
      "15550001111@s.whatsapp.net",
      "15550001111",
    ]);
  });

  it("never lets a device suffix reach .env", () => {
    // ":7" is a device, not a principal. Upstream cuts it before comparing, so
    // storing it would only make the file harder to read.
    for (const form of whatsappAllowlistForms("100000000000001:7@lid")) {
      expect(form).not.toContain(":");
    }
  });

  it("yields a single entry for a bare number and nothing for a non-id", () => {
    expect(whatsappAllowlistForms("15550001111")).toEqual(["15550001111"]);
    expect(whatsappAllowlistForms("")).toEqual([]);
    expect(whatsappAllowlistForms(null)).toEqual([]);
    expect(whatsappAllowlistForms("@lid")).toEqual([]);
  });
});

describe("mergeAllowlistEntries", () => {
  it("keeps entries it did not write", () => {
    // A box may carry a hand-edited allowlist. Auto-authorizing the owner adds
    // to it; it never takes somebody else's access away.
    expect(mergeAllowlistEntries("15559998888", ["15550001111"])).toEqual([
      "15559998888",
      "15550001111",
    ]);
  });

  it("is idempotent", () => {
    const once = mergeAllowlistEntries(null, whatsappAllowlistForms(OWNER.lid));
    const twice = mergeAllowlistEntries(formatAllowedUsers(once), whatsappAllowlistForms(OWNER.lid));
    expect(twice).toEqual(once);
  });

  it("treats a device-suffixed repeat as the duplicate it is", () => {
    expect(mergeAllowlistEntries("100000000000001@lid", ["100000000000001:7@lid"])).toEqual([
      "100000000000001@lid",
    ]);
  });

  it("keeps the two spellings of one id as the deliberate pair they are", () => {
    expect(mergeAllowlistEntries(null, ["100000000000001@lid", "100000000000001"])).toEqual([
      "100000000000001@lid",
      "100000000000001",
    ]);
  });

  it("drops blanks and tolerates a missing base", () => {
    expect(mergeAllowlistEntries(" , ,15550001111, ", [])).toEqual(["15550001111"]);
    expect(mergeAllowlistEntries(null, [])).toEqual([]);
    expect(mergeAllowlistEntries(undefined, [])).toEqual([]);
  });
});

describe("allowlistAuthorizes", () => {
  it("matches on the normalised id, whichever spelling is stored", () => {
    expect(allowlistAuthorizes("100000000000001", OWNER)).toBe(true);
    expect(allowlistAuthorizes("100000000000001@lid", OWNER)).toBe(true);
    // The phone half of the same account authorizes it too.
    expect(allowlistAuthorizes("15550001111", OWNER)).toBe(true);
  });

  it("honours upstream's allow-everyone marker", () => {
    expect(allowlistAuthorizes("*", OWNER)).toBe(true);
  });

  it("is false when nothing covers the owner", () => {
    expect(allowlistAuthorizes("15559998888", OWNER)).toBe(false);
    expect(allowlistAuthorizes("", OWNER)).toBe(false);
    expect(allowlistAuthorizes(null, OWNER)).toBe(false);
  });

  it("is false when nothing is paired, rather than vacuously true", () => {
    expect(allowlistAuthorizes("15550001111", null)).toBe(false);
  });
});

describe("pairedIdentityAllowlistEntries", () => {
  it("covers BOTH the phone id and the LID", () => {
    // The bridge's `connected` event reports the phone jid, but a self-chat
    // message can arrive under the LID. Authorizing only one of them is how a
    // freshly paired box ends up answering nobody.
    expect(pairedIdentityAllowlistEntries(OWNER)).toEqual([
      "15550001111@s.whatsapp.net",
      "15550001111",
      "100000000000001@lid",
      "100000000000001",
    ]);
  });

  it("folds in an extra id without repeating what it already has", () => {
    expect(pairedIdentityAllowlistEntries(OWNER, [OWNER.id])).toEqual(
      pairedIdentityAllowlistEntries(OWNER),
    );
  });

  it("is empty when nothing is paired", () => {
    expect(pairedIdentityAllowlistEntries(null)).toEqual([]);
  });
});

describe("the paired identity on disk", () => {
  let dir: string;
  const originalHome = process.env.HERMES_HOME;

  const writeCreds = async (contents: unknown, legacy = false) => {
    const sessionDir = legacy
      ? path.join(dir, "whatsapp", "session")
      : path.join(dir, "platforms", "whatsapp", "session");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "creds.json"), JSON.stringify(contents));
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-whatsapp-id-"));
    process.env.HERMES_HOME = dir;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = originalHome;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads the linked account out of creds.json", async () => {
    await writeCreds({ me: { id: OWNER.id, lid: OWNER.lid, name: OWNER.name } });
    expect(await readPairedWhatsappIdentity()).toEqual(OWNER);
  });

  it("finds a session in the legacy location too", async () => {
    // The adapter and the CLI genuinely disagree about where this lives.
    await writeCreds({ me: { id: OWNER.id, lid: null, name: null } }, true);
    expect(await readPairedWhatsappIdentity()).toEqual({ id: OWNER.id, lid: null, name: null });
  });

  it("survives a bridge old enough to have no LID", async () => {
    await writeCreds({ me: { id: OWNER.id } });
    expect(await readPairedWhatsappIdentity()).toEqual({ id: OWNER.id, lid: null, name: null });
  });

  it("returns null rather than throwing on missing or unusable creds", async () => {
    expect(await readPairedWhatsappIdentity()).toBeNull();
    await writeCreds({});
    expect(await readPairedWhatsappIdentity()).toBeNull();
    // A half-written file during pairing must not take the status route down.
    const sessionDir = path.join(dir, "platforms", "whatsapp", "session");
    await fs.writeFile(path.join(sessionDir, "creds.json"), '{"me":{"id":');
    expect(await readPairedWhatsappIdentity()).toBeNull();
  });

  describe("markWhatsappPaired", () => {
    it("authorizes the owner as well as enabling the channel", async () => {
      // The bug: upstream's step 7 writes WHATSAPP_ENABLED and stops, so the
      // gateway's sender check has nothing to match and denies everyone.
      await writeCreds({ me: { id: OWNER.id, lid: OWNER.lid, name: OWNER.name } });
      const keys = await markWhatsappPaired(OWNER.id);

      expect(keys).toEqual(["WHATSAPP_ENABLED", "WHATSAPP_ALLOWED_USERS"]);
      const env = await readHermesEnv();
      expect(env.WHATSAPP_ENABLED).toBe("true");
      expect(env.WHATSAPP_ALLOWED_USERS).toBe(
        "15550001111@s.whatsapp.net,15550001111,100000000000001@lid,100000000000001",
      );
      expect(
        allowlistAuthorizes(env.WHATSAPP_ALLOWED_USERS, await readPairedWhatsappIdentity()),
      ).toBe(true);
    });

    it("unions into a hand-fixed allowlist instead of clobbering it", async () => {
      // The bench box was repaired by hand before this code existed. Re-pairing
      // it must not drop the entries somebody already put there.
      await writeCreds({ me: { id: OWNER.id, lid: OWNER.lid, name: OWNER.name } });
      await setHermesEnvValues({
        WHATSAPP_ALLOWED_USERS: "100000000000001@lid,100000000000001,15559998888",
      });

      await markWhatsappPaired(OWNER.id);
      const env = await readHermesEnv();
      expect(env.WHATSAPP_ALLOWED_USERS).toBe(
        "100000000000001@lid,100000000000001,15559998888,15550001111@s.whatsapp.net,15550001111",
      );
    });

    it("writes nothing new when the allowlist is already right", async () => {
      await writeCreds({ me: { id: OWNER.id, lid: OWNER.lid, name: OWNER.name } });
      await markWhatsappPaired(OWNER.id);
      const first = (await readHermesEnv()).WHATSAPP_ALLOWED_USERS;

      const keys = await markWhatsappPaired(OWNER.id);
      expect(keys).toEqual(["WHATSAPP_ENABLED"]);
      expect((await readHermesEnv()).WHATSAPP_ALLOWED_USERS).toBe(first);
    });

    it("leaves an explicit allow-everyone flag to do its job", async () => {
      await writeCreds({ me: { id: OWNER.id, lid: OWNER.lid, name: OWNER.name } });
      await setHermesEnvValues({ WHATSAPP_ALLOW_ALL_USERS: "true" });

      expect(await markWhatsappPaired(OWNER.id)).toEqual(["WHATSAPP_ENABLED"]);
      expect((await readHermesEnv()).WHATSAPP_ALLOWED_USERS).toBeUndefined();
    });

    it("still enables when there is no identity to read", async () => {
      await writeCreds({});
      expect(await markWhatsappPaired(null)).toEqual(["WHATSAPP_ENABLED"]);
      expect((await readHermesEnv()).WHATSAPP_ENABLED).toBe("true");
    });
  });

  describe("setHermesWhatsappConfig keeps the owner authorized", () => {
    beforeEach(async () => {
      await writeCreds({ me: { id: OWNER.id, lid: OWNER.lid, name: OWNER.name } });
    });

    it("makes the owner the allowlist in self-chat mode", async () => {
      const result = await setHermesWhatsappConfig({ mode: "self-chat", enabled: true });
      expect(result.authorized).toBe(true);
      expect((await readHermesEnv()).WHATSAPP_ALLOWED_USERS).toBe(
        "15550001111@s.whatsapp.net,15550001111,100000000000001@lid,100000000000001",
      );
    });

    it("keeps the owner alongside the panel's numbers in bot mode", async () => {
      const result = await setHermesWhatsappConfig({
        mode: "bot",
        allowedUsers: ["+1 555 999 8888"],
      });
      expect(result.authorized).toBe(true);
      const env = await readHermesEnv();
      expect(env.WHATSAPP_MODE).toBe("bot");
      expect(env.WHATSAPP_ALLOWED_USERS).toBe(
        "15559998888,15550001111@s.whatsapp.net,15550001111,100000000000001@lid,100000000000001",
      );
    });

    it("honours a removal from the panel without locking the owner out", async () => {
      await setHermesWhatsappConfig({ allowedUsers: ["15559998888", "15557776666"] });
      await setHermesWhatsappConfig({ allowedUsers: ["15559998888"] });

      const env = await readHermesEnv();
      // The removed guest is gone...
      expect(env.WHATSAPP_ALLOWED_USERS).not.toContain("15557776666");
      // ...and the owner is not collateral damage.
      expect(allowlistAuthorizes(env.WHATSAPP_ALLOWED_USERS, OWNER)).toBe(true);
    });

    it("refuses to leave a paired box authorizing nobody", async () => {
      // THE INVARIANT. Emptying the list on a paired box used to delete the key
      // outright, which is the state the gateway reads as "deny everyone".
      const result = await setHermesWhatsappConfig({ allowedUsers: [] });
      expect(result.paired).toBe(true);
      expect(result.authorized).toBe(true);
      expect((await readHermesEnv()).WHATSAPP_ALLOWED_USERS).toBeTruthy();
    });

    it("clears a stale allow-everyone flag and still authorizes the owner", async () => {
      await setHermesEnvValues({ WHATSAPP_ALLOW_ALL_USERS: "true" });
      const result = await setHermesWhatsappConfig({ allowedUsers: ["15559998888"] });

      const env = await readHermesEnv();
      expect(env.WHATSAPP_ALLOW_ALL_USERS).toBe("false");
      expect(result.authorized).toBe(true);
      expect(allowlistAuthorizes(env.WHATSAPP_ALLOWED_USERS, OWNER)).toBe(true);
    });

    it("does not rewrite an allowlist that is already correct", async () => {
      await setHermesWhatsappConfig({ mode: "self-chat" });
      const result = await setHermesWhatsappConfig({ mode: "self-chat" });
      // Mode is re-written; the allowlist is not, so the panel can still tell
      // "nothing changed" from "saved".
      expect(result.changedKeys).toEqual(["WHATSAPP_MODE"]);
    });

    it("reports authorized:false on an unpaired box rather than guessing", async () => {
      await fs.rm(path.join(dir, "platforms"), { recursive: true, force: true });
      const result = await setHermesWhatsappConfig({ mode: "bot" });
      expect(result.paired).toBe(false);
      expect(result.authorized).toBe(false);
    });
  });

  describe("readHermesWhatsappStatus", () => {
    it("says whether the gateway allowlist covers the paired account", async () => {
      await writeCreds({ me: { id: OWNER.id, lid: OWNER.lid, name: OWNER.name } });
      await setHermesEnvValues({ WHATSAPP_ENABLED: "true", WHATSAPP_ALLOWED_USERS: "15559998888" });
      expect((await readHermesWhatsappStatus()).authorized).toBe(false);

      await setHermesEnvValues({ WHATSAPP_ALLOWED_USERS: "15559998888,100000000000001@lid" });
      expect((await readHermesWhatsappStatus()).authorized).toBe(true);
    });

    it("is not authorized when nothing is paired", async () => {
      await setHermesEnvValues({ WHATSAPP_ALLOWED_USERS: "15550001111" });
      expect((await readHermesWhatsappStatus()).authorized).toBe(false);
    });

    it("counts an explicit allow-everyone flag as authorization", async () => {
      await writeCreds({ me: { id: OWNER.id, lid: OWNER.lid, name: OWNER.name } });
      await setHermesEnvValues({ WHATSAPP_ENABLED: "true", WHATSAPP_ALLOW_ALL_USERS: "true" });
      expect((await readHermesWhatsappStatus()).authorized).toBe(true);
    });
  });
});
