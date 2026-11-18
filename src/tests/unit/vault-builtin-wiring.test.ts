/**
 * ClawBox Vault as a built-in part of every box (TASK-2524): what the
 * installer and the updater have to do for it, where its data lives and who
 * may read it, and how its extension reaches the box's own browser.
 *
 * These are the joins between the vault (vault/) and the rest of the tree,
 * each one a place where a later edit could quietly take the vault off a box
 * or open it up: the unit and its registration, the packages, the loopback
 * rule, the secret-folder guards, the desktop app's owner-only wiring and the
 * browser's extension flag. The vault's own behaviour is proved in vault/tests
 * (bun) and the tools in mcp-vault-tools.test.ts.
 */
import { execFileSync, spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { testEnv } from "../helpers/env";
import { apps, APP_GLYPHS } from "@/lib/desktop-apps";
import { PROTECTED_HOME_DIRS } from "@/lib/file-guard";
import { OWNER_ONLY_APP_IDS, VAULT_APP_TREE } from "@/lib/non-owner-scope";
import {
  VAULT_DEFAULT_PORT,
  VAULT_DESKTOP_APP_ID,
  VAULT_PROXY_PREFIX,
  vaultRequestHeaders,
  vaultResponseHeaders,
  vaultServicePort,
  vaultUpstreamPath,
} from "@/lib/vault-proxy";
import { SECRET_NAME_RE } from "../../../mcp/lib/guard";

// Starts real processes (bash, git): the 5 s default is not enough on a loaded runner.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const ROOT = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

const INSTALL_SH = read("install.sh");
const INSTALL_X64 = read("install-x64.sh");
const UNIT = read("config", "clawbox-vault.service");
const START = read("scripts", "start-vault.sh");
const LAUNCH = read("scripts", "launch-browser.sh");

/** The entries of a `NAME=( … )` array in a shell script, comments dropped. */
function shellArray(source: string, name: string): string[] {
  const start = source.indexOf(`${name}=(`);
  expect(start, name).toBeGreaterThan(-1);
  const body = source.slice(start + name.length + 2, source.indexOf("\n)", start));
  return body
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** The body of a top-level shell function. */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  expect(start, name).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}\n", start));
}

describe("the service: installed and started on every box, loopback only", () => {
  it("is a system unit under the clawbox user, like the web server, and is enabled at boot", () => {
    expect(UNIT).toMatch(/^User=clawbox$/m);
    expect(UNIT).toMatch(/^Group=clawbox$/m);
    expect(UNIT).toMatch(/^WorkingDirectory=\/home\/clawbox\/clawbox\/vault$/m);
    expect(UNIT).toMatch(/^ExecStart=\/home\/clawbox\/clawbox\/scripts\/start-vault\.sh$/m);
    expect(UNIT).toMatch(/^\[Install\]\nWantedBy=multi-user\.target$/m);
    expect(UNIT).toMatch(/^Restart=on-failure$/m);
    // Everything it writes is the owner's passwords or the keys to them.
    expect(UNIT).toMatch(/^UMask=0077$/m);
    expect(UNIT).toMatch(/^NoNewPrivileges=yes$/m);
    // gpg-agent stops with the unit.
    expect(UNIT).toMatch(/^KillMode=control-group$/m);
  });

  it("takes nothing from the project's .env, which everything running as clawbox can edit", () => {
    const directives = UNIT.split("\n").filter((line) => !line.startsWith("#"));
    expect(directives.filter((line) => line.startsWith("EnvironmentFile"))).toEqual([]);
    // Cards stay off: nothing here switches them on, and nothing on the box sets the flag.
    expect(directives.join("\n")).not.toContain("CLAWBOX_VAULT_CARDS");
    expect(INSTALL_SH).not.toContain("CLAWBOX_VAULT_CARDS");
    expect(INSTALL_X64).not.toContain("CLAWBOX_VAULT_CARDS");
    expect(read("scripts", "gateway-pre-start.sh")).not.toContain("CLAWBOX_VAULT_CARDS");
    expect(read("scripts", "register-mcp.sh")).not.toContain("CLAWBOX_VAULT_CARDS");
  });

  it("is pinned to 127.0.0.1 by its start script, and the service refuses anything else by itself", () => {
    expect(START).toMatch(/^export CLAWBOX_VAULT_HOST=127\.0\.0\.1$/m);
    expect(START).toMatch(/exec "\$BUN" run src\/server\/main\.ts/);
    const config = read("vault", "src", "server", "config.ts");
    expect(config).toContain('const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);');
    expect(config).toMatch(/if \(!LOOPBACK\.has\(host\)\) \{\s*throw new Error/);
    expect(read("vault", "src", "server", "main.ts")).toMatch(/hostname: config\.host,/);
  });

  it("is registered as an ACTIVE unit of every edition, so a fresh install and an update both install, enable and start it", () => {
    expect(shellArray(INSTALL_SH, "EXPECTED_ACTIVE_SERVICES")).toContain("clawbox-vault.service");
    // Every edition: never among the units only some SKUs run.
    expect(shellArray(INSTALL_SH, "EDITION_SCOPED_UNITS")).not.toContain("clawbox-vault.service");
    expect(shellArray(INSTALL_SH, "EXPECTED_INSTALLED_SERVICES")).not.toContain("clawbox-vault.service");
    // Fresh install: started with the other always-on units.
    expect(shellFunction(INSTALL_SH, "step_start_services")).toMatch(/local -a svcs=\(clawbox-ap clawbox-setup clawbox-performance clawbox-vault\)/);
    // Update: the rebuild step installs and enables the unit before it restarts
    // every enabled clawbox-* unit, which is what starts a unit new to the box.
    const rebuild = shellFunction(INSTALL_SH, "step_rebuild_reboot");
    expect(rebuild.indexOf("step_systemd_services")).toBeGreaterThan(-1);
    expect(rebuild.indexOf("restart_services_after_update")).toBeGreaterThan(rebuild.indexOf("step_systemd_services"));
    const restart = shellFunction(INSTALL_SH, "restart_services_after_update");
    expect(restart).toContain("systemctl list-unit-files --type=service --state=enabled --no-legend 'clawbox-*'");
    expect(restart).toMatch(/systemctl start --no-block "\$\{start\[@\]\}"/);
    // The unit is not skipped by the enable loop the way the on-demand ones are.
    const enable = shellFunction(INSTALL_SH, "step_systemd_services");
    expect(enable).not.toMatch(/"clawbox-vault\.service" \]\] && continue/);
  });

  it("gets its packages on a fresh install and on every update, without failing either over them", () => {
    const apt = shellFunction(INSTALL_SH, "step_apt_update");
    expect(apt).toMatch(/^  ensure_vault_packages \|\| true$/m);
    // git is in the base line, which is fatal by design.
    expect(apt).toMatch(/apt-get install -y -qq git /);
    const packages = shellFunction(INSTALL_SH, "ensure_vault_packages");
    expect(packages).toMatch(/for pkg in pass gnupg; do/);
    expect(packages).toMatch(/apt-get install -y -qq \$missing \|\| true/);
    // A box that reached post_update without the updater's apt and rebuild
    // steps (a hand-run force-update) still gets the packages and a running unit.
    const post = shellFunction(INSTALL_SH, "step_post_update");
    expect(post.indexOf("optional_step vault_service ensure_vault_service")).toBeGreaterThan(post.indexOf("optional_step systemd_services step_systemd_services"));
    const ensure = shellFunction(INSTALL_SH, "ensure_vault_service");
    expect(ensure).toContain("ensure_vault_packages || rc=1");
    expect(ensure).toContain("systemctl start --no-block clawbox-vault.service");
    // …and a running vault left on the previous build by that road is restarted onto this one.
    expect(ensure).toMatch(/elif vault_runs_previous_build; then\s+echo[^\n]*\n[^\n]*MainPID[^\n]*\n\s+if ! systemctl restart --no-block clawbox-vault\.service/);
    // The one runtime package comes with the app's own install.
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.tldts).toBeTruthy();
    expect(fs.existsSync(path.join(ROOT, "vault", "node_modules"))).toBe(false);
  });

  it("restarts a running vault after an update only when it still runs the previous build", () => {
    // The real function, a real process standing in for the vault, and a
    // systemctl that answers its MainPID.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-stale-")));
    const project = path.join(tmp, "clawbox");
    const vaultDir = path.join(project, "vault");
    const files = ["vault/package.json", "vault/src/main.ts", "vault/extension/manifest.json", "scripts/start-vault.sh"];
    const write = () => {
      for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(project, f)), { recursive: true });
        fs.writeFileSync(path.join(project, f), "x");
      }
      const past = new Date(Date.now() - 120_000);
      for (const f of files) fs.utimesSync(path.join(project, f), past, past);
    };
    write();
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "systemctl"), '#!/bin/sh\necho "$FAKE_PID"\n', { mode: 0o755 });
    const fn = `${shellFunction(INSTALL_SH, "vault_runs_previous_build")}\n}\n`;
    const ask = (pid: number) =>
      spawnSync("bash", ["-c", `${fn}PROJECT_DIR="$1"; if vault_runs_previous_build; then echo previous; else echo current; fi`, "_", project], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_PID: String(pid) },
        encoding: "utf8",
      }).stdout.trim();
    const child = spawn("sleep", ["60"], { cwd: vaultDir, stdio: "ignore" });
    try {
      expect(child.pid).toBeGreaterThan(0);
      const pid = child.pid as number;
      expect(ask(pid)).toBe("current");
      expect(ask(0)).toBe("current");
      // A source changed after it started (an update checked out a new commit).
      const later = new Date(Date.now() + 10_000);
      fs.utimesSync(path.join(vaultDir, "src", "main.ts"), later, later);
      expect(ask(pid)).toBe("previous");
      write();
      expect(ask(pid)).toBe("current");
      // The checkout replaced vault/ under it: its cwd now reads "(deleted)".
      fs.rmSync(vaultDir, { recursive: true, force: true });
      write();
      expect(ask(pid)).toBe("previous");
    } finally {
      child.kill();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("says so when a vault it started or restarted does not stay up, and tries no apt it cannot have", () => {
    // The real functions and a systemctl stand-in. Before the --no-block call
    // the unit is FAKE_BEFORE on pid 1111; after it, each is-active probe takes
    // the next "state:pid" of FAKE_AFTER (the last one repeats) and `show`
    // answers the pid of the probe last taken.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-up-")));
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        'tok() { n=$(cat "$FAKE_DIR/n" 2>/dev/null || echo 1); set -- $FAKE_AFTER; [ "$n" -le $# ] || n=$#; eval "echo \\${$n}"; }',
        'case "$1" in',
        "  is-enabled) echo enabled ;;",
        "  is-active)",
        '    if [ ! -f "$FAKE_DIR/called" ]; then [ "$FAKE_BEFORE" = up ]; exit; fi',
        '    n=$(( $(cat "$FAKE_DIR/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_DIR/n"',
        '    [ "$(tok | cut -d: -f1)" = up ] ;;',
        '  show) if [ -f "$FAKE_DIR/called" ]; then tok | cut -d: -f2; else echo 1111; fi ;;',
        '  start|restart) echo "$1" >> "$FAKE_DIR/called" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(bin, "apt-get"), '#!/bin/sh\necho "$*" >> "$FAKE_DIR/apt"\n', { mode: 0o755 });
    const fns = ["ensure_vault_service", "vault_came_up", "ensure_vault_packages"].map((n) => `${shellFunction(INSTALL_SH, n)}\n}\n`).join("");
    const run = (stubs: string, before: "up" | "down", after: string) => {
      const dir = fs.mkdtempSync(path.join(tmp, "case-"));
      // ensure_vault_service is the script's last command: its status is the exit status.
      const r = spawnSync("bash", ["-c", `${fns}${stubs}\nensure_vault_service`], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_DIR: dir, FAKE_BEFORE: before, FAKE_AFTER: after, VAULT_UP_WAIT_S: "2", VAULT_UP_STEADY_S: "0" },
        encoding: "utf8",
      });
      expect(r.error).toBeUndefined();
      expect(r.signal).toBeNull();
      const calls = fs.existsSync(path.join(dir, "called")) ? fs.readFileSync(path.join(dir, "called"), "utf8").trim() : "";
      return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, apt: fs.existsSync(path.join(dir, "apt")) };
    };
    const installed = "dpkg_installed() { return 0; }\nvault_runs_previous_build() { return 0; }";
    const flapping = Array.from({ length: 12 }, (_, i) => `up:${i % 2 ? 3333 : 2222}`).join(" ");
    try {
      // A start that comes up and stays on its pid: no warning.
      let r = run(installed, "down", "up:2222");
      expect(r.calls).toBe("start");
      expect(r.status).toBe(0);
      expect(r.out).not.toContain("Warning");
      // A start whose launcher never comes up: the update says so, and the step is not "ok".
      r = run(installed, "down", "down:0");
      expect(r.status).toBe(1);
      expect(r.out).toContain("Warning: clawbox-vault.service did not stay up after its start");
      // Up on its first probe, gone on the next (the steady check is what sees it).
      r = run(installed, "down", "up:2222 down:0");
      expect(r.status).toBe(1);
      expect(r.out).toContain("did not stay up after its start");
      // Active all along, but on another pid at every look: a launcher systemd keeps restarting.
      r = run(installed, "down", flapping);
      expect(r.status).toBe(1);
      expect(r.out).toContain("did not stay up after its start");
      // A restart onto this build: up only counts on a NEW process.
      r = run(installed, "up", "up:2222");
      expect(r.calls).toBe("restart");
      expect(r.status).toBe(0);
      r = run(installed, "up", "up:1111");
      expect(r.status).toBe(1);
      expect(r.out).toContain("Warning: clawbox-vault.service did not stay up after its restart");
      // The packages are missing and apt cannot be had: no apt-get run, a warning, status 1.
      r = run("dpkg_installed() { return 1; }\nwait_for_apt() { return 1; }\nvault_runs_previous_build() { return 1; }", "up", "up:1111");
      expect(r.apt).toBe(false);
      expect(r.status).toBe(1);
      expect(r.out).toContain("Warning: ClawBox Vault packages not installed: pass gnupg (apt is busy");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is installed by the PC installer too, under that install's own user and checkout", () => {
    const fn = shellFunction(INSTALL_X64, "install_vault_service");
    expect(fn).toContain("User=$CLAWBOX_USER");
    expect(fn).toContain("WorkingDirectory=$PROJECT_DIR/vault");
    expect(fn).toContain("ExecStart=$PROJECT_DIR/scripts/start-vault.sh");
    expect(fn).toContain("systemctl enable clawbox-vault.service");
    expect(fn).not.toContain("EnvironmentFile");
    // A fresh install and, because that is the root step every PC update runs, every update.
    expect(shellFunction(INSTALL_X64, "step_systemd_services")).toContain("install_vault_service ||");
    const apt = shellFunction(INSTALL_X64, "step_apt_update");
    expect(apt).toContain("install_vault_service ||");
    expect(apt).toMatch(/apt-get install -y -qq pass gnupg/);
  });

  it("ships as source: nothing built is committed, and the service builds its extension itself", () => {
    const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "vault"], { encoding: "utf8", maxBuffer: 16 << 20 }).split("\0").filter(Boolean);
    expect(tracked.length).toBeGreaterThan(40);
    expect(tracked.filter((f) => /(^|\/)(build|dist|node_modules|extension-build)\//.test(f))).toEqual([]);
    expect(tracked.filter((f) => /\.(gpg|key|pem|jsonl)$/.test(f) || /(^|\/)(state\.json|agent-token|pairing\.json)$/.test(f))).toEqual([]);
    expect(read("vault", ".gitignore")).toContain("extension-build/");
    expect(read("vault", "src", "server", "main.ts")).toMatch(/void buildExtension\(\{/);
    // The root project neither type-checks nor lints the vault as part of the web app.
    const tsconfig = JSON.parse(read("tsconfig.json")) as { exclude: string[] };
    expect(tsconfig.exclude).toContain("vault");
  });
});

describe("the vault's folder is one of the box's secret folders", () => {
  it("is refused to the Files app, the coding agent's file tools and the agent's shell", () => {
    expect(PROTECTED_HOME_DIRS).toContain(".clawbox-vault");
    expect(read("src", "lib", "coding-permission-rules.ts")).toMatch(/"\.openclaw", "\.hermes", "\.codex", "\.clawkeep", "\.clawbox-vault",/);
    for (const command of [
      "cat ~/.clawbox-vault/agent-token",
      "ls -la /home/clawbox/.clawbox-vault/store",
      "GNUPGHOME=$HOME/.clawbox-vault/gnupg PASSWORD_STORE_DIR=$HOME/.clawbox-vault/store pass show bank.example.com/me",
      "tar czf /tmp/x.tgz .clawbox-vault",
    ]) {
      expect(SECRET_NAME_RE.test(command), command).toBe(true);
    }
    // A folder that only looks alike is nobody's secret.
    expect(SECRET_NAME_RE.test("ls ~/clawbox-vault-notes")).toBe(false);
  });

  it("is where the service keeps everything, and nowhere else", () => {
    const config = read("vault", "src", "server", "config.ts");
    expect(config).toContain('join(env.HOME || homedir(), ".clawbox-vault")');
    for (const part of ['join(homeDir, "store")', 'join(homeDir, "gnupg")', 'join(homeDir, "extension")']) expect(config).toContain(part);
    // Never the user's own keyring or pass store.
    expect(config).not.toContain(".password-store");
    expect(config).not.toMatch(/["']\.gnupg["']/);
  });
});

describe("the desktop app is the owner's alone", () => {
  it("is on the desktop, with a window on both surfaces and a glyph", () => {
    const app = apps.find((a) => a.id === VAULT_DESKTOP_APP_ID);
    expect(app).toMatchObject({ id: "vault", name: "ClawBox Vault", type: "vault" });
    expect(APP_GLYPHS.vault).toBe("key");
    expect(read("src", "app", "page.tsx")).toMatch(/case "vault":\s*return <VaultApp \/>;/);
    expect(read("src", "app", "app", "[id]", "page.tsx")).toMatch(/case "vault":\s*return <VaultApp \/>;/);
    expect(OWNER_ONLY_APP_IDS).toContain("vault");
    expect(VAULT_APP_TREE).toBe(VAULT_PROXY_PREFIX);
  });

  it("frames the vault's page same-origin and unsandboxed, so every request carries the owner's cookie", () => {
    const component = read("src", "components", "VaultApp.tsx");
    expect(component).toContain("src={VAULT_FRAME_SRC}");
    expect(component).not.toMatch(/sandbox=/);
    expect(component).not.toContain("WebappFrame");
    // Its own route, not the generic app proxy that lets cookie-less requests through.
    const route = read("src", "app", "apps", "clawbox-vault", "[[...path]]", "route.ts");
    expect(route).toContain("sessionIdentity(request)");
    expect(route).toContain("if (!who.isOwner) return ownerOnlyResponse();");
    expect(route).not.toContain("resolveAppProxyTarget");
    expect(route).not.toContain("CLAWBOX_TEST_MODE");
  });

  it("reaches the desktop app's half of the service and nothing else", () => {
    for (const [path_, upstream] of [
      ["/apps/clawbox-vault", "/"],
      ["/apps/clawbox-vault/", "/"],
      ["/apps/clawbox-vault/index.html", "/index.html"],
      ["/apps/clawbox-vault/app.js", "/app.js"],
      ["/apps/clawbox-vault/app.css", "/app.css"],
      ["/apps/clawbox-vault/favicon.png", "/favicon.png"],
      ["/apps/clawbox-vault/api/health", "/api/health"],
      ["/apps/clawbox-vault/api/ui/status", "/api/ui/status"],
      ["/apps/clawbox-vault/api/ui/extension-lock", "/api/ui/extension-lock"],
      ["/apps/clawbox-vault/api/ui/pairing/auto", "/api/ui/pairing/auto"],
    ] as const) {
      expect(vaultUpstreamPath(path_), path_).toBe(upstream);
    }
    for (const path_ of [
      "/apps/clawbox-vault/api/agent/entries",
      "/apps/clawbox-vault/api/agent/fill",
      "/apps/clawbox-vault/api/ext/secret",
      "/apps/clawbox-vault/api/ext/commands",
      "/apps/clawbox-vault/api/pair",
      "/apps/clawbox-vault/api/pair/auto",
      "/apps/clawbox-vault/api/ui",
      "/apps/clawbox-vault/api/ui/",
      "/apps/clawbox-vault/api/ui/Entries",
      "/apps/clawbox-vault/api/ui/a/b/c",
      "/apps/clawbox-vault/api/ui/%65ntries",
      "/apps/clawbox-vault/api/ui/..",
      "/apps/clawbox-vault/../clawbox-vault/api/agent/entries",
      "/apps/clawbox-vault/pairing.json",
      "/apps/clawbox-vault/app.js.map",
      "/apps/clawbox-vault-notes/",
      "/apps/other/",
      "/",
    ]) {
      expect(vaultUpstreamPath(path_), path_).toBeNull();
    }
    // Every route of the service's UI API fits the pattern, so none is cut off by it.
    const app = read("vault", "src", "server", "app.ts");
    const uiRoutes = [...app.matchAll(/path === "(\/api\/ui\/[^"]+)"/g)].map((m) => m[1]);
    expect(uiRoutes.length).toBeGreaterThan(12);
    for (const r of uiRoutes) expect(vaultUpstreamPath(`/apps/clawbox-vault${r}`), r).toBe(r);
  });

  it("forwards the vault's bearer and nothing of ClawBox's, and frames the answer for this origin only", () => {
    const sent = vaultRequestHeaders(new Headers({ authorization: "Bearer v", "content-type": "application/json", cookie: "clawbox_session=x", origin: "http://clawbox.local", host: "clawbox.local", "x-forwarded-for": "198.51.100.7" }));
    expect([...sent.keys()].sort()).toEqual(["authorization", "content-type"]);
    const back = vaultResponseHeaders(new Headers({ "content-type": "text/html", "content-security-policy": "default-src 'none'", "set-cookie": "a=b", "cross-origin-resource-policy": "cross-origin" }));
    expect(back.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'self'");
    expect(back.get("set-cookie")).toBeNull();
    expect(back.get("cross-origin-resource-policy")).toBeNull();
    expect(back.get("cache-control")).toBe("no-store");
    expect(vaultResponseHeaders(new Headers({ "content-security-policy": "default-src 'none'; frame-ancestors 'none'" })).get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(vaultServicePort({})).toBe(VAULT_DEFAULT_PORT);
    expect(VAULT_DEFAULT_PORT).toBe(4796);
    expect(vaultServicePort({ CLAWBOX_VAULT_PORT: "4999" })).toBe(4999);
    for (const bad of ["0", "70000", "abc", "-1", "4796.5"]) expect(vaultServicePort({ CLAWBOX_VAULT_PORT: bad }), bad).toBe(4796);
  });
});

describe("the extension is preloaded in the box's own browser", () => {
  let home = "";
  const LIB = path.join(ROOT, "scripts", "lib", "vault-extension.sh");

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "clawbox-vault-ext-"));
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  const flags = (env: Record<string, string> = {}) =>
    execFileSync("bash", ["-c", 'set -euo pipefail; source "$1"; vault_extension_flags', "_", LIB], {
      encoding: "utf8",
      env: testEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env }),
    })
      .split("\n")
      .filter(Boolean);

  function build(dir: string, files: string[]): void {
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), "x");
    }
  }
  const COMPLETE = ["manifest.json", "popup.html", "build/background.js", "build/content.js", "build/popup.js"];

  it("loads nothing on a box whose vault has never built one, or is halfway through", () => {
    expect(flags()).toEqual([]);
    const dir = path.join(home, ".clawbox-vault", "extension");
    for (const missing of COMPLETE) {
      fs.rmSync(dir, { recursive: true, force: true });
      build(dir, COMPLETE.filter((f) => f !== missing));
      expect(flags(), `without ${missing}`).toEqual([]);
    }
  });

  it("loads the folder the service built, from its fixed place, on every start", () => {
    const dir = path.join(home, ".clawbox-vault", "extension");
    fs.rmSync(dir, { recursive: true, force: true });
    build(dir, COMPLETE);
    expect(flags()).toEqual([`--load-extension=${dir}`, "--disable-features=DisableLoadExtensionCommandLineSwitch"]);
    // The same place the service writes to.
    expect(read("vault", "src", "server", "config.ts")).toContain('extensionDir: env.CLAWBOX_VAULT_EXTENSION_DIR || join(homeDir, "extension")');
    const other = path.join(home, "elsewhere");
    build(other, COMPLETE);
    expect(flags({ CLAWBOX_VAULT_EXTENSION_DIR: other })[0]).toBe(`--load-extension=${other}`);
    expect(flags({ CLAWBOX_VAULT_HOME: path.join(home, "no-vault-here") })).toEqual([]);
  });

  /** What vault_extension_flags printed after the last waitMs (its first line). */
  let lastFlag = "";

  /** Run vault_extension_wait with a stub systemctl; returns how long it took, in ms. */
  function waitMs(opts: { state: string; enabled: boolean; upForS?: number; limit?: number; home: string; appearAfterS?: number }): number {
    const bin = path.join(home, `bin-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(bin, { recursive: true });
    const uptimeUs = Math.floor(Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1_000_000);
    const entered = uptimeUs - (opts.upForS ?? 0) * 1_000_000;
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *ActiveState*) echo "${opts.state}" ;;`,
        `  *ActiveEnterTimestampMonotonic*) echo "${entered}" ;;`,
        `  *is-enabled*) exit ${opts.enabled ? 0 : 1} ;;`,
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const dir = path.join(opts.home, ".clawbox-vault", "extension");
    const started = Date.now();
    lastFlag = execFileSync(
      "bash",
      [
        "-c",
        // The folder is finished by a background writer, as the vault's first build would. Its
        // streams go to /dev/null, so it never holds the output pipe this call reads open.
        'set -euo pipefail; source "$1"; if [ "$3" != none ]; then (sleep "$3"; mkdir -p "$4/build"; for f in manifest.json popup.html build/background.js build/content.js build/popup.js; do echo x > "$4/$f"; done) </dev/null >/dev/null 2>&1 & fi; vault_extension_wait "$2"; vault_extension_flags | head -n 1',
        "_",
        LIB,
        String(opts.limit ?? 5),
        opts.appearAfterS === undefined ? "none" : String(opts.appearAfterS),
        dir,
      ],
      { encoding: "utf8", env: testEnv({ PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: opts.home }) },
    ).trim();
    return Date.now() - started;
  }

  it("waits for a vault that is just starting to build the folder, and not for one that will not", () => {
    const fresh = (name: string) => fs.mkdtempSync(path.join(home, `${name}-`));
    // Starting right now (an update, a boot): the browser gets the extension of this very start.
    const coming = fresh("coming");
    const took = waitMs({ state: "activating", enabled: true, home: coming, appearAfterS: 1 });
    expect(took).toBeGreaterThanOrEqual(900);
    expect(took).toBeLessThan(4500);
    expect(fs.existsSync(path.join(coming, ".clawbox-vault", "extension", "manifest.json"))).toBe(true);
    expect(lastFlag).toBe(`--load-extension=${path.join(coming, ".clawbox-vault", "extension")}`);
    // Enabled and about to be started, or up for a few seconds: the same.
    expect(waitMs({ state: "inactive", enabled: true, home: fresh("queued"), appearAfterS: 1 })).toBeGreaterThanOrEqual(900);
    expect(waitMs({ state: "active", enabled: true, upForS: 3, home: fresh("young"), appearAfterS: 1 })).toBeGreaterThanOrEqual(900);
    // No vault on this box, or one that has been up for minutes with no folder: no wait at all.
    expect(waitMs({ state: "inactive", enabled: false, home: fresh("none") })).toBeLessThan(900);
    expect(waitMs({ state: "active", enabled: true, upForS: 600, home: fresh("old") })).toBeLessThan(900);
    // And it gives up at the limit rather than holding the browser back.
    const gaveUp = waitMs({ state: "activating", enabled: true, home: fresh("never"), limit: 2 });
    expect(lastFlag).toBe("");
    expect(gaveUp).toBeGreaterThanOrEqual(1900);
    expect(gaveUp).toBeLessThan(5000);
  });

  it("is passed to the browser by the launcher, which no other flag of that kind fights", () => {
    expect(LAUNCH).toContain('source "$(dirname "${BASH_SOURCE[0]}")/lib/vault-extension.sh"');
    expect(LAUNCH).toContain("mapfile -t EXTENSION_FLAGS < <(vault_extension_flags)");
    expect(LAUNCH.indexOf("vault_extension_wait ")).toBeGreaterThan(-1);
    expect(LAUNCH.indexOf("vault_extension_wait ")).toBeLessThan(LAUNCH.indexOf("mapfile -t EXTENSION_FLAGS"));
    const exec = LAUNCH.slice(LAUNCH.lastIndexOf("exec env DISPLAY="));
    expect(exec).toContain('"${EXTENSION_FLAGS[@]}" \\');
    // Chromium keeps only the LAST --disable-features: a second one would undo this one.
    expect(LAUNCH.match(/--disable-features/g) ?? []).toEqual([]);
    expect(read("scripts", "lib", "browser-clean-start.sh")).not.toContain("--disable-features");
    expect(LAUNCH).not.toContain("--disable-extensions");
  });

  it("pairs by itself with a secret web pages cannot read, and only once the owner chose a PIN", () => {
    const manifest = JSON.parse(read("vault", "extension", "manifest.json")) as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    const background = read("vault", "src", "extension", "background.ts");
    expect(background).toContain('chrome.runtime.getURL("pairing.json")');
    expect(background).toContain("/api/pair/auto");
    const auth = read("vault", "src", "server", "auth.ts");
    expect(auth).toMatch(/if \(!this\.state\.pin\) return \{ ok: false, reason: "not_set_up" \};/);
    expect(auth).toMatch(/if \(!this\.autoPairEnabled\(\)\) return \{ ok: false, reason: "off" \};/);
  });
});
