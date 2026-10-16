# shellcheck shell=bash
# A clean start for the shared browser — the ONE rule every launcher of it
# follows: scripts/launch-browser.sh (clawbox-browser.service, which the web
# server's keeper and the Browser app's Open start) and the x64 desktop
# session's clawbox-desktop-browser, which installs this file beside its other
# helpers in /usr/local/lib/clawbox/.
#
# The window on the remote desktop used to collect tabs: Chromium restored the
# last session on every start (and after a crash, offered to), and every start
# added the start page on top. So:
#
#   1. Before a start, the profile's Default/Preferences is set to open the new
#      tab page instead of the last session, and to remember a clean exit
#      (browser_reset_session_prefs). Only those four keys change; the file is
#      parsed and written whole, atomically, and never while a browser is on
#      the profile (that browser would write its own copy back over it).
#      Cookies, sign-ins and everything else in the profile are not touched.
#   2. BROWSER_CLEAN_START_FLAGS goes on the command line: no "Restore pages?"
#      bubble, whatever the profile says.
#   3. A browser that is already running is reused, never joined by a second
#      start (browser_reuse_running): its page is brought to the front, and a
#      URL is opened only when one was asked for — in a blank tab when there is
#      one, so asking twice does not leave a trail of tabs either.
#
# Sourced by the launchers. Run directly it is the same three for a test or a
# person:
#
#   browser-clean-start.sh in-use PROFILE         exit 0 while a browser holds it
#   browser-clean-start.sh reset-prefs PROFILE    step 1, with a line saying what it did
#   browser-clean-start.sh reuse PORT [URL [START]]  step 3 (exit 1: nothing answers on PORT)
#
# Needs python3 for the JSON; without it the preferences are left as they are
# and the launcher starts the browser anyway.

# shellcheck disable=SC2034  # read by the launchers that source this
BROWSER_CLEAN_START_FLAGS=(--hide-crash-restore-bubble)

# _browser_holds_profile PID PROFILE [lock] — is PID a browser on PROFILE?
# Read in bash alone (no process started per PID: this runs over every one).
#
#   * --user-data-dir=PROFILE is an argument of its own: whatever runs it,
#     since a launcher always passes the profile to the browser.
#   * Otherwise only a Chromium build (by its executable) counts. A running
#     one may have rewritten its command line into ONE space-joined string —
#     its children always, the browser itself when started through a wrapper
#     — which still names the profile. With `lock` (PID is the one the
#     profile's SingletonLock names) a Chromium naming no profile at all also
#     counts: a browser on its default profile.
#
# A PID the kernel has since handed to something else is none of these.
_browser_holds_profile() {
  local pid="$1" profile="$2" lock="${3:-}" a joined exe
  local -a argv=()
  { mapfile -d '' -t argv < "/proc/$pid/cmdline"; } 2>/dev/null || return 1
  [ "${#argv[@]}" -gt 0 ] || return 1
  for a in "${argv[@]}"; do
    case "$a" in "--user-data-dir=$profile"|"--user-data-dir=$profile/") return 0 ;; esac
  done
  joined=" ${argv[*]} "
  case "$joined" in
    *" --user-data-dir=$profile "*|*" --user-data-dir=$profile/ "*) ;;
    *" --user-data-dir="*) return 1 ;;
    *) [ -n "$lock" ] || return 1 ;;
  esac
  exe="$(readlink "/proc/$pid/exe" 2>/dev/null)" || return 1
  case "${exe##*/}" in
    *chrome*|*chromium*) return 0 ;;
  esac
  return 1
}

# browser_profile_in_use PROFILE — exit 0 while a browser runs on PROFILE:
# the live browser its SingletonLock (<host>-<pid>) names, or any browser
# process on it (see _browser_holds_profile). A lock left by a browser that
# was killed, or by a boot before this one, is not one.
browser_profile_in_use() {
  local profile="$1" target pid d
  while [[ "$profile" == */ && "$profile" != / ]]; do profile="${profile%/}"; done
  if target="$(readlink "$profile/SingletonLock" 2>/dev/null)"; then
    pid="${target##*-}"
    if [[ "$pid" =~ ^[0-9]+$ ]] && _browser_holds_profile "$pid" "$profile" lock; then
      return 0
    fi
  fi
  for d in /proc/[0-9]*; do
    _browser_holds_profile "${d#/proc/}" "$profile" && return 0
  done
  return 1
}

# browser_reset_session_prefs PROFILE — step 1. Prints one line saying what it
# did. Exit 0 when the profile now starts clean (or has no preferences yet, so
# there is no session to restore), 1 when a browser is running on it and it was
# left alone, 2 when the file could not be read or written as JSON.
browser_reset_session_prefs() {
  local profile="$1"
  while [[ "$profile" == */ && "$profile" != / ]]; do profile="${profile%/}"; done
  if browser_profile_in_use "$profile"; then
    echo "a browser is running on $profile; its preferences are left to it"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found; $profile/Default/Preferences is left as it is"
    return 2
  fi
  python3 - "$profile/Default/Preferences" <<'PY'
import json, os, stat, sys, tempfile

path = sys.argv[1]
# The new tab page on start (5; 1 is "continue where you left off"), no start
# URLs of the profile's own, and the last exit a clean one.
WANT = (
    ("session", "restore_on_startup", 5),
    ("session", "startup_urls", []),
    ("profile", "exit_type", "Normal"),
    ("profile", "exited_cleanly", True),
)

def leave(why, code=2):
    print(f"{path}: {why}; left as it is")
    sys.exit(code)

def no_constants(name):
    raise ValueError(f"{name} is not JSON")

try:
    st = os.lstat(path)
except FileNotFoundError:
    print(f"{path} does not exist yet: a fresh profile has no session to restore")
    sys.exit(0)
except OSError as e:
    leave(f"cannot be read ({e.strerror})")
if not stat.S_ISREG(st.st_mode):
    leave("not a regular file")
if os.geteuid() not in (0, st.st_uid):
    leave("owned by another user")
try:
    with open(path, "rb") as f:
        prefs = json.loads(f.read().decode("utf-8"), parse_constant=no_constants)
except OSError as e:
    leave(f"cannot be read ({e.strerror})")
except (UnicodeDecodeError, ValueError):
    leave("not valid JSON")
if not isinstance(prefs, dict):
    leave("not a JSON object")

changed = []
for section, key, value in WANT:
    block = prefs.setdefault(section, {})
    if not isinstance(block, dict):
        leave(f'"{section}" is not an object')
    have = block.get(key)
    # type() too: 1 == True and 5 == 5.0 in Python, not in the file.
    if type(have) is not type(value) or have != value:
        block[key] = value
        changed.append(f"{section}.{key}")
if not changed:
    print(f"{path} already starts clean")
    sys.exit(0)

folder = os.path.dirname(path)
try:
    fd, tmp = tempfile.mkstemp(prefix=".Preferences.", suffix=".tmp", dir=folder)
except OSError as e:
    leave(f"no room for a new copy beside it ({e.strerror})")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(prefs, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, stat.S_IMODE(st.st_mode))
    if os.geteuid() == 0:
        # Root starting the browser for its owner: the copy stays the owner's.
        os.chown(tmp, st.st_uid, st.st_gid)
    os.replace(tmp, path)
except (OSError, ValueError) as e:
    # ValueError: a string Python read but cannot write back as UTF-8 (a lone
    # surrogate escape) — the original is still in place.
    try:
        os.unlink(tmp)
    except OSError:
        pass
    leave(f"cannot be written ({getattr(e, 'strerror', None) or e})")
try:
    dirfd = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(dirfd)
    finally:
        os.close(dirfd)
except OSError:
    pass
print(f"{path}: set {', '.join(changed)}")
PY
}

# browser_reuse_running PORT [URL [START]] — step 3, for a browser that
# answers on its DevTools PORT (on this machine). Prints one line saying what
# it did; exit 0 when it did it, 1 when nothing answers on PORT (the caller
# starts a browser), 2 when one answers but the request failed or was refused.
#
#   * no URL asked for: its most recently used page comes to the front. Nothing
#     is opened — a running browser with a page gets no blank tab.
#   * a URL asked for: a page already showing it comes to the front; else the
#     URL opens in place of a blank tab (the new tab page, about:blank) when
#     there is one, and in a new tab of the running browser when there is not.
#   * no page at all: the URL asked for, else START (the owner's start page,
#     about:blank when there is none), so there is a window to look at.
#
# URL and START are http(s) addresses or about:blank. A URL that is not is
# refused (exit 2) and nothing opens; a START that is not is about:blank.
browser_reuse_running() {
  local port="$1" url="${2:-}" start="${3:-}"
  if ! command -v python3 >/dev/null 2>&1; then
    curl -s -m 3 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1 || return 1
    echo "python3 not found, so the running browser is left as it is"
    return 2
  fi
  python3 - "$port" "$url" "$start" <<'PY'
import json, re, sys, urllib.parse, urllib.request

port, url, start = sys.argv[1], sys.argv[2], sys.argv[3]
base = f"http://127.0.0.1:{port}"
BLANK = ("about:blank", "chrome://newtab/", "chrome://new-tab-page/", "chrome-search://local-ntp/local-ntp.html", "")
ADDRESS = re.compile(r"https?://\S+|about:blank")
# DevTools target ids are hex; anything else never reaches a URL path.
TARGET_ID = re.compile(r"[A-Za-z0-9_-]+")

def call(path, method="GET"):
    req = urllib.request.Request(base + path, method=method)
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.read()

if not port.isdigit():
    print(f"{port!r} is not a port")
    sys.exit(2)
try:
    targets = json.loads(call("/json/list"))
except (OSError, ValueError):
    sys.exit(1)
if url and not ADDRESS.fullmatch(url):
    print(f"{url!r} is not an http(s) address; nothing opened")
    sys.exit(2)
if not ADDRESS.fullmatch(start):
    start = "about:blank"

# Most recently used first: the order the DevTools list keeps.
pages = [t for t in targets if isinstance(t, dict) and t.get("type") == "page"
         and isinstance(t.get("id"), str) and TARGET_ID.fullmatch(t["id"]) and len(t["id"]) <= 128
         and isinstance(t.get("url"), str) and not t["url"].startswith("devtools://")]

def activate(page):
    call(f"/json/activate/{page['id']}")

def open_tab(address):
    # Chromium unescapes the query, so the URL travels escaped whole. PUT:
    # Chromium no longer takes GET for a call that changes something.
    page = json.loads(call(f"/json/new?{urllib.parse.quote(address, safe='')}", method="PUT"))
    return page if isinstance(page, dict) and isinstance(page.get("id"), str) and TARGET_ID.fullmatch(page["id"]) else None

same = next((p for p in pages if url and p["url"] == url), None)
try:
    if not pages:
        open_tab(url or start)
        print(f"opened {url or start} in it: it had no page")
    elif not url:
        activate(pages[0])
        print("brought its page to the front; opened nothing")
    elif same:
        activate(same)
        print(f"{url} was already open; brought it to the front")
    else:
        blank = next((p for p in pages if p["url"] in BLANK), None)
        page = open_tab(url)
        if blank:
            # Opened first, closed after: a window whose only tab closed first
            # would take the browser with it.
            call(f"/json/close/{blank['id']}")
        if page:
            activate(page)
        print(f"opened {url} " + ("in place of a blank tab" if blank else "in a new tab"))
except (OSError, ValueError) as e:
    print(f"it did not take the request ({e}); left as it is")
    sys.exit(2)
PY
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  case "${1:-}/${2:-}" in
    in-use/?*) browser_profile_in_use "$2" ;;
    reset-prefs/?*) browser_reset_session_prefs "$2" ;;
    reuse/?*) browser_reuse_running "$2" "${3:-}" "${4:-}" ;;
    *) echo "usage: $0 in-use PROFILE | reset-prefs PROFILE | reuse PORT [URL [START]]" >&2; exit 64 ;;
  esac
fi
