import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * TASK-1380. After an ordinary in-app update rebooted a box whose only uplink
 * was a saved WiFi network, the box came back broadcasting ClawBox-Setup and
 * had lost its LAN: clawbox-ap.service had disconnected the client that
 * NetworkManager had already autoconnected, and raised the hotspot instead.
 *
 * scripts/start-ap.sh picked its saved-WiFi candidates with
 * `awk -F: '/wifi/ && !/ClawBox-Setup/'` over `nmcli -t -f NAME,TYPE`. A WiFi
 * profile's terse TYPE is "802-11-wireless", so only a profile whose NAME
 * contained "wifi" was ever tried; for every other network the list was empty,
 * the script went straight to "falling back to AP mode", and
 * release_wifi_for_ap — which does match 802-11-wireless — took the live
 * client down to free the radio.
 *
 * These tests EXECUTE the shipped script against a fake CLAWBOX_ROOT with
 * nmcli, iw, ip, sysctl, iptables and sleep stubbed on PATH, the way
 * ap-watchdog-honours-disable.test.ts does. The nmcli stub keeps a small model
 * of NetworkManager (saved profiles, the connection active on the radio, the
 * device state) and answers in real terse format — TYPE 802-11-wireless, ':'
 * and '\' escaped in names — and every call's argv is recorded, so the
 * assertions are about what the script actually did to the radio.
 */

// Starts real processes: vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const START_AP = path.join(REPO, "scripts", "start-ap.sh");
const IFACE = "wlTEST0";
// The one host path the AP branch writes outside $CLAWBOX_ROOT. It is root-owned
// on every box and runner this suite is meant for; see beforeAll.
const DNSMASQ_SHARED = "/etc/NetworkManager/dnsmasq-shared.d";
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

beforeAll(() => {
  // Unconditional, not skipIf: a suite that skips itself on a runner without
  // bash reports green while proving nothing.
  if (!hasBash) {
    throw new Error("bash is required: these tests execute scripts/start-ap.sh rather than reading it");
  }
  // The AP branch rewrites $DNSMASQ_SHARED/upstream-dns.conf when it can. As an
  // unprivileged user it cannot; refuse rather than edit a real NetworkManager
  // config from a unit test.
  let writable = false;
  try {
    accessSync(DNSMASQ_SHARED, constants.W_OK);
    writable = true;
  } catch {
    // Not writable or not there — the expected case.
  }
  if (writable) {
    throw new Error(`${DNSMASQ_SHARED} is writable by this user: run this suite unprivileged`);
  }
});

// Synthetic profiles only — no real network names, no PSKs.
const HOME = "11111111-1111-4111-8111-111111111111";
const OFFICE = "22222222-2222-4222-8222-222222222222";
const CAFE = "33333333-3333-4333-8333-333333333333";
const TWIN = "44444444-4444-4444-8444-444444444444";
const STALE_AP = "55555555-5555-4555-8555-555555555555";
const GARAGE_AP = "66666666-6666-4666-8666-666666666666";
const WIRED = "77777777-7777-4777-8777-777777777777";

interface Profile {
  uuid: string;
  name: string;
  type?: string;
  priority?: number;
  timestamp?: number;
  /** 802-11-wireless.mode; "" is unset (NetworkManager's default, infrastructure). */
  mode?: string;
  /** What `nmcli connection up` does for it: connect, fail, or exit 0 without connecting. */
  up?: "ok" | "fail" | "hollow";
}

/** nmcli's terse escaping, which applies to every value it prints with -t/-g. */
const nmEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

// The nmcli stand-in. State lives in $NMSTUB:
//   profiles   uuid, type, priority, timestamp, mode ("-" = unset), up, escaped name, name
//   active     uuid of the connection active on the radio ("" = none)
//   state      the radio's numeric NetworkManager device state
//   ethernet   "connected" or "unavailable"
//   late       a uuid NetworkManager autoconnects during the pre-AP scan's rescan
//   ap-busy    a uuid NetworkManager autoconnects when the AP's first activation fails
//   after-fail a uuid NetworkManager autoconnects when a client activation fails
//   calls      argv of every call, tab-joined, one per line
//   unsupported  any call this stand-in cannot answer faithfully
const NMCLI_STUB = `#!/usr/bin/env bash
NM="$NMSTUB"
IFC=${IFACE}
(IFS=$'\\t'; printf '%s\\n' "$*") >> "$NM/calls"
fields=""; get=0
while [ $# -gt 0 ]; do
  case "$1" in
    -t|--terse) shift ;;
    -f|--fields) fields="$2"; shift 2 ;;
    -g|--get-values) fields="$2"; get=1; shift 2 ;;
    -w|--wait|-e|--escape) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
active="$(cat "$NM/active" 2>/dev/null)"
state="$(cat "$NM/state" 2>/dev/null)"
[ -n "$state" ] || state=30
eth="$(cat "$NM/ethernet" 2>/dev/null)"
[ -n "$eth" ] || eth=unavailable

unsupported() { (IFS=$'\\t'; printf '%s\\n' "$*") >> "$NM/unsupported"; echo "stub nmcli: unsupported call" >&2; exit 2; }
set_active() { printf '%s' "$1" > "$NM/active"; printf '%s' "$2" > "$NM/state"; }
state_text() {
  case "$state" in
    100) echo "100 (connected)" ;;
    20) echo "20 (unavailable)" ;;
    *) echo "$state (disconnected)" ;;
  esac
}
read_profile() { IFS=$'\\t' read -r P_UUID P_TYPE P_PRIO P_TS P_MODE P_UP P_ESC P_NAME; }
# A profile the way nmcli resolves one: "uuid X", "id X", or a bare X.
find_profile() {
  while read_profile; do
    case "$1" in
      uuid) [ "$P_UUID" = "$2" ] && return 0 ;;
      id) [ "$P_NAME" = "$2" ] && return 0 ;;
      *) if [ "$P_NAME" = "$2" ] || [ "$P_UUID" = "$2" ]; then return 0; fi ;;
    esac
  done < "$NM/profiles"
  return 1
}
dev_of() {
  if [ -n "$active" ] && [ "$P_UUID" = "$active" ]; then echo "$IFC"
  elif [ "$P_TYPE" = 802-3-ethernet ] && [ "$eth" = connected ]; then echo eth0
  fi
}
project() {
  local out="" sep="" f v IFS=,
  for f in $fields; do
    case "$f" in
      NAME) v="$P_ESC" ;;
      UUID) v="$P_UUID" ;;
      TYPE) v="$P_TYPE" ;;
      AUTOCONNECT-PRIORITY) v="$P_PRIO" ;;
      TIMESTAMP) v="$P_TS" ;;
      DEVICE) v="$(dev_of)" ;;
      *) unsupported "field" "$f" ;;
    esac
    out="$out$sep$v"; sep=":"
  done
  printf '%s\\n' "$out"
}

case "$1 $2" in
  "general status")
    [ "$fields" = RUNNING ] || unsupported "$@"
    echo running ;;
  "device status")
    wstate=disconnected
    [ "$state" = 100 ] && wstate=connected
    [ "$state" = 20 ] && wstate=unavailable
    # One write, as nmcli does: start-ap.sh reads this through \`grep -q\` under
    # pipefail, and a stub writing line by line could take a SIGPIPE there.
    listing="$(while IFS=: read -r D T S; do
      out=""; sep=""
      for f in $(printf '%s' "$fields" | tr , ' '); do
        case "$f" in DEVICE) v="$D" ;; TYPE) v="$T" ;; STATE) v="$S" ;; *) unsupported "$@" ;; esac
        out="$out$sep$v"; sep=":"
      done
      echo "$out"
    done <<EOF
eth0:ethernet:$eth
$IFC:wifi:$wstate
lo:loopback:unmanaged
EOF
)"
    printf '%s\\n' "$listing" ;;
  "device show")
    [ "$3" = "$IFC" ] || { echo "Error: Device '$3' not found." >&2; exit 10; }
    [ "$fields" = GENERAL.STATE ] || unsupported "$@"
    if [ "$get" = 1 ]; then state_text; else echo "GENERAL.STATE:$(state_text)"; fi ;;
  "device disconnect")
    set_active "" 30 ;;
  "device wifi")
    case "$3" in
      rescan)
        late="$(cat "$NM/late" 2>/dev/null)"
        if [ -n "$late" ] && [ -z "$active" ]; then set_active "$late" 100; rm -f "$NM/late"; fi ;;
      list) echo "Synthetic-Neighbour:70:WPA2:2437 MHz" ;;
      *) unsupported "$@" ;;
    esac ;;
  "connection show")
    shift 2
    only_active=0
    if [ "$1" = "--active" ]; then only_active=1; shift; fi
    if [ $# -gt 0 ]; then
      kind=any; case "$1" in uuid|id) kind="$1"; shift ;; esac
      find_profile "$kind" "$1" || { echo "Error: $1 - no such connection profile." >&2; exit 10; }
      { [ "$get" = 1 ] && [ "$fields" = 802-11-wireless.mode ]; } || unsupported "$@"
      if [ "$P_MODE" = - ]; then echo ""; else echo "$P_MODE"; fi
      exit 0
    fi
    listing="$(while read_profile; do
      if [ "$only_active" = 1 ] && [ -z "$(dev_of)" ]; then continue; fi
      project
    done < "$NM/profiles")"
    if [ -n "$listing" ]; then printf '%s\\n' "$listing"; fi ;;
  "connection up")
    shift 2
    kind=any; case "$1" in uuid|id) kind="$1"; shift ;; esac
    find_profile "$kind" "$1" || { echo "Error: unknown connection '$1'." >&2; exit 10; }
    if [ "$P_MODE" = ap ]; then
      busy="$(cat "$NM/ap-busy" 2>/dev/null)"
      if [ -n "$busy" ]; then
        rm -f "$NM/ap-busy"; set_active "$busy" 100
        echo "Error: Connection activation failed: device busy" >&2; exit 4
      fi
      set_active "$P_UUID" 100; echo "Connection successfully activated"; exit 0
    fi
    case "$P_UP" in
      ok) set_active "$P_UUID" 100; echo "Connection successfully activated"; exit 0 ;;
      hollow) set_active "" 30; echo "Connection successfully activated"; exit 0 ;;
      *)
        set_active "" 30
        after="$(cat "$NM/after-fail" 2>/dev/null)"
        if [ -n "$after" ]; then rm -f "$NM/after-fail"; set_active "$after" 100; fi
        echo "Error: Connection activation failed: (53) The Wi-Fi network could not be found." >&2; exit 4 ;;
    esac ;;
  "connection down")
    shift 2
    kind=any; case "$1" in uuid|id) kind="$1"; shift ;; esac
    if find_profile "$kind" "$1" && [ -n "$active" ] && [ "$P_UUID" = "$active" ]; then set_active "" 30; exit 0; fi
    echo "Error: '$1' is not an active connection." >&2; exit 10 ;;
  "connection modify")
    shift 2
    kind=any; case "$1" in uuid|id) kind="$1"; shift ;; esac
    find_profile "$kind" "$1" || { echo "Error: unknown connection '$1'." >&2; exit 10; } ;;
  "connection delete")
    shift 2
    kind=any; case "$1" in uuid|id) kind="$1"; shift ;; esac
    find_profile "$kind" "$1" || { echo "Error: unknown connection '$1'." >&2; exit 10; }
    awk -F'\\t' -v u="$P_UUID" '$1 != u' "$NM/profiles" > "$NM/profiles.new" && mv "$NM/profiles.new" "$NM/profiles"
    if [ "$P_UUID" = "$active" ]; then set_active "" 30; fi ;;
  "connection add")
    shift 2
    con=""; mode="-"
    while [ $# -gt 0 ]; do
      case "$1" in con-name) con="$2"; shift 2 ;; wifi.mode|802-11-wireless.mode) mode="$2"; shift 2 ;; *) shift ;; esac
    done
    printf 'a9a9a9a9-0000-4000-8000-0000000000a9\\t802-11-wireless\\t0\\t0\\t%s\\tok\\t%s\\t%s\\n' "$mode" "$con" "$con" >> "$NM/profiles"
    echo "Connection '$con' successfully added." ;;
  *) unsupported "$@" ;;
esac
`;

// iw reports AP mode exactly when the active connection is an access-point profile.
const IW_STUB = `#!/usr/bin/env bash
a="$(cat "$NMSTUB/active" 2>/dev/null)"
m=""
[ -n "$a" ] && m="$(awk -F'\\t' -v u="$a" '$1 == u {print $5}' "$NMSTUB/profiles")"
t=managed
[ "$m" = ap ] && t=AP
printf 'Interface ${IFACE}\\n\\ttype %s\\n' "$t"
`;

let root: string;
let nm: string;

function makeBox(opts: {
  setupComplete: boolean;
  hotspotEnv?: string;
  ethernet?: boolean;
  profiles: Profile[];
  /** uuid of the connection already active on the radio (device state 100). */
  active?: string;
  late?: string;
  apBusy?: string;
  afterFail?: string;
}) {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-start-ap-"));
  nm = path.join(root, "nm");
  const bin = path.join(root, "bin");
  for (const d of [path.join(root, "data"), nm, bin]) mkdirSync(d, { recursive: true });

  writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ setup_complete: opts.setupComplete }));
  if (opts.hotspotEnv !== undefined) writeFileSync(path.join(root, "data", "hotspot.env"), opts.hotspotEnv);

  const rows = [{ uuid: WIRED, name: "Wired connection 1", type: "802-3-ethernet" }, ...opts.profiles].map((p: Profile) =>
    [
      p.uuid,
      p.type ?? "802-11-wireless",
      String(p.priority ?? 0),
      String(p.timestamp ?? 0),
      p.mode === undefined ? "infrastructure" : p.mode || "-",
      p.up ?? "fail",
      nmEscape(p.name),
      p.name,
    ].join("\t"),
  );
  writeFileSync(path.join(nm, "profiles"), rows.join("\n") + "\n");
  writeFileSync(path.join(nm, "active"), opts.active ?? "");
  writeFileSync(path.join(nm, "state"), opts.active ? "100" : "30");
  writeFileSync(path.join(nm, "ethernet"), opts.ethernet ? "connected" : "unavailable");
  if (opts.late) writeFileSync(path.join(nm, "late"), opts.late);
  if (opts.apBusy) writeFileSync(path.join(nm, "ap-busy"), opts.apBusy);
  if (opts.afterFail) writeFileSync(path.join(nm, "after-fail"), opts.afterFail);
  writeFileSync(path.join(nm, "calls"), "");

  writeFileSync(path.join(bin, "nmcli"), NMCLI_STUB, { mode: 0o755 });
  writeFileSync(path.join(bin, "iw"), IW_STUB, { mode: 0o755 });
  // No upstream address (so no subnet collision), no real sleeps, no firewall.
  for (const tool of ["ip", "sysctl", "iptables", "sleep"]) {
    writeFileSync(path.join(bin, tool), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  }
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** argv of every nmcli call, in order. */
  calls: string[][];
  /** The same, space-joined, for readable assertions. */
  lines: string[];
}

function runStartAp(): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["SKIP_PRESCAN", "HOTSPOT_SSID", "HOTSPOT_PASSWORD", "HOTSPOT_DISABLED", "CLIENT_UP_WAIT"]) delete env[k];
  const res = spawnSync("bash", [START_AP], {
    env: {
      ...env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
      CLAWBOX_ROOT: root,
      NMSTUB: nm,
      NETWORK_INTERFACE: IFACE,
      NM_READY_TIMEOUT: "2",
      IFACE_TIMEOUT: "1",
      PRE_AP_SCAN_TIMEOUT: "0",
      AP_UP_RETRIES: "3",
    },
    encoding: "utf-8",
    timeout: 25_000,
  });
  const calls = readFileSync(path.join(nm, "calls"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
  // A call the stand-in could not answer would make every assertion below a
  // statement about the stub, not the script.
  expect(existsSync(path.join(nm, "unsupported")) ? readFileSync(path.join(nm, "unsupported"), "utf-8") : "").toBe("");
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", calls, lines: calls.map((c) => c.join(" ")) };
}

const has = (args: string[], ...words: string[]) => words.every((w) => args.includes(w));
const isClientUp = (a: string[]) => has(a, "connection", "up") && !a.includes("ClawBox-Setup");
/** Anything that builds the hotspot or takes the radio away from a client. */
const isApActivity = (a: string[]) =>
  a.includes("ClawBox-Setup") || has(a, "device", "disconnect") || has(a, "connection", "down");
const firstIndex = (r: Run, pred: (a: string[]) => boolean) => r.calls.findIndex(pred);

/** What every run must hold, whatever the scenario. */
function expectSafeCalls(r: Run) {
  for (const a of r.calls) {
    expect(a, "never ask nmcli for secrets").not.toContain("--show-secrets");
    // Saved profiles are acted on by UUID; only the hotspot is addressed by its name.
    if (a[a.indexOf("connection") + 1] && ["up", "down", "modify"].includes(a[a.indexOf("connection") + 1])) {
      if (!a.includes("ClawBox-Setup")) expect(a, `${a.join(" ")} must select the profile by uuid`).toContain("uuid");
    }
  }
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("start-ap.sh keeps a saved WiFi client instead of taking the radio for the hotspot", () => {
  it("leaves alone a saved network NetworkManager already autoconnected (the update-reboot failure)", () => {
    makeBox({
      setupComplete: true,
      profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }],
      active: HOME,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.lines.filter((l) => /connection (down|up|add|delete)|device disconnect/.test(l))).toEqual([]);
    expect(r.lines.filter((l) => l.includes("ClawBox-Setup"))).toEqual([]);
    expect(existsSync(path.join(root, "data", "ap-runtime.env")), "the hotspot was published").toBe(false);
    expect(r.stdout).toContain("Example-Home");
    expectSafeCalls(r);
  });

  it("brings an inactive saved network up by UUID before any hotspot activity", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }] });
    const r = runStartAp();
    expect(r.status).toBe(0);
    const up = firstIndex(r, isClientUp);
    expect(up, "no saved network was tried").toBeGreaterThanOrEqual(0);
    expect(r.calls[up]).toEqual(["--wait", "45", "connection", "up", "uuid", HOME, "ifname", IFACE]);
    // Success is the device state, read after the activation.
    const verified = r.calls.findIndex((a, i) => i > up && has(a, "GENERAL.STATE", "device", "show"));
    expect(verified).toBeGreaterThan(up);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expectSafeCalls(r);
  });

  it.each([
    ["inactive", undefined],
    ["already connected", "tricky"],
  ])("finds a client whose name has ':', '\\\\' and 'ClawBox-Setup' in it (%s)", (_label, activeFlag) => {
    const tricky = String.raw`ClawBox-Setup-home: attic\loft`;
    makeBox({
      setupComplete: true,
      profiles: [
        { uuid: HOME, name: tricky, up: "ok" },
        // Same name, lower priority: only its UUID tells it apart.
        { uuid: TWIN, name: tricky, priority: -1, up: "fail" },
      ],
      active: activeFlag ? HOME : undefined,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expect(r.calls.some((a) => a.includes(TWIN) && has(a, "connection", "up"))).toBe(false);
    if (activeFlag) {
      expect(r.calls.filter(isClientUp)).toEqual([]);
    } else {
      expect(r.calls.filter(isClientUp).map((a) => a[a.indexOf("uuid") + 1])).toEqual([HOME]);
    }
    // The log shows the name as the owner knows it, not nmcli's escaped form.
    expect(r.stdout).toContain(`'${tricky}'`);
    expectSafeCalls(r);
  });

  it("never tries the hotspot profile or another access-point profile as a client", () => {
    makeBox({
      setupComplete: true,
      profiles: [
        // Each is excluded by one rule alone: this one only by its exact name
        // (its mode is unset, which reads as infrastructure)...
        { uuid: STALE_AP, name: "ClawBox-Setup", mode: "", up: "ok" },
        // ...and this one only by its mode.
        { uuid: GARAGE_AP, name: "Garage-Hotspot", mode: "ap", priority: 50, up: "ok" },
      ],
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.calls.some((a) => has(a, "connection", "up") && (a.includes(STALE_AP) || a.includes(GARAGE_AP)))).toBe(false);
    expect(r.stdout).toContain("No saved WiFi client profiles");
    expect(r.lines).toContainEqual(expect.stringMatching(/^connection add .*con-name ClawBox-Setup/));
    expect(r.lines).toContain("connection up ClawBox-Setup");
    expectSafeCalls(r);
  });

  it("does not count another access point that holds the radio as a joined network", () => {
    makeBox({
      setupComplete: true,
      profiles: [{ uuid: GARAGE_AP, name: "Garage-Hotspot", mode: "ap", up: "ok" }],
      active: GARAGE_AP,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("skipping AP mode");
    expect(r.lines).toContain("connection up ClawBox-Setup");
    expectSafeCalls(r);
  });

  it("tries saved clients by priority, then most recent use, and stops at the first that connects", () => {
    makeBox({
      setupComplete: true,
      // Listed in the order nmcli prints them, which is NOT the preferred order.
      profiles: [
        { uuid: CAFE, name: "Example-Cafe", priority: 0, timestamp: 1000, up: "ok" },
        { uuid: OFFICE, name: "Example-Office", priority: 0, timestamp: 2000, up: "ok" },
        { uuid: HOME, name: "Example-Home", priority: 10, timestamp: 10, up: "fail" },
      ],
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.calls.filter(isClientUp).map((a) => a[a.indexOf("uuid") + 1])).toEqual([HOME, OFFICE]);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expectSafeCalls(r);
  });

  it("raises the hotspot only after every saved client has failed", () => {
    makeBox({
      setupComplete: true,
      profiles: [
        { uuid: CAFE, name: "Example-Cafe", priority: 0, timestamp: 1000, up: "fail" },
        { uuid: OFFICE, name: "Example-Office", priority: 0, timestamp: 2000, up: "hollow" },
        { uuid: HOME, name: "Example-Home", priority: 10, timestamp: 10, up: "fail" },
      ],
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.calls.filter(isClientUp).map((a) => a[a.indexOf("uuid") + 1])).toEqual([HOME, OFFICE, CAFE]);
    const lastClient = r.calls.map((a, i) => (isClientUp(a) ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
    const firstAp = firstIndex(r, isApActivity);
    expect(firstAp).toBeGreaterThan(lastClient);
    expect(r.stdout).toContain("returned success but interface not connected");
    expect(r.stdout).toContain("No saved WiFi profiles connected, falling back to AP mode");
    expect(r.lines).toContain("connection up ClawBox-Setup");
    expectSafeCalls(r);
  });

  it("still falls back to the hotspot when there is no saved client at all", () => {
    makeBox({ setupComplete: true, profiles: [] });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.lines).toContainEqual(expect.stringMatching(/^connection add .*con-name ClawBox-Setup/));
    expect(r.lines).toContain("connection up ClawBox-Setup");
    // The seam: the caches land under CLAWBOX_ROOT, where the web server reads them.
    expect(readFileSync(path.join(root, "data", "ap-runtime.env"), "utf-8")).toContain('AP_IP="10.42.0.1"');
    expect(readFileSync(path.join(root, "data", "wifi-scan-cache.json"), "utf-8")).toContain("Synthetic-Neighbour");
    expectSafeCalls(r);
  });
});

describe("start-ap.sh rechecks for a late NetworkManager autoconnect before taking the radio", () => {
  it("keeps a client that autoconnected during the pre-AP scan", () => {
    makeBox({
      setupComplete: true,
      profiles: [{ uuid: HOME, name: "Example-Home", up: "fail" }],
      late: HOME,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("before the hotspot was set up");
    const scan = firstIndex(r, (a) => has(a, "wifi", "rescan"));
    expect(scan, "the pre-AP scan did not run").toBeGreaterThanOrEqual(0);
    expect(r.calls.slice(scan).filter(isApActivity)).toEqual([]);
    expect(existsSync(path.join(root, "data", "ap-runtime.env"))).toBe(false);
    expectSafeCalls(r);
  });

  it("keeps a client NetworkManager autoconnected while a saved-client attempt was failing", () => {
    // Activating the next candidate would knock that connection down again.
    makeBox({
      setupComplete: true,
      profiles: [
        { uuid: HOME, name: "Example-Home", priority: 10, up: "fail" },
        { uuid: CAFE, name: "Example-Cafe", priority: 5, up: "fail" },
        { uuid: OFFICE, name: "Example-Office", priority: 0, up: "ok" },
      ],
      afterFail: OFFICE,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.calls.filter(isClientUp).map((a) => a[a.indexOf("uuid") + 1])).toEqual([HOME]);
    expect(r.stdout).toContain("by autoconnect");
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expectSafeCalls(r);
  });

  it("keeps a client that grabbed the radio when an AP activation attempt failed", () => {
    makeBox({
      setupComplete: true,
      profiles: [{ uuid: HOME, name: "Example-Home", up: "fail" }],
      apBusy: HOME,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("before AP attempt 2");
    expect(r.lines.filter((l) => l === "connection up ClawBox-Setup")).toHaveLength(1);
    const busy = r.lines.indexOf("connection up ClawBox-Setup");
    expect(r.calls.slice(busy + 1).filter(isApActivity)).toEqual([]);
    expectSafeCalls(r);
  });
});

// The cases below pin behaviour the fix must NOT change, so they say nothing
// about HOW a profile is addressed (by name before the fix, by UUID after it):
// they pass on the old script too, which is what shows the behaviour is kept.
// UUID addressing has its own tests above and in the last block.
const targets = (a: string[], uuid: string, name: string) => a.includes(uuid) || a.includes(name);
const released = (r: Run, uuid: string, name: string) =>
  r.calls.some((a) => has(a, "connection", "down") && targets(a, uuid, name));
const autoconnectOff = (r: Run, uuid: string, name: string) =>
  r.calls.some((a) => has(a, "connection", "modify", "connection.autoconnect", "no") && targets(a, uuid, name));

describe("start-ap.sh keeps the hotspot behaviour it had", () => {
  it("with an Ethernet uplink, hosts the hotspot and does not join saved WiFi", () => {
    makeBox({
      setupComplete: true,
      ethernet: true,
      profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }],
      active: HOME,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.calls.filter(isClientUp)).toEqual([]);
    expect(autoconnectOff(r, HOME, "Example-Home")).toBe(true);
    expect(released(r, HOME, "Example-Home")).toBe(true);
    expect(r.lines).toContain("connection up ClawBox-Setup");
  });

  it("before setup is complete, the hotspot owns the radio even over a live client", () => {
    makeBox({
      setupComplete: false,
      profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }],
      active: HOME,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.calls.filter(isClientUp)).toEqual([]);
    expect(autoconnectOff(r, HOME, "Example-Home")).toBe(true);
    expect(released(r, HOME, "Example-Home")).toBe(true);
    expect(r.lines).toContain("connection up ClawBox-Setup");
  });

  it("before setup is complete, a client that autoconnects during the scan is still released", () => {
    makeBox({
      setupComplete: false,
      profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }],
      late: HOME,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(released(r, HOME, "Example-Home")).toBe(true);
    expect(r.lines).toContain("connection up ClawBox-Setup");
  });

  it("skips AP mode without touching the radio when the owner disabled the hotspot after setup", () => {
    makeBox({
      setupComplete: true,
      hotspotEnv: "HOTSPOT_SSID='ClawBox-Setup'\nHOTSPOT_DISABLED=1\n",
      profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }],
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Hotspot disabled in settings");
    expect(r.calls).toEqual([]);
  });

  it("before setup is complete, HOTSPOT_DISABLED alone does not stop the hotspot (unchanged)", () => {
    makeBox({
      setupComplete: false,
      hotspotEnv: "HOTSPOT_DISABLED=1\n",
      profiles: [],
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.lines).toContain("connection up ClawBox-Setup");
  });
});

describe("release_wifi_for_ap reads profiles with the same parser", () => {
  it("frees the radio from a client whose name contains ':' and keeps it from autoconnecting", () => {
    // `IFS=: read -r con ctype` cut "Example\: Home:802-11-wireless" at the
    // escaped colon, so the TYPE never matched and the profile was skipped:
    // left on autoconnect, it took the radio back from the hotspot.
    makeBox({
      setupComplete: false,
      profiles: [{ uuid: HOME, name: "Example: Home", up: "ok" }],
      active: HOME,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.lines).toContain(`connection modify uuid ${HOME} connection.autoconnect no`);
    expect(r.lines).toContain(`connection down uuid ${HOME}`);
    expect(r.lines).toContain("connection up ClawBox-Setup");
    expectSafeCalls(r);
  });

  it("spares only the hotspot itself, by its exact name", () => {
    makeBox({
      setupComplete: false,
      profiles: [
        { uuid: HOME, name: "ClawBox-Setup-home", up: "ok" },
        { uuid: GARAGE_AP, name: "Garage-Hotspot", mode: "ap", up: "ok" },
      ],
      active: HOME,
    });
    const r = runStartAp();
    expect(r.status).toBe(0);
    for (const u of [HOME, GARAGE_AP]) {
      expect(r.lines).toContain(`connection modify uuid ${u} connection.autoconnect no`);
      expect(r.lines).toContain(`connection down uuid ${u}`);
    }
    // The one it creates is never released.
    expect(r.lines.filter((l) => /^connection (down|modify) uuid a9a9a9a9-/.test(l))).toEqual([]);
    expectSafeCalls(r);
  });
});

describe("start-ap.sh's test seam leaves production paths alone", () => {
  it("defaults CLAWBOX_ROOT to the appliance tree, and nothing root-run sets it", () => {
    const src = readFileSync(START_AP, "utf-8");
    expect(src).toMatch(/^ROOT="\$\{CLAWBOX_ROOT:-\/home\/clawbox\/clawbox\}"$/m);
    for (const v of ["CONFIG_FILE", "HOTSPOT_ENV", "SCAN_CACHE", "RUNTIME_FILE"]) {
      expect(src).toMatch(new RegExp(`^${v}="\\$ROOT/data/[a-z.-]+"$`, "m"));
    }
    // Every data path goes through the seam; none is left hard-coded beside it.
    expect(src.split("\n").filter((l) => !/^\s*#/.test(l) && l.includes("/home/clawbox/clawbox/data"))).toEqual([]);
    for (const unit of ["clawbox-ap.service", "clawbox-ap-watchdog.service"]) {
      expect(readFileSync(path.join(REPO, "config", unit), "utf-8")).not.toContain("CLAWBOX_ROOT");
    }
  });
});
