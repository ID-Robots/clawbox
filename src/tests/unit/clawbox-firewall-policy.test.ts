import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A ClawBox shipped with no host firewall at all. `iptables -S` on a real
 * device (Jetson, beta 7de5b39) showed `-P INPUT ACCEPT` and nothing but
 * NetworkManager's shared-AP chains, so every port anything happened to bind on
 * 0.0.0.0 answered the whole LAN — including CUPS on 631 and rpcbind on 111,
 * neither of which ClawBox uses. Customer security review, 2026-07-28.
 *
 * These tests EXECUTE scripts/clawbox-firewall.sh against a stubbed `ufw` on a
 * prepended PATH and assert on the command stream it actually produced.
 * Grepping the script would pass on a rewrite that kept the port numbers in a
 * comment and stopped issuing the rules.
 *
 * The properties that matter are the ones a wrong-but-plausible rewrite would
 * break:
 *
 *   * default-deny is what closes 631/111 — they are never named in the policy,
 *     and MUST NOT be, because a blocklist only ever closes what someone
 *     remembered. The test therefore asserts the default, not the ports.
 *   * SSH is allowed BEFORE the firewall is enabled. Reversed, this bricks
 *     every box in the field with no console attached.
 *   * FORWARD stays ACCEPT. ufw defaults it to DROP, which would strand the
 *     hotspot's internet sharing, because start-ap.sh APPENDS its FORWARD
 *     ACCEPT rules and they would sit behind ufw's chain.
 *   * mDNS is open. avahi answers unsolicited multicast, so conntrack's
 *     ESTABLISHED allowance does not cover it, and `clawbox.local` — the
 *     documented way owners reach the box — would stop resolving.
 *   * the script never resets. A flush destroys NetworkManager's nm-sh-* chains
 *     and nothing in this repo re-adds them, so the captive portal would go
 *     down mid-setup and stay down until a reboot.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const FIREWALL = path.join(REPO, "scripts", "clawbox-firewall.sh");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

// Unconditional, matching ap-watchdog-honours-disable.test.ts: a suite that
// skips itself on a runner without bash reports green while proving nothing,
// and what it is failing to prove here is whether a shipped device is exposed.
beforeAll(() => {
  if (!hasBash) {
    throw new Error(
      "bash is required: these tests execute scripts/clawbox-firewall.sh rather than reading it",
    );
  }
});

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  /** Every `ufw` invocation, in order, as a single argv string per line. */
  ufwCalls: string[];
  /** Every `systemctl` invocation, in order. */
  systemctlCalls: string[];
}

/**
 * Run the real script with a stubbed environment.
 *
 * `ufwStatus` is what the stub reports for `ufw status` — "inactive" is a box
 * that has never had a firewall (every device in the field today), anything
 * else is a re-run.
 */
function runFirewall(opts: {
  ufwStatus?: string;
  /** Numbered rules the stub reports, to exercise the convergence path. */
  numbered?: string;
  /** Omit the ufw stub entirely, as on a box where apt could not install it. */
  withoutUfw?: boolean;
  /** dpkg-query exit/output, to exercise the NFS guard on rpcbind. */
  nfsInstalled?: boolean;
}): Run {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-fw-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, "calls.log");

  const stub = (name: string, body: string) => {
    const p = path.join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(p, 0o755);
  };

  if (!opts.withoutUfw) {
    // The numbered listing goes through a fixture file rather than an inlined
    // printf: multi-line shell output embedded in a stub is its own source of
    // false passes.
    const numberedFile = path.join(root, "numbered.txt");
    writeFileSync(numberedFile, opts.numbered ?? "");
    // The stub is STATEFUL: `ufw enable` flips what `ufw status` reports, the
    // way the real thing does. Without that, the script's closing "did it
    // actually come up active?" check reads the pre-enable value and every run
    // returns 1 — a stub that cannot model success would make the whole suite
    // assert on a failure path.
    const stateFile = path.join(root, "ufw.state");
    writeFileSync(stateFile, opts.ufwStatus ?? "inactive");
    stub(
      "ufw",
      [
        'if [ "$1" = "status" ] && [ "$2" = "numbered" ]; then',
        `  cat ${JSON.stringify(numberedFile)}`,
        "  exit 0",
        "fi",
        'if [ "$1" = "status" ]; then',
        `  printf 'Status: %s\\n' "$(cat ${JSON.stringify(stateFile)})"`,
        "  exit 0",
        "fi",
        'for a in "$@"; do',
        `  [ "$a" = "enable" ] && printf 'active' > ${JSON.stringify(stateFile)}`,
        `  [ "$a" = "disable" ] && printf 'inactive' > ${JSON.stringify(stateFile)}`,
        "done",
        "exit 0",
      ].join("\n"),
    );
  }
  // id -u must report root or the script refuses to run.
  stub("id", 'if [ "$1" = "-u" ]; then echo 0; exit 0; fi\nexit 0');
  stub("systemctl", "exit 0");
  // Real dpkg-query exits NON-ZERO whenever any queried name is unknown to the
  // dpkg database, which is the normal case here (autofs and ypbind are never
  // on a Jetson image) — even when another name matched and printed. Stubbing
  // exit 0 would model a world that does not exist and would hide the pipefail
  // bug this stub exists to catch.
  stub(
    "dpkg-query",
    opts.nfsInstalled ? "echo 'install ok installed'\nexit 1" : "echo 'unknown'\nexit 1",
  );

  // PATH contains ONLY the sandbox: the script must never reach the developer's
  // real ufw/systemctl. The handful of coreutils it genuinely needs are
  // symlinked in, so "is ufw present" is decided by this test, not by the host.
  const realTools = ["bash", "grep", "sed", "sort", "cat", "head", "printf", "env", "dirname"];
  for (const t of realTools) {
    const found = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf-8" }).stdout?.trim();
    if (found) {
      try {
        symlinkSync(found, path.join(bin, t));
      } catch {
        /* already linked, or shell builtin with no binary — both fine */
      }
    }
  }

  const res = spawnSync("bash", [FIREWALL], {
    env: {
      ...process.env,
      PATH: bin,
      NETWORK_INTERFACE: "wlTEST0",
    },
    encoding: "utf-8",
  });

  const calls = existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean) : [];
  return {
    status: res.status,
    stdout: `${res.stdout ?? ""}${res.stderr ?? ""}`,
    ufwCalls: calls.filter((c) => c.startsWith("ufw ")),
    systemctlCalls: calls.filter((c) => c.startsWith("systemctl ")),
  };
}

describe("the ClawBox firewall policy", () => {
  it("denies inbound by default", () => {
    // The entire finding. Everything else in the file is an exception to this
    // one line, and 631/111 close because of it and nothing else.
    const run = runFirewall({});
    expect(run.status).toBe(0);
    expect(run.ufwCalls).toContain("ufw --force default deny incoming");
  });

  it("opens EXACTLY the TCP ports the box serves, and nothing else", () => {
    // An exact set, not a presence check. A presence check passes just as
    // happily on a policy that also opened 3006 — the unauthenticated root PTY
    // this firewall exists to close — or 5900, or 8384. It also subsumes the
    // old "never names 631 or 111" assertion, and does so against every port
    // rather than the two anyone happened to think of.
    const run = runFirewall({});
    const ports = new Set(
      run.ufwCalls.flatMap((c) => [...c.matchAll(/port (\d+) proto tcp/g)].map((m) => m[1])),
    );
    // 53 is the hotspot's captive-portal DNS, scoped to the two AP subnets by
    // the assertion below; everything else here is a LAN service port.
    expect([...ports].sort()).toEqual(["18789", "22", "443", "53", "80", "8090"]);
  });

  it("only ever allows the service ports from private IPv4 sources", () => {
    // The security property in one line. Without an exact set here, adding
    // 0.0.0.0/0 to PRIVATE_V4 — i.e. exposing SSH and the gateway to the whole
    // internet — passes every other test in this file.
    const run = runFirewall({});
    const SERVICE_PORTS = new Set(["22", "80", "443", "18789", "8090"]);
    const v4Sources = new Set(
      run.ufwCalls
        .map((c) => /^ufw allow from (\d[^ ]*) to any port (\d+) proto tcp/.exec(c))
        .filter((m): m is RegExpExecArray => Boolean(m) && SERVICE_PORTS.has(m![2]))
        .map((m) => m[1]),
    );
    expect([...v4Sources].sort()).toEqual([
      "10.0.0.0/8",
      "100.64.0.0/10",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
    ]);
  });

  it("never opens a service port to every IPv4 address", () => {
    // A bare `ufw allow <port>` creates the v4 rule as well as the v6 one, which
    // would silently undo the scoping above. The v6 rules must name `::/0`.
    const run = runFirewall({});
    for (const c of run.ufwCalls.filter((c) => c.startsWith("ufw allow"))) {
      expect(c, `unscoped allow would cover IPv4: ${c}`).not.toMatch(
        /^ufw allow to any port \d+ proto tcp/,
      );
    }
    expect(run.ufwCalls.filter((c) => c.includes("from ::/0")).length).toBeGreaterThan(0);
  });

  it("allows SSH before it enables the firewall", () => {
    // Reversed, this strands every box in the field. Nobody is next to these
    // devices.
    const run = runFirewall({ ufwStatus: "inactive" });
    const firstSsh = run.ufwCalls.findIndex((c) => /port 22 proto tcp/.test(c));
    const enable = run.ufwCalls.findIndex((c) => c === "ufw --force enable");
    expect(firstSsh).toBeGreaterThan(-1);
    expect(enable).toBeGreaterThan(-1);
    expect(firstSsh).toBeLessThan(enable);
  });

  it("keeps routing on ACCEPT so hotspot internet sharing survives", () => {
    // ufw's own default is DROP. start-ap.sh appends its FORWARD ACCEPT rules,
    // so they would land behind ufw's chain and never be consulted.
    const run = runFirewall({});
    expect(run.ufwCalls).toContain("ufw --force default allow routed");
    expect(run.ufwCalls.join("\n")).not.toMatch(/default deny routed/);
  });

  it("opens 443, so a box with certs installed keeps HTTPS", () => {
    // production-server.js binds 443 on 0.0.0.0 as soon as a cert pair exists in
    // data/certs/. Omitting it would have taken HTTPS away from every box with
    // certs the moment this firewall landed — a regression no probe of a
    // cert-less box could have caught.
    const run = runFirewall({});
    expect(run.ufwCalls.filter((c) => /port 443 proto tcp/.test(c)).length).toBeGreaterThan(0);
  });

  it("keeps Tailscale reachable", () => {
    // 100.64/10 is CGNAT, which is what a tailnet uses. Dropping it would
    // silently kill `.ts.net` access, a documented ClawBox feature.
    const run = runFirewall({});
    expect(run.ufwCalls.join("\n")).toContain("100.64.0.0/10");
  });

  it("keeps mDNS reachable", () => {
    // avahi answers unsolicited multicast; ESTABLISHED does not cover it, and
    // `clawbox.local` is how owners are told to reach the box.
    const run = runFirewall({});
    expect(run.ufwCalls.join("\n")).toMatch(/port 5353 proto udp/);
  });

  it("keeps the hotspot's DHCP and DNS working on both AP subnets", () => {
    const run = runFirewall({});
    const rules = run.ufwCalls.join("\n");
    // DHCPDISCOVER comes from 0.0.0.0, so it can only be matched by interface.
    expect(rules).toMatch(/ufw allow in on wlTEST0 to any port 67 proto udp/);
    // start-ap.sh moves the AP to 10.43.0.0/24 when the upstream LAN already
    // occupies 10.42.0.0/24, so a rule for only one subnet breaks that box.
    expect(rules).toMatch(/from 10\.42\.0\.0\/24 to any port 53/);
    expect(rules).toMatch(/from 10\.43\.0\.0\/24 to any port 53/);
  });

  it("never resets or flushes", () => {
    // A flush destroys NetworkManager's nm-sh-in-*/nm-sh-fw-* chains, which are
    // built once on connection activation and re-added by nothing in this repo.
    // The captive portal would go down mid-setup and stay down until a reboot.
    const run = runFirewall({ ufwStatus: "active" });
    const rules = run.ufwCalls.join("\n");
    expect(rules).not.toMatch(/\breset\b/);
    expect(rules).not.toMatch(/\bflush\b/);
  });

  it("retires an older generation's rules, and leaves the owner's alone", () => {
    // Re-running must not stack duplicates and must not remove a rule the owner
    // added. The versioned `clawbox-v<N>` comment is the only marker that
    // distinguishes them — and the match is anchored, so a rule the owner
    // commented `clawbox-v1-mine` is NOT ours to delete.
    const run = runFirewall({
      ufwStatus: "active",
      numbered: [
        "[ 1] 22/tcp        ALLOW IN    10.0.0.0/8       # clawbox-v0",
        "[ 2] 9999/tcp      ALLOW IN    Anywhere         # owner's own rule",
        "[ 3] 80/tcp        ALLOW IN    10.0.0.0/8       # clawbox-v0",
        "[ 4] 22/tcp        ALLOW IN    10.0.0.0/8       # clawbox-v1",
        "[ 5] 7777/tcp      ALLOW IN    Anywhere         # clawbox-v1-mine",
      ].join("\n"),
    });
    const deletes = run.ufwCalls.filter((c) => c.startsWith("ufw --force delete"));
    // Only the v0 rules, highest first — never the current version, never the
    // owner's, and never the lookalike comment on rule 5.
    expect(deletes).toEqual(["ufw --force delete 3", "ufw --force delete 1"]);
  });

  it("adds the current rules BEFORE retiring anything", () => {
    // The property that keeps a field device reachable. Delete-first would mean
    // a window with the policy at DROP and no allow rules, and any later `ufw
    // allow` failure (IPv6 disabled, read-only /etc) would strand the box for
    // good. Every in-app update takes this path.
    const run = runFirewall({
      ufwStatus: "active",
      numbered: ["[ 1] 22/tcp   ALLOW IN   10.0.0.0/8   # clawbox-v0"].join("\n"),
    });
    expect(run.status).toBe(0);
    const firstDelete = run.ufwCalls.findIndex((c) => c.startsWith("ufw --force delete"));
    const lastAllow = run.ufwCalls.map((c) => c.startsWith("ufw allow")).lastIndexOf(true);
    expect(firstDelete).toBeGreaterThan(-1);
    expect(lastAllow).toBeGreaterThan(-1);
    expect(lastAllow).toBeLessThan(firstDelete);
  });

  it("re-running on an up-to-date box deletes nothing", () => {
    // No churn on update: the current generation is already installed, ufw
    // skips the duplicate adds, and there is no older version to retire. The
    // old delete-everything-then-re-add shape took the web UI and the hotspot
    // down for the length of ~40 sequential ufw invocations, on every update.
    const run = runFirewall({
      ufwStatus: "active",
      numbered: ["[ 1] 22/tcp   ALLOW IN   10.0.0.0/8   # clawbox-v1"].join("\n"),
    });
    expect(run.ufwCalls.filter((c) => c.startsWith("ufw --force delete"))).toEqual([]);
  });

  it("tags every rule it adds with the current version", () => {
    const run = runFirewall({});
    const adds = run.ufwCalls.filter((c) => c.startsWith("ufw allow"));
    expect(adds.length).toBeGreaterThan(0);
    for (const a of adds) expect(a).toMatch(/comment clawbox-v\d+$/);
  });

  it("does nothing at all when ufw is not installed", () => {
    // An offline update can leave a box without the package. Failing hard here
    // would take the whole post_update step red for no security benefit.
    //
    // `withoutUfw` builds a PATH that contains ONLY the sandbox bin, so
    // `command -v ufw` genuinely misses. Merely omitting the stub would let the
    // script find the developer's real /usr/sbin/ufw — a false red on any
    // Ubuntu workstation, and an actual firewall rewrite in a root CI container.
    const run = runFirewall({ withoutUfw: true });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/ufw not installed/);
    expect(run.ufwCalls).toEqual([]);
  });

  describe("rpcbind", () => {
    it("is disabled and masked when nothing needs RPC", () => {
      // The one service we turn off rather than merely firewall: masking is
      // strictly better than a port rule because it survives a firewall being
      // switched off later.
      const run = runFirewall({ nfsInstalled: false });
      const calls = run.systemctlCalls.join("\n");
      expect(calls).toMatch(/systemctl mask rpcbind\.socket/);
      expect(calls).toMatch(/systemctl mask rpcbind\.service/);
    });

    it("is left alone when an NFS or NIS package is installed", () => {
      // Masking rpcbind under a mounted NFS share breaks the owner's storage.
      // Closing the port at the firewall is still in force either way.
      const run = runFirewall({ nfsInstalled: true });
      expect(run.systemctlCalls.join("\n")).not.toMatch(/mask rpcbind/);
      expect(run.stdout).toMatch(/rpcbind left alone/);
    });
  });
});

describe("the installer wiring", () => {
  const install = readFileSync(path.join(REPO, "install.sh"), "utf-8");

  it("runs the firewall on update, not only on a fresh flash", () => {
    // The whole point. install.sh is never re-run in full on an existing box —
    // the updater dispatches `--step post_update` — so a firewall wired only
    // into step_system_config would leave every shipped device exposed.
    const postUpdate = install.slice(
      install.indexOf("step_post_update() {"),
      install.indexOf("gateway_port_listening()"),
    );
    expect(postUpdate).toMatch(/step_firewall \|\| echo/);
  });

  it("runs it on a fresh install too", () => {
    const systemConfig = install.slice(
      install.indexOf("step_system_config() {"),
      install.indexOf("step_persistent_journal() {"),
    );
    // Guarded, like every other fixup in this function's sibling
    // step_post_update: install.sh runs under `set -euo pipefail`, so a bare
    // call would let a ufw failure abort a first flash.
    expect(systemConfig).toMatch(/step_firewall \|\| echo/);
  });

  it("installs ufw", () => {
    expect(install).toMatch(/apt-get install .*\bufw\b/);
  });

  it("stands down inside the e2e-install container", () => {
    // A CI container has no netfilter to program; `ufw enable` fails there and
    // step_system_config is not `|| warn`-guarded, so the whole install would
    // go red on every PR.
    const step = install.slice(install.indexOf("step_firewall() {"), install.indexOf("step_nm_dispatcher() {"));
    expect(step).toMatch(/is_test_mode/);
  });

  it("is dispatchable but not reachable from the web server's root escalation", () => {
    // `firewall` in DISPATCH_STEPS lets support re-assert the policy by hand.
    // Keeping it OUT of the root dispatcher's allow-list stops the web process
    // from rewriting the firewall through the one-tap escalation surface.
    const dispatch = install.slice(install.indexOf("DISPATCH_STEPS=("), install.indexOf("\n)", install.indexOf("DISPATCH_STEPS=(")));
    expect(dispatch).toMatch(/^\s*firewall\s*$/m);
    const allowed = readFileSync(path.join(REPO, "config", "clawbox-root-step.sh"), "utf-8");
    const list = /^ALLOWED_STEPS="([^"]*)"/m.exec(allowed);
    expect(list).not.toBeNull();
    expect(list![1].split(/\s+/)).not.toContain("firewall");
  });
});
