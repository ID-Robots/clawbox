import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { testEnv } from "@/tests/helpers/env";

// The ClawBox Desktop session's drop-down terminal: Guake in the ClawBox look,
// on Win+Down (scripts/x64-migration/kiosk/install-guake.sh). The per-user half
// (`--user-config`) is run for real against a scratch home and a fake dconf;
// nothing here touches the machine's Guake, dconf or packages.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = path.resolve(__dirname, "../../..");
const KIOSK = path.join(REPO, "scripts/x64-migration/kiosk");
const SCRIPT = path.join(KIOSK, "install-guake.sh");
const ASSETS = path.join(KIOSK, "guake");

let tmp: string;
let home: string;
let dconf: string;

function run(): string {
  const r = spawnSync("bash", [SCRIPT, "--user-config"], {
    // testEnv: Next declares NODE_ENV a required key of ProcessEnv, and CI
    // runs tsc over the tests. The NODE_ENV it adds is one the script never
    // reads; these three are still the whole of what it is given.
    env: testEnv({ PATH: process.env.PATH ?? "", HOME: home, CLAWBOX_DCONF: dconf }),
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}
const read = (rel: string) => fs.readFileSync(path.join(home, ".config", rel), "utf8");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guake-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  dconf = path.join(tmp, "dconf");
  fs.writeFileSync(dconf, `#!/bin/sh\necho "$*" >> "${tmp}/dconf.args"\ncat > "${tmp}/dconf.in"\n`, { mode: 0o755 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("install-guake.sh", () => {
  it("is valid bash, and so is the session installer that calls it", () => {
    execFileSync("bash", ["-n", SCRIPT]);
    execFileSync("bash", ["-n", path.join(KIOSK, "install-desktop-session.sh")]);
    expect(fs.readFileSync(path.join(KIOSK, "install-desktop-session.sh"), "utf8")).toMatch(/install-guake\.sh/);
  });

  it("loads the ClawBox settings into Guake's own dconf path", () => {
    run();
    expect(fs.readFileSync(path.join(tmp, "dconf.args"), "utf8").trim()).toBe("load /org/guake/");
    expect(fs.readFileSync(path.join(tmp, "dconf.in"), "utf8")).toBe(fs.readFileSync(path.join(ASSETS, "clawbox-guake.dconf"), "utf8"));
  });

  it("writes the tab strip into the GTK stylesheet once, however often it runs, and keeps the owner's own rules", () => {
    fs.mkdirSync(path.join(home, ".config/gtk-3.0"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config/gtk-3.0/gtk.css"), "/* mine */\nwindow { color: red; }\n");
    run();
    run();
    const css = read("gtk-3.0/gtk.css");
    expect(css.startsWith("/* mine */\nwindow { color: red; }\n")).toBe(true);
    expect(css.match(/>>> clawbox-guake >>>/g)).toHaveLength(1);
    expect(css.match(/<<< clawbox-guake <<</g)).toHaveLength(1);
    expect(css).toContain(fs.readFileSync(path.join(ASSETS, "guake.css"), "utf8"));
  });

  it("binds Win+Down and starts Guake with the session, each only when missing", () => {
    run();
    expect(read("clawbox-desktop/keybinds.xml")).toContain('<keybind key="W-Down">');
    expect(read("clawbox-desktop/keybinds.xml")).toContain('command="guake -t"');
    expect(read("clawbox-desktop/autostart")).toMatch(/^guake &$/m);
    expect(fs.statSync(path.join(home, ".config/clawbox-desktop/autostart")).mode & 0o111).not.toBe(0);
    run();
    expect(read("clawbox-desktop/keybinds.xml").match(/W-Down/g)).toHaveLength(1);
    expect(read("clawbox-desktop/autostart").match(/^guake &$/gm)).toHaveLength(1);
  });

  it("leaves a Win+Down the owner bound to something else alone, and adds to an autostart that has other things", () => {
    const dir = path.join(home, ".config/clawbox-desktop");
    fs.mkdirSync(dir, { recursive: true });
    const mine = '<keybind key="W-Down"><action name="Execute" command="foot" /></keybind>\n';
    fs.writeFileSync(path.join(dir, "keybinds.xml"), mine);
    fs.writeFileSync(path.join(dir, "autostart"), "#!/bin/sh\nsyncthing &\n");
    run();
    expect(read("clawbox-desktop/keybinds.xml")).toBe(mine);
    expect(read("clawbox-desktop/autostart")).toMatch(/syncthing &[\s\S]*guake &/);
  });
});

describe("the ClawBox look", () => {
  const dconfText = fs.readFileSync(path.join(ASSETS, "clawbox-guake.dconf"), "utf8");
  const css = fs.readFileSync(path.join(ASSETS, "guake.css"), "utf8");

  it("restyles Guake's own window and nothing else: every selector is scoped to #guake-terminal", () => {
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").split("{").slice(0, -1).map((chunk) => chunk.split("}").pop()!.trim());
    expect(selectors.length).toBeGreaterThan(5);
    for (const group of selectors) {
      for (const sel of group.split(",")) expect(sel.trim()).toMatch(/^#guake-terminal\b/);
    }
  });

  it("is a full palette — 16 colours, a foreground and a background — on the darker canvas", () => {
    const palette = /^palette='([^']+)'$/m.exec(dconfText)?.[1] ?? "";
    const colours = palette.split(":");
    expect(colours).toHaveLength(18);
    for (const c of colours) expect(c).toMatch(/^#[0-9a-f]{12}$/);
    expect(colours[17]).toBe("#0d0d11111717");
    expect(css).toContain("#0d1117");
  });

  it("uses the system monospace, never JetBrains Mono (Guake letter-spaces it)", () => {
    expect(dconfText).toMatch(/^style='Monospace \d+'$/m);
    expect(dconfText.replace(/^#.*$/gm, "")).not.toMatch(/JetBrains/i);
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/JetBrains/i);
  });

  it("is opaque, with tabs on top and no tray icon or start-up notification", () => {
    expect(dconfText).toMatch(/^transparency=100$/m);
    expect(dconfText).toMatch(/^tab-ontop=true$/m);
    expect(dconfText).toMatch(/^use-trayicon=false$/m);
    expect(dconfText).toMatch(/^use-popup=false$/m);
  });
});
