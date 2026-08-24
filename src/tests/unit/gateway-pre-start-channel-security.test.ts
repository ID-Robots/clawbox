import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// gateway-pre-start.sh re-secures the messaging channels on EVERY gateway
// start. Two independent jobs, both load-bearing:
//
//   * strip `dmPolicy`/`allowFrom` — an older ClawBox wrote `"open"` + `["*"]`,
//     which exposed the agent's shell/file/system_power tools to anyone who
//     found the bot. Devices must self-heal without a reconfigure.
//   * reset an out-of-schema `groupPolicy` — ONE invalid value invalidates the
//     whole config, so the gateway loads no channels at all and every bot goes
//     silent while still reporting "channel active".
//
// The second is why this now covers Discord as well as Telegram: a bad Discord
// value would take a working Telegram bot down with it.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** Pull the channel-security block out of the .sh verbatim. */
function extractPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf('channels = cfg.get("channels")');
  const end = src.indexOf("\n# Migration: devices that configured OpenRouter", start);
  if (start < 0 || end < 0) throw new Error("channel-security block not found");
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractPolicy() : "";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "channel-security-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Applied {
  channels: Record<string, Record<string, unknown>>;
  changed: boolean;
}

/** Run the extracted policy against a config and return the resulting channels. */
function applyPolicy(config: Record<string, unknown>): Applied {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  const program = [
    "import json, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    POLICY,
    "print(json.dumps({'channels': cfg.get('channels') or {}, 'changed': changed}))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim());
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh channel security", () => {
  for (const channel of ["telegram", "discord"]) {
    describe(channel, () => {
      it("strips an inherited open DM policy", () => {
        const out = applyPolicy({
          channels: { [channel]: { enabled: true, dmPolicy: "open", allowFrom: ["*"] } },
        });
        expect(out.channels[channel]).not.toHaveProperty("dmPolicy");
        expect(out.channels[channel]).not.toHaveProperty("allowFrom");
        expect(out.changed).toBe(true);
      });

      it("keeps the rest of the channel intact", () => {
        const out = applyPolicy({
          channels: { [channel]: { enabled: true, dmPolicy: "open", token: { source: "env" } } },
        });
        expect(out.channels[channel].enabled).toBe(true);
        expect(out.channels[channel].token).toEqual({ source: "env" });
      });

      it("resets an out-of-schema groupPolicy to the safe default", () => {
        const out = applyPolicy({ channels: { [channel]: { groupPolicy: "invite-only" } } });
        expect(out.channels[channel].groupPolicy).toBe("disabled");
        expect(out.changed).toBe(true);
      });

      it("leaves a valid groupPolicy alone", () => {
        for (const value of ["open", "disabled", "allowlist"]) {
          const out = applyPolicy({ channels: { [channel]: { groupPolicy: value } } });
          expect(out.channels[channel].groupPolicy).toBe(value);
          expect(out.changed).toBe(false);
        }
      });

      it("is a no-op on an already-safe channel", () => {
        const out = applyPolicy({ channels: { [channel]: { enabled: true } } });
        expect(out.changed).toBe(false);
        expect(out.channels[channel]).toEqual({ enabled: true });
      });
    });
  }

  it("secures both channels in a single pass", () => {
    const out = applyPolicy({
      channels: {
        telegram: { enabled: true, allowFrom: ["*"] },
        discord: { enabled: true, dmPolicy: "open" },
      },
    });
    expect(out.channels.telegram).not.toHaveProperty("allowFrom");
    expect(out.channels.discord).not.toHaveProperty("dmPolicy");
  });

  it("ignores a channels value that is not an object", () => {
    const out = applyPolicy({ channels: { discord: "nope" } });
    expect(out.changed).toBe(false);
  });

  it("does nothing when the config has no channels at all", () => {
    const out = applyPolicy({ gateway: { port: 18789 } });
    expect(out.changed).toBe(false);
    expect(out.channels).toEqual({});
  });
});
