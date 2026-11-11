import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WEB_ROOT_STEPS, X64_INSTALL_ROOT_STEPS } from "@/lib/root-steps";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * The AppArmor profile that lets a read-only Codex run build its sandbox on
 * Ubuntu 23.10+ (kernel.apparmor_restrict_unprivileged_userns=1).
 *
 * Codex's read-only sandbox is `/usr/bin/bwrap --unshare-net`; AppArmor refuses
 * bwrap the user namespace, so every command of a team's planner or reviewer
 * failed with "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted".
 * config/apparmor/bwrap-userns-restrict is upstream AppArmor's own profile for
 * that (proven on the owner's x64 laptop), and both installers load it:
 *
 *   1. the profile — what it attaches to and what its child denies;
 *   2. the helper both installers carry, `ensure_bwrap_userns_profile`, and the
 *      four gates that keep it to boxes that need it and can take it safely;
 *   3. where it is called from: the install, and the root step an update
 *      already runs — so an installed box gets it without a reinstall;
 *   4. the helper RUN against a box modelled in a temp dir.
 */

const REPO = path.resolve(__dirname, "../../..");
const read = (...p: string[]) => fs.readFileSync(path.join(REPO, ...p), "utf-8");

const PROFILE_PATH = path.join(REPO, "config", "apparmor", "bwrap-userns-restrict");
const INSTALL_SH = read("install.sh");
const INSTALL_X64 = read("install-x64.sh");
const UPDATER = read("src", "lib", "updater.ts");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunctionFrom(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${source.slice(start, end)}\n}`;
}

/** Code only: a comment that mentions `sysctl` cannot satisfy — or break — an assertion about what runs. */
function shellCode(fn: string): string {
  return fn
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

/** Each `profile NAME [ATTACH] [flags=(…)] {` block of an AppArmor file, by name. */
function profileBlocks(text: string): Map<string, { attach: string | null; body: string }> {
  const blocks = new Map<string, { attach: string | null; body: string }>();
  const lines = text.split("\n").filter((l) => !l.trim().startsWith("#"));
  let current: { name: string; attach: string | null; body: string[] } | null = null;
  for (const line of lines) {
    const header = /^profile\s+(\S+)\s+(?:(\/\S+)\s+)?(?:flags=\([^)]*\)\s*)?\{\s*$/.exec(line);
    if (header) {
      current = { name: header[1], attach: header[2] ?? null, body: [] };
      continue;
    }
    if (current && /^\}\s*$/.test(line)) {
      blocks.set(current.name, { attach: current.attach, body: current.body.join("\n") });
      current = null;
      continue;
    }
    current?.body.push(line);
  }
  return blocks;
}

describe("config/apparmor/bwrap-userns-restrict", () => {
  const profile = () => fs.readFileSync(PROFILE_PATH, "utf-8");

  it("ships with the project, and the design draft it came from is gone", () => {
    expect(fs.existsSync(PROFILE_PATH)).toBe(true);
    expect(fs.existsSync(path.join(REPO, "design", "bwrap-userns-restrict.proven"))).toBe(false);
  });

  it("attaches to /usr/bin/bwrap and to nothing else", () => {
    const blocks = profileBlocks(profile());
    const attachments = [...blocks.values()].map((b) => b.attach).filter((a): a is string => a !== null);
    expect(attachments).toEqual(["/usr/bin/bwrap"]);
    // Every `profile` header in the file was read by the parser above.
    const headers = profile().split("\n").filter((l) => /^profile\s/.test(l));
    expect(headers).toHaveLength(blocks.size);
  });

  it("stacks everything bwrap starts under a child profile that audits and denies every capability", () => {
    const blocks = profileBlocks(profile());
    const parent = blocks.get("bwrap");
    const child = blocks.get("unpriv_bwrap");
    expect(parent, "profile bwrap").toBeDefined();
    expect(child, "profile unpriv_bwrap").toBeDefined();
    // The child has no attachment of its own: only bwrap's children reach it.
    expect(child!.attach).toBeNull();
    expect(child!.body).toContain("audit deny capability,");
    expect(child!.body).not.toMatch(/^\s*allow capability,/m);
    // bwrap itself needs its capabilities inside the namespace it builds; what it
    // starts is stacked with the child, and so is whatever that starts in turn.
    expect(parent!.body).toContain("allow capability,");
    expect(parent!.body).toContain("allow pix /** -> &bwrap//&unpriv_bwrap,");
    expect(child!.body).toContain("allow pix /** -> &unpriv_bwrap,");
  });

  it("is upstream's abi 4.0 profile, with no unconfined escape", () => {
    const text = profile();
    expect(text).toMatch(/^abi <abi\/4\.0>,$/m);
    expect(text).toContain("include <tunables/global>");
    expect(text).not.toMatch(/unconfined/);
    // Only the two hooks upstream leaves for local additions.
    const includes = text.split("\n").filter((l) => /^\s*include\b/.test(l)).map((l) => l.trim());
    expect(includes).toEqual([
      "include <tunables/global>",
      "include if exists <local/bwrap-userns-restrict>",
      "include if exists <local/unpriv_bwrap>",
    ]);
  });

  it("says why ClawBox ships it, and opens with the line a later run knows it by", () => {
    const text = profile();
    expect(text.split("\n")[0]).toMatch(/^# ClawBox: /);
    expect(text).toMatch(/Codex/);
    expect(text).toMatch(/RTM_NEWADDR/);
  });
});

describe("both installers carry ensure_bwrap_userns_profile", () => {
  const installers: Array<[string, string, string]> = [
    ["install.sh", INSTALL_SH, "$SRC_DIR"],
    ["install-x64.sh", INSTALL_X64, "$PROJECT_DIR"],
  ];

  describe.each(installers)("%s", (_name, source, sourceRoot) => {
    const ensure = () => shellCode(extractShellFunctionFrom(source, "ensure_bwrap_userns_profile"));
    const apply = () => shellCode(extractShellFunctionFrom(source, "bwrap_userns_profile_install"));

    it("defines the helper and runs only where all four gates hold", () => {
      const code = ensure();
      // 1. bwrap is installed
      expect(code).toContain("local bwrap_bin=/usr/bin/bwrap");
      expect(code).toMatch(/\[ ! -x "\$bwrap_bin" \]/);
      // 2. the restriction is on, read as 1
      expect(code).toContain("local restrict_flag=/proc/sys/kernel/apparmor_restrict_unprivileged_userns");
      expect(code).toMatch(/"\$\(cat "\$restrict_flag" 2>\/dev\/null \|\| true\)" != "1"/);
      // 3. apparmor_parser exists
      expect(code).toMatch(/command -v apparmor_parser/);
      // 4. no other profile under /etc/apparmor.d attaches to bwrap — this file excluded
      expect(code).toContain("local profile_dir=/etc/apparmor.d");
      expect(code).toMatch(/grep -rIlE --exclude="\$name" "\$attach_re" "\$profile_dir"/);
      expect(code).toContain("local name=bwrap-userns-restrict");
    });

    it("reads the shipped file from the tree the installer runs out of", () => {
      expect(ensure()).toContain(`local src="${sourceRoot}/config/apparmor/$name"`);
    });

    it("installs root:root 0644 at /etc/apparmor.d/bwrap-userns-restrict, loads it with -r, and writes nothing else", () => {
      const code = ensure();
      const run = apply();
      expect(code).toContain('local dest="$profile_dir/$name"');
      const installs = run.split("\n").filter((l) => /\binstall -/.test(l));
      expect(installs.length).toBeGreaterThan(0);
      for (const line of installs) {
        expect(line).toContain("-o root -g root -m 0644");
        expect(line).toContain('"$dest"');
      }
      expect(run).toContain('"$parser" -r "$dest"');
      // Byte-identical means nothing to do.
      expect(code).toContain('cmp -s');
      expect(code).toContain("already installed");
    });

    it("never touches the sysctl or any other profile", () => {
      const all = `${ensure()}\n${apply()}`;
      expect(all).not.toMatch(/\bsysctl\b/);
      expect(all).not.toMatch(/>>?\s*"?\$restrict_flag/);
      expect(all).not.toMatch(/\btee\b/);
      expect(all).not.toMatch(/apparmor_parser\s+-R|aa-disable|aa-complain|aa-teardown/);
      // The only thing removed is the file this helper just wrote.
      for (const line of all.split("\n").filter((l) => /\brm\b/.test(l))) {
        expect(line).toMatch(/rm -f "\$(dest|prev|staged)"/);
      }
    });

    it("is called from step_ai_tools_install, next to ensure_codex_cli, and cannot fail it", () => {
      const step = shellCode(extractShellFunctionFrom(source, "step_ai_tools_install"));
      const codex = step.indexOf("ensure_codex_cli");
      const bwrap = step.indexOf("ensure_bwrap_userns_profile");
      expect(codex).toBeGreaterThan(-1);
      expect(bwrap).toBeGreaterThan(codex);
      const line = step.split("\n").find((l) => l.includes("ensure_bwrap_userns_profile"))!;
      expect(line).toMatch(/\|\| /);
    });
  });

  describe("the update path", () => {
    // The updater's step list is the authority on what runs on EVERY update.
    function updateStepBlock(id: string): string {
      const start = UPDATER.indexOf(`id: "${id}"`);
      if (start < 0) throw new Error(`update step ${id} not found`);
      const end = UPDATER.indexOf("\n  },", start);
      return UPDATER.slice(start, end);
    }

    it("install.sh hooks step_post_update, which every update runs as root out of the root-owned mirror", () => {
      const post = shellCode(extractShellFunctionFrom(INSTALL_SH, "step_post_update"));
      expect(post).toMatch(/optional_step bwrap_userns_profile ensure_bwrap_userns_profile/);
      // The same neighbourhood as the Codex CLI it serves.
      expect(post.indexOf("optional_step codex_cli step_codex_cli"))
        .toBeLessThan(post.indexOf("ensure_bwrap_userns_profile"));
      const block = updateStepBlock("post_update");
      expect(block).toContain("requiresRoot: true");
      expect(block).not.toContain("applies:");
    });

    it("install-x64.sh hooks step_apt_update, the installer step its update always forwards to root", () => {
      const apt = shellCode(extractShellFunctionFrom(INSTALL_X64, "step_apt_update"));
      expect(apt).toMatch(/ensure_bwrap_userns_profile \|\| /);
      // Reached on an installed PC: the updater runs it unconditionally ...
      const block = updateStepBlock("apt_update");
      expect(block).toContain("requiresRoot: true");
      expect(block).not.toContain("applies:");
      // ... and the PC's root dispatcher forwards it to this installer.
      expect(X64_INSTALL_ROOT_STEPS).toContain("apt_update");
      const dispatcher = read("scripts", "x64-migration", "clawbox-x64-root-step.sh");
      expect(/^INSTALLER_STEPS="([^"]*)"/m.exec(dispatcher)![1].split(/\s+/)).toContain("apt_update");
    });

    it("adds no root step name: both hooks are on lists that already exist", () => {
      expect(WEB_ROOT_STEPS).toContain("post_update");
      expect(WEB_ROOT_STEPS).toContain("apt_update");
      for (const list of [
        ...WEB_ROOT_STEPS,
        ...X64_INSTALL_ROOT_STEPS,
        ...(/ALLOWED_STEPS="([^"]*)"/.exec(read("config", "clawbox-root-step.sh"))![1].split(/\s+/)),
        ...(/WEB_ROOT_STEPS="([^"]*)"/.exec(read("config", "clawbox-run-root-step.sh"))![1].split(/\s+/)),
      ]) {
        expect(list).not.toMatch(/bwrap|apparmor/);
      }
    });
  });

  it("install-x64.sh pins the profile it loads, because root must not load policy a user can rewrite", () => {
    const pin = /^BWRAP_USERNS_PROFILE_SHA256="([0-9a-f]{64})"$/m.exec(INSTALL_X64);
    expect(pin, "BWRAP_USERNS_PROFILE_SHA256 in install-x64.sh").not.toBeNull();
    const actual = createHash("sha256").update(fs.readFileSync(PROFILE_PATH)).digest("hex");
    // Edit the profile, update the pin: the root-owned installer copy refuses
    // a checkout that carries a profile it was not built for.
    expect(pin![1]).toBe(actual);
    expect(shellCode(extractShellFunctionFrom(INSTALL_X64, "ensure_bwrap_userns_profile")))
      .toContain('"$actual" != "$BWRAP_USERNS_PROFILE_SHA256"');
  });
});

/**
 * The shipped helper, RUN against a box modelled in a temp dir. The three
 * absolute paths the gates read are swapped for paths in the box — each swap
 * asserted to have matched exactly once, so the copy cannot silently drift from
 * the real function — and `install` drops its -o/-g (the test is not root).
 */
d("ensure_bwrap_userns_profile against a modelled box", () => {
  let box: string;
  let PROFILE = "";

  const installers: Array<{ name: string; source: string; root: "SRC_DIR" | "PROJECT_DIR"; pinned: boolean }> = [
    { name: "install.sh", source: INSTALL_SH, root: "SRC_DIR", pinned: false },
    { name: "install-x64.sh", source: INSTALL_X64, root: "PROJECT_DIR", pinned: true },
  ];

  function swapOnce(text: string, from: string, to: string): string {
    const count = text.split(from).length - 1;
    if (count !== 1) throw new Error(`expected exactly one "${from}", found ${count}`);
    return text.replace(from, () => to);
  }

  beforeEach(() => {
    // Read per case, not while collecting: a missing profile must fail each
    // case with its own reason rather than take the whole file down.
    PROFILE = fs.readFileSync(PROFILE_PATH, "utf-8");
    box = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-bwrap-profile-"));
    for (const dir of ["bin", "tmp", "tree/config/apparmor", "usr/bin", "etc/apparmor.d"]) {
      fs.mkdirSync(path.join(box, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(box, "usr/bin/bwrap"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(box, "flag"), "1\n");
    fs.writeFileSync(path.join(box, "tree/config/apparmor/bwrap-userns-restrict"), PROFILE);
    fs.writeFileSync(
      path.join(box, "bin/apparmor_parser"),
      [
        "#!/bin/bash",
        'echo "$*" >> "$BOX/parser-calls"',
        '[ -f "$BOX/parser-fails" ] && { echo "AppArmor parser error: stub refusal" >&2; exit 1; }',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    if (box) fs.rmSync(box, { recursive: true, force: true });
  });

  const dest = () => path.join(box, "etc/apparmor.d/bwrap-userns-restrict");
  const parserCalls = () => {
    const file = path.join(box, "parser-calls");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n") : [];
  };

  function run(
    inst: (typeof installers)[number],
    opts: { testMode?: boolean; withParser?: boolean } = {},
  ): { rc: number; out: string; err: string } {
    let ensure = extractShellFunctionFrom(inst.source, "ensure_bwrap_userns_profile");
    ensure = swapOnce(ensure, "local bwrap_bin=/usr/bin/bwrap", `local bwrap_bin=${box}/usr/bin/bwrap`);
    ensure = swapOnce(
      ensure,
      "local restrict_flag=/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      `local restrict_flag=${box}/flag`,
    );
    ensure = swapOnce(ensure, "local profile_dir=/etc/apparmor.d", `local profile_dir=${box}/etc/apparmor.d`);
    const pin = /^BWRAP_USERNS_PROFILE_SHA256=.*$/m.exec(inst.source)?.[0] ?? "";
    const script = [
      "set -euo pipefail",
      `is_test_mode() { ${opts.testMode ? "true" : "false"}; }`,
      // Not root here: the real call chowns to root:root, which an unprivileged
      // test cannot. Everything else about `install` is the real thing.
      'install() { local a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; command install "${a[@]}"; }',
      `${inst.root}=${box}/tree`,
      pin,
      extractShellFunctionFrom(inst.source, "bwrap_userns_profile_install"),
      ensure,
      "rc=0",
      "ensure_bwrap_userns_profile || rc=$?",
      'echo "rc=$rc"',
    ].join("\n");
    const bins = opts.withParser === false ? "" : `${box}/bin:`;
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: { PATH: `${bins}/usr/bin:/bin`, BOX: box, HOME: box, TMPDIR: path.join(box, "tmp") } as unknown as NodeJS.ProcessEnv,
    });
    const rc = Number(/^rc=(\d+)$/m.exec(r.stdout)?.[1] ?? NaN);
    return { rc, out: r.stdout.replace(/^rc=\d+\n?/m, ""), err: r.stderr };
  }

  /** Nothing the helper staged may outlive it. */
  const noLeftovers = () => expect(fs.readdirSync(path.join(box, "tmp"))).toEqual([]);

  describe.each(installers)("$name", (inst) => {
    it("installs the profile 0644 and loads it with apparmor_parser -r on a box that needs it", () => {
      const r = run(inst);
      expect(r.rc).toBe(0);
      expect(fs.readFileSync(dest(), "utf-8")).toBe(PROFILE);
      expect(fs.statSync(dest()).mode & 0o777).toBe(0o644);
      expect(parserCalls()).toEqual([`-r ${dest()}`]);
      expect(r.out).toMatch(/installed and loaded/);
      expect(fs.readFileSync(path.join(box, "flag"), "utf-8")).toBe("1\n");
      expect(fs.readdirSync(path.join(box, "etc/apparmor.d"))).toEqual(["bwrap-userns-restrict"]);
      noLeftovers();
    });

    it("is idempotent: a byte-identical file is one log line and no reload", () => {
      expect(run(inst).rc).toBe(0);
      const again = run(inst);
      expect(again.rc).toBe(0);
      expect(again.out.trim().split("\n")).toHaveLength(1);
      expect(again.out).toMatch(/already installed/);
      expect(parserCalls()).toHaveLength(1);
      noLeftovers();
    });

    it.each([
      ["bwrap is not installed", () => fs.rmSync(path.join(box, "usr/bin/bwrap"))],
      ["the restriction is off (reads 0)", () => fs.writeFileSync(path.join(box, "flag"), "0\n")],
      ["the restriction does not exist on this kernel", () => fs.rmSync(path.join(box, "flag"))],
    ])("skips, quietly and successfully, when %s", (_why, setup) => {
      setup();
      const r = run(inst);
      expect(r.rc).toBe(0);
      expect(r.out.trim().split("\n")).toHaveLength(1);
      expect(r.err).toBe("");
      expect(fs.existsSync(dest())).toBe(false);
      expect(parserCalls()).toEqual([]);
    });

    it("skips when apparmor_parser is not installed", () => {
      const r = run(inst, { withParser: false });
      expect(r.rc).toBe(0);
      expect(r.out).toMatch(/apparmor_parser is not installed/);
      expect(fs.existsSync(dest())).toBe(false);
    });

    it.each([
      ["a distro-style profile", "usr.bin.bwrap", "abi <abi/4.0>,\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n}\n"],
      ["a bare attachment", "mine", "/usr/bin/bwrap {\n  capability,\n}\n"],
      ["a glob attachment", "globbed", "profile b /{usr/,}bin/bwrap flags=(attach_disconnected) {\n}\n"],
      ["an attachment whose brace is on the next line", "split", "profile b /usr/bin/bwrap flags=(complain)\n{\n}\n"],
    ])("skips when %s already attaches to bwrap, and leaves it alone", (_what, file, text) => {
      fs.writeFileSync(path.join(box, "etc/apparmor.d", file), text);
      const r = run(inst);
      expect(r.rc).toBe(0);
      expect(r.out).toMatch(/already has a profile for bwrap/);
      expect(fs.existsSync(dest())).toBe(false);
      expect(fs.readFileSync(path.join(box, "etc/apparmor.d", file), "utf-8")).toBe(text);
      expect(parserCalls()).toEqual([]);
    });

    it("is not stopped by a profile that only MENTIONS bwrap in a rule or a comment", () => {
      fs.writeFileSync(
        path.join(box, "etc/apparmor.d/steam"),
        [
          "profile steam /usr/bin/steam flags=(unconfined) {",
          "  /usr/bin/bwrap ix,",
          "  /usr/bin/bwrap Cx -> bwrap_child,",
          "}",
          "# profile bwrap /usr/bin/bwrap {",
          "",
        ].join("\n"),
      );
      fs.mkdirSync(path.join(box, "etc/apparmor.d/local"));
      fs.writeFileSync(path.join(box, "etc/apparmor.d/local/bwrap-userns-restrict"), "# site additions\n");
      expect(run(inst).rc).toBe(0);
      expect(fs.readFileSync(dest(), "utf-8")).toBe(PROFILE);
    });

    it("leaves a file of that name that is not ClawBox's alone", () => {
      const theirs = "abi <abi/4.0>,\nprofile bwrap /usr/bin/bwrap flags=(unconfined) { userns, }\n";
      fs.writeFileSync(dest(), theirs);
      const r = run(inst);
      expect(r.rc).toBe(0);
      expect(r.out).toMatch(/is not ClawBox's/);
      expect(fs.readFileSync(dest(), "utf-8")).toBe(theirs);
      expect(parserCalls()).toEqual([]);
      noLeftovers();
    });

    it("leaves a symlink at that name alone", () => {
      const target = path.join(box, "elsewhere");
      fs.writeFileSync(target, "# ClawBox: pretending\n");
      fs.symlinkSync(target, dest());
      const r = run(inst);
      expect(r.rc).toBe(0);
      expect(fs.lstatSync(dest()).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, "utf-8")).toBe("# ClawBox: pretending\n");
      expect(parserCalls()).toEqual([]);
    });

    it("replaces an older ClawBox copy and reloads it", () => {
      fs.writeFileSync(dest(), "# ClawBox: an older revision\nabi <abi/4.0>,\n");
      const r = run(inst);
      expect(r.rc).toBe(0);
      expect(fs.readFileSync(dest(), "utf-8")).toBe(PROFILE);
      expect(parserCalls()).toEqual([`-r ${dest()}`]);
      noLeftovers();
    });

    it("warns and fails the helper — never the install — when the kernel refuses it, and leaves no file behind", () => {
      fs.writeFileSync(path.join(box, "parser-fails"), "");
      const r = run(inst);
      expect(r.rc).toBe(1);
      expect(r.err).toMatch(/WARN: could not install or load/);
      expect(r.err).toMatch(/stub refusal/);
      // A file left behind would read "already installed" and never be retried.
      expect(fs.existsSync(dest())).toBe(false);
      noLeftovers();
    });

    it("puts an older ClawBox copy back when the new one is refused", () => {
      const older = "# ClawBox: an older revision\nabi <abi/4.0>,\n";
      fs.writeFileSync(dest(), older);
      fs.writeFileSync(path.join(box, "parser-fails"), "");
      const r = run(inst);
      expect(r.rc).toBe(1);
      expect(fs.readFileSync(dest(), "utf-8")).toBe(older);
      noLeftovers();
    });
  });

  describe("install.sh only", () => {
    const inst = installers[0];

    it("does nothing under CLAWBOX_TEST_MODE", () => {
      const r = run(inst, { testMode: true });
      expect(r.rc).toBe(0);
      expect(r.out).toMatch(/CLAWBOX_TEST_MODE=1/);
      expect(fs.existsSync(dest())).toBe(false);
      expect(parserCalls()).toEqual([]);
    });

    it("warns when the mirror it reads has no profile", () => {
      fs.rmSync(path.join(box, "tree/config/apparmor/bwrap-userns-restrict"));
      const r = run(inst);
      expect(r.rc).toBe(1);
      expect(r.err).toMatch(/WARN: .* is missing/);
      expect(fs.existsSync(dest())).toBe(false);
    });
  });

  describe("install-x64.sh only", () => {
    const inst = installers[1];

    it("refuses a checkout whose profile is not the one this installer is pinned to", () => {
      // What the install user could write into their own tree.
      fs.writeFileSync(
        path.join(box, "tree/config/apparmor/bwrap-userns-restrict"),
        `${PROFILE}\nprofile evil /home/clawbox/exploit flags=(unconfined) {\n  userns,\n}\n`,
      );
      const r = run(inst);
      expect(r.rc).toBe(1);
      expect(r.err).toMatch(/not the profile this installer ships/);
      expect(fs.existsSync(dest())).toBe(false);
      expect(parserCalls()).toEqual([]);
      noLeftovers();
    });

    it("does not call a checkout that has not been cloned yet a failure (step_apt_update runs first on a new install)", () => {
      fs.rmSync(path.join(box, "tree/config"), { recursive: true });
      const r = run(inst);
      expect(r.rc).toBe(0);
      expect(r.out).toMatch(/is not in the checkout yet/);
      expect(fs.existsSync(dest())).toBe(false);
    });
  });
});
