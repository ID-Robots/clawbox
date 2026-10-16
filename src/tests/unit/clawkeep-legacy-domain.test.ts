import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateLegacyPortalUrl } from "@/lib/portal-legacy-domain";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-clawkeep-legacy-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "clawkeep");
const CONFIG_PATH = path.join(DATA_DIR, "config.toml");

let clawkeep: typeof import("@/lib/clawkeep");

beforeAll(async () => {
  process.env.CLAWKEEP_DATA_DIR = DATA_DIR;
  process.env.CLAWKEEP_CONFIG_PATH = CONFIG_PATH;
  await fs.mkdir(DATA_DIR, { recursive: true });
  clawkeep = await import("@/lib/clawkeep");
});

afterAll(async () => {
  delete process.env.CLAWKEEP_DATA_DIR;
  delete process.env.CLAWKEEP_CONFIG_PATH;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("migrateLegacyPortalUrl", () => {
  it.each([
    ["https://openclawhardware.dev", "https://clawbox.com"],
    ["https://www.openclawhardware.dev", "https://clawbox.com"],
    ["https://openclawhardware.dev/", "https://clawbox.com/"],
    ["https://WWW.OpenClawHardware.dev/api/portal/devices/heartbeat", "https://clawbox.com/api/portal/devices/heartbeat"],
    ["http://openclawhardware.dev", "https://clawbox.com"],
  ])("rewrites %s", (from, to) => {
    expect(migrateLegacyPortalUrl(from)).toBe(to);
  });

  it.each([
    "https://clawbox.com",
    "https://backup.example.org",
    "http://192.0.2.10:8080",
    "https://openclawhardware.dev.example.org",
    "https://openclawhardware.dev:8443",
    "not a url",
    "",
  ])("leaves %s untouched", (value) => {
    expect(migrateLegacyPortalUrl(value)).toBe(value);
  });
});

describe("config.toml legacy server migration", () => {
  it("rewrites and persists a legacy server on read, keeping other lines", async () => {
    const legacy = `# comment\nserver = "https://www.openclawhardware.dev" # pinned\n\n[openclaw]\nserver = "https://openclawhardware.dev"\n`;
    await fs.writeFile(CONFIG_PATH, legacy);
    const read = await clawkeep.readConfigToml();
    const expected = `# comment\nserver = "https://clawbox.com" # pinned\n\n[openclaw]\nserver = "https://openclawhardware.dev"\n`;
    expect(read).toBe(expected);
    expect(await fs.readFile(CONFIG_PATH, "utf8")).toBe(expected);
  });

  it("leaves a custom server byte-for-byte", async () => {
    const custom = `server = "https://backup.example.org"\r\n`;
    await fs.writeFile(CONFIG_PATH, custom);
    expect(await clawkeep.readConfigToml()).toBe(custom);
    expect(await fs.readFile(CONFIG_PATH, "utf8")).toBe(custom);
  });

  it("migrateLegacyServerToml handles CRLF", () => {
    expect(clawkeep.migrateLegacyServerToml(`server="https://openclawhardware.dev"\r\nx = 1\r\n`))
      .toBe(`server="https://clawbox.com"\r\nx = 1\r\n`);
  });
});
