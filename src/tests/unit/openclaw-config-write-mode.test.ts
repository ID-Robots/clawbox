// `openclaw.json` holds `channels.telegram.botToken` and the gateway's auth
// token, and it is 0600 on a box. Every writer here is a temp-then-rename, and
// `rename` replaces the INODE: the temp file's mode is the one that survives,
// so a plain `writeFile` under the service user's umask (0002 on an OpenClaw
// box) left the live credential file at 0664 — readable by every account on the
// device, from a save that answered 200.
//
// Real files, no fs mock: the whole point is what the filesystem ends up
// holding, which a mocked `writeFile` cannot show.

import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let lib: typeof import("@/lib/openclaw-config");

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-openclaw-mode-"));
  process.env.CLAWBOX_OPENCLAW_HOME = home;
  vi.resetModules();
  lib = await import("@/lib/openclaw-config");
});

afterEach(() => {
  delete process.env.CLAWBOX_OPENCLAW_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function modeOf(file: string): string {
  return (fs.statSync(file).mode & 0o777).toString(8);
}

describe("writeConfig and the mode of openclaw.json", () => {
  it("keeps the 0600 a box's config file already has", async () => {
    fs.writeFileSync(lib.CONFIG_PATH, JSON.stringify({ gateway: { port: 18789 } }), { mode: 0o600 });
    fs.chmodSync(lib.CONFIG_PATH, 0o600);

    await lib.writeConfig({ gateway: { port: 18789 } } as never);

    expect(modeOf(lib.CONFIG_PATH)).toBe("600");
  });

  it("keeps a mode an operator chose deliberately", async () => {
    fs.writeFileSync(lib.CONFIG_PATH, "{}", { mode: 0o640 });
    fs.chmodSync(lib.CONFIG_PATH, 0o640);

    await lib.writeConfig({} as never);

    expect(modeOf(lib.CONFIG_PATH)).toBe("640");
  });

  it("creates a config file this box has never had at 0600", async () => {
    await lib.writeConfig({} as never);

    expect(modeOf(lib.CONFIG_PATH)).toBe("600");
  });

  // A crashed write leaves a `.tmp` behind, and `writeFile`'s own `mode` is
  // ignored for a file that already exists — so the chmod is not belt and
  // braces, it is the only thing that fixes the mode on this path.
  it("re-secures a stale temp file a crashed write left at 0666", async () => {
    fs.writeFileSync(lib.CONFIG_PATH, "{}", { mode: 0o600 });
    fs.chmodSync(lib.CONFIG_PATH, 0o600);
    fs.writeFileSync(`${lib.CONFIG_PATH}.tmp`, "half", { mode: 0o666 });
    fs.chmodSync(`${lib.CONFIG_PATH}.tmp`, 0o666);

    await lib.writeConfig({} as never);

    expect(modeOf(lib.CONFIG_PATH)).toBe("600");
  });
});
