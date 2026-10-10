/**
 * The x64 root dispatcher (scripts/x64-migration/clawbox-x64-root-step.sh),
 * RUN — not grepped. It is root's side of every web-started step on a PC
 * installed with install-x64.sh, so what matters is what it does with
 * owner-writable input, and only running it shows that.
 *
 * A sandbox copy: the root check, the root-owned config path and the system
 * binaries it calls are swapped for stand-ins, each swap asserted to have
 * matched exactly once so the copy cannot silently drift from the real file.
 * `runuser` is dropped — the test already IS an unprivileged account, which is
 * the point of reading the timezone request through it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SOURCE = fs.readFileSync(
  path.resolve(process.cwd(), "scripts/x64-migration/clawbox-x64-root-step.sh"),
  "utf8",
);

let sandbox: string;
let project: string;
let state: string;
let dispatcher: string;

function swap(text: string, from: string, to: string): string {
  const count = text.split(from).length - 1;
  if (count < 1) throw new Error(`dispatcher no longer contains: ${from}`);
  return text.split(from).join(to);
}

function stub(name: string, body: string): string {
  const file = path.join(sandbox, "bin", name);
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return file;
}

function run(step: string): { status: number | null; out: string } {
  const r = spawnSync("/bin/bash", [dispatcher, step], {
    encoding: "utf8",
    timeout: 20_000,
    // Nothing from this shell: the real unit starts with systemd's empty slate.
    env: { PATH: "/usr/bin:/bin", STUB_STATE: state } as unknown as NodeJS.ProcessEnv,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const setCalls = () => {
  const file = path.join(state, "set-calls");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
};
const writeRequest = (text: string) => fs.writeFileSync(path.join(project, "data", "timezone.env"), text);

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-x64-dispatcher-"));
  project = path.join(sandbox, "clawbox");
  state = path.join(sandbox, "state");
  fs.mkdirSync(path.join(project, "data"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, "bin"));
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "current"), "Etc/UTC\n");

  const timedatectl = stub("timedatectl", `
case "$1" in
  list-timezones) printf '%s\\n' Etc/UTC UTC Europe/Sofia America/New_York ;;
  show) cat "$STUB_STATE/current" ;;
  set-timezone) echo "$2" > "$STUB_STATE/current"; echo "$2" >> "$STUB_STATE/set-calls" ;;
esac`);
  const systemctl = stub("systemctl", `echo "$*" >> "$STUB_STATE/systemctl-calls"`);
  const installer = stub("installer", `echo "installer user=$CLAWBOX_USER dir=$CLAWBOX_DIR args=$*"`);
  const unitFile = path.join(sandbox, "clawbox-gateway.service");
  const conf = path.join(sandbox, "x64.env");
  fs.writeFileSync(conf, `CLAWBOX_USER=owner\nPROJECT_DIR=${project}\nROOT_INSTALLER=${installer}\n`);

  let text = SOURCE;
  text = swap(text, '[ "$(id -u)" -eq 0 ]', "true");
  text = swap(text, 'ROOT_CONF="/etc/clawbox/x64.env"', `ROOT_CONF="${conf}"`);
  text = swap(text, '/usr/sbin/runuser -u "$CLAWBOX_USER" -- ', "");
  text = swap(text, "/usr/bin/timedatectl", timedatectl);
  text = swap(text, "/usr/bin/systemctl", systemctl);
  text = swap(text, "/etc/systemd/system/clawbox-gateway.service", unitFile);
  dispatcher = path.join(sandbox, "clawbox-root-step.sh");
  fs.writeFileSync(dispatcher, text, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("set_timezone on an install-x64.sh PC", () => {
  it("applies the zone the owner asked for", () => {
    writeRequest("TIMEZONE=Europe/Sofia\n");
    const r = run("set_timezone");
    expect(r.status).toBe(0);
    expect(r.out).toContain("system timezone set to Europe/Sofia");
    expect(setCalls()).toEqual(["Europe/Sofia"]);
  });

  it("is a no-op when nothing is recorded, or the clock is already there", () => {
    expect(run("set_timezone")).toMatchObject({ status: 0 });
    writeRequest("TIMEZONE=Etc/UTC\n");
    const r = run("set_timezone");
    expect(r.status).toBe(0);
    expect(r.out).toContain("system timezone already Etc/UTC");
    expect(setCalls()).toEqual([]);
  });

  it.each([
    ["a zone this PC does not carry", "TIMEZONE=Mars/Olympus_Mons\n", "not one this PC carries"],
    ["a path", "TIMEZONE=../../../etc/shadow\n", "not a zone name"],
    ["an option", "TIMEZONE=--help\n", "not a zone name"],
    ["shell syntax", "TIMEZONE=$(touch /tmp/x)\n", "not a zone name"],
  ])("refuses %s and leaves the clock alone", (_what, request, reason) => {
    writeRequest(request);
    const r = run("set_timezone");
    expect(r.status).toBe(1);
    expect(r.out).toContain(reason);
    expect(setCalls()).toEqual([]);
  });

  it("will not follow a symlink planted where the request goes", () => {
    const secret = path.join(sandbox, "secret");
    fs.writeFileSync(secret, "TIMEZONE=Europe/Sofia\n");
    fs.symlinkSync(secret, path.join(project, "data", "timezone.env"));
    const r = run("set_timezone");
    expect(r.status).toBe(1);
    expect(r.out).toContain("is not the plain file the timezone route writes");
    expect(setCalls()).toEqual([]);
  });

  it("does not hang on a FIFO planted there", () => {
    const fifo = spawnSync("mkfifo", [path.join(project, "data", "timezone.env")]);
    expect(fifo.status).toBe(0);
    const r = run("set_timezone");
    expect(r.status).toBe(1);
    expect(r.out).toContain("is not the plain file the timezone route writes");
  });
});

describe("the update's own root steps", () => {
  it("post_update applies the zone, and only warns when it cannot", () => {
    writeRequest("TIMEZONE=America/New_York\n");
    expect(run("post_update")).toMatchObject({ status: 0 });
    expect(setCalls()).toEqual(["America/New_York"]);

    writeRequest("TIMEZONE=Mars/Olympus_Mons\n");
    const r = run("post_update");
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[x64-timezone\]: /m);
  });

  it("gateway_setup checks the installed unit instead of rewriting it", () => {
    const missing = run("gateway_setup");
    expect(missing.status).toBe(1);
    expect(missing.out).toContain("clawbox-gateway.service is not installed");

    fs.writeFileSync(path.join(sandbox, "clawbox-gateway.service"), "[Service]\n");
    const r = run("gateway_setup");
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(state, "systemctl-calls"), "utf8").trim().split("\n")).toEqual([
      "daemon-reload",
      "reset-failed clawbox-gateway.service",
    ]);
    expect(fs.readFileSync(path.join(sandbox, "clawbox-gateway.service"), "utf8")).toBe("[Service]\n");
  });

  it("hands a forwarded installer step the user and checkout recorded at install time", () => {
    // systemd gives the unit no logname and no SUDO_USER; before this the
    // installer stopped at "could not resolve an unprivileged install user".
    const r = run("apt_update");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`installer user=owner dir=${project} args=--step apt_update`);
  });

  it.each(["bootstrap_updater", "rebuild_reboot"])("still refuses %s: the updater runs it as the owner", (step) => {
    const r = run(step);
    expect(r.status).toBe(64);
    expect(r.out).toContain(`clawbox-root-step: step '${step}' has no implementation on the x64 install`);
  });

  it("refuses to hand root's installer an account it should not run as", () => {
    // ROOT_INSTALLER named: the default path exists on a real x64 PC and not on
    // CI, and the case is about the user, not the copy.
    fs.writeFileSync(
      path.join(sandbox, "x64.env"),
      `CLAWBOX_USER=root\nPROJECT_DIR=${project}\nROOT_INSTALLER=${path.join(sandbox, "bin", "installer")}\n`,
    );
    const r = run("apt_update");
    expect(r.status).toBe(78);
    expect(r.out).not.toContain("installer user=");
  });
});
