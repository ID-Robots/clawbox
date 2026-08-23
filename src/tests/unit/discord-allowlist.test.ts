import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  DISCORD_ENV_ALLOWED_USERS,
  DiscordEmptyAllowlistError,
  formatDiscordAllowedUsers,
  mapDiscordConnectionState,
  normalizeDiscordUserId,
  parseDiscordAllowedUsers,
  parseDiscordAllowlistExtras,
  parseHermesGatewaySnapshot,
  readHermesDiscordAccess,
  setHermesDiscordAllowlist,
} from "@/lib/hermes-discord";

/**
 * DISCORD_ALLOWED_USERS: the value whose absence made a connected bot deny
 * every message, and the four states the panel maps that onto.
 */

const OWNER = "100000000000000001";
const FRIEND = "100000000000000002";

describe("Discord id normalisation", () => {
  it("accepts a snowflake", () => {
    expect(normalizeDiscordUserId(OWNER)).toBe(OWNER);
  });

  it("trims a pasted value", () => {
    expect(normalizeDiscordUserId(`  ${OWNER}\t`)).toBe(OWNER);
  });

  it("rejects anything that is not digits", () => {
    for (const value of ["", "not-an-id", "12345", `${OWNER}@lid`, "*", null, undefined]) {
      expect(normalizeDiscordUserId(value)).toBeNull();
    }
  });

  it("rejects an id carrying a newline, which would forge a second env line", () => {
    expect(normalizeDiscordUserId(`${OWNER}\nDISCORD_ALLOW_ALL_USERS=true`)).toBeNull();
  });
});

describe("parsing a stored allowlist", () => {
  it("reads a comma-joined value", () => {
    expect(parseDiscordAllowedUsers(`${OWNER},${FRIEND}`)).toEqual([OWNER, FRIEND]);
  });

  it("tolerates the spacing a hand-edited env has", () => {
    expect(parseDiscordAllowedUsers(` ${OWNER} , ${FRIEND} `)).toEqual([OWNER, FRIEND]);
  });

  it("de-duplicates", () => {
    expect(parseDiscordAllowedUsers(`${OWNER},${OWNER}`)).toEqual([OWNER]);
  });

  it("drops the allow-everyone marker rather than treating it as a user", () => {
    expect(parseDiscordAllowedUsers(`*,${OWNER}`)).toEqual([OWNER]);
  });

  it("reports non-id entries separately instead of losing them", () => {
    // Hermes also accepts usernames here. They still grant access, so the panel
    // has to be able to show them even though the picker cannot tick them.
    expect(parseDiscordAllowlistExtras(`${OWNER},someuser,*`)).toEqual(["someuser", "*"]);
  });

  it("serialises without spaces, because upstream denies an entry with one", () => {
    expect(formatDiscordAllowedUsers([OWNER, FRIEND])).toBe(`${OWNER},${FRIEND}`);
    expect(formatDiscordAllowedUsers([OWNER, FRIEND])).not.toContain(" ");
  });
});

describe("setHermesDiscordAllowlist on disk", () => {
  let home: string;
  let previous: string | undefined;

  const envPath = () => path.join(home, ".env");

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-discord-env-"));
    previous = process.env.HERMES_HOME;
    process.env.HERMES_HOME = home;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("writes the selected ids comma-joined and whitespace-free", async () => {
    const result = await setHermesDiscordAllowlist([OWNER, FRIEND]);

    expect(result.changedKeys).toEqual([DISCORD_ENV_ALLOWED_USERS]);
    expect(result.authorized).toBe(true);
    const text = await fs.readFile(envPath(), "utf-8");
    expect(text).toContain(`${DISCORD_ENV_ALLOWED_USERS}=${OWNER},${FRIEND}\n`);
  });

  it("creates the env file at 0600", async () => {
    await setHermesDiscordAllowlist([OWNER]);
    const stat = await fs.stat(envPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("merges into an existing env instead of replacing it", async () => {
    await fs.writeFile(envPath(), "DISCORD_BOT_TOKEN=abc\n# a comment\nOTHER=1\n", { mode: 0o600 });
    await setHermesDiscordAllowlist([OWNER]);

    const text = await fs.readFile(envPath(), "utf-8");
    expect(text).toContain("DISCORD_BOT_TOKEN=abc");
    expect(text).toContain("# a comment");
    expect(text).toContain("OTHER=1");
    expect(text).toContain(`${DISCORD_ENV_ALLOWED_USERS}=${OWNER}`);
  });

  it("is idempotent against a value that was set by hand", async () => {
    // The bench box had exactly this: DISCORD_ALLOWED_USERS written by hand
    // during the manual fix. Re-selecting the same person from the picker must
    // write nothing, so nothing restarts the gateway for a no-op.
    await fs.writeFile(envPath(), `${DISCORD_ENV_ALLOWED_USERS}=${OWNER}\n`, { mode: 0o600 });
    const before = await fs.readFile(envPath(), "utf-8");

    const result = await setHermesDiscordAllowlist([OWNER]);

    expect(result.changedKeys).toEqual([]);
    expect(await fs.readFile(envPath(), "utf-8")).toBe(before);
  });

  it("ignores ordering and spacing when deciding whether anything changed", async () => {
    await fs.writeFile(envPath(), `${DISCORD_ENV_ALLOWED_USERS}= ${FRIEND} , ${OWNER} \n`, { mode: 0o600 });
    const result = await setHermesDiscordAllowlist([OWNER, FRIEND]);
    expect(result.changedKeys).toEqual([]);
  });

  it("replaces the line rather than appending a second definition", async () => {
    await fs.writeFile(envPath(), `${DISCORD_ENV_ALLOWED_USERS}=${OWNER}\n`, { mode: 0o600 });
    await setHermesDiscordAllowlist([FRIEND]);

    const text = await fs.readFile(envPath(), "utf-8");
    const definitions = text.split("\n").filter((line) => line.startsWith(DISCORD_ENV_ALLOWED_USERS));
    expect(definitions).toEqual([`${DISCORD_ENV_ALLOWED_USERS}=${FRIEND}`]);
  });

  it("removes somebody the picker deselected", async () => {
    await fs.writeFile(envPath(), `${DISCORD_ENV_ALLOWED_USERS}=${OWNER},${FRIEND}\n`, { mode: 0o600 });
    const result = await setHermesDiscordAllowlist([OWNER]);

    expect(result.allowedUsers).toEqual([OWNER]);
    expect(await fs.readFile(envPath(), "utf-8")).toContain(`${DISCORD_ENV_ALLOWED_USERS}=${OWNER}\n`);
  });

  it("refuses to leave a configured bot with nobody allowed", async () => {
    await fs.writeFile(envPath(), `${DISCORD_ENV_ALLOWED_USERS}=${OWNER}\n`, { mode: 0o600 });

    await expect(setHermesDiscordAllowlist([])).rejects.toBeInstanceOf(DiscordEmptyAllowlistError);
    // And the refusal is total: the value on disk is untouched.
    expect(await fs.readFile(envPath(), "utf-8")).toContain(`${DISCORD_ENV_ALLOWED_USERS}=${OWNER}`);
  });

  it("allows an empty user list when a channel rule already admits people", async () => {
    // Emptying the user list is only dangerous when nothing else covers for it.
    await fs.writeFile(envPath(), "DISCORD_ALLOWED_CHANNELS=555\n", { mode: 0o600 });
    const result = await setHermesDiscordAllowlist([]);
    expect(result.authorized).toBe(true);
  });

  it("rejects one bad id rather than silently dropping it", async () => {
    // Dropping it would save an allowlist that quietly excludes somebody the
    // owner believes they just added.
    await expect(setHermesDiscordAllowlist([OWNER, "nope"])).rejects.toThrow("Invalid Discord user id");
  });

  it("never writes the allow-everyone flag", async () => {
    await setHermesDiscordAllowlist([OWNER]);
    expect(await fs.readFile(envPath(), "utf-8")).not.toContain("DISCORD_ALLOW_ALL_USERS");
  });

  it("reports every input the adapter's admission check consults", async () => {
    await fs.writeFile(
      envPath(),
      [
        `${DISCORD_ENV_ALLOWED_USERS}=${OWNER},someuser`,
        "DISCORD_ALLOWED_ROLES=9",
        "DISCORD_ALLOWED_CHANNELS=7",
        "DISCORD_ALLOW_ALL_USERS=true",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const access = await readHermesDiscordAccess();
    expect(access.allowedUsers).toEqual([OWNER]);
    expect(access.allowlistExtras).toEqual(["someuser"]);
    expect(access.allowedRoles).toEqual(["9"]);
    expect(access.allowedChannels).toEqual(["7"]);
    expect(access.allowAllUsers).toBe(true);
    expect(access.authorized).toBe(true);
  });

  it("reports an env with no allowlist at all as unauthorized", async () => {
    await fs.writeFile(envPath(), "DISCORD_BOT_TOKEN=abc\n", { mode: 0o600 });
    const access = await readHermesDiscordAccess();
    expect(access.authorized).toBe(false);
  });
});

describe("parseHermesGatewaySnapshot", () => {
  it("reads the platform entry Hermes writes", () => {
    const raw = JSON.stringify({
      gateway_state: "running",
      platforms: {
        discord: {
          state: "connected",
          error_code: null,
          error_message: null,
          updated_at: "2026-08-23T14:22:04.876937+00:00",
        },
      },
    });
    expect(parseHermesGatewaySnapshot(raw, "discord")).toEqual({
      gatewayState: "running",
      platform: {
        state: "connected",
        errorCode: null,
        updatedAt: "2026-08-23T14:22:04.876937+00:00",
      },
    });
  });

  it("returns no platform when the gateway knows nothing about Discord", () => {
    const raw = JSON.stringify({ gateway_state: "running", platforms: { whatsapp: {} } });
    expect(parseHermesGatewaySnapshot(raw, "discord").platform).toBeNull();
  });

  it("survives a truncated or corrupt file", () => {
    expect(parseHermesGatewaySnapshot("{not json", "discord")).toEqual({
      gatewayState: null,
      platform: null,
    });
  });
});

describe("mapDiscordConnectionState", () => {
  const snapshot = (state: string | null, errorCode: string | null = null) => ({
    gatewayState: "running",
    platform: state === null ? null : { state, errorCode, updatedAt: null },
  });

  it("reports connected only when the platform is up AND somebody is allowed", () => {
    expect(
      mapDiscordConnectionState({
        gatewayRunning: true,
        snapshot: snapshot("connected"),
        authorized: true,
      }),
    ).toBe("connected");
  });

  it("reports denied-no-allowlist for the connected-but-silent bot", () => {
    // This is the state the bench box was in after the intents were fixed: the
    // adapter logged "messages are being denied because no allowlist is
    // configured" and the panel said "receiving".
    expect(
      mapDiscordConnectionState({
        gatewayRunning: true,
        snapshot: snapshot("connected"),
        authorized: false,
      }),
    ).toBe("denied-no-allowlist");
  });

  it("reports intents-missing from the adapter's own error code", () => {
    expect(
      mapDiscordConnectionState({
        gatewayRunning: true,
        snapshot: snapshot("error", "discord_intents_required"),
        authorized: true,
      }),
    ).toBe("intents-missing");
  });

  it("keeps intents-missing visible even while an allowlist exists", () => {
    // Both problems can be true at once; the one that stops the bot connecting
    // at all is the one to act on first.
    expect(
      mapDiscordConnectionState({
        gatewayRunning: true,
        snapshot: snapshot("retrying", "discord_intents_required"),
        authorized: false,
      }),
    ).toBe("intents-missing");
  });

  it("reports offline when the gateway process is down, whatever the file says", () => {
    expect(
      mapDiscordConnectionState({
        gatewayRunning: false,
        snapshot: snapshot("connected"),
        authorized: true,
      }),
    ).toBe("offline");
  });

  it("reports offline for a snapshot left behind by a gateway that stopped", () => {
    expect(
      mapDiscordConnectionState({
        gatewayRunning: true,
        snapshot: { gatewayState: "stopped", platform: { state: "connected", errorCode: null, updatedAt: null } },
        authorized: true,
      }),
    ).toBe("offline");
  });

  it("reports offline for a rejected token rather than inventing a fifth state", () => {
    expect(
      mapDiscordConnectionState({
        gatewayRunning: true,
        snapshot: snapshot("error", "discord_auth_error"),
        authorized: true,
      }),
    ).toBe("offline");
  });

  it("reports offline when the gateway has no Discord entry yet", () => {
    expect(
      mapDiscordConnectionState({
        gatewayRunning: true,
        snapshot: snapshot(null),
        authorized: true,
      }),
    ).toBe("offline");
  });
});
