import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * TASK-1380, the follow-up regressions. start-ap-saved-wifi.test.ts proves the
 * fix itself — a saved WiFi client is found, kept, or tried before the hotspot
 * takes the radio. These cases push on the edges of HOW scripts/start-ap.sh
 * reads NetworkManager:
 *
 *   - a profile NAME that looks like another profile's UUID;
 *   - a name with a newline, an escape sequence, a tab or 100 characters in it;
 *   - ordering ties, negative priorities and values nmcli should never print;
 *   - an `802-11-wireless.mode` query that fails for one profile;
 *   - the bounds on what one run does: the `--wait` on every client attempt,
 *     one attempt per profile, at most AP_UP_RETRIES hotspot activations;
 *   - a profile an earlier Ethernet-uplink run set to autoconnect=no, on a box
 *     that later boots without Ethernet.
 *
 * Like the first suite, these EXECUTE the shipped script with nmcli, iw, sleep
 * and friends stubbed on PATH. The nmcli stand-in keeps a model of
 * NetworkManager — saved profiles, the connection on the radio, the device
 * state, each profile's autoconnect flag — and answers in nmcli's terse format.
 * Every assertion is about argv the script handed nmcli, what it printed, or
 * the state it left the model in.
 *
 * N5/N8 below promote the original external red evidence into regressions.
 * Inhibition is modelled, not proof of a real NM atomic activation barrier.
 */

// Starts real processes: vitest's 5 s test and 10 s hook defaults are not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const START_AP = path.join(REPO, "scripts", "start-ap.sh");
const IFACE = "wlTEST0";
// The one host path the AP branch writes outside $CLAWBOX_ROOT; see beforeAll.
const DNSMASQ_SHARED = "/etc/NetworkManager/dnsmasq-shared.d";
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

beforeAll(() => {
  // Unconditional, not skipIf: a suite that skips itself on a runner without
  // bash reports green while proving nothing.
  if (!hasBash) {
    throw new Error("bash is required: these tests execute scripts/start-ap.sh rather than reading it");
  }
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
const LOFT = "44444444-4444-4444-8444-444444444444";
const GARAGE = "55555555-5555-4555-8555-555555555555";
const ATTIC = "66666666-6666-4666-8666-666666666666";
const WIRED = "77777777-7777-4777-8777-777777777777";
/** Shaped like a UUID, and the UUID of no profile anywhere in these tests. */
const NOBODY = "99999999-9999-4999-8999-999999999999";
/** The UUID the stand-in gives the hotspot profile start-ap.sh creates. */
const HOTSPOT = "a9a9a9a9-0000-4000-8000-0000000000a9";

interface Profile {
  uuid: string;
  name: string;
  type?: string;
  /** What nmcli prints in AUTOCONNECT-PRIORITY; a string for values it never should. */
  priority?: number | string;
  /** What nmcli prints in TIMESTAMP; a string for values it never should. */
  timestamp?: number | string;
  /** 802-11-wireless.mode; "" is unset (NetworkManager's default, infrastructure). */
  mode?: string;
  /** `nmcli -g 802-11-wireless.mode connection show uuid <it>` exits with this status. */
  modeQueryExit?: number;
  /** What `nmcli connection up` does for it: connect, fail, or exit 0 without connecting. */
  up?: "ok" | "fail" | "hollow";
}

/**
 * nmcli's terse escaping, which applies to every value it prints with -t/-g:
 * ':' and '\' are backslash-escaped and NOTHING else is (nmcli(1), --escape).
 * A newline or an ESC in a name is printed as the raw byte. Whether
 * NetworkManager accepts such a connection.id at all is not established here;
 * if it does, this is how nmcli prints it.
 */
const nmEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

// The nmcli stand-in. State lives in $NMSTUB:
//   p/NNN/meta   uuid, type, priority, timestamp, mode, up, autoconnect,
//                mode-query exit status — tab-separated, "-" for unset/none
//   p/NNN/name   the name, raw;  p/NNN/esc  the name as nmcli prints it
//   active       uuid of the connection on the radio ("" = none)
//   state        the radio's numeric NetworkManager device state
//   ethernet     "connected" or "unavailable"
//   ap-plan      outcomes of successive hotspot activations: busy | hollow | ok
//   calls        argv of every nmcli call, tab-joined, one per line
//   trace        nmcli and sleep calls interleaved, in the order they ran
//   unsupported  any call this stand-in cannot answer faithfully
// Profiles are listed in directory order, which is the order nmcli prints them.
const NMCLI_STUB = `#!/usr/bin/env bash
NM="$NMSTUB"
IFC=${IFACE}
TAB=$'\\t'
# One line per call: a newline inside an argument is logged as the two
# characters \\n, so it cannot pass for the start of another call.
joined() {
  local a out="" sep=""
  for a in "$@"; do out+="$sep\${a//$'\\n'/\\\\n}"; sep="$TAB"; done
  printf '%s\\n' "$out"
}
joined "$@" >> "$NM/calls"
{ printf 'nmcli\\t'; joined "$@"; } >> "$NM/trace"

fields=""; get=0; raw=0
while [ $# -gt 0 ]; do
  case "$1" in
    -t|--terse) shift ;;
    -f|--fields) fields="$2"; shift 2 ;;
    -g|--get-values) fields="$2"; get=1; shift 2 ;;
    -e|--escape) [ "$2" = no ] && raw=1; shift 2 ;;
    -w|--wait) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
active=""; state=""; eth=""
read -r active < "$NM/active" || true
read -r state < "$NM/state" || true
read -r eth < "$NM/ethernet" || true
[ -n "$state" ] || state=30
[ -n "$eth" ] || eth=unavailable

unsupported() { joined "$@" >> "$NM/unsupported"; echo "stub nmcli: unsupported call" >&2; exit 2; }
set_active() { printf '%s' "$1" > "$NM/active"; printf '%s' "$2" > "$NM/state"; }
state_text() {
  case "$state" in
    100) echo "100 (connected)" ;;
    20) echo "20 (unavailable)" ;;
    *) echo "$state (disconnected)" ;;
  esac
}
load() {
  P_DIR="$1"
  IFS="$TAB" read -r P_UUID P_TYPE P_PRIO P_TS P_MODE P_UP P_AC P_MODEFAIL < "$1/meta"
  P_NAME=""; P_ESC=""
  IFS= read -r -d '' P_NAME < "$1/name" || true
  IFS= read -r -d '' P_ESC < "$1/esc" || true
}
save_meta() {
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$P_UUID" "$P_TYPE" "$P_PRIO" "$P_TS" "$P_MODE" "$P_UP" "$P_AC" "$P_MODEFAIL" > "$P_DIR/meta"
}
# A profile the way nmcli resolves one: "uuid X", "id X", or a bare X — the
# first profile in listing order whose name OR uuid is X.
find_profile() {
  local d
  for d in "$NM"/p/*; do
    [ -e "$d/meta" ] || continue
    load "$d"
    case "$1" in
      uuid) [ "$P_UUID" = "$2" ] && return 0 ;;
      id) [ "$P_NAME" = "$2" ] && return 0 ;;
      *) if [ "$P_NAME" = "$2" ] || [ "$P_UUID" = "$2" ]; then return 0; fi ;;
    esac
  done
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
      NAME) if [ "$raw" = 1 ]; then v="$P_NAME"; else v="$P_ESC"; fi ;;
      UUID) v="$P_UUID" ;;
      TYPE) v="$P_TYPE" ;;
      AUTOCONNECT) v="$P_AC" ;;
      AUTOCONNECT-PRIORITY) v="$P_PRIO" ;;
      TIMESTAMP) v="$P_TS" ;;
      DEVICE) v="$(dev_of)" ;;
      *) unsupported "field" "$f" ;;
    esac
    out+="$sep$v"; sep=":"
  done
  printf '%s\\n' "$out"
}
selector() { kind=any; case "$1" in uuid|id) kind="$1"; return 0 ;; esac; return 1; }

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
    if [ "$fields" = GENERAL.AUTOCONNECT ]; then
      if [ -f "$NM/device-ac" ]; then cat "$NM/device-ac"; else echo yes; fi
      exit 0
    fi
    [ "$fields" = GENERAL.STATE ] || unsupported "$@"
    if [ "$get" = 1 ]; then state_text; else echo "GENERAL.STATE:$(state_text)"; fi ;;
  "device set")
    [ "$3" = "$IFC" ] && [ "$4" = autoconnect ] || unsupported "$@"
    case "$5" in yes|no) printf '%s' "$5" > "$NM/device-ac" ;; *) unsupported "$@" ;; esac ;;
  "device disconnect")
    set_active "" 30 ;;
  "device wifi")
    case "$3" in
      rescan) ;;
      list) echo "Synthetic-Neighbour:70:WPA2:2437 MHz" ;;
      *) unsupported "$@" ;;
    esac ;;
  "connection show")
    shift 2
    only_active=0
    if [ "$1" = "--active" ]; then only_active=1; shift; fi
    if [ $# -gt 0 ]; then
      selector "$1" && shift
      find_profile "$kind" "$1" || { echo "Error: $1 - no such connection profile." >&2; exit 10; }
      [ "$get" = 1 ] || unsupported "$@"
      case "$fields" in
        connection.uuid,connection.id,connection.interface-name,802-11-wireless.mode,802-11-wireless.ssid)
          printf '%s\\n' "$P_UUID" "$P_NAME" "$(cat "$P_DIR/iface")" "$P_MODE" "$(cat "$P_DIR/ssid")" ;;
        802-11-wireless.mode)
          if [ "$P_MODEFAIL" != - ]; then
            echo "Error: synthetic failure reading 802-11-wireless.mode" >&2; exit "$P_MODEFAIL"
          fi
          if [ "$P_MODE" = - ]; then echo ""; else echo "$P_MODE"; fi ;;
        connection.interface-name) echo "$IFC" ;;
        connection.autoconnect) echo "$P_AC" ;;
        connection.id) printf '%s\\n' "$P_ESC" ;;
        *) unsupported "$@" ;;
      esac
      exit 0
    fi
    listing="$(for d in "$NM"/p/*; do
      [ -e "$d/meta" ] || continue
      load "$d"
      if [ "$only_active" = 1 ] && [ -z "$(dev_of)" ]; then continue; fi
      project
    done)"
    if [ -n "$listing" ]; then printf '%s\\n' "$listing"; fi ;;
  "connection up")
    shift 2
    selector "$1" && shift
    find_profile "$kind" "$1" || { echo "Error: unknown connection '$1'." >&2; exit 10; }
    if [ "$P_MODE" = ap ]; then
      outcome=""; rest=""
      if [ -s "$NM/ap-plan" ]; then read -r outcome rest < "$NM/ap-plan"; printf '%s\\n' "$rest" > "$NM/ap-plan"; fi
      case "$outcome" in
        busy) set_active "" 30; echo "Error: Connection activation failed: device busy" >&2; exit 4 ;;
        hollow) set_active "" 30; echo "Connection successfully activated"; exit 0 ;;
        *) set_active "$P_UUID" 100; echo "Connection successfully activated"; exit 0 ;;
      esac
    fi
    case "$P_UP" in
      ok) set_active "$P_UUID" 100; echo "Connection successfully activated"; exit 0 ;;
      hollow) set_active "" 30; echo "Connection successfully activated"; exit 0 ;;
      *) set_active "" 30; echo "Error: Connection activation failed: (53) The Wi-Fi network could not be found." >&2; exit 4 ;;
    esac ;;
  "connection down")
    shift 2
    selector "$1" && shift
    if find_profile "$kind" "$1" && [ -n "$active" ] && [ "$P_UUID" = "$active" ]; then set_active "" 30; exit 0; fi
    echo "Error: '$1' is not an active connection." >&2; exit 10 ;;
  "connection modify")
    shift 2
    selector "$1" && shift
    find_profile "$kind" "$1" || { echo "Error: unknown connection '$1'." >&2; exit 10; }
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        connection.autoconnect)
          case "$2" in no|false|off|0) P_AC=no ;; *) P_AC=yes ;; esac
          save_meta; shift 2 ;;
        *) shift ;;
      esac
    done ;;
  "connection delete")
    shift 2
    selector "$1" && shift
    find_profile "$kind" "$1" || { echo "Error: unknown connection '$1'." >&2; exit 10; }
    rm -rf "$P_DIR"
    if [ "$P_UUID" = "$active" ]; then set_active "" 30; fi ;;
  "connection add")
    shift 2
    con=""; mode="-"; ac=yes; ssid=""; iface=""
    while [ $# -gt 0 ]; do
      case "$1" in
        connection.uuid) echo "Error: failed to modify connection.uuid: the property can't be changed." >&2; exit 2 ;;
        ssid) ssid="$2"; shift 2 ;;
        ifname) iface="$2"; shift 2 ;;
        con-name) con="$2"; shift 2 ;;
        wifi.mode|802-11-wireless.mode) mode="$2"; shift 2 ;;
        autoconnect|connection.autoconnect) case "$2" in no|false|off|0) ac=no ;; *) ac=yes ;; esac; shift 2 ;;
        *) shift ;;
      esac
    done
    next=0
    for d in "$NM"/p/*; do
      [ -e "$d/meta" ] || continue
      n=$((10#$(basename "$d")))
      [ "$n" -ge "$next" ] && next=$((n + 1))
    done
    d="$(printf '%s/p/%03d' "$NM" "$next")"
    mkdir -p "$d"
    printf '%s' "$ssid" > "$d/ssid"
    printf '%s' "$iface" > "$d/iface"
    printf '${HOTSPOT}\\t802-11-wireless\\t0\\t0\\t%s\\tok\\t%s\\t-\\n' "$mode" "$ac" > "$d/meta"
    printf '%s' "$con" > "$d/name"
    printf '%s' "$con" > "$d/esc"
    echo "Connection '$con' (${HOTSPOT}) successfully added." ;;
  *) unsupported "$@" ;;
esac
`;

// iw reports AP mode exactly when the connection on the radio is an access-point profile.
const IW_STUB = `#!/usr/bin/env bash
a=""; read -r a < "$NMSTUB/active" || true
m=""
[ -n "$a" ] && m="$(awk -F'\\t' -v u="$a" '$1 == u {print $5}' "$NMSTUB"/p/*/meta 2>/dev/null)"
t=managed
[ "$m" = ap ] && t=AP
printf 'Interface ${IFACE}\\n\\ttype %s\\n' "$t"
`;

// The script's own pauses, recorded in order with the nmcli calls, never slept.
const SLEEP_STUB = `#!/usr/bin/env bash
printf 'sleep\\t%s\\n' "$*" >> "$NMSTUB/trace"
`;

let root: string;
let nm: string;

const field = (v: string | number, what: string) => {
  const s = String(v);
  // The stand-in's meta file is tab-separated, and bash's read folds empty fields.
  if (s === "" || /[\t\n]/.test(s)) throw new Error(`stub ${what} must be a non-empty single token: ${JSON.stringify(s)}`);
  return s;
};

function writeProfile(index: number, p: Profile) {
  const dir = path.join(nm, "p", String(index).padStart(3, "0"));
  mkdirSync(dir, { recursive: true });
  const meta = [
    field(p.uuid, "uuid"),
    field(p.type ?? "802-11-wireless", "type"),
    field(p.priority ?? 0, "priority"),
    field(p.timestamp ?? 0, "timestamp"),
    p.mode === undefined ? "infrastructure" : field(p.mode || "-", "mode"),
    p.up ?? "fail",
    "yes",
    p.modeQueryExit === undefined ? "-" : field(p.modeQueryExit, "mode query exit"),
  ];
  writeFileSync(path.join(dir, "meta"), meta.join("\t") + "\n");
  writeFileSync(path.join(dir, "name"), p.name);
  writeFileSync(path.join(dir, "esc"), nmEscape(p.name));
}

function makeBox(opts: {
  setupComplete: boolean;
  ethernet?: boolean;
  /** In the order nmcli lists them. */
  profiles: Profile[];
  /** uuid of the connection already active on the radio (device state 100). */
  active?: string;
  /** Outcomes of successive hotspot activations; any beyond the plan succeed. */
  apPlan?: Array<"busy" | "hollow" | "ok">;
}) {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-start-ap-edges-"));
  nm = path.join(root, "nm");
  const bin = path.join(root, "bin");
  for (const d of [path.join(root, "data"), path.join(nm, "p"), bin]) mkdirSync(d, { recursive: true });

  writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ setup_complete: opts.setupComplete }));
  [{ uuid: WIRED, name: "Wired connection 1", type: "802-3-ethernet" }, ...opts.profiles].forEach((p, i) => writeProfile(i, p));
  writeFileSync(path.join(nm, "active"), opts.active ?? "");
  writeFileSync(path.join(nm, "state"), opts.active ? "100" : "30");
  writeFileSync(path.join(nm, "ethernet"), opts.ethernet ? "connected" : "unavailable");
  writeFileSync(path.join(nm, "ap-plan"), (opts.apPlan ?? []).join(" ") + "\n");
  writeFileSync(path.join(nm, "calls"), "");
  writeFileSync(path.join(nm, "trace"), "");

  writeFileSync(path.join(bin, "nmcli"), NMCLI_STUB, { mode: 0o755 });
  writeFileSync(path.join(bin, "iw"), IW_STUB, { mode: 0o755 });
  writeFileSync(path.join(bin, "sleep"), SLEEP_STUB, { mode: 0o755 });
  // No upstream address (so no subnet collision), no firewall.
  for (const tool of ["ip", "sysctl", "iptables"]) {
    writeFileSync(path.join(bin, tool), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  }
}

/** A profile's modelled state, as the script's own calls left it. */
function profileState(uuid: string): { autoconnect: string } {
  for (const d of readdirSync(path.join(nm, "p"))) {
    const meta = readFileSync(path.join(nm, "p", d, "meta"), "utf-8").trimEnd().split("\t");
    if (meta[0] === uuid) return { autoconnect: meta[6] };
  }
  throw new Error(`no profile ${uuid} in the model`);
}

/**
 * Power-cycle the modelled box. The radio comes back idle; NetworkManager then
 * autoconnects a saved client only if that profile still has autoconnect=yes
 * (first in listing order — its real choice also weighs priority, which no
 * test here depends on). The call log starts afresh.
 */
function reboot(opts: { ethernet: boolean }) {
  let active = "";
  for (const d of readdirSync(path.join(nm, "p")).sort()) {
    const [uuid, type, , , mode, up, autoconnect] = readFileSync(path.join(nm, "p", d, "meta"), "utf-8").trimEnd().split("\t");
    if (type === "802-11-wireless" && mode !== "ap" && autoconnect === "yes" && up === "ok") {
      active = uuid;
      break;
    }
  }
  writeFileSync(path.join(nm, "active"), active);
  writeFileSync(path.join(nm, "state"), active ? "100" : "30");
  writeFileSync(path.join(nm, "ethernet"), opts.ethernet ? "connected" : "unavailable");
  writeFileSync(path.join(nm, "calls"), "");
  writeFileSync(path.join(nm, "trace"), "");
}

const activeNow = () => readFileSync(path.join(nm, "active"), "utf-8");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** argv of every nmcli call, in order. */
  calls: string[][];
  /** The same, space-joined, for readable assertions. */
  lines: string[];
  /** nmcli and sleep calls interleaved: ["nmcli", ...argv] or ["sleep", seconds]. */
  trace: string[][];
}

function runStartAp(extraEnv: Record<string, string> = {}): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["SKIP_PRESCAN", "HOTSPOT_SSID", "HOTSPOT_PASSWORD", "HOTSPOT_DISABLED", "CLIENT_UP_WAIT", "AP_UP_RETRIES"]) delete env[k];
  const res = spawnSync("bash", [START_AP], {
    env: {
      ...env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
      CLAWBOX_ROOT: root,
      CLAWBOX_RADIO_RUN_DIR: path.join(root, "radio-run"),
      CLAWBOX_AP_SUPERVISED: "1",
      NMSTUB: nm,
      NETWORK_INTERFACE: IFACE,
      NM_READY_TIMEOUT: "2",
      IFACE_TIMEOUT: "1",
      PRE_AP_SCAN_TIMEOUT: "0",
      AP_UP_RETRIES: "3",
      ...extraEnv,
    },
    encoding: "utf-8",
    timeout: 25_000,
  });
  const rows = (file: string) =>
    readFileSync(path.join(nm, file), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));
  const calls = rows("calls");
  // A call the stand-in could not answer would make every assertion below a
  // statement about the stub, not the script.
  expect(existsSync(path.join(nm, "unsupported")) ? readFileSync(path.join(nm, "unsupported"), "utf-8") : "").toBe("");
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    calls,
    lines: calls.map((c) => c.join(" ")),
    trace: rows("trace"),
  };
}

const has = (args: string[], ...words: string[]) => words.every((w) => args.includes(w));
const verb = (a: string[]) => (a.includes("connection") ? a[a.indexOf("connection") + 1] : undefined);
const isHotspotUp = (a: string[]) => has(a, "connection", "up", "uuid", HOTSPOT);
const isClientUp = (a: string[]) => verb(a) === "up" && !a.includes(HOTSPOT);
const uuidOf = (a: string[]) => (a.includes("uuid") ? a[a.indexOf("uuid") + 1] : `<not by uuid: ${a.join(" ")}>`);
const clientUps = (r: Run) => r.calls.filter(isClientUp).map(uuidOf);
/** Anything that builds the hotspot or takes the radio away from a client. */
const isApActivity = (a: string[]) =>
  a.includes("ClawBox-Setup") || has(a, "device", "disconnect") || has(a, "connection", "down");
const targetsOf = (r: Run, v: string) => r.calls.filter((a) => verb(a) === v && !a.includes(HOTSPOT)).map(uuidOf);

/**
 * What every run must hold: saved profiles are acted on by `uuid <X>`, and
 * every X the script hands nmcli — in a query as much as an action — is a
 * UUID nmcli itself printed in the UUID column of a real profile.
 */
function expectOnlyRealUuids(r: Run, profiles: Profile[]) {
  const real = new Set([WIRED, HOTSPOT, ...profiles.map((p) => p.uuid)]);
  for (const a of r.calls) {
    expect(a, "never ask nmcli for secrets").not.toContain("--show-secrets");
    const v = verb(a);
    if (v && ["up", "down", "modify", "delete"].includes(v) && !a.includes(HOTSPOT)) {
      expect(a, `${a.join(" ")} must select the profile by uuid`).toContain("uuid");
    }
    a.forEach((w, i) => {
      if (w === "uuid") expect(real.has(a[i + 1]), `${a.join(" ")}: '${a[i + 1]}' is not the UUID of any profile`).toBe(true);
    });
  }
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("N1: a profile whose NAME is a UUID is still acted on by its own UUID", () => {
  // OFFICE is listed FIRST, so anything that resolved the string "<OFFICE>" the
  // way a bare `nmcli connection up|down <X>` does — the first profile whose
  // name or uuid is X — would land on OFFICE, not on the profile named that.
  const office: Profile = { uuid: OFFICE, name: "Example-Office", priority: 0, up: "fail" };
  const impostor: Profile = { uuid: HOME, name: OFFICE, priority: 10, up: "ok" };
  const nobody: Profile = { uuid: CAFE, name: NOBODY, priority: 5, up: "fail" };

  it("tries it by the UUID column, never the profile its name points at", () => {
    const profiles = [office, { ...impostor, up: "fail" as const }, { ...nobody, up: "ok" as const }];
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.status).toBe(0);
    // Priority 10, then 5: the UUID-named profile, then the one named like a
    // UUID nobody has. OFFICE (priority 0) is never reached.
    expect(r.calls.filter(isClientUp)).toEqual([
      ["--wait", "45", "connection", "up", "uuid", HOME, "ifname", IFACE],
      ["--wait", "45", "connection", "up", "uuid", CAFE, "ifname", IFACE],
    ]);
    expect(r.calls.some((a) => a.includes(OFFICE) && verb(a) !== "show")).toBe(false);
    expect(activeNow()).toBe(CAFE);
    // The log names each by the name the owner gave it, beside its real UUID.
    expect(r.stdout).toContain(`trying saved WiFi: '${OFFICE}' (${HOME})`);
    expect(r.stdout).toContain(`trying saved WiFi: '${NOBODY}' (${CAFE})`);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expectOnlyRealUuids(r, profiles);
  });

  it("connects the UUID-named profile itself when it is the one in range", () => {
    const profiles = [office, impostor, nobody];
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(clientUps(r)).toEqual([HOME]);
    expect(activeNow()).toBe(HOME);
    expect(r.stdout).toContain(`WiFi connected to '${OFFICE}' — skipping AP mode`);
    expectOnlyRealUuids(r, profiles);
  });

  it("recognises it as the client already on the radio", () => {
    const profiles = [office, impostor, nobody];
    makeBox({ setupComplete: true, profiles, active: HOME });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(r.calls.filter((a) => ["up", "down", "modify"].includes(verb(a) ?? ""))).toEqual([]);
    expect(r.stdout).toContain(`WiFi connected to '${OFFICE}' (${HOME}) already — skipping AP mode`);
    expectOnlyRealUuids(r, profiles);
  });

  it("releases each profile by its own UUID, exactly once, when the hotspot takes the radio", () => {
    const profiles = [office, impostor, nobody];
    makeBox({ setupComplete: false, profiles, active: HOME });
    const r = runStartAp();
    expect(r.status).toBe(0);
    // One release pass (the first activation succeeds): every client profile
    // is turned down and kept off autoconnect once, by its own UUID — so
    // OFFICE is not hit twice and the impostor is not skipped.
    expect(targetsOf(r, "down").sort()).toEqual([HOME, OFFICE, CAFE].sort());
    expect(targetsOf(r, "modify").sort()).toEqual([HOME, OFFICE, CAFE].sort());
    for (const u of [HOME, OFFICE, CAFE]) expect(profileState(u).autoconnect).toBe("no");
    expect(r.lines.filter((l) => l === `--wait 30 connection up uuid ${HOTSPOT} ifname ${IFACE}`)).toHaveLength(1);
    expect(activeNow()).toBe(HOTSPOT);
    expectOnlyRealUuids(r, profiles);
  });
});

describe("N2: names with a newline or control characters in them", () => {
  // A newline is printed raw, so the rest of the name lands on a line of its
  // own. This one is built to look like a whole row naming GARAGE at priority
  // 999 — but its ':' are escaped like every other ':' in a name, so the
  // fragment's first field is "<GARAGE>\" (no UUID) and its TYPE
  // "802-11-wireless\" (no WiFi type). That escaping is what keeps a fragment
  // from ever passing for a row; listed without it (`-e no`), this one would.
  const forged = `${GARAGE}:802-11-wireless:999:999:Forged`;
  const loft: Profile = { uuid: LOFT, name: `Example-Loft\n${forged}`, priority: 10, up: "fail" };
  const spill: Profile = { uuid: ATTIC, name: "Example-Attic\nsecond line", priority: 8, up: "fail" };
  const esc: Profile = { uuid: OFFICE, name: "\x1b[31mExample-Red\x1b[0m", priority: 6, up: "fail" };
  const tab: Profile = { uuid: CAFE, name: "Example\tTab\x7f", priority: 4, up: "fail" };
  const long: Profile = { uuid: HOME, name: `Example-${"L".repeat(92)}`, priority: 2, up: "fail" };
  const garage: Profile = { uuid: GARAGE, name: "Example-Garage", priority: 0, up: "ok" };
  const profiles = [loft, spill, esc, tab, long, garage];

  it("drops the spilled fragment and still tries every real profile once, in order", () => {
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.status).toBe(0);
    // The forged "priority 999" row did not put GARAGE first or try it twice.
    expect(clientUps(r)).toEqual([LOFT, ATTIC, OFFICE, CAFE, HOME, GARAGE]);
    expect(activeNow()).toBe(GARAGE);
    expect(r.stdout).toContain("WiFi connected to 'Example-Garage' — skipping AP mode");
    // No argv carries any part of a fragment.
    expect(r.calls.some((a) => a.some((w) => w.includes("second line") || w.includes("Forged")))).toBe(false);
    expectOnlyRealUuids(r, profiles);
  });

  it("logs names with control characters replaced and no longer than 64 characters", () => {
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.stdout, "a raw control character reached the log").not.toMatch(/[\x00-\x09\x0b-\x1f\x7f]/);
    expect(r.stdout).toContain("trying saved WiFi: '?[31mExample-Red?[0m' (");
    expect(r.stdout).toContain("trying saved WiFi: 'Example?Tab?' (");
    // The part of a newline name before the newline is what reaches the log.
    expect(r.stdout).toContain(`trying saved WiFi: 'Example-Loft' (${LOFT})`);
    expect(r.stdout).toContain(`trying saved WiFi: '${long.name.slice(0, 64)}' (${HOME})`);
    expect(r.stdout).not.toContain(long.name.slice(0, 65));
    const names = [...r.stdout.matchAll(/trying saved WiFi: '([^']*)'/g)].map((m) => m[1]);
    expect(names).toHaveLength(profiles.length);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(64);
  });

  it("does not release client profiles when every client fails and the fallback hotspot comes up", () => {
    const failing = profiles.map((p) => ({ ...p, up: "fail" as const }));
    makeBox({ setupComplete: true, profiles: failing });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(clientUps(r)).toEqual([LOFT, ATTIC, OFFICE, CAFE, HOME, GARAGE]);
    // Client-preferred fallback must NOT release any client profile.
    expect(targetsOf(r, "down")).toEqual([]);
    expect(activeNow()).toBe(HOTSPOT);
    expectOnlyRealUuids(r, failing);
  });
});

describe("N3: the order saved clients are tried in", () => {
  // nmcli's listing order is deliberately NOT the order of the UUIDs' bytes.
  const T_C = "cccccccc-0000-4000-8000-00000000000c";
  const T_A = "aaaaaaaa-0000-4000-8000-00000000000a";
  const T_E = "eeeeeeee-0000-4000-8000-00000000000e";
  const T_B = "bbbbbbbb-0000-4000-8000-00000000000b";

  it("keeps nmcli's own order between profiles with equal priority and equal timestamp", () => {
    const profiles: Profile[] = [
      { uuid: T_C, name: "Example-Tie-1", priority: 0, timestamp: 500 },
      { uuid: T_A, name: "Example-Tie-2", priority: 0, timestamp: 500 },
      { uuid: T_E, name: "Example-Tie-3", priority: 0, timestamp: 500 },
      { uuid: T_B, name: "Example-Tie-4", priority: 0, timestamp: 500 },
    ];
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(clientUps(r)).toEqual([T_C, T_A, T_E, T_B]);
    expectOnlyRealUuids(r, profiles);
  });

  it("tries a negative priority after every priority-0 profile, however recent", () => {
    const profiles: Profile[] = [
      { uuid: HOME, name: "Example-Fallback", priority: -5, timestamp: 9_999_999_999 },
      { uuid: OFFICE, name: "Example-Office", priority: 0, timestamp: 10 },
      { uuid: CAFE, name: "Example-Cafe", priority: -1, timestamp: 1 },
      { uuid: LOFT, name: "Example-Loft", priority: 0, timestamp: 0 },
    ];
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(clientUps(r)).toEqual([OFFICE, LOFT, CAFE, HOME]);
    expectOnlyRealUuids(r, profiles);
  });

  it("orders a priority or timestamp that is not a plain integer as 0", () => {
    // nmcli prints both as integers; these values are synthetic, and pin the
    // script's own guard: a value that is not all digits counts as 0, never as
    // the number `sort -n` would read off its front.
    const profiles: Profile[] = [
      { uuid: HOME, name: "Example-Junk-Priority", priority: "12abc", timestamp: 100 },
      { uuid: OFFICE, name: "Example-Plain", priority: 0, timestamp: 200 },
      { uuid: CAFE, name: "Example-Junk-Time", priority: 3, timestamp: "77x" },
      { uuid: LOFT, name: "Example-Three", priority: 3, timestamp: 1 },
      { uuid: GARAGE, name: "Example-Float", priority: "7.5", timestamp: 300 },
    ];
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(clientUps(r)).toEqual([LOFT, CAFE, GARAGE, OFFICE, HOME]);
    expectOnlyRealUuids(r, profiles);
  });

  it("orders seven profiles by priority, then most recent use, then listing order", () => {
    const profiles: Profile[] = [
      { uuid: T_C, name: "Example-C", priority: 0, timestamp: 500 },
      { uuid: HOME, name: "Example-Neg", priority: -5, timestamp: 9999 },
      { uuid: OFFICE, name: "Example-Junk", priority: "12abc", timestamp: 100 },
      { uuid: CAFE, name: "Example-Recent", priority: 3, timestamp: 1 },
      { uuid: T_A, name: "Example-A", priority: 0, timestamp: 500 },
      { uuid: LOFT, name: "Example-Top", priority: 10, timestamp: 0 },
      { uuid: GARAGE, name: "Example-Junk-Time", priority: 3, timestamp: "77x" },
    ];
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(clientUps(r)).toEqual([LOFT, CAFE, GARAGE, T_C, T_A, OFFICE, HOME]);
    expect(r.lines).toContain(`--wait 30 connection up uuid ${HOTSPOT} ifname ${IFACE}`);
    expectOnlyRealUuids(r, profiles);
  });
});

describe("N4: a profile whose mode nmcli cannot report", () => {
  it.each([1, 10])("is never activated, while the others are still tried (query exits %i)", (exit) => {
    const profiles: Profile[] = [
      // Would win on priority, and would connect, if it were tried at all.
      { uuid: HOME, name: "Example-Unknown-Mode", priority: 10, modeQueryExit: exit, up: "ok" },
      // An unset mode is NetworkManager's default (infrastructure): eligible.
      { uuid: OFFICE, name: "Example-Unset-Mode", priority: 5, mode: "", up: "fail" },
      { uuid: CAFE, name: "Example-Cafe", priority: 0, mode: "infrastructure", up: "ok" },
    ];
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(clientUps(r)).toEqual([OFFICE, CAFE]);
    expect(activeNow()).toBe(CAFE);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expectOnlyRealUuids(r, profiles);
  });

  it("an unset mode alone is enough to be tried and joined", () => {
    const profiles: Profile[] = [{ uuid: OFFICE, name: "Example-Unset-Mode", mode: "", up: "ok" }];
    makeBox({ setupComplete: true, profiles });
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(clientUps(r)).toEqual([OFFICE]);
    expect(activeNow()).toBe(OFFICE);
  });
});

describe("N6: what one run may do, bounded", () => {
  const three: Profile[] = [
    { uuid: HOME, name: "Example-Home", priority: 2, up: "fail" },
    { uuid: OFFICE, name: "Example-Office", priority: 1, up: "hollow" },
    { uuid: CAFE, name: "Example-Cafe", priority: 0, up: "fail" },
  ];
  const clientUpArgv = (wait: string, uuid: string) => ["--wait", wait, "connection", "up", "uuid", uuid, "ifname", IFACE];

  it("caps every client attempt with --wait CLIENT_UP_WAIT", () => {
    // What this proves is the per-attempt contract the script hands nmcli. It
    // says nothing about how long a real association takes, and it is not a
    // bound on the run as a whole.
    makeBox({ setupComplete: true, profiles: three });
    const r = runStartAp({ CLIENT_UP_WAIT: "7" });
    expect(r.status).toBe(0);
    expect(r.calls.filter(isClientUp)).toEqual([clientUpArgv("7", HOME), clientUpArgv("7", OFFICE), clientUpArgv("7", CAFE)]);
  });

  it.each(["abc", "-1", "1.5", " 30", "4x", ""])("falls back to --wait 45 for CLIENT_UP_WAIT=%j", (value) => {
    // Handed through, a value nmcli rejects would fail every attempt at once.
    makeBox({ setupComplete: true, profiles: three });
    const r = runStartAp({ CLIENT_UP_WAIT: value });
    expect(r.status).toBe(0);
    expect(r.calls.filter(isClientUp)).toEqual([clientUpArgv("45", HOME), clientUpArgv("45", OFFICE), clientUpArgv("45", CAFE)]);
  });

  it("tries each saved client exactly once, and none after the hotspot work begins, even when every activation fails", () => {
    makeBox({ setupComplete: true, profiles: three, apPlan: ["busy", "busy", "busy", "busy", "busy"] });
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(clientUps(r)).toEqual([HOME, OFFICE, CAFE]);
    const lastClient = r.calls.map((a, i) => (isClientUp(a) ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
    expect(lastClient).toBeLessThan(r.calls.findIndex(isApActivity));
    expect(r.lines.filter((l) => l === `--wait 30 connection up uuid ${HOTSPOT} ifname ${IFACE}`)).toHaveLength(3);
    expect(r.stderr).toContain("ERROR: access point did not come up after 3 attempts");
    expect(existsSync(path.join(root, "data", "ap-runtime.env")), "a hotspot that never came up was published").toBe(false);
    expectOnlyRealUuids(r, three);
  });

  it.each([
    ["1", ["busy", "busy"], 1],
    ["2", ["hollow", "busy", "busy"], 2],
    ["4", ["busy", "hollow", "busy", "hollow", "busy"], 4],
  ] as const)("makes at most AP_UP_RETRIES=%s hotspot activations", (retries, plan, attempts) => {
    makeBox({ setupComplete: false, profiles: [], apPlan: [...plan] });
    const r = runStartAp({ AP_UP_RETRIES: retries });
    expect(r.status).toBe(1);
    expect(r.calls.filter(isHotspotUp)).toHaveLength(attempts);
    expect(r.stderr).toContain(`ERROR: access point did not come up after ${retries} attempts`);
  });

  it("stops retrying at the first activation that puts the radio in AP mode", () => {
    makeBox({ setupComplete: false, profiles: [], apPlan: ["busy", "hollow", "ok", "busy"] });
    const r = runStartAp({ AP_UP_RETRIES: "5" });
    expect(r.status).toBe(0);
    expect(r.calls.filter(isHotspotUp)).toHaveLength(3);
    expect(r.stdout).toContain("Access point active (attempt 3)");
    expect(activeNow()).toBe(HOTSPOT);
  });

  it("pauses between hotspot attempts, never after the last one, within a bounded total", () => {
    // These are the pauses the SCRIPT asks for (the sleep stub's argv), not
    // elapsed time, and they exclude nmcli's own waits. With NM ready, a
    // pre-scan budget of 0 s and IFACE_TIMEOUT=1 the script may ask for: the
    // pre-scan's one 3 s settle, one 1 s interface poll, and 3 s between each
    // pair of hotspot attempts.
    makeBox({ setupComplete: true, profiles: three, apPlan: ["busy", "busy", "busy"] });
    const r = runStartAp({ AP_UP_RETRIES: "3" });
    expect(r.status).toBe(1);
    const firstAp = r.trace.findIndex((t) => t[0] === "nmcli" && isHotspotUp(t.slice(1)));
    const lastAp = r.trace.map((t, i) => (t[0] === "nmcli" && isHotspotUp(t.slice(1)) ? i : -1)).reduce((m, i) => Math.max(m, i), -1);
    const sleepsBetween = r.trace.slice(firstAp, lastAp).filter((t) => t[0] === "sleep").map((t) => t[1]);
    expect(sleepsBetween).toEqual(["3", "3"]);
    expect(r.trace.slice(lastAp + 1).filter((t) => t[0] === "sleep"), "a pause after the final attempt").toEqual([]);
    const total = r.trace.filter((t) => t[0] === "sleep").reduce((s, t) => s + Number(t[1]), 0);
    expect(total).toBeLessThanOrEqual(3 + 1 + 2 * 3);
  });
});

describe("N7: a client an Ethernet-uplink run left on autoconnect=no", () => {
  it("is still tried explicitly, and joined, when the box later boots without Ethernet", () => {
    const profiles: Profile[] = [{ uuid: HOME, name: "Example-Home", up: "ok" }];
    // Run 1: setup complete, cable plugged in, HOME on the radio. The script
    // hosts the hotspot and — by design — takes HOME off autoconnect.
    makeBox({ setupComplete: true, ethernet: true, profiles, active: HOME });
    expect(profileState(HOME).autoconnect).toBe("yes");
    const first = runStartAp();
    expect(first.status).toBe(0);
    expect(first.lines).toContain(`connection modify uuid ${HOME} connection.autoconnect no`);
    expect(activeNow()).toBe(HOTSPOT);
    expect(profileState(HOME).autoconnect).toBe("no");

    // The box is moved and powered up with no cable. With autoconnect off,
    // NetworkManager does not join HOME by itself: the radio comes up idle.
    reboot({ ethernet: false });
    expect(activeNow()).toBe("");

    // Run 2: the only way back onto HOME is start-ap.sh asking for it.
    const second = runStartAp();
    expect(second.status).toBe(0);
    expect(second.calls.filter(isClientUp)).toEqual([["--wait", "45", "connection", "up", "uuid", HOME, "ifname", IFACE]]);
    expect(second.stdout).toContain("WiFi connected to 'Example-Home' — skipping AP mode");
    expect(activeNow()).toBe(HOME);
    expect(second.calls.filter(isApActivity)).toEqual([]);
    expectOnlyRealUuids(second, profiles);
  });
});

// Promoted from the external red evidence; baseline traces stay outside the repo.
// N5: the original release-window reds were reproduced before editing. The
// removed release hooks are now admission hooks with mandatory race witnesses.
import { renameSync } from "node:fs";

/**
 * NetworkManager's own autoconnect, landing at one exact point of the run:
 * just BEFORE ("before") or just AFTER ("after") the nmcli call whose argv,
 * space-joined, is `when` — once, and only onto an idle radio.
 */
function autoconnectAt(when: string, uuid: string, at: "before" | "after") {
  const bin = path.join(root, "bin");
  renameSync(path.join(bin, "nmcli"), path.join(bin, "nmcli-model"));
  writeFileSync(
    path.join(bin, "nmcli"),
    `#!/usr/bin/env bash
land() {
  if [ ! -e "$NMSTUB/raced" ] && [ -z "$(cat "$NMSTUB/active")" ]; then
    : > "$NMSTUB/raced"
    printf '%s' ${JSON.stringify(uuid)} > "$NMSTUB/active"; printf 100 > "$NMSTUB/state"
  fi
}
match=0; [ "$*" = ${JSON.stringify(when)} ] && match=1
[ "$match" = 1 ] && [ ${JSON.stringify(at)} = before ] && land
"$(dirname "$0")/nmcli-model" "$@"; rc=$?
[ "$match" = 1 ] && [ ${JSON.stringify(at)} = after ] && land
exit $rc
`,
    { mode: 0o755 },
  );
}

const show = (r: Run) => r.lines.filter((l) => !/802-11-wireless\.mode/.test(l)).map((l, i) => `  ${String(i).padStart(2)} nmcli ${l}`).join("\n");

describe("N5 evidence: a client that autoconnects inside the last AP attempt's window", () => {
  const home: Profile = { uuid: HOME, name: "Example-Home", up: "fail" };

  it("a client that lands during the pre-AP scan is kept", () => {
    makeBox({ setupComplete: true, profiles: [home] });
    autoconnectAt(`device wifi rescan ifname ${IFACE}`, HOME, "after");
    const r = runStartAp();
    console.log(`control trace:\n${show(r)}\nstdout tail:\n${r.stdout.trim().split("\n").slice(-2).join("\n")}`);
    expect(existsSync(path.join(nm, "raced"))).toBe(true);
    expect(activeNow()).toBe(HOME);
    expect(r.lines).not.toContain(`--wait 30 connection up uuid ${HOTSPOT} ifname ${IFACE}`);
  });

  it("N5-a: a client that lands before inhibition is acknowledged is kept", () => {
    // Original red hooked the release enumeration. Release no longer exists
    // in this policy: inject at admission instead, and REQUIRE the witness.
    makeBox({ setupComplete: true, profiles: [home] });
    autoconnectAt(`--wait 5 device set ${IFACE} autoconnect no`, HOME, "before");
    const r = runStartAp();
    console.log(`N5-a trace (mode queries elided):\n${show(r)}\nstdout tail:\n${r.stdout.trim().split("\n").slice(-4).join("\n")}`);
    expect(existsSync(path.join(nm, "raced")), "the race was not staged").toBe(true);
    expect(r.lines, "HOME was connected when the release took it down").not.toContain(`connection down uuid ${HOME}`);
    expect(activeNow(), "the customer's WiFi was replaced by the hotspot").toBe(HOME);
  });

  it("N5-b: an already-pending client that lands after inhibition is acknowledged is kept", () => {
    // An activation already started before inhibition may finish afterward.
    // This forced completion is not a new automatic start: it ignores the
    // inhibition flag. AP up in this model would preempt it if attempted.
    makeBox({ setupComplete: true, profiles: [home] });
    autoconnectAt(`--wait 5 device set ${IFACE} autoconnect no`, HOME, "after");
    const r = runStartAp();
    console.log(`N5-b trace (mode queries elided):\n${show(r)}\nstdout tail:\n${r.stdout.trim().split("\n").slice(-4).join("\n")}`);
    expect(existsSync(path.join(nm, "raced")), "the race was not staged").toBe(true);
    expect(activeNow(), "the customer's WiFi was replaced by the hotspot").toBe(HOME);
  });
});

// Promoted from the external red evidence; baseline traces stay outside the repo.
// N8 / known defect D1: scripts/nm-dispatcher-failover.sh reads saved WiFi
// profiles by NAME (`awk -F:` over escaped terse output) and activates them by
// NAME in the baseline. Each D1 regression requires the desired outcome. The
// controls, identical but with plain names, show the
// harness drives the dispatcher faithfully and that only the names differ.
// The shipped dispatcher is run from a sandbox copy whose only change is the
// path of the root-owned network.env, exactly as failover-waits-for-route.test.ts does.

const DISPATCHER = path.join(REPO, "scripts", "nm-dispatcher-failover.sh");

/** systemd as the dispatcher and the watchdog reach it: the worker runs inline, each exit recorded. */
function writeSystemctlStub() {
  writeFileSync(path.join(root, "bin", "systemctl"), `#!/bin/bash
case "$*" in
  "--no-block start clawbox-wifi-failover.service")
    bash "${path.join(REPO, "scripts/wifi-failover.sh")}" >> "$NMSTUB/journal" 2>&1; rc=$?
    printf '%s\\n' "$rc" >> "$NMSTUB/worker-exits"
    exit "$rc" ;;
  "--no-block restart clawbox-ap.service") touch "$NMSTUB/recovery-ap" ;;
  "--job-mode=fail --no-block restart clawbox-ap.service") touch "$NMSTUB/watchdog-ap" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
}

function runDispatcher(args: string[] = ["eth0", "down"], extraEnv: Record<string, string> = {}) {
  const bin = path.join(root, "bin");
  const x = { mode: 0o755 };
  writeSystemctlStub();
  writeFileSync(path.join(root, "network.env"), `NETWORK_INTERFACE=${IFACE}\n`);
  const src = readFileSync(DISPATCHER, "utf-8");
  expect(src).toContain("/etc/clawbox/network.env");
  const copy = path.join(root, "dispatcher.sh");
  writeFileSync(copy, src.replaceAll("/etc/clawbox/network.env", path.join(root, "network.env")));
  writeFileSync(path.join(bin, "logger"), `#!/usr/bin/env bash\nshift 2\n[ "$1" = "--" ] && shift\necho "$*" >> "$NMSTUB/journal"\n`, x);
  writeFileSync(path.join(bin, "setsid"), `#!/usr/bin/env bash\necho "detached waiter $*" >> "$NMSTUB/journal"\n`, x);
  const waiter = path.join(root, "waiter.sh");
  writeFileSync(waiter, "#!/usr/bin/env bash\nexit 0\n", x);
  const witness = path.join(root, "start-ap-witness.sh");
  writeFileSync(witness, `#!/usr/bin/env bash\n: > "$NMSTUB/recovery-ap"\n`, x);
  mkdirSync(path.join(root, "run"), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CONNECTION_ID;
  const res = spawnSync("bash", [copy, ...args], {
    env: {
      ...env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      NMSTUB: nm,
      NETWORK_INTERFACE: IFACE,
      CLAWBOX_RADIO_RUN_DIR: path.join(root, "radio-run"),
      CLAWBOX_ONLINE_WAITER: waiter,
      CLAWBOX_RUN_DIR: path.join(root, "run"),
      CLAWBOX_START_AP: witness,
      ...extraEnv,
    },
    encoding: "utf-8",
    timeout: 25_000,
  });
  const read = (f: string) => (existsSync(path.join(nm, f)) ? readFileSync(path.join(nm, f), "utf-8") : "");
  // The recovery hotspot is launched in the background; let it land.
  if (read("journal").includes("Recovery AP launch dispatched")) {
    const until = Date.now() + 3000;
    while (!existsSync(path.join(nm, "recovery-ap")) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  expect(read("unsupported")).toBe("");
  const lines = read("calls").split("\n").filter(Boolean).map((l) => l.split("\t").join(" "));
  const workerExits = read("worker-exits").split("\n").filter(Boolean).map(Number);
  const out = { status: res.status, journal: read("journal").trim(), lines, recoveryAp: existsSync(path.join(nm, "recovery-ap")), workerExits };
  console.log(`journal:\n${out.journal.replace(/^/gm, "  ")}\nnmcli actions:\n${lines.filter((l) => /^connection (up|down)/.test(l)).map((l) => `  nmcli ${l}`).join("\n") || "  (none)"}\nrecovery hotspot launched: ${out.recoveryAp}\nradio afterwards: ${activeNow() || "(idle)"}`);
  return out;
}
const ups = (lines: string[]) => lines.filter((l) => /(?:^| )connection up /.test(l));

describe("N8 evidence: the failover dispatcher on Ethernet down", () => {
  it("a plain-named saved network is joined", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }] });
    const d = runDispatcher();
    expect(d.status).toBe(0);
    expect(ups(d.lines)).toEqual([`--wait 45 connection up uuid ${HOME} ifname ${IFACE}`]);
    expect(activeNow()).toBe(HOME);
  });

  it("a plain-named client already on the radio is left alone", () => {
    makeBox({
      setupComplete: true,
      profiles: [
        { uuid: HOME, name: "Example-Home", up: "ok" },
        { uuid: CAFE, name: "Example-Cafe", up: "fail" },
      ],
      active: HOME,
    });
    const d = runDispatcher();
    expect(ups(d.lines)).toEqual([]);
    expect(activeNow()).toBe(HOME);
  });

  it("D1-a: a saved network whose name has ':' is tried and joined", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example: Attic", up: "ok" }] });
    const d = runDispatcher();
    expect(activeNow(), "the only saved network was never tried").toBe(HOME);
  });

  it("D1-b: of two saved networks sharing a name, the reachable one is joined", () => {
    makeBox({
      setupComplete: true,
      profiles: [
        { uuid: OFFICE, name: "Example-Twin", priority: 10, up: "fail" },
        { uuid: HOME, name: "Example-Twin", priority: 0, up: "ok" },
      ],
    });
    const d = runDispatcher();
    expect(activeNow(), "both attempts named 'Example-Twin' and nmcli resolved the first profile twice").toBe(HOME);
  });

  it("D1-c: a profile named like another profile's UUID is the one activated", () => {
    // Modelled assumption: a bare `nmcli connection up X` resolves to the first
    // profile, in listing order, whose name OR uuid is X. OFFICE is listed first.
    makeBox({
      setupComplete: true,
      profiles: [
        { uuid: OFFICE, name: "Example-Office", priority: 0, up: "fail" },
        { uuid: HOME, name: OFFICE, priority: 10, up: "ok" },
      ],
    });
    const d = runDispatcher();
    expect(activeNow(), "`connection up <OFFICE>` activated OFFICE, not the profile named so").toBe(HOME);
  });

  it("D1-d: a client with ':' in its name already on the radio is left alone", () => {
    makeBox({
      setupComplete: true,
      profiles: [
        { uuid: HOME, name: "Example: Office", up: "ok" },
        { uuid: CAFE, name: "Example-Cafe", up: "fail" },
      ],
      active: HOME,
    });
    const d = runDispatcher();
    expect(ups(d.lines), "the live client was not recognised and another network was activated over it").toEqual([]);
    expect(activeNow()).toBe(HOME);
    expect(d.recoveryAp, "a recovery hotspot was launched on a box that was online over WiFi").toBe(false);
  });
});


// A wrapper around the same strict model, not a second nmcli implementation.
function wrapNm(before: string, after = "") {
  const bin = path.join(root, "bin");
  renameSync(path.join(bin, "nmcli"), path.join(bin, "nmcli-model"));
  writeFileSync(path.join(bin, "nmcli"), `#!/usr/bin/env bash
${before}
"$(dirname "$0")/nmcli-model" "$@"; rc=$?
${after}
exit $rc
`, { mode: 0o755 });
}
const deviceAc = () => readFileSync(path.join(nm, "device-ac"), "utf-8");

describe("C1 elapsed recovery budgets", () => {
  it("reserves the complete lock, phase and cleanup budgets in the unit deadline", () => {
    const script = readFileSync(START_AP, "utf-8");
    const unit = readFileSync("config/clawbox-ap.service", "utf-8");
    const helper = readFileSync("scripts/wifi-radio.sh", "utf-8");
    const lock = Number(helper.match(/flock -x -w (\d+)/)?.[1]);
    const phases = [...script.matchAll(/phase_deadline=\$\(\(SECONDS \+ (\d+)\)\)/g)].map(m => Number(m[1]));
    const candidate = Number(script.match(/CLIENT_TOTAL_BUDGET:-(\d+)/)?.[1]);
    const ap = Number(script.match(/AP_TOTAL_BUDGET:-(\d+)/)?.[1]);
    expect(phases).toEqual([60, 30, 45]);
    expect(candidate).toBe(120);
    expect(ap).toBe(150);
    const start = Number(unit.match(/^TimeoutStartSec=(\d+)/m)?.[1]);
    expect(start).toBeGreaterThanOrEqual(lock + phases.reduce((a, b) => a + b, 0) + candidate + ap + 15);
  });
  it.each([false, true])("exhausts slow candidates into a working AP (lock contention=%s)", (contended) => {
    makeBox({ setupComplete: true, profiles: [HOME, OFFICE, CAFE, LOFT, GARAGE, ATTIC].map(uuid => ({ uuid, name: uuid })) });
    // Real elapsed time, not the fixture's no-op sleep. Each unreachable
    // candidate consumes its requested wait. The total budget must clip it.
    wrapNm(`if [[ "$*" == *'connection up uuid'* ]] && [[ "$*" != *'${HOTSPOT}'* ]]; then
  printf "%s\\n" "$*" >> "$NMSTUB/slow-attempts"
  /bin/sleep "$2"
fi`);
    let lockedAt = 0;
    if (contended) {
      mkdirSync(path.join(root, "radio-run"));
      writeFileSync(path.join(root, "radio-run", `${IFACE}.lock`), "");
      // Start an actual owner; it stamps the moment it holds the lock.
      const stamp = path.join(root, "locked-at");
      const holder = spawnSync("bash", ["-c", 'exec 9< "$1"; flock -x 9; date +%s%3N > "$2"; ( /bin/sleep 2 ) >&- 2>&- <&- &', "test", path.join(root, "radio-run", `${IFACE}.lock`), stamp], { encoding: "utf-8" });
      expect(holder.status).toBe(0);
      lockedAt = Number(readFileSync(stamp, "utf-8").trim());
    }
    const began = Date.now();
    const r = runStartAp({ CLIENT_TOTAL_BUDGET: "3", CLIENT_UP_WAIT: "2", SKIP_PRESCAN: "1" });
    expect(r.status, r.stderr).toBe(0);
    const elapsed = Date.now() - began;
    expect(elapsed).toBeLessThan(contended ? 8500 : 6500);
    // Ownership waiting must not spend the candidate or recovery reserve. From
    // the moment the owner held the lock: its 2 s, then at least one whole 2 s
    // attempt (the budget is whole bash SECONDS, so 2-3 s of it remain) — at
    // least 4 s. Charged to the budget, the wait leaves ~1 s of attempts
    // (~3.3 s). Measured from `began`, the owner's head start made the old
    // 4500 ms floor fail correct runs under load.
    if (contended) expect(Date.now() - lockedAt).toBeGreaterThanOrEqual(3700);
    const attempts = readFileSync(path.join(nm, "slow-attempts"), "utf-8").trim().split("\n");
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.length).toBeLessThan(6);
    expect(activeNow()).toBe(HOTSPOT);
    expect(deviceAc()).toBe("yes");
    expect(r.stdout).toContain("candidate budget exhausted");
  });

  it("bounds stalled AP activation and restores policy on exhaustion", () => {
    makeBox({ setupComplete: true, profiles: [] });
    wrapNm(`if [[ "$*" == *'connection up uuid ${HOTSPOT}'* ]]; then /bin/sleep 10; exit 4; fi`);
    const began = Date.now();
    const r = runStartAp({ AP_TOTAL_BUDGET: "2", SKIP_PRESCAN: "1" });
    expect(r.status).not.toBe(0);
    expect(Date.now() - began).toBeLessThan(5000);
    expect(deviceAc()).toBe("yes");
  });
});

describe("N5 admission and restoration contracts (synthetic NM barrier)", () => {
  it.each(["yes", "no"])("restores original device autoconnect=%s after verified fallback", (original) => {
    makeBox({ setupComplete: true, profiles: [] });
    writeFileSync(path.join(nm, "device-ac"), original);
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(activeNow()).toBe(HOTSPOT);
    expect(deviceAc()).toBe(original);
    expect(r.lines).toContain(`--wait 5 device set ${IFACE} autoconnect no`);
    expect(r.lines).not.toContain(`device disconnect ${IFACE}`);
  });

  it("blocks a NEW automatic start between final state observation and AP up", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home" }] });
    wrapNm(`if [ "$*" = "--wait 30 connection up uuid ${HOTSPOT} ifname ${IFACE}" ]; then
  : > "$NMSTUB/boundary"
  if [ "$(cat "$NMSTUB/device-ac" 2>/dev/null)" != no ]; then
    printf '${HOME}' > "$NMSTUB/active"; printf 100 > "$NMSTUB/state"
    : > "$NMSTUB/preempted"
  fi
fi`, `# Explicit activation may re-enable runtime device autoconnect in NM.
case "$*" in *"connection up uuid"*) printf yes > "$NMSTUB/device-ac" ;; esac`);
    const r = runStartAp();
    expect(r.status).toBe(0);
    expect(existsSync(path.join(nm, "boundary"))).toBe(true);
    expect(existsSync(path.join(nm, "preempted"))).toBe(false);
    expect(deviceAc()).toBe("yes");
    expect(profileState(HOME).autoconnect).toBe("yes");
    expect(activeNow()).toBe(HOTSPOT);
  });

  it("restores policy after exhausted AP retries", () => {
    makeBox({ setupComplete: true, profiles: [], apPlan: ["busy", "busy", "busy"] });
    expect(runStartAp().status).toBe(1);
    expect(deviceAc()).toBe("yes");
    expect(existsSync(path.join(root, "data", "ap-runtime.env"))).toBe(false);
  });

  it("restores policy even when the inhibit command mutates then fails", () => {
    makeBox({ setupComplete: true, profiles: [] });
    wrapNm("", `if [ "$*" = "--wait 5 device set ${IFACE} autoconnect no" ]; then exit 1; fi`);
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(r.calls.filter(isHotspotUp)).toEqual([]);
    expect(deviceAc()).toBe("yes");
  });

  it("refuses AP admission on an inhibition readback mismatch", () => {
    makeBox({ setupComplete: true, profiles: [] });
    wrapNm(`if [ "$*" = "--wait 5 device set ${IFACE} autoconnect no" ]; then exit 0; fi`);
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(r.calls.filter(isHotspotUp)).toEqual([]);
    expect(deviceAc()).toBe("yes");
  });

  it("reports restoration failure instead of claiming a clean success", () => {
    makeBox({ setupComplete: true, profiles: [] });
    wrapNm(`if [ "$*" = "--wait 5 device set ${IFACE} autoconnect yes" ]; then exit 1; fi`);
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("recovery failed (autoconnect=yes)");
    expect(deviceAc()).toBe("no"); // explicit cleanup failure, never called clean
    expect(existsSync(path.join(root, "data", "ap-runtime.env"))).toBe(false);
  });

  it("restores on TERM after inhibition", () => {
    makeBox({ setupComplete: true, profiles: [] });
    // nmcli now runs below timeout: signal the owning shell, not its timer.
    wrapNm("", `if [ "$*" = "--wait 5 device set ${IFACE} autoconnect no" ]; then kill -TERM "$(ps -o ppid= -p "$PPID" | tr -d ' ')"; fi`);
    const r = runStartAp();
    expect(r.status).toBe(143);
    expect(r.calls.filter(isHotspotUp)).toEqual([]);
    expect(deviceAc()).toBe("yes");
  });

  it("defers a still-activating client after a bounded observation without cancelling it", () => {
    makeBox({ setupComplete: true, profiles: [] });
    writeFileSync(path.join(nm, "state"), "50");
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(r.trace.filter((a) => a[0] === "sleep")).toHaveLength(15);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expect(deviceAc()).toBe("yes");
  });

  it("never replaces a connected client whose mode query failed", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", modeQueryExit: 10 }], active: HOME });
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expect(activeNow()).toBe(HOME);
    expect(deviceAc()).toBe("yes");
  });
});

describe("N8 fallback and exact identity", () => {
  it("uses recovery for zero candidates, not a silent no-op", () => {
    makeBox({ setupComplete: true, profiles: [] });
    const d = runDispatcher();
    expect(d.status).toBe(0);
    expect(d.recoveryAp).toBe(true);
    expect(ups(d.lines)).toEqual([]);
  });
  it("does not treat a hollow nmcli success as failover complete", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example: Home", up: "hollow" }] });
    const d = runDispatcher();
    expect(d.recoveryAp).toBe(true);
    expect(d.journal).not.toContain("Already on WiFi");
    expect(ups(d.lines)).toEqual([`--wait 45 connection up uuid ${HOME} ifname ${IFACE}`]);
  });
  it.each(["ClawBox-Setup", OFFICE, "Example\\Path\nwith\tcontrol"])("preserves an active client named %j", (name) => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name, up: "ok" }], active: HOME });
    const d = runDispatcher();
    expect(d.status).toBe(0);
    expect(ups(d.lines)).toEqual([]);
    expect(d.recoveryAp).toBe(false);
    expect(activeNow()).toBe(HOME);
  });
  it("defers unknown connected identity instead of activating a rival", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", modeQueryExit: 10 }], active: HOME });
    const d = runDispatcher();
    expect(d.status).toBe(1);
    expect(ups(d.lines)).toEqual([]);
    expect(d.recoveryAp).toBe(false);
    expect(activeNow()).toBe(HOME);
  });
});


describe("N8 AP ownership", () => {
  it("preserves an inactive infrastructure ClawBox-Setup during fallback", () => {
    makeBox({ setupComplete: true, profiles: [
      { uuid: HOME, name: "ClawBox-Setup", up: "fail" },
    ] });
    const r = runStartAp();
    expect(r.status, r.stderr).toBe(0);
    expect(clientUps(r)).toEqual([HOME]);
    expect(profileState(HOME).autoconnect).toBe("yes");
    expect(r.lines).not.toContain(`connection delete uuid ${HOME}`);
    expect(activeNow()).toBe(HOTSPOT);
    expect(r.calls.filter(isHotspotUp)).toHaveLength(1);
    expectOnlyRealUuids(r, [{ uuid: HOME, name: "ClawBox-Setup" }]);
  });

  it("refuses duplicate owned AP identities without deleting either or leaving inhibition", () => {
    makeBox({ setupComplete: true, profiles: [
      { uuid: HOME, name: "ClawBox-Setup", mode: "ap" },
      { uuid: OFFICE, name: "ClawBox-Setup", mode: "ap" },
    ] });
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Ambiguous owned AP");
    expect(r.calls.filter((a) => ["up", "down", "delete", "modify"].includes(verb(a) ?? ""))).toEqual([]);
    expect(profileState(HOME).autoconnect).toBe("yes");
    expect(profileState(OFFICE).autoconnect).toBe("yes");
    expect(deviceAc()).toBe("yes");
  });

  it.each([
    `--wait 5 device set ${IFACE} autoconnect no`,
    `device wifi rescan ifname ${IFACE}`,
    `--wait 30 connection up uuid ${HOTSPOT} ifname ${IFACE}`,
  ])("recovers startup SIGKILL at %s before a replacement snapshots policy", (killAt) => {
    makeBox({ setupComplete: true, profiles: [] });
    wrapNm("", `if [ "$*" = "${killAt}" ] && [ ! -e "$NMSTUB/killed" ]; then
      touch "$NMSTUB/killed"
      kill -KILL "$(ps -o ppid= -p "$PPID" | tr -d ' ')"
    fi`);
    const killed = runStartAp();
    expect(killed.status).not.toBe(0);
    expect(deviceAc()).toBe("no");
    const recovered = runStartAp();
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(deviceAc()).toBe("yes");
    expect(activeNow()).toBe(HOTSPOT);
  });

  it("does not take down an unrelated access point", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Other-AP", mode: "ap" }], active: HOME });
    const d = runDispatcher();
    expect(d.status).toBe(1);
    expect(d.lines.filter((l) => /connection (up|down) /.test(l))).toEqual([]);
    expect(d.recoveryAp).toBe(false);
    expect(activeNow()).toBe(HOME);
  });
  it("takes down only the active owned AP by UUID before joining a client", () => {
    makeBox({ setupComplete: true, profiles: [
      { uuid: HOTSPOT, name: "ClawBox-Setup", mode: "ap" },
      { uuid: HOME, name: "Example: Home", up: "ok" },
    ], active: HOTSPOT });
    const d = runDispatcher();
    expect(d.status).toBe(0);
    expect(d.lines.filter((l) => /connection down /.test(l))).toEqual([`--wait 10 connection down uuid ${HOTSPOT}`]);
    expect(activeNow()).toBe(HOME);
    expect(d.recoveryAp).toBe(false);
  });
});

// PR #1089 review follow-up (CodeRabbit threads on start-ap.sh:316 and
// wifi-failover.sh:54): what the radio reads while NetworkManager is still
// bringing it up, or still carrying an activation nmcli stopped waiting for.
//
// `state-plan` scripts successive `-g GENERAL.STATE device show` reads: a
// number is that device state with nothing on the radio, `fail` is a read that
// errors, `client=<uuid>` is an activation that has landed. An exhausted plan
// leaves the model as it is. `afterUp` re-plans the moment that client's
// FIRST `connection up` returns (or every one, with `every`): nmcli gives up
// (exit 3, as on its --wait timeout) with the radio still activating (70), and
// NetworkManager carries on. Otherwise a later attempt is the model's own.
function nmStatePlan(plan: string[], afterUp?: { uuid: string; plan: string[]; every?: boolean }) {
  writeFileSync(path.join(nm, "state-plan"), plan.join(" ") + "\n");
  wrapNm(`if [ "$*" = "-g GENERAL.STATE device show ${IFACE}" ]; then
  next=""; rest=""
  read -r next rest < "$NMSTUB/state-plan" || true
  if [ -n "$next" ]; then
    printf '%s\\n' "$rest" > "$NMSTUB/state-plan"
    case "$next" in
      fail) echo "Error: synthetic GENERAL.STATE failure" >&2; exit 10 ;;
      client=*) printf '%s' "\${next#client=}" > "$NMSTUB/active"; printf 100 > "$NMSTUB/state" ;;
      *) : > "$NMSTUB/active"; printf '%s' "$next" > "$NMSTUB/state" ;;
    esac
  fi
fi`, afterUp ? `if [[ "$*" == *"connection up uuid ${afterUp.uuid} "* ]] && { ${afterUp.every ? "true" : "false"} || [ ! -e "$NMSTUB/after-up-done" ]; }; then
  : > "$NMSTUB/after-up-done"
  : > "$NMSTUB/active"; printf 70 > "$NMSTUB/state"
  printf '%s\\n' ${JSON.stringify(afterUp.plan.join(" "))} > "$NMSTUB/state-plan"
  echo "Error: Timeout expired (synthetic); activation continues" >&2
  rc=3
fi` : "");
}
const FAILOVER = path.join(REPO, "scripts", "wifi-failover.sh");
/** The worker's own cap on re-runs per episode, as shipped (NaN where it has none). */
const RECHECK_MAX = () => Number(/^RECHECK_MAX=(\d+)$/m.exec(readFileSync(FAILOVER, "utf-8"))?.[1]);
/** The episode marker a deferred worker leaves for the watchdog, in the radio run directory. */
const pendingFile = () => path.join(root, "radio-run", `${IFACE}.failover-pending`);
const workerExits = () => {
  const f = path.join(nm, "worker-exits");
  return existsSync(f) ? readFileSync(f, "utf-8").split("\n").filter(Boolean).map(Number) : [];
};
/** NetworkManager's verdict on the activation in flight: idle (30) or a client on the radio (100). */
const settle = (state: "30" | "100", active = "") => {
  writeFileSync(path.join(nm, "state"), state);
  writeFileSync(path.join(nm, "active"), active);
};
const WATCHDOG = path.join(REPO, "scripts", "ap-watchdog.sh");
/** One tick of clawbox-ap-watchdog.service, the shipped script against the same model. */
function runWatchdog() {
  writeSystemctlStub();
  const res = spawnSync("bash", [WATCHDOG], {
    env: {
      ...process.env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
      NMSTUB: nm,
      NETWORK_INTERFACE: IFACE,
      CLAWBOX_ROOT: root,
      CLAWBOX_RADIO_RUN_DIR: path.join(root, "radio-run"),
      // Never the box's real libexec copy; this suite asserts on systemctl requests.
      CLAWBOX_START_AP: path.join(root, "no-start-ap.sh"),
    },
    encoding: "utf-8",
    timeout: 25_000,
  });
  expect(existsSync(path.join(nm, "unsupported")) ? readFileSync(path.join(nm, "unsupported"), "utf-8") : "").toBe("");
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
const traceRows = () => readFileSync(path.join(nm, "trace"), "utf-8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const sleepCount = (rows: string[][]) => rows.filter((a) => a[0] === "sleep").length;
/** The script's pauses before the first nmcli call whose argv contains `word`. */
const sleepsBefore = (word: string) => {
  const rows = traceRows();
  const at = rows.findIndex((a) => a[0] === "nmcli" && a.includes(word));
  return sleepCount(at < 0 ? rows : rows.slice(0, at));
};
/** The script's pauses after the first client `connection up`. */
const sleepsAfterUp = () => {
  const rows = traceRows();
  const at = rows.findIndex((a) => a[0] === "nmcli" && a.join(" ").includes("connection up"));
  expect(at, "no connection up was attempted").toBeGreaterThanOrEqual(0);
  return sleepCount(rows.slice(at + 1));
};

describe("PR #1089 review: start-ap.sh admits a radio still coming up only once it settles", () => {
  const home: Profile = { uuid: HOME, name: "Example-Home", up: "ok" };

  it("waits out an unavailable radio (20) and still joins the saved network", () => {
    makeBox({ setupComplete: true, profiles: [home] });
    // The first read is the "already connected?" check before inhibition.
    nmStatePlan(["20", "20", "20", "30"]);
    const r = runStartAp();
    expect(r.status, r.stderr).toBe(0);
    expect(clientUps(r)).toEqual([HOME]);
    expect(activeNow()).toBe(HOME);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expect(deviceAc()).toBe("yes");
    expect(sleepCount(r.trace)).toBe(2);
  });

  it("waits out a radio NetworkManager has not taken under management yet (10)", () => {
    makeBox({ setupComplete: true, profiles: [home] });
    nmStatePlan(["10", "10", "20", "30"]);
    const r = runStartAp();
    expect(r.status, r.stderr).toBe(0);
    expect(clientUps(r)).toEqual([HOME]);
    expect(activeNow()).toBe(HOME);
    expect(deviceAc()).toBe("yes");
  });

  it("waits out an unreadable state and still raises the fallback hotspot", () => {
    makeBox({ setupComplete: true, profiles: [] });
    nmStatePlan(["fail", "fail", "fail", "30"]);
    const r = runStartAp({ SKIP_PRESCAN: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(activeNow()).toBe(HOTSPOT);
    expect(deviceAc()).toBe("yes");
    expect(sleepsBefore("add")).toBe(2);
  });

  it("keeps a saved network NetworkManager joins while the radio is still coming up", () => {
    makeBox({ setupComplete: true, profiles: [{ ...home, up: "fail" }] });
    nmStatePlan(["20", "20", `client=${HOME}`]);
    const r = runStartAp();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("during admission");
    expect(activeNow()).toBe(HOME);
    expect(clientUps(r)).toEqual([]);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expect(deviceAc()).toBe("yes");
  });

  it.each([
    ["stays unavailable (20)", () => writeFileSync(path.join(nm, "state"), "20")],
    ["stays unreadable", () => nmStatePlan(Array(40).fill("fail"))],
  ])("still defers a radio that %s — after the same 15 s look, with nothing taken from it", (_, stage) => {
    makeBox({ setupComplete: true, profiles: [home] });
    stage();
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did not settle — deferring");
    expect(sleepCount(r.trace)).toBe(15);
    expect(clientUps(r)).toEqual([]);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expect(deviceAc()).toBe("yes");
  });

  it("does not widen the look to every state: unknown (0) is still deferred at once", () => {
    makeBox({ setupComplete: true, profiles: [home] });
    writeFileSync(path.join(nm, "state"), "0");
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(sleepCount(r.trace)).toBe(0);
    expect(clientUps(r)).toEqual([]);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expect(deviceAc()).toBe("yes");
  });
});

describe("PR #1089 review: wifi-failover.sh waits out an activation in flight before deciding", () => {
  it("keeps the network an activation already in flight at Ethernet-down lands on", () => {
    makeBox({ setupComplete: true, profiles: [
      { uuid: HOME, name: "Example-Home", up: "ok" },
      { uuid: CAFE, name: "Example-Cafe", up: "fail" },
    ] });
    nmStatePlan(["50", "50", `client=${HOME}`]);
    const d = runDispatcher();
    expect(d.status).toBe(0);
    expect(d.journal).toContain(`Already on WiFi UUID ${HOME}`);
    expect(ups(d.lines)).toEqual([]);
    expect(d.recoveryAp).toBe(false);
    expect(activeNow()).toBe(HOME);
    expect(sleepCount(traceRows())).toBe(2);
  });

  it("keeps the network an attempt lands on after nmcli stopped waiting for it", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }] });
    nmStatePlan([], { uuid: HOME, plan: ["70", "70", `client=${HOME}`] });
    const d = runDispatcher();
    expect(d.status).toBe(0);
    expect(ups(d.lines)).toEqual([`--wait 45 connection up uuid ${HOME} ifname ${IFACE}`]);
    expect(d.recoveryAp).toBe(false);
    expect(activeNow()).toBe(HOME);
    expect(sleepsAfterUp()).toBe(2);
  });

  it("moves on to the next saved network when that activation then fails", () => {
    makeBox({ setupComplete: true, profiles: [
      { uuid: HOME, name: "Example-Home", priority: 10, up: "fail" },
      { uuid: CAFE, name: "Example-Cafe", priority: 0, up: "ok" },
    ] });
    nmStatePlan([], { uuid: HOME, plan: ["70", "70", "30"] });
    const d = runDispatcher();
    expect(d.status).toBe(0);
    expect(ups(d.lines)).toEqual([HOME, CAFE].map((u) => `--wait 45 connection up uuid ${u} ifname ${IFACE}`));
    expect(activeNow()).toBe(CAFE);
    expect(d.recoveryAp).toBe(false);
  });

  it("still raises the recovery hotspot when the only saved network then fails", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "fail" }] });
    nmStatePlan([], { uuid: HOME, plan: ["70", "70", "30"] });
    const d = runDispatcher();
    expect(d.status).toBe(0);
    expect(ups(d.lines)).toEqual([`--wait 45 connection up uuid ${HOME} ifname ${IFACE}`]);
    expect(d.journal).toContain("starting hotspot as recovery");
    expect(d.recoveryAp).toBe(true);
  });

  it("defers, untouched, an activation still in flight after the bounded look, and leaves it to the watchdog", () => {
    makeBox({ setupComplete: true, profiles: [
      { uuid: HOME, name: "Example-Home", priority: 10, up: "fail" },
      { uuid: CAFE, name: "Example-Cafe", priority: 0, up: "ok" },
    ] });
    nmStatePlan([], { uuid: HOME, plan: [] });
    const d = runDispatcher();
    expect(d.workerExits).toEqual([1]);
    expect(d.status).toBe(1);
    expect(d.journal).toContain("(state 70) — deferring failover");
    expect(d.journal).toContain(`re-check 1/${RECHECK_MAX()} left to the watchdog`);
    expect(sleepsAfterUp()).toBe(15);
    expect(ups(d.lines), "a rival was activated over an activation in flight").toEqual([`--wait 45 connection up uuid ${HOME} ifname ${IFACE}`]);
    expect(d.lines.filter((l) => /connection down /.test(l))).toEqual([]);
    expect(d.recoveryAp).toBe(false);
    expect(readFileSync(pendingFile(), "utf-8")).toBe("1\n");
  });

  it("does not wait on, or act over, a radio whose state cannot be read", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }] });
    nmStatePlan(Array(5).fill("fail"));
    const d = runDispatcher();
    expect(d.status).toBe(1);
    expect(d.journal).toContain("(state unreadable) — deferring failover");
    expect(sleepCount(traceRows())).toBe(0);
    expect(ups(d.lines)).toEqual([]);
    expect(d.recoveryAp).toBe(false);
  });

  it("keeps every settle inside the one budget the unit's timeout was sized for", () => {
    const script = readFileSync(path.join(REPO, "scripts", "wifi-failover.sh"), "utf-8");
    const unit = readFileSync(path.join(REPO, "config", "clawbox-wifi-failover.service"), "utf-8");
    const helper = readFileSync(path.join(REPO, "scripts", "wifi-radio.sh"), "utf-8");
    const lock = Number(helper.match(/flock -x -w (\d+)/)?.[1]);
    const budgets = [...script.matchAll(/^deadline=\$\(\(SECONDS \+ (\d+)\)\)$/gm)].map((m) => Number(m[1]));
    const settle = Number(script.match(/^SETTLE_S=(\d+)$/m)?.[1]);
    const timeout = Number(unit.match(/^TimeoutStartSec=(\d+)$/m)?.[1]);
    expect(budgets).toEqual([120]);
    expect(settle).toBeGreaterThan(0);
    expect(settle).toBeLessThan(45);
    // Lock wait, then ONE budget for everything after it, then a margin.
    expect(timeout).toBeGreaterThanOrEqual(lock + budgets[0] + 15);
    // The budget is running before the first look, which may itself settle,
    // and every attempt leaves its own settle in reserve.
    expect(script.indexOf("deadline=$((SECONDS + ")).toBeLessThan(script.indexOf("\nkeep_client_or_defer\n"));
    expect(script).toContain("remaining=$((deadline - SETTLE_S - SECONDS))");
  });
});

// TASK-1380 residual R1: post-setup, start-ap.sh snapshots the radio's device
// autoconnect before admission. A radio NetworkManager does not have yet
// (driver or firmware still loading) failed that read, and the unit, before
// admission's own bounded look could run; nothing retries the unit post-setup.
/** The radio is absent for its first `n` device reads, state and policy alike. */
function radioAbsentFor(n: number) {
  writeFileSync(path.join(nm, "absent-reads"), String(n));
  wrapNm(`case "$*" in
  "-g GENERAL.AUTOCONNECT device show ${IFACE}"|"-g GENERAL.STATE device show ${IFACE}")
    left="$(cat "$NMSTUB/absent-reads")"
    if [ "$left" -gt 0 ]; then
      printf '%s' "$((left - 1))" > "$NMSTUB/absent-reads"
      echo "Error: Device '${IFACE}' not found." >&2; exit 10
    fi ;;
esac`);
}

describe("TASK-1380 residual R1: a radio not there yet when start-ap.sh must snapshot its policy", () => {
  const home: Profile = { uuid: HOME, name: "Example-Home", up: "ok" };

  it("waits for a radio that appears a few seconds in, then inhibits, admits and joins", () => {
    makeBox({ setupComplete: true, profiles: [home] });
    radioAbsentFor(4);
    const r = runStartAp();
    expect(r.status, r.stderr).toBe(0);
    expect(clientUps(r)).toEqual([HOME]);
    expect(activeNow()).toBe(HOME);
    expect(r.calls.filter(isApActivity)).toEqual([]);
    expect(deviceAc()).toBe("yes");
    expect(sleepsBefore("set")).toBe(3);
  });

  it("refuses a radio that never appears after the same bounded look, before any mutation", () => {
    makeBox({ setupComplete: true, profiles: [home] });
    radioAbsentFor(999);
    const r = runStartAp();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("WiFi device policy unreadable");
    expect(sleepCount(r.trace)).toBe(15);
    expect(r.calls.filter((a) => has(a, "device", "set")), "the device policy was mutated").toEqual([]);
    expect(existsSync(path.join(root, "radio-run", `${IFACE}.policy`)), "a snapshot was published").toBe(false);
    expect(clientUps(r)).toEqual([]);
    expect(r.calls.filter(isApActivity)).toEqual([]);
  });
});

// TASK-1380 residual R2: an activation still in flight when the settle window
// closed was deferred (exit 1), and when it then failed nothing ran the worker
// again — NetworkManager dispatches `down` only for a connection that came up,
// and the dispatcher starts the worker on Ethernet `down` alone. The worker
// now leaves a marker, and ap-watchdog.sh (root, every 20 s) starts it again
// once the radio has settled: at most RECHECK_MAX times per episode, a marker
// dropped after FAILOVER_PENDING_MAX_AGE. (systemd 255 refuses the native
// route, RestartForceExitStatus= on a Type=oneshot unit: see the pin below.)
describe("TASK-1380 residual R2: an activation that outlives the settle window", () => {
  it("evidence: no dispatcher event NetworkManager sends for that failure starts the worker", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "fail" }] });
    const events: Array<[string[], Record<string, string>]> = [
      [[IFACE, "down"], {}],
      [[IFACE, "connectivity-change"], { CONNECTIVITY_STATE: "NONE" }],
      [["", "connectivity-change"], { CONNECTIVITY_STATE: "NONE" }],
    ];
    for (const [args, env] of events) {
      const d = runDispatcher(args, env);
      expect(d.status, args.join(" ")).toBe(0);
      expect(d.workerExits, `${args.join(" ")} started the worker`).toEqual([]);
    }
  });

  it("raises the recovery hotspot once the watchdog sees that activation settle as failed", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "fail" }] });
    nmStatePlan([], { uuid: HOME, plan: [] }); // in flight (70) until NetworkManager decides
    const d = runDispatcher();
    expect(d.workerExits).toEqual([1]);
    expect(d.recoveryAp).toBe(false);
    expect(readFileSync(pendingFile(), "utf-8")).toBe("1\n");
    // A tick while NetworkManager is still at it changes nothing.
    expect(runWatchdog().status).toBe(0);
    expect(workerExits()).toEqual([1]);
    // NetworkManager gives up on it: the next tick runs the worker again.
    settle("30");
    const w = runWatchdog();
    expect(w.status).toBe(0);
    expect(w.stdout).toContain("after a deferred failover — re-running it");
    expect(workerExits()).toEqual([1, 0]);
    expect(existsSync(path.join(nm, "recovery-ap")), "the recovery hotspot was never raised").toBe(true);
    expect(existsSync(pendingFile()), "the marker outlived the episode").toBe(false);
    // Episode over: later ticks leave the box alone.
    runWatchdog();
    expect(workerExits()).toEqual([1, 0]);
  });

  it("keeps the network that activation lands on", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }] });
    nmStatePlan([], { uuid: HOME, plan: [] });
    const d = runDispatcher();
    expect(d.workerExits).toEqual([1]);
    settle("100", HOME);
    runWatchdog();
    expect(workerExits()).toEqual([1, 0]);
    expect(readFileSync(path.join(nm, "journal"), "utf-8")).toContain(`Already on WiFi UUID ${HOME}`);
    expect(ups(d.lines)).toEqual([`--wait 45 connection up uuid ${HOME} ifname ${IFACE}`]);
    expect(existsSync(path.join(nm, "recovery-ap"))).toBe(false);
    expect(activeNow()).toBe(HOME);
    expect(existsSync(pendingFile())).toBe(false);
  });

  it("never acts over an activation that keeps going in flight: RECHECK_MAX re-checks, then the episode ends", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "fail" }] });
    nmStatePlan([], { uuid: HOME, plan: [], every: true });
    expect(RECHECK_MAX(), "wifi-failover.sh states no re-check cap").toBeGreaterThan(0);
    runDispatcher();
    for (let tick = 1; tick <= RECHECK_MAX() + 2; tick++) {
      settle("30"); // each attempt fails slowly, then the next one is in flight again
      runWatchdog();
    }
    expect(workerExits(), "the run, then one per re-check, then nothing").toEqual(Array(RECHECK_MAX() + 1).fill(1));
    const calls = readFileSync(path.join(nm, "calls"), "utf-8");
    expect(calls).not.toMatch(/connection\tdown/);
    expect(existsSync(path.join(nm, "recovery-ap"))).toBe(false);
    expect(existsSync(path.join(nm, "watchdog-ap"))).toBe(false);
    expect(existsSync(pendingFile())).toBe(false);
  });

  it("stands down during a deliberate client-connect, and drops a marker past its age", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "fail" }] });
    nmStatePlan([], { uuid: HOME, plan: [] });
    runDispatcher();
    settle("30");
    const connectLock = path.join(root, "data", "wifi-connecting.lock");
    writeFileSync(connectLock, String(Date.now()));
    runWatchdog();
    expect(workerExits(), "the worker ran over a client-connect in progress").toEqual([1]);
    rmSync(connectLock);
    const old = new Date(Date.now() - 3600_000);
    utimesSync(pendingFile(), old, old);
    runWatchdog();
    expect(workerExits(), "a stale marker re-ran the worker").toEqual([1]);
    expect(existsSync(pendingFile())).toBe(false);
  });

  it("pre-setup, re-runs the worker and leaves restoring the AP to it in that tick", () => {
    makeBox({ setupComplete: false, profiles: [] });
    mkdirSync(path.join(root, "radio-run"), { recursive: true });
    writeFileSync(pendingFile(), "1\n");
    settle("30");
    runWatchdog();
    expect(workerExits()).toEqual([0]);
    expect(existsSync(path.join(nm, "recovery-ap"))).toBe(true);
    expect(existsSync(path.join(nm, "watchdog-ap")), "the watchdog restarted the AP alongside the worker").toBe(false);
  });

  it("pre-setup, a marker it cannot act on does not cost the hotspot its self-heal", () => {
    makeBox({ setupComplete: false, profiles: [] });
    mkdirSync(path.join(root, "radio-run"), { recursive: true });
    writeFileSync(pendingFile(), "1\n");
    nmStatePlan(["fail"]); // the radio's state cannot be read this tick
    runWatchdog();
    expect(workerExits()).toEqual([]);
    expect(existsSync(path.join(nm, "watchdog-ap")), "the setup hotspot was left down").toBe(true);
    expect(readFileSync(pendingFile(), "utf-8")).toBe("1\n");
  });

  it("counts per episode: a marker already at the cap is not renewed, and goes with the deferral", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "fail" }] });
    mkdirSync(path.join(root, "radio-run"), { recursive: true });
    writeFileSync(pendingFile(), `${RECHECK_MAX()}\n`);
    nmStatePlan([], { uuid: HOME, plan: [] });
    const d = runDispatcher();
    expect(d.workerExits).toEqual([1]);
    expect(d.recoveryAp).toBe(false);
    expect(existsSync(pendingFile())).toBe(false);
  });

  it("pins the bound: one marker name, the cap and the age agree; the unit stays restart-free", () => {
    const unit = readFileSync(path.join(REPO, "config", "clawbox-wifi-failover.service"), "utf-8");
    const worker = readFileSync(FAILOVER, "utf-8");
    const watchdog = readFileSync(WATCHDOG, "utf-8");
    const helper = readFileSync(path.join(REPO, "scripts", "wifi-radio.sh"), "utf-8");
    const runDir = 'RADIO_DIR="${CLAWBOX_RADIO_RUN_DIR:-/run/clawbox-radio}"';
    expect(helper).toContain(runDir);
    expect(watchdog).toContain(runDir);
    expect(worker).toContain('PENDING="$RADIO_DIR/$RADIO_IFACE.failover-pending"');
    expect(watchdog).toContain('FAILOVER_PENDING="$RADIO_DIR/$IFACE.failover-pending"');
    expect(RECHECK_MAX()).toBeGreaterThanOrEqual(1);
    expect(RECHECK_MAX()).toBeLessThanOrEqual(5);
    const maxAge = Number(/^FAILOVER_PENDING_MAX_AGE=(\d+)$/m.exec(watchdog)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(3600);
    // systemd refuses Restart=always/on-success AND RestartForceExitStatus= on
    // Type=oneshot ("isn't allowed for Type=oneshot services. Refusing.",
    // systemd-analyze verify, systemd 255): such a line would stop this unit
    // loading at all. Re-runs go through the watchdog instead.
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).not.toMatch(/^Restart/m);
  });
});

// The re-run must not become a road around the owner's hotspot switch
// (TASK-507): pre-setup, the worker's recovery restarts clawbox-ap.service and
// start-ap.sh honours HOTSPOT_DISABLED only once setup is complete.
describe("TASK-1380 R2: the deferred-failover re-run honours the owner's hotspot switch", () => {
  const hotspotEnv = (disabled: string) =>
    writeFileSync(path.join(root, "data", "hotspot.env"), `HOTSPOT_SSID='ClawBox-Setup'\nHOTSPOT_DISABLED=${disabled}\n`);
  const leaveMarker = () => {
    mkdirSync(path.join(root, "radio-run"), { recursive: true });
    writeFileSync(pendingFile(), "1\n");
  };

  it("pre-setup, switched off, with a marker: no re-run, so nothing raises the hotspot", () => {
    makeBox({ setupComplete: false, profiles: [] });
    hotspotEnv("1");
    leaveMarker();
    settle("30");
    expect(runWatchdog().status).toBe(0);
    expect(workerExits(), "the worker ran, and its recovery raises a hotspot the owner switched off").toEqual([]);
    expect(existsSync(path.join(nm, "recovery-ap"))).toBe(false);
    expect(existsSync(path.join(nm, "watchdog-ap"))).toBe(false);
    expect(readFileSync(pendingFile(), "utf-8"), "left to age out, not consumed").toBe("1\n");
  });

  it("pre-setup, switched off, no marker: left alone as before", () => {
    makeBox({ setupComplete: false, profiles: [] });
    hotspotEnv("1");
    settle("30");
    expect(runWatchdog().status).toBe(0);
    expect(workerExits()).toEqual([]);
    expect(existsSync(path.join(nm, "watchdog-ap"))).toBe(false);
  });

  it("pre-setup, switched on, with a marker: re-run, and the AP left to the worker", () => {
    makeBox({ setupComplete: false, profiles: [] });
    hotspotEnv("0");
    leaveMarker();
    settle("30");
    runWatchdog();
    expect(workerExits()).toEqual([0]);
    expect(existsSync(path.join(nm, "recovery-ap"))).toBe(true);
    expect(existsSync(path.join(nm, "watchdog-ap"))).toBe(false);
  });

  it("post-setup, switched off, with a marker: the saved-client recovery still runs", () => {
    makeBox({ setupComplete: true, profiles: [{ uuid: HOME, name: "Example-Home", up: "ok" }] });
    hotspotEnv("1");
    leaveMarker();
    settle("30");
    runWatchdog();
    expect(workerExits()).toEqual([0]);
    expect(activeNow()).toBe(HOME);
    expect(existsSync(pendingFile())).toBe(false);
  });
});
