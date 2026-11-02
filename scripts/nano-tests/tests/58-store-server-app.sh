#!/usr/bin/env bash
# timeout: 900
# covers: src/lib/project-folder.ts src/lib/store-install.ts src/lib/store-install-receipt.ts src/lib/store-search.ts
# covers: src/lib/app-proxy.ts src/lib/app-server-start.ts src/lib/webapp-icon.ts scripts/app-port.js
# covers: src/app/setup-api/apps/* src/app/setup-api/webapps/* src/app/apps/*
# covers: src/lib/app-window.ts src/components/WebappFrame.tsx
#
# A ClawBox server app from the Store (Audiobook Player) on a box whose owner
# never chose a project folder — the state a fresh or factory-reset box is in:
#
#   1. The project folder in force is ~/Projects (no config key at all).
#   2. The Store's search finds the app by its slug, hyphens and all.
#   3. It installs with no "set a project folder first" refusal, into
#      ~/Projects/<id>, carrying the Store's receipt.
#   4. Its desktop address sends the frame on to /apps/<id>/ with a redirect,
#      and that document opens with the owner's session — not the box's login
#      page — once the app answers; without a session it still asks to log in.
#   5. Uninstall removes it, and a reinstall answers ok again, into the same
#      folder, with the same redirect (its build is not waited for a second
#      time: one build of a Next app is most of the deadline on a Nano).
#   6. A page the app's frame navigates to ITSELF arrives with no cookie (the
#      sandbox): the box answers it with the page that asks the window to
#      reopen it (src/lib/app-window.ts), never the login redirect; the same
#      address with the owner's cookie — the window's reopen — opens; a
#      visitor's top-level navigation still gets the login. The App Router's
#      own fetches are answered for the sandbox's opaque origin, and the box's
#      API answers that origin 401.
#
# First, a multi-page Next.js app of the test's own (WINDOW_FLOW), built on the
# board with the box's own Next and React versions and put on the desktop from
# its project folder, clicked through in a real headless Chromium inside its
# window (/app/installed-<id>, the same frame as the desktop's) over the
# board's LAN address — plain HTTP, where a sandboxed frame sends no cookie, no
# Sec-Fetch-* and no Referer: <Link> navigations, plain links, a fetch of its
# own API, an image, a form post, a server action, none of which may show the
# login screen; from inside it /setup-api gets no owner session and the window
# will not open the box's API for it; a visitor without a session gets the
# login. Skipped when the board has no Chromium for Playwright. It has 240 s
# of the test's 900 (about 40 s on a Nano with the npm cache warm), and the
# Store flow's deadlines count from the start of the test, so the two
# together stay inside it.
#
# NOT `parallel:` — it changes config.json and installs an app. The owner's own
# project folder, if the board has one, is put back on the way out, and the
# app is uninstalled. The owner's cookie exists only on the board. Skipped when
# the Store does not list the app.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# shellcheck disable=SC2016  # expanded on the board
FLOW='
say() { printf "RESULT %s\n" "$*"; }
SECRET_FILE="$REPO/data/.session-secret"
CONFIG="$REPO/data/config.json"
APP=audiobook-player
FOLDER="$HOME/Projects/$APP"

owner_cookie() {
  node -e "
    const fs = require(\"fs\"), crypto = require(\"crypto\");
    const secret = fs.readFileSync(process.argv[1], \"utf8\").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, gen })).toString(\"base64url\");
    process.stdout.write(payload + \".\" + crypto.createHmac(\"sha256\", secret).update(payload).digest(\"hex\"));
  " "$SECRET_FILE" "$CONFIG"
}

# call METHOD PATH [BODY] [MAX_TIME] — as the signed-in owner.
call() {
  local method=$1 path=$2 body=${3:-} max=${4:-120} out code extra=()
  [ -n "$body" ] && extra=(-H "Content-Type: application/json" --data-binary "$body")
  out=$(mktemp)
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$COOKIE" \
    | curl -sS -o "$out" -w "%{http_code}" -X "$method" --max-time "$max" "${extra[@]}" -K - "$DASHBOARD$path" 2>/dev/null)
  printf "%s\n" "${code:-000}"; cat "$out"; rm -f "$out"
}
status_of() { printf "%s\n" "$1" | head -n1; }
body_of() { printf "%s\n" "$1" | tail -n +2; }
py() { python3 -c "import json,sys; j=json.load(sys.stdin); a=sys.argv[2:]; print(eval(sys.argv[1]))" "$@" 2>/dev/null; }

# doc PATH [cookie|none] — what a desktop window loading PATH gets: "<status> <redirect>".
doc() {
  local jar=""
  [ "${2:-cookie}" = cookie ] && jar="header = \"Cookie: clawbox_session=$COOKIE\""
  printf "%s\n" "$jar" | curl -sS -o /dev/null -w "%{http_code} %{redirect_url}" --max-time 30 -K - \
    -H "Sec-Fetch-Dest: iframe" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Site: same-origin" -H "Accept: text/html" \
    "$DASHBOARD$1" 2>/dev/null
}

# top PATH — a visitor typing the address: a top-level navigation, no cookie.
top() {
  curl -sS -o /dev/null -w "%{http_code} %{redirect_url}" --max-time 30 \
    -H "Sec-Fetch-Dest: document" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Site: none" -H "Accept: text/html" \
    "$DASHBOARD$1" 2>/dev/null
}

# frame_nav PATH — a navigation the sandboxed app frame makes itself: no
# cookie, cross-site. "<status> <body>".
frame_nav() {
  local out code
  out=$(mktemp)
  code=$(curl -sS -o "$out" -w "%{http_code}" --max-time 30 \
    -H "Sec-Fetch-Dest: iframe" -H "Sec-Fetch-Mode: navigate" -H "Sec-Fetch-Site: cross-site" -H "Accept: text/html" \
    "$DASHBOARD$1" 2>/dev/null)
  printf "%s %s" "${code:-000}" "$(tr -d "\n" < "$out" | head -c 4000)"; rm -f "$out"
}

# opaque [CURL_ARGS…] PATH — a fetch from the app frame (Origin: null, no
# cookie): "<status> <allow-origin> <content-type>".
opaque() {
  local path=${*: -1} args=("${@:1:$#-1}") hdr code ao ct
  hdr=$(mktemp)
  code=$(curl -sS -o /dev/null -D "$hdr" -w "%{http_code}" --max-time 60 -H "Origin: null" -H "Sec-Fetch-Mode: cors" -H "Sec-Fetch-Site: cross-site" "${args[@]}" "$DASHBOARD$path" 2>/dev/null)
  ao=$(grep -i "^access-control-allow-origin:" "$hdr" | tail -n 1 | cut -d: -f2- | tr -d " \r")
  ct=$(grep -i "^content-type:" "$hdr" | tail -n 1 | cut -d: -f2- | cut -d";" -f1 | tr -d " \r")
  rm -f "$hdr"
  printf "%s %s %s" "${code:-000}" "${ao:--}" "${ct:--}"
}

# set_folder VALUE — "" removes the key, the way a factory reset leaves config.json.
set_folder() {
  python3 -c "
import json, os, sys
p, v = sys.argv[1], sys.argv[2]
c = json.load(open(p))
if v: c[\"coding_agent_default_directory\"] = v
else: c.pop(\"coding_agent_default_directory\", None)
t = p + \".nano-tmp\"
open(t, \"w\").write(json.dumps(c, indent=2))
os.chmod(t, 0o600)
os.replace(t, p)
" "$CONFIG" "$1"
}

uninstall() { call POST /setup-api/apps/uninstall "{\"appId\":\"$APP\"}" 60; }
# install MAX_SECONDS
install() { call POST /setup-api/apps/install "{\"appId\":\"$APP\",\"source\":\"clawbox\"}" "$1"; }
# $1: the seconds the window flow already took of the test's deadline.
T0=$(( $(date +%s) - ${1:-0} ))
left() { local n=$(( T0 + $1 - $(date +%s) )); [ "$n" -lt 30 ] && n=30; echo "$n"; }

# wait_open UNTIL — poll the desktop address until /apps/<id>/ answers 200 (the
# app builds and starts after install), at most until T0+UNTIL; echoes the last answer.
wait_open() {
  local end=$(( T0 + $1 )) first second
  while :; do
    first=$(doc "/setup-api/webapps?app=$APP")
    second=$(doc "/apps/$APP/")
    case "$second" in 200*) break ;; esac
    [ "$(date +%s)" -ge "$end" ] && break
    sleep 10
  done
  printf "%s | %s\n" "$first" "$second"
}

if [ ! -r "$SECRET_FILE" ]; then say "not ok - $SECRET_FILE is not readable as the box account"; exit 0; fi
COOKIE=$(owner_cookie)
SAVED=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(\"coding_agent_default_directory\") or \"\")" "$CONFIG" 2>/dev/null)
cleanup() {
  uninstall >/dev/null 2>&1
  [ -n "$SAVED" ] && set_folder "$SAVED"
}
trap cleanup EXIT

r=$(call GET "/setup-api/apps/store?limit=200&q=audiobook%20player")
if [ "$(status_of "$r")" != 200 ] || [ "$(body_of "$r" | py "any(a.get(\"slug\") == sys.argv[2] for a in j.get(\"apps\", []))" "$APP")" != True ]; then
  say "skip the Store does not list $APP here: HTTP $(status_of "$r")"; exit 0
fi

uninstall >/dev/null 2>&1
set_folder ""
r=$(call GET /setup-api/coding-agent/status)
DIR=$(body_of "$r" | py "j.get(\"defaultDirectory\")")
[ "$DIR" = "$HOME/Projects" ] && say "ok - with no folder chosen the project folder in force is ~/Projects" \
  || say "not ok - with no folder chosen the status names \"$DIR\" (HTTP $(status_of "$r"))"

r=$(call GET "/setup-api/apps/store?limit=200&q=$APP")
[ "$(body_of "$r" | py "[a.get(\"slug\") for a in j.get(\"apps\", [])].count(sys.argv[2])" "$APP")" = 1 ] \
  && say "ok - the Store search finds $APP by its slug, hyphens and all" \
  || say "not ok - the Store search for \"$APP\" did not list it once: HTTP $(status_of "$r") $(body_of "$r" | head -c 200)"

for round in install reinstall; do
  if [ "$round" = install ]; then r=$(install "$(left 480)"); else r=$(install "$(left 840)"); fi
  if [ "$(status_of "$r")" = 200 ] && [ "$(body_of "$r" | py "j.get(\"ok\")")" = True ]; then
    say "ok - $round: the Store installed $APP with no project folder chosen"
  else
    say "not ok - $round: the install answered HTTP $(status_of "$r") $(body_of "$r" | py "j.get(\"error\")" | head -c 300)"; exit 0
  fi
  [ -f "$FOLDER/clawbox.json" ] && [ -f "$FOLDER/.clawbox/store-app.json" ] \
    && say "ok - $round: it is in ~/Projects/$APP with the Store receipt, owned by $(stat -c %U "$FOLDER")" \
    || say "not ok - $round: ~/Projects/$APP has no clawbox.json or no Store receipt"
  if [ "$round" = install ]; then
    OPEN=$(wait_open 640)
    case "$OPEN" in
      "302 "*"/apps/$APP/ | 200 "*) say "ok - $round: the desktop address redirects to /apps/$APP/, which opens with the owner session" ;;
      *"/login"*) say "not ok - $round: the app window lands on the login page: $OPEN" ;;
      *) say "not ok - $round: the app window did not open: $OPEN" ;;
    esac
  else
    OPEN="$(doc "/setup-api/webapps?app=$APP") | $(doc "/apps/$APP/")"
    case "$OPEN" in
      "302 "*"/apps/$APP/ | "*"/login"*) say "not ok - $round: the app window lands on the login page: $OPEN" ;;
      "302 "*"/apps/$APP/ | "*) say "ok - $round: the desktop address redirects to /apps/$APP/ again ($OPEN)" ;;
      *) say "not ok - $round: the desktop address did not redirect to /apps/$APP/: $OPEN" ;;
    esac
  fi
  ANON=$(top "/apps/$APP/")
  case "$ANON" in 307*"/login"*) say "ok - $round: a visitor opening /apps/$APP/ without a session is sent to log in" ;; *) say "not ok - $round: a visitor opening /apps/$APP/ without a session got $ANON" ;; esac
  if [ "$round" = install ]; then
    # 6. What a navigation the frame makes itself gets: no cookie, cross-site.
    REOPEN=$(frame_nav "/apps/$APP/?nano=1")
    case "$REOPEN" in
      "401 "*clawboxAppReopen*) say "ok - a page the app frame opens itself gets the reopen page, not the login redirect" ;;
      *) say "not ok - a page the app frame opens itself answered: $(printf "%s" "$REOPEN" | head -c 160)" ;;
    esac
    case "$(doc "/apps/$APP/?nano=1")" in
      200*) say "ok - the window reopening that page with the owner session opens it" ;;
      *) say "not ok - the window reopening that page answered $(doc "/apps/$APP/?nano=1")" ;;
    esac
    PRE=$(opaque -X OPTIONS -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: next-router-state-tree,next-url,rsc" "/apps/$APP/")
    case "$PRE" in
      "204 null"*) say "ok - the App Router preflight from the app frame is answered for its opaque origin" ;;
      *) say "not ok - the App Router preflight from the app frame answered: $PRE" ;;
    esac
    RSC=$(opaque -H "RSC: 1" "/apps/$APP/?_rsc=")
    case "$RSC" in
      "200 null text/x-component"*) say "ok - an App Router fetch from the app frame is readable by it" ;;
      *) say "not ok - an App Router fetch from the app frame answered: $RSC" ;;
    esac
    BOX=$(opaque "/setup-api/system/version")
    case "$BOX" in 401*) say "ok - the box API answers the app frame 401" ;; *) say "not ok - the box API answered the app frame: $BOX" ;; esac
  fi
  if [ "$round" = install ]; then
    r=$(uninstall)
    [ "$(status_of "$r")" = 200 ] && [ ! -e "$FOLDER" ] && say "ok - uninstall removed $APP and its folder" \
      || say "not ok - uninstall answered HTTP $(status_of "$r"), folder $( [ -e "$FOLDER" ] && echo still there || echo gone)"
  fi
done
'

# A multi-page Next.js app of the test's own, clicked through in its window
# (see the header). $1 is the run id, for the folder's name.
# shellcheck disable=SC2016  # expanded on the board
WINDOW_FLOW='
say() { printf "RESULT %s\n" "$*"; }
SECRET_FILE="$REPO/data/.session-secret"
CONFIG="$REPO/data/config.json"
owner_cookie() {
  node -e "
    const fs = require(\"fs\"), crypto = require(\"crypto\");
    const secret = fs.readFileSync(process.argv[1], \"utf8\").trim();
    let gen = 0;
    try { const c = JSON.parse(fs.readFileSync(process.argv[2], \"utf8\")); if (Number.isFinite(c.session_generation)) gen = c.session_generation; } catch {}
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, gen })).toString(\"base64url\");
    process.stdout.write(payload + \".\" + crypto.createHmac(\"sha256\", secret).update(payload).digest(\"hex\"));
  " "$SECRET_FILE" "$CONFIG"
}
call() {
  local method=$1 path=$2 body=${3:-} out code extra=()
  [ -n "$body" ] && extra=(-H "Content-Type: application/json" --data-binary "$body")
  out=$(mktemp)
  code=$(printf "header = \"Cookie: clawbox_session=%s\"\nheader = \"Origin: http://127.0.0.1\"\n" "$COOKIE" \
    | curl -sS -o "$out" -w "%{http_code}" -X "$method" --max-time 120 "${extra[@]}" -K - "$DASHBOARD$path" 2>/dev/null)
  printf "%s\n" "${code:-000}"; cat "$out"; rm -f "$out"
}
status_of() { printf "%s\n" "$1" | head -n1; }
body_of() { printf "%s\n" "$1" | tail -n +2; }

EXE=$(find "$HOME/.cache/ms-playwright" -maxdepth 4 -type f \( -name headless_shell -o -name chrome \) -perm -u+x 2>/dev/null | sort -V | tail -n 1)
if [ -z "$EXE" ] || [ ! -d "$REPO/node_modules/playwright" ]; then say "skip no Chromium for Playwright on the board: the window click-through needs one"; exit 0; fi
if [ ! -r "$SECRET_FILE" ]; then say "not ok - $SECRET_FILE is not readable as the box account"; exit 0; fi
COOKIE=$(owner_cookie)
# This flow's share of the test's deadline (see the header).
END=$(( $(date +%s) + 240 ))
left() { local n=$(( END - $(date +%s) )); [ "$n" -lt 10 ] && n=10; echo "$n"; }

BASE=$(body_of "$(call GET /setup-api/coding-agent/status)" | python3 -c "import json,sys; print(json.load(sys.stdin).get(\"defaultDirectory\") or \"\")" 2>/dev/null)
[ -n "$BASE" ] || BASE=$HOME/Projects
APP="nano-ci-$(printf "%s" "$1" | tr -c "A-Za-z0-9-" "-" | cut -c1-40)-window"
DIR=$BASE/$APP
case "$DIR" in *"/../"* | *"/./"* | *"//"*) say "not ok - refusing to make $DIR"; exit 0 ;; /home/clawbox/?*/nano-ci-*) ;; *) say "not ok - refusing to make $DIR"; exit 0 ;; esac
PORT=$(node -e "const s = require(\"net\").createServer(); s.listen(0, \"127.0.0.1\", () => { console.log(s.address().port); s.close(); });")
cleanup() {
  [ -f "$DIR/.nano-pid" ] && kill -- "-$(cat "$DIR/.nano-pid")" 2>/dev/null
  call POST /setup-api/apps/uninstall "{\"appId\":\"$APP\"}" >/dev/null 2>&1
  case "$DIR" in /home/clawbox/?*/nano-ci-*) rm -rf -- "$DIR" ;; esac
}
trap cleanup EXIT
rm -rf -- "$DIR"; mkdir -p "$DIR/app/books/[id]" "$DIR/app/plain" "$DIR/app/form/done" "$DIR/app/action/done" "$DIR/app/api/echo" "$DIR/app/api/submit" "$DIR/public"
VERSIONS=$(node -e "const p = require(process.argv[1]); const d = p.dependencies || {}; console.log([d.next, d.react, d[\"react-dom\"]].join(\" \"))" "$REPO/package.json")
read -r V_NEXT V_REACT V_DOM <<< "$VERSIONS"
printf "{ \"name\": \"%s\", \"private\": true, \"dependencies\": { \"next\": \"%s\", \"react\": \"%s\", \"react-dom\": \"%s\" } }\n" "$APP" "$V_NEXT" "$V_REACT" "$V_DOM" > "$DIR/package.json"
printf "{ \"name\": \"Nano Window\", \"kind\": \"server\", \"port\": %s, \"start\": \"npx next start -p %s\" }\n" "$PORT" "$PORT" > "$DIR/clawbox.json"
printf "export default { basePath: \"/apps/%s\", skipTrailingSlashRedirect: true };\n" "$APP" > "$DIR/next.config.mjs"
printf "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\"><circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"#f97316\"/></svg>\n" > "$DIR/public/dot.svg"
cat > "$DIR/app/layout.jsx" <<"EOF"
import Link from "next/link";
export default function RootLayout({ children }) {
  return (
    <html lang="en"><body>
      <nav>
        <Link id="nav-home" href="/">Home</Link> <Link id="nav-books" href="/books">Books</Link> <Link id="nav-form" href="/form">Form</Link> <Link id="nav-action" href="/action">Action</Link>
        <a id="nav-plain" href="/apps/__APP__/plain">Plain link</a>
      </nav>
      {children}
    </body></html>
  );
}
EOF
cat > "$DIR/app/page.jsx" <<"EOF"
import ApiButton from "./api-button";
export const dynamic = "force-dynamic";
export default function Home() {
  return (<main data-page="home"><h1>HOME</h1><img id="dot" src="/apps/__APP__/dot.svg" width="24" height="24" alt="" /><ApiButton /></main>);
}
EOF
cat > "$DIR/app/api-button.jsx" <<"EOF"
"use client";
import { useState } from "react";
export default function ApiButton() {
  const [out, setOut] = useState("");
  const call = async () => {
    try { const r = await fetch("/apps/__APP__/api/echo"); const j = await r.json(); setOut("api " + r.status + " " + j.ok); } catch (e) { setOut("api error " + e.message); }
  };
  return (<p><button id="api-btn" onClick={call}>Call API</button> <span id="api-out">{out}</span></p>);
}
EOF
cat > "$DIR/app/books/page.jsx" <<"EOF"
import Link from "next/link";
export const dynamic = "force-dynamic";
export default function Books() {
  return (<main data-page="books"><h1>BOOKS</h1>{[1, 2, 3].map((n) => <p key={n}><Link id={"book-" + n} href={"/books/" + n}>Book {n}</Link></p>)}</main>);
}
EOF
cat > "$DIR/app/books/[id]/page.jsx" <<"EOF"
export const dynamic = "force-dynamic";
export default async function Book({ params }) {
  const { id } = await params;
  return (<main data-page={"book-" + id}><h1>BOOK {id}</h1></main>);
}
EOF
cat > "$DIR/app/plain/page.jsx" <<"EOF"
export const dynamic = "force-dynamic";
export default function Plain() {
  return (<main data-page="plain"><h1>PLAIN</h1><a id="plain-back" href="/apps/__APP__/books">Books</a></main>);
}
EOF
cat > "$DIR/app/form/page.jsx" <<"EOF"
export const dynamic = "force-dynamic";
export default function Form() {
  return (<main data-page="form"><h1>FORM</h1><form method="post" action="/apps/__APP__/api/submit"><input name="title" defaultValue="hello form" /><button id="form-submit" type="submit">Post</button></form></main>);
}
EOF
cat > "$DIR/app/form/done/page.jsx" <<"EOF"
export const dynamic = "force-dynamic";
export default async function Done({ searchParams }) {
  const { title } = await searchParams;
  return (<main data-page="form-done"><h1>SAVED {String(title ?? "")}</h1></main>);
}
EOF
cat > "$DIR/app/api/submit/route.js" <<"EOF"
export async function POST(request) {
  const title = String((await request.formData()).get("title") ?? "");
  return new Response(null, { status: 303, headers: { Location: "/apps/__APP__/form/done?title=" + encodeURIComponent(title) } });
}
EOF
cat > "$DIR/app/api/echo/route.js" <<"EOF"
export const dynamic = "force-dynamic";
export async function GET() { return Response.json({ ok: true }); }
EOF
cat > "$DIR/app/action/page.jsx" <<"EOF"
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
async function save(formData) {
  "use server";
  redirect("/action/done?note=" + encodeURIComponent(String(formData.get("note") ?? "")));
}
export default function Action() {
  return (<main data-page="action"><h1>ACTION</h1><form action={save}><input name="note" defaultValue="hello action" /><button id="action-submit" type="submit">Save</button></form></main>);
}
EOF
cat > "$DIR/app/action/done/page.jsx" <<"EOF"
export const dynamic = "force-dynamic";
export default async function ActionDone({ searchParams }) {
  const { note } = await searchParams;
  return (<main data-page="action-done"><h1>ACTION DONE {String(note ?? "")}</h1></main>);
}
EOF
find "$DIR/app" -type f -exec sed -i "s/__APP__/$APP/g" {} +
printf "node_modules\n.next\n.nano-pid\n" > "$DIR/.gitignore"
cd "$DIR" || exit 0
if ! timeout "$(left)" npm install --no-audit --no-fund --prefer-offline > "$DIR/.install.log" 2>&1; then say "not ok - window: npm install of the test app failed: $(tail -n 3 "$DIR/.install.log" | tr "\n" " " | head -c 300)"; exit 0; fi
if ! timeout "$(left)" npx next build > "$DIR/.build.log" 2>&1; then say "not ok - window: the test app did not build: $(tail -n 5 "$DIR/.build.log" | tr "\n" " " | head -c 300)"; exit 0; fi
git init -q && git add -A && git -c user.name=nano-ci -c user.email=nano-ci@example.invalid commit -qm "test app" || { say "not ok - window: git init of the test app failed"; exit 0; }
setsid bash -c "echo \$\$ > \"$DIR/.nano-pid\"; exec npx next start -p $PORT" > "$DIR/.server.log" 2>&1 < /dev/null &
until curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/apps/$APP/" || [ "$(date +%s)" -ge "$END" ]; do sleep 1; done
r=$(call POST /setup-api/coding-agent/projects/desktop "{\"directory\":\"$DIR\"}")
if [ "$(status_of "$r")" != 200 ]; then say "not ok - window: the test app could not be put on the desktop: HTTP $(status_of "$r") $(body_of "$r" | head -c 200)"; exit 0; fi
say "ok - window: a multi-page Next.js app ($V_NEXT) is on the desktop at /apps/$APP/"

HOST=$(hostname -I 2>/dev/null | awk "{print \$1}")
SITE="http://${HOST:-127.0.0.1}"
cat > "$DIR/.click.cjs" <<"EOF"
const { chromium } = require("playwright");
const [base, app, name, exe] = process.argv.slice(2);
const say = (line) => process.stdout.write("RESULT " + line + "\n");
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: "clawbox_session", value: process.env.OWNER_COOKIE, url: base }]);
    const page = await context.newPage();
    const boxCalls = [];
    page.on("request", async (req) => {
      if (!req.url().includes("/setup-api/system/version")) return;
      const h = await req.allHeaders().catch(() => ({}));
      boxCalls.push(/clawbox_session=/.test(h.cookie || ""));
    });
    await page.goto(base + "/app/installed-" + app, { waitUntil: "domcontentloaded", timeout: 120000 });
    const sel = "iframe[title=\"" + name + "\"]";
    const fl = page.frameLocator(sel);
    const frameUrl = async () => { const el = await page.$(sel); const f = el && (await el.contentFrame()); return f ? f.url() : ""; };
    const at = async (step, marker, text) => {
      try {
        await fl.locator("[data-page=\"" + marker + "\"]").waitFor({ timeout: 90000 });
        if (text) {
          const h1 = await fl.locator("h1").innerText();
          if (!h1.includes(text)) throw new Error("the page says " + h1);
        }
        say("ok - window: " + step);
        return true;
      } catch (e) {
        const u = await frameUrl();
        const where = u.includes("/login") ? "the box login screen" : u ? new URL(u).pathname : "nothing";
        say("not ok - window: " + step + ": the window shows " + where + " (" + String(e.message).split("\n")[0].slice(0, 120) + ")");
        return false;
      }
    };
    const click = (id) => fl.locator("#" + id).click({ timeout: 60000 });
    if (!(await at("the app opens in its window", "home"))) return;
    await click("nav-books"); if (!(await at("a Next.js <Link> to another page", "books"))) return;
    await click("book-2"); if (!(await at("a <Link> to a dynamic page", "book-2"))) return;
    await click("nav-plain"); if (!(await at("a plain link the frame follows itself", "plain"))) return;
    await click("plain-back"); if (!(await at("a second plain link", "books"))) return;
    await click("nav-home"); if (!(await at("a <Link> home", "home"))) return;
    await click("api-btn");
    try {
      await fl.locator("#api-out").filter({ hasText: "api 200 true" }).waitFor({ timeout: 60000 });
      say("ok - window: the app fetches its own /api");
    } catch {
      say("not ok - window: the app fetch of its own /api: " + (await fl.locator("#api-out").innerText().catch(() => "?")));
    }
    const img = await fl.locator("#dot").evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
    say((img ? "ok" : "not ok") + " - window: an image under the app path loads");
    await click("nav-form"); if (!(await at("a <Link> to a form", "form"))) return;
    await click("form-submit"); await at("a form post answered with a redirect to a page", "form-done", "SAVED hello form");
    await click("nav-action"); if (!(await at("a <Link> to a server action form", "action"))) return;
    await click("action-submit"); await at("a server action", "action-done", "ACTION DONE hello action");
    const frame = await (await page.$(sel)).contentFrame();
    const answer = await frame.evaluate(async () => {
      try { const r = await fetch("/setup-api/system/version", { credentials: "include" }); return "answered " + r.status; } catch (e) { return "refused"; }
    });
    await page.waitForTimeout(1500);
    const leaked = boxCalls.some((c) => c);
    say((boxCalls.length > 0 && !leaked ? "ok" : "not ok") + " - window: the app fetch of /setup-api carries no owner session (" + answer + ", " + boxCalls.length + " request(s), owner cookie on " + boxCalls.filter((c) => c).length + ")");
    await frame.evaluate((origin) => window.parent.postMessage({ clawboxAppReopen: { href: origin + "/setup-api/system/version" } }, "*"), new URL(base).origin);
    await page.waitForTimeout(3000);
    const after = await frameUrl();
    say((after.includes("/setup-api/") ? "not ok" : "ok") + " - window: the window does not open /setup-api for the app (frame at " + (after ? new URL(after).pathname : "nothing") + ")");
    const visitor = await browser.newContext();
    const v = await visitor.newPage();
    await v.goto(base + "/apps/" + app + "/books", { waitUntil: "domcontentloaded", timeout: 60000 });
    await v.waitForTimeout(4000);
    const vu = v.url();
    const shown = await v.locator("[data-page=\"books\"]").count();
    say((vu.includes("/login") && shown === 0 ? "ok" : "not ok") + " - a visitor without a session opening the app gets the login (" + new URL(vu).pathname + ")");
    await visitor.close();
  } finally {
    await browser.close();
  }
})().catch((e) => say("not ok - window: the browser check failed: " + String((e && e.message) || e).split("\n")[0].slice(0, 200)));
EOF
OWNER_COOKIE="$COOKIE" NODE_PATH="$REPO/node_modules" timeout "$(left)" node "$DIR/.click.cjs" "$SITE" "$APP" "Nano Window" "$EXE" 2>&1 | grep "^RESULT " | sed "s/^RESULT //" | while IFS= read -r line; do printf "RESULT %s\n" "$line"; done
'

# report OUT LABEL — the RESULT lines a flow printed, as TAP; its tail when it printed none.
report() {
  local results
  results=$(printf '%s\n' "$1" | grep '^RESULT ' | sed 's/^RESULT //')
  if [ -z "$results" ]; then
    not_ok "the $2 printed nothing on the board"
    printf '%s\n' "$1" | tail -n 20 | while IFS= read -r line; do note "$line"; done
    return
  fi
  printf '%s\n' "$results" | while IFS= read -r line; do
    case "$line" in
      "ok - "*) ok "${line#ok - }" ;;
      "not ok - "*) printf 'not ok - %s\n' "${line#not ok - }" ;;
      "skip "*) skip "${line#skip }" ;;
      *) note "$line" ;;
    esac
  done
  if printf '%s\n' "$results" | grep -q '^not ok - '; then NANO_TEST_FAILED=1; fi
}

W0=$(date +%s)
report "$(board "$WINDOW_FLOW" "$NANO_RUN_ID")" "app window click-through"
report "$(board "$FLOW" "$(( $(date +%s) - W0 ))")" "Store server-app flow"
finish
