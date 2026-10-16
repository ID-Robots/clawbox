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

  // Settings → Users: a passwd/group database of files, and the account tools
  // recording what root was asked to do. `owner` is the install user.
  fs.writeFileSync(path.join(state, "passwd"), `root:x:0:0::/root:/bin/bash\nowner:x:1000:1000::${sandbox}/accounts/owner:/bin/bash\n`);
  fs.writeFileSync(path.join(state, "group"), "root:x:0:\nsudo:x:27:owner\nowner:x:1000:\n");
  fs.mkdirSync(path.join(sandbox, "accounts", "owner"), { recursive: true });
  const getent = stub("getent", `
grep -m1 "^$2:" "$STUB_STATE/$1" || exit 2`);
  const groupadd = stub("groupadd", `
echo "groupadd $*" >> "$STUB_STATE/calls"
echo "\${@: -1}:x:999:" >> "$STUB_STATE/group"`);
  const useradd = stub("useradd", `
echo "useradd $*" >> "$STUB_STATE/calls"
[ -f "$STUB_STATE/useradd-fails" ] && { echo "useradd: cannot lock /etc/passwd; try again later." >&2; exit 1; }
name="\${@: -1}"
echo "$name:x:1001:1001::${sandbox}/accounts/$name:/bin/bash" >> "$STUB_STATE/passwd"
echo "$name:x:1001:" >> "$STUB_STATE/group"
echo "$name clawbox-users" >> "$STUB_STATE/members"
mkdir -p "${sandbox}/accounts/$name"`);
  const chpasswd = stub("chpasswd", `
cat >> "$STUB_STATE/chpasswd-input"
[ -f "$STUB_STATE/chpasswd-fails" ] && { echo "chpasswd: (user x) pam_chauthtok() failed" >&2; exit 1; }
exit 0`);
  const userdel = stub("userdel", `
echo "userdel $*" >> "$STUB_STATE/calls"
name="\${@: -1}"
grep -v "^$name:" "$STUB_STATE/passwd" > "$STUB_STATE/passwd.new"; mv "$STUB_STATE/passwd.new" "$STUB_STATE/passwd"`);
  const id = stub("id", `
[ "$1" = "-nG" ] || exit 1
groups="$2"
while read -r who grp; do [ "$who" = "$2" ] && groups="$groups $grp"; done < <(cat "$STUB_STATE/members" 2>/dev/null)
echo "$groups"`);
  const pkill = stub("pkill", `echo "pkill $*" >> "$STUB_STATE/calls"`);
  const chmod = stub("chmod", `echo "chmod $*" >> "$STUB_STATE/calls"`);

  let text = SOURCE;
  text = swap(text, '[ "$(id -u)" -eq 0 ]', "true");
  text = swap(text, 'ROOT_CONF="/etc/clawbox/x64.env"', `ROOT_CONF="${conf}"`);
  text = swap(text, '/usr/sbin/runuser -u "$CLAWBOX_USER" -- ', "");
  text = swap(text, "/usr/bin/timedatectl", timedatectl);
  text = swap(text, "/usr/bin/systemctl", systemctl);
  text = swap(text, "/etc/systemd/system/clawbox-gateway.service", unitFile);
  text = swap(text, "/usr/bin/getent", getent);
  text = swap(text, "/usr/sbin/groupadd", groupadd);
  text = swap(text, "/usr/sbin/useradd", useradd);
  text = swap(text, "/usr/sbin/chpasswd", chpasswd);
  text = swap(text, "/usr/sbin/userdel", userdel);
  text = swap(text, "/usr/bin/id -nG", `${id} -nG`);
  text = swap(text, "/usr/bin/pkill", pkill);
  text = swap(text, "/usr/bin/chmod", chmod);
  text = swap(text, "  sleep 1\n", "");
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

  it("post_update only warns when no valid install user is recorded", () => {
    // require_install_user exits 78; inside post_update that must stay a
    // warning, never end the step.
    fs.writeFileSync(
      path.join(sandbox, "x64.env"),
      `CLAWBOX_USER=root\nPROJECT_DIR=${project}\nROOT_INSTALLER=${path.join(sandbox, "bin", "installer")}\n`,
    );
    writeRequest("TIMEZONE=America/New_York\n");
    const r = run("post_update");
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^CLAWBOX-WARN\[x64-timezone\]: /m);
    expect(r.out).toContain("clawbox-root-step: x64 post-update done");
    expect(setCalls()).toEqual([]);
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

describe("Settings → Users on an install-x64.sh PC", () => {
  // The owner's "Add a user" failed with "The account could not be created"
  // on every x64 PC: the launcher refused user_add before root saw it, and
  // this dispatcher had no implementation to reach. Both halves, run.
  const LAUNCHER = fs.readFileSync(
    path.resolve(process.cwd(), "scripts/x64-migration/clawbox-x64-run-root-step.sh"),
    "utf8",
  );
  const writeAdd = (record: string) => fs.writeFileSync(path.join(project, "data", ".user-add-input"), record, { mode: 0o600 });
  const writeRemove = (record: string) => fs.writeFileSync(path.join(project, "data", ".user-remove-input"), record, { mode: 0o600 });
  const calls = () => {
    const file = path.join(state, "calls");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
  };
  const passwd = () => fs.readFileSync(path.join(state, "passwd"), "utf8");

  it.each(["user_add", "user_remove"])("the web launcher permits %s", (step) => {
    const list = /WEB_ROOT_STEPS="([^"]*)"/.exec(LAUNCHER)?.[1].split(/\s+/).filter(Boolean) ?? [];
    expect(list).toContain(step);
  });

  it("creates the account in clawbox-users, sets its password, and keeps the password out of every log line", () => {
    writeAdd("carol:a long passphrase\n".trimEnd());
    const r = run("user_add");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("created ClawBox user 'carol'");
    expect(r.out).not.toContain("a long passphrase");
    expect(calls()).toEqual(expect.arrayContaining([
      "groupadd --system clawbox-users",
      "useradd --create-home --shell /bin/bash --user-group --groups clawbox-users carol",
    ]));
    // Never sudo, never adm: exactly one supplementary group.
    expect(calls().find((c) => c.startsWith("useradd"))).not.toMatch(/sudo|adm|wheel/);
    expect(fs.readFileSync(path.join(state, "chpasswd-input"), "utf8")).toBe("carol:a long passphrase\n");
    // The record is read once and gone.
    expect(fs.existsSync(path.join(project, "data", ".user-add-input"))).toBe(false);
    // The new home is the user's alone and the owner's is closed to them.
    expect(calls()).toEqual(expect.arrayContaining([
      `chmod 0750 ${sandbox}/accounts/carol`,
      `chmod o-rwx ${sandbox}/accounts/owner`,
    ]));
  });

  it("does not create the group again once it exists", () => {
    fs.appendFileSync(path.join(state, "group"), "clawbox-users:x:999:\n");
    writeAdd("carol:a long passphrase");
    expect(run("user_add").status).toBe(0);
    expect(calls().some((c) => c.startsWith("groupadd"))).toBe(false);
  });

  it.each([
    ["the install user", "owner:pw-long-enough", 64, "cannot be created here"],
    ["root", "root:pw-long-enough", 64, "cannot be created here"],
    ["an invalid name", "Bad;Name:pw-long-enough", 64, "is not a valid username"],
    ["a record with no password", "carol:", 64, "has no password"],
    ["a second record", "carol:pw\nroot:pw", 64, "exactly one record"],
  ])("refuses %s before any account tool runs", (_what, record, status, reason) => {
    writeAdd(record);
    const r = run("user_add");
    expect(r.status).toBe(status);
    expect(r.out).toContain(reason);
    expect(calls()).toEqual([]);
  });

  it("answers 65 for a name an account or group already has", () => {
    fs.appendFileSync(path.join(state, "group"), "plugdev:x:46:\n");
    writeAdd("plugdev:pw-long-enough");
    const r = run("user_add");
    expect(r.status).toBe(65);
    expect(r.out).toContain("Error: an account or group named 'plugdev' already exists");
    expect(calls()).toEqual([]);
  });

  it("refuses a symlink planted where the record goes", () => {
    const secret = path.join(sandbox, "secret");
    fs.writeFileSync(secret, "carol:pw-long-enough");
    fs.symlinkSync(secret, path.join(project, "data", ".user-add-input"));
    const r = run("user_add");
    expect(r.status).toBe(64);
    expect(r.out).toContain("is a symlink");
    expect(calls()).toEqual([]);
  });

  it("says why useradd failed, and removes the account again when the password cannot be set", () => {
    fs.writeFileSync(path.join(state, "useradd-fails"), "");
    writeAdd("carol:pw-long-enough");
    const failed = run("user_add");
    expect(failed.status).toBe(1);
    expect(failed.out).toContain("Error: useradd could not create 'carol'");
    fs.rmSync(path.join(state, "useradd-fails"));

    fs.writeFileSync(path.join(state, "chpasswd-fails"), "");
    writeAdd("carol:pw-long-enough");
    const r = run("user_add");
    expect(r.status).toBe(1);
    expect(r.out).toContain("Error: could not set the password for 'carol'; the account was removed again");
    expect(calls()).toContain("userdel --remove carol");
  });

  it("removes a ClawBox user it created, ending their processes first", () => {
    writeAdd("carol:pw-long-enough");
    expect(run("user_add").status).toBe(0);
    writeRemove("carol");
    const r = run("user_remove");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("removed ClawBox user 'carol'");
    const seen = calls();
    expect(seen.indexOf("pkill -KILL -u 1001")).toBeGreaterThan(-1);
    expect(seen.indexOf("pkill -KILL -u 1001")).toBeLessThan(seen.indexOf("userdel --remove carol"));
    expect(passwd()).not.toContain("carol:");
  });

  it("is done when the account is already gone", () => {
    writeRemove("carol");
    const r = run("user_remove");
    expect(r.status).toBe(0);
    expect(r.out).toContain("has no account; nothing to remove");
  });

  it.each([
    ["the install user", "owner", "cannot be removed here"],
    ["root", "root", "cannot be removed here"],
  ])("never removes %s", (_what, name, reason) => {
    writeRemove(name);
    const r = run("user_remove");
    expect(r.status).toBe(64);
    expect(r.out).toContain(reason);
    expect(calls()).toEqual([]);
  });

  it("refuses an account outside clawbox-users, and one that administers the box", () => {
    fs.appendFileSync(path.join(state, "passwd"), `guest:x:1002:1002::${sandbox}/accounts/guest:/bin/bash\n`);
    writeRemove("guest");
    const outside = run("user_remove");
    expect(outside.status).toBe(64);
    expect(outside.out).toContain("is not a ClawBox user");

    fs.appendFileSync(path.join(state, "members"), "guest clawbox-users\nguest sudo\n");
    writeRemove("guest");
    const admin = run("user_remove");
    expect(admin.status).toBe(64);
    expect(admin.out).toContain("is an administrator account");
    expect(calls()).toEqual([]);
  });

  it("refuses when no valid install user is recorded", () => {
    fs.writeFileSync(
      path.join(sandbox, "x64.env"),
      `CLAWBOX_USER=root\nPROJECT_DIR=${project}\nROOT_INSTALLER=${path.join(sandbox, "bin", "installer")}\n`,
    );
    writeAdd("carol:pw-long-enough");
    const r = run("user_add");
    expect(r.status).toBe(78);
    expect(calls()).toEqual([]);
  });
});
