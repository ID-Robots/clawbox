// `~/.hermes/config.yaml` is the Hermes edition's credential file: it holds
// `TELEGRAM_BOT_TOKEN` — the bot the gateway long-polls — and the provider
// `api_key`s. Nothing on the device narrows it (no writer in install.sh,
// install-x64.sh, scripts/ or src/ chmods it), so a box whose config.yaml was
// created under the service user's umask sits at 0644 or 0664 for ever.
//
// This is the Hermes half of `openclaw-config-write-mode.test.ts`, and it pins
// the same doctrine on the twin file: 0600 unconditionally rather than the mode
// the file happens to have, because preserving what an umask widened would
// leave exactly those boxes the ones the fix never reaches. It covers the two
// paths the OpenClaw suite cannot: the `.bak`, a FULL COPY of the credential
// file at a stable name written on every merge write, and the stale temp.
//
// Real files, no fs mock: the whole point is what the filesystem ends up
// holding, which a mocked `writeFile` cannot show.

import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: cliMock }));

const CONFIG = "model:\n  provider: openrouter\n  default: anthropic/claude-sonnet-4\n";

let home: string;
let configPath: string;
let lib: typeof import("@/lib/hermes-config-yaml");

beforeEach(async () => {
  cliMock.mockReset();
  cliMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hermes-mode-"));
  process.env.HERMES_HOME = home;
  configPath = path.join(home, "config.yaml");
  vi.resetModules();
  lib = await import("@/lib/hermes-config-yaml");
});

afterEach(() => {
  delete process.env.HERMES_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function modeOf(file: string): string {
  return (fs.statSync(file).mode & 0o777).toString(8);
}

function writeConfigAt(mode: number): void {
  fs.writeFileSync(configPath, CONFIG, { mode });
  fs.chmodSync(configPath, mode);
}

/** One ordinary merge write, proved to have taken the merge path. */
async function patch(): Promise<void> {
  const result = await lib.patchHermesConfig({ set: { "model.provider": "clawlocal" } });
  expect(result.mode).toBe("merge");
  expect(cliMock).not.toHaveBeenCalled();
}

describe("patchHermesConfig and the mode of config.yaml", () => {
  it("re-secures a config.yaml an installer left group- and world-readable", async () => {
    writeConfigAt(0o644);

    await patch();

    // The rename is what repairs it: the temp this write created at 0600 keeps
    // its mode across the swap, and the widened inode is gone with it.
    expect(modeOf(configPath)).toBe("600");
    expect(await fsp.readFile(configPath, "utf-8")).toContain("provider: clawlocal");
  });

  it("keeps the 0600 a correctly-installed box already has", async () => {
    writeConfigAt(0o600);

    await patch();

    expect(modeOf(configPath)).toBe("600");
  });

  it("creates a config.yaml this box has never had at 0600", async () => {
    await lib.patchHermesConfig({ set: { "model.provider": "clawlocal" } });

    expect(modeOf(configPath)).toBe("600");
  });

  // The `.bak` is a full copy of the credential file under a name that never
  // changes, so a `.bak` wider than the config is the same leak one filename
  // over — and it is written on EVERY merge write, not once.
  it("writes the .bak at 0600 even when the config it copies was wider", async () => {
    writeConfigAt(0o644);

    await patch();

    const backup = `${configPath}.bak`;
    expect(modeOf(backup)).toBe("600");
    // It really is the previous revision, not the new one.
    expect(await fsp.readFile(backup, "utf-8")).toContain("provider: openrouter");
  });

  // `writeFile`'s own `mode` is ignored for a file that already exists, so a
  // temp left behind by a crashed write would otherwise hold the whole
  // credential file at its old mode for the length of the write and carry that
  // mode across the rename.
  it("does not let a stale temp a crashed write left at 0666 ride the rename", async () => {
    writeConfigAt(0o600);
    const tmp = `${configPath}.clawbox-tmp-${process.pid}`;
    fs.writeFileSync(tmp, "stale: 1\n", { mode: 0o666 });
    fs.chmodSync(tmp, 0o666);

    await patch();

    expect(modeOf(configPath)).toBe("600");
    expect(fs.existsSync(tmp)).toBe(false);
    expect(await fsp.readFile(configPath, "utf-8")).not.toContain("stale");
  });
});
