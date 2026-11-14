#!/usr/bin/env bash
# timeout: 300
# covers: vault/* mcp/tools/vault.ts mcp/clawbox-mcp.ts config/clawbox-vault.service scripts/start-vault.sh scripts/lib/vault-extension.sh scripts/launch-browser.sh src/lib/vault-proxy.ts src/app/apps/clawbox-vault/* src/lib/non-owner-scope.ts
#
# ClawBox Vault, the built-in password manager, on a real box of either
# runtime: the unit the installer and the updater put there is enabled and
# running as the box user; it listens on loopback and nowhere else; its first
# start made its own keyring and store; the extension folder the browser loads
# is built, with a pairing secret only the box user can read; the desktop app
# answers the owner and nobody else; and the box's own MCP server offers the
# seven vault tools, no card tool, and no password in anything they say.
#
# It changes nothing the owner would notice: it never chooses the vault PIN.
# On a box without one (every reflashed board) the tools must answer "not set
# up" and the browser must not be able to pair; on a box whose owner has
# chosen one, the same tools must answer instead.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

EXPECTED=(vault_list vault_match vault_fill vault_save vault_generate vault_delete vault_audit)
CARD_TOOLS=(vault_cards_list vault_card_fill)

# ── The unit ────────────────────────────────────────────────────────────────
# shellcheck disable=SC2016  # expanded on the board
UNIT=$(board '
  printf "enabled=%s\n" "$(systemctl is-enabled clawbox-vault.service 2>/dev/null || true)"
  printf "active=%s\n" "$(systemctl is-active clawbox-vault.service 2>/dev/null || true)"
  pid=$(systemctl show clawbox-vault.service -p MainPID --value 2>/dev/null || true)
  printf "user=%s\n" "$(ps -o user= -p "${pid:-0}" 2>/dev/null | tr -d " ")"
  printf "cwd=%s\n" "$(readlink "/proc/${pid:-0}/cwd" 2>/dev/null || true)"
')
u() { printf '%s\n' "$UNIT" | sed -n "s/^$1=//p" | head -n1; }
if [ "$(u enabled)" = enabled ] && [ "$(u active)" = active ]; then
  ok "clawbox-vault.service is enabled and active"
else
  not_ok "clawbox-vault.service is enabled=$(u enabled) active=$(u active)"
  note "$(board 'journalctl -u clawbox-vault.service -n 15 --no-pager 2>&1 | cut -c1-200' | tr '\n' '|' | head -c 1200)"
  finish
fi
if [ "$(u user)" = clawbox ] && [ "$(u cwd)" = /home/clawbox/clawbox/vault ]; then
  ok "it runs as the box user out of the checkout ($(u cwd))"
else
  not_ok "it runs as user=$(u user) in cwd=$(u cwd)"
fi

# ── Loopback only ───────────────────────────────────────────────────────────
# shellcheck disable=SC2016  # expanded on the board
NET=$(board '
  ss -Hltn "sport = :4796" 2>/dev/null | awk "{print \$4}" | sort -u | tr "\n" " "
  printf "\n"
  curl -sS --max-time 5 http://127.0.0.1:4796/api/health 2>/dev/null
  printf "\n"
  lan=$(ip -4 -o addr show scope global 2>/dev/null | awk "{print \$4}" | cut -d/ -f1 | head -n1)
  if [ -n "$lan" ]; then
    code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "http://$lan:4796/api/health" 2>/dev/null)
    printf "lan=%s\n" "${code:-000}"
  else
    printf "lan=none\n"
  fi
')
LISTEN=$(printf '%s\n' "$NET" | sed -n 1p | tr -s ' ' | sed 's/ $//')
HEALTH=$(printf '%s\n' "$NET" | sed -n 2p)
LAN=$(printf '%s\n' "$NET" | sed -n 's/^lan=//p')
if [ "$LISTEN" = "127.0.0.1:4796" ]; then
  ok "it listens on 127.0.0.1:4796 and on no other address"
else
  not_ok "port 4796 is bound on: ${LISTEN:-nothing}"
fi
if [ "$(printf '%s' "$HEALTH" | jq -r '.app' 2>/dev/null)" = clawbox-vault ]; then
  ok "the health check answers on loopback (v$(printf '%s' "$HEALTH" | jq -r '.version'))"
else
  not_ok "the health check did not answer on loopback: $(printf '%s' "$HEALTH" | head -c 200)"
  finish
fi
case "$LAN" in
  000) ok "nothing answers on the box's network address at port 4796" ;;
  none) skip "the board has no network address to try port 4796 on" ;;
  *) not_ok "port 4796 answered on the box's network address (HTTP $LAN)" ;;
esac

# ── First run: its own keyring, store and extension folder ──────────────────
# shellcheck disable=SC2016  # expanded on the board
FILES=$(board '
  v=$HOME/.clawbox-vault
  m() { stat -c %a "$1" 2>/dev/null || echo missing; }
  printf "home=%s gnupg=%s store=%s token=%s pairing=%s\n" "$(m "$v")" "$(m "$v/gnupg")" "$(m "$v/store")" "$(m "$v/agent-token")" "$(m "$v/extension/pairing.json")"
  printf "gpgid=%s git=%s manifest=%s worker=%s\n" "$([ -s "$v/store/.gpg-id" ] && echo yes || echo no)" "$([ -d "$v/store/.git" ] && echo yes || echo no)" \
    "$(jq -r ".manifest_version" "$v/extension/manifest.json" 2>/dev/null)" "$([ -s "$v/extension/build/background.js" ] && echo yes || echo no)"
  printf "war=%s\n" "$(jq -r "(.web_accessible_resources // []) | length" "$v/extension/manifest.json" 2>/dev/null)"
  printf "userstore=%s\n" "$([ -e "$HOME/.password-store" ] && echo present || echo absent)"
  curl -sS --max-time 20 http://127.0.0.1:4796/api/ui/status 2>/dev/null
  printf "\n"
  cd "$REPO" && bash -c "source scripts/lib/vault-extension.sh; vault_extension_flags" | tr "\n" " "
  printf "\n"
')
f() { printf '%s\n' "$FILES" | tr ' ' '\n' | sed -n "s/^$1=//p" | head -n1; }
STATUS=$(printf '%s\n' "$FILES" | grep '^{' | head -n1)
FLAGS=$(printf '%s\n' "$FILES" | grep -- '--load-extension=' | head -n1)
if [ "$(f home)" = 700 ] && [ "$(f gnupg)" = 700 ] && [ "$(f store)" = 700 ] && [ "$(f gpgid)" = yes ] && [ "$(f git)" = yes ]; then
  ok "the vault made its own keyring and store in ~/.clawbox-vault (all mode 700, git-tracked)"
else
  not_ok "~/.clawbox-vault is not as the first run leaves it: $(printf '%s' "$FILES" | sed -n 1,2p | tr '\n' ' ')"
fi
if [ "$(printf '%s' "$STATUS" | jq -r '.store.ready' 2>/dev/null)" = true ]; then
  ok "the service reports its password store ready"
else
  not_ok "the service reports its store not ready: $(printf '%s' "$STATUS" | head -c 300)"
fi
if [ "$(f token)" = 600 ] && [ "$(f pairing)" = 600 ]; then
  ok "the agent token and the browser's pairing secret are readable by the box user only"
else
  not_ok "token mode=$(f token), pairing secret mode=$(f pairing) (both must be 600)"
fi
if [ "$(f manifest)" = 3 ] && [ "$(f worker)" = yes ] && [ "$(f war)" = 0 ]; then
  ok "the extension folder is built (MV3, nothing web-accessible)"
else
  not_ok "the extension folder is incomplete: manifest_version=$(f manifest) worker=$(f worker) web_accessible=$(f war)"
fi
if [ -n "$FLAGS" ]; then
  ok "the browser launcher loads it: $(printf '%s' "$FLAGS" | cut -d' ' -f1)"
else
  not_ok "the browser launcher finds no extension folder to load"
fi
if [ "$(printf '%s' "$STATUS" | jq -r '.cards' 2>/dev/null)" = false ]; then
  ok "cards are off"
else
  not_ok "the service does not report cards off: $(printf '%s' "$STATUS" | head -c 200)"
fi
PIN_SET=$(printf '%s' "$STATUS" | jq -r '.pinSet' 2>/dev/null)

# ── The desktop app is the owner's alone ────────────────────────────────────
board_owner_api GET /apps/clawbox-vault/api/ui/status
if [ "$API_STATUS" = 200 ] && [ "$(api_json '.pinSet | type')" = boolean ]; then
  ok "the owner reaches the vault's app through the web server (pinSet=$(api_json '.pinSet'))"
else
  not_ok "the owner got HTTP $API_STATUS from /apps/clawbox-vault/api/ui/status: $(printf '%s' "$API_BODY" | head -c 200)"
fi
board_api GET /apps/clawbox-vault/api/ui/status
if [ "$API_STATUS" = 403 ] && [ "$(api_json '.code')" = owner_only ]; then
  ok "the assistant's bearer is refused there (403 owner_only)"
else
  not_ok "the assistant's bearer got HTTP $API_STATUS from the vault's app: $(printf '%s' "$API_BODY" | head -c 200)"
fi
# shellcheck disable=SC2016  # expanded on the board
ANON=$(board 'curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$DASHBOARD/apps/clawbox-vault/api/ui/status" 2>/dev/null')
case "$ANON" in
  401|403) ok "a caller with no session is refused there (HTTP $ANON)" ;;
  *) not_ok "a caller with no session got HTTP ${ANON:-000} from the vault's app" ;;
esac
for path in /apps/clawbox-vault/api/agent/entries /apps/clawbox-vault/api/pair/auto /apps/clawbox-vault/api/ext/secret; do
  board_owner_api GET "$path"
  if [ "$API_STATUS" = 404 ]; then
    ok "not reachable through the web server, even for the owner: ${path#/apps/clawbox-vault}"
  else
    not_ok "the web server answered HTTP $API_STATUS for $path"
  fi
done

# ── On the service itself: the agent API, the cards switch, automatic pairing
# The token is read on the board and reaches curl on its stdin only.
# shellcheck disable=SC2016  # expanded on the board
AGENT=$(board '
  t=$(tr -d "\r\n" < "$HOME/.clawbox-vault/agent-token")
  call() { printf "header = \"Authorization: Bearer %s\"\n" "$t" | curl -sS -o /tmp/vault-nano.$$ -w "%{http_code}" --max-time 20 "$@" -K - 2>/dev/null; printf " "; head -c 300 /tmp/vault-nano.$$; printf "\n"; rm -f /tmp/vault-nano.$$; }
  call http://127.0.0.1:4796/api/agent/entries
  call http://127.0.0.1:4796/api/agent/cards
  call -X POST -H "Content-Type: application/json" --data-binary "{\"url\":\"https://shop.example.com/checkout\"}" http://127.0.0.1:4796/api/agent/card-fill
  call -H "Origin: https://evil.example.org" http://127.0.0.1:4796/api/agent/entries
  curl -sS -o /dev/null -w "%{http_code}\n" --max-time 10 http://127.0.0.1:4796/api/agent/entries 2>/dev/null
  s=$(jq -r ".secret // empty" "$HOME/.clawbox-vault/extension/pairing.json" 2>/dev/null)
  curl -sS -o /dev/null -w "%{http_code}\n" --max-time 10 -X POST -H "Content-Type: application/json" -H "Origin: https://evil.example.org" --data-binary "{\"secret\":\"$s\"}" http://127.0.0.1:4796/api/pair/auto 2>/dev/null
  curl -sS -o /dev/null -w "%{http_code}\n" --max-time 10 -X POST -H "Content-Type: application/json" -H "Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop" --data-binary "{\"secret\":\"not-the-secret-0123456789abcdefghijklmnop\"}" http://127.0.0.1:4796/api/pair/auto 2>/dev/null
')
a() { printf '%s\n' "$AGENT" | sed -n "${1}p"; }
ENTRIES_CODE=$(a 1 | cut -d' ' -f1)
if [ "$PIN_SET" = true ]; then
  if [ "$ENTRIES_CODE" = 200 ]; then
    ok "the agent API answers with its token (the owner has chosen a PIN)"
  else
    not_ok "the agent API answered HTTP $ENTRIES_CODE with its token"
  fi
else
  if [ "$ENTRIES_CODE" = 409 ] && a 1 | grep -q not_set_up; then
    ok "no PIN chosen yet: the agent API answers 409 not_set_up, so nothing is saved or filled"
  else
    not_ok "no PIN is set, yet the agent API answered: $(a 1 | head -c 200)"
  fi
fi
if [ "$(a 2 | cut -d' ' -f1)" = 404 ] && [ "$(a 3 | cut -d' ' -f1)" = 404 ]; then
  ok "every card route of the agent API answers 404"
else
  not_ok "card routes answered $(a 2 | cut -d' ' -f1) and $(a 3 | cut -d' ' -f1) (both must be 404)"
fi
if [ "$(a 4 | cut -d' ' -f1)" = 403 ]; then
  ok "a browser origin is refused on the agent API"
else
  not_ok "a browser origin got HTTP $(a 4 | cut -d' ' -f1) on the agent API"
fi
if [ "$(a 5)" = 401 ]; then
  ok "the agent API refuses a caller without the token"
else
  not_ok "the agent API answered HTTP $(a 5) without a token"
fi
if [ "$(a 6)" = 403 ]; then
  ok "a web page's origin cannot pair, even with the secret"
else
  not_ok "a web origin got HTTP $(a 6) from the pairing route"
fi
case "$PIN_SET:$(a 7)" in
  true:401) ok "an extension with the wrong secret cannot pair" ;;
  false:409|null:409) ok "nothing can pair before the owner has chosen a PIN (409)" ;;
  *) not_ok "the pairing route answered HTTP $(a 7) to a wrong secret (pinSet=$PIN_SET)" ;;
esac

# ── The tools, through the box's own MCP server ─────────────────────────────
# shellcheck disable=SC2016  # JavaScript, not shell
SESSION='
(async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["run", "mcp/clawbox-mcp.ts"], cwd: process.cwd(), stderr: "ignore" });
  const client = new Client({ name: "nano-ci", version: "1.0.0" });
  await client.connect(transport);
  const text = (r) => (Array.isArray(r.content) && r.content[0] && r.content[0].type === "text" ? r.content[0].text : "");
  const call = async (name, args) => { try { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: text(r) }; } catch (e) { return { isError: true, text: String(e && e.message || e) }; } };
  const out = { names: (await client.listTools()).tools.map((t) => t.name) };
  out.list = await call("vault_list", {});
  out.audit = await call("vault_audit", { limit: 5 });
  out.match = await call("vault_match", { url: "https://nano-ci.example.com/login" });
  out.fill = await call("vault_fill", { url: "https://nano-ci.example.com/login" });
  out.card = await call("vault_cards_list", {});
  console.log(JSON.stringify(out));
  await client.close();
  process.exit(0);
})().catch((err) => { console.error(String(err && err.message || err)); process.exit(1); });
'
# shellcheck disable=SC2016  # expanded on the board
RAW=$(board 'cd "$REPO" && exec timeout 180 bun -e "$1"' "$SESSION")
ANSWER=$(printf '%s\n' "$RAW" | grep '^{' | tail -n 1)
if [ -z "$ANSWER" ] || ! printf '%s' "$ANSWER" | jq -e . >/dev/null 2>&1; then
  not_ok "the MCP session did not answer: $(printf '%s' "$RAW" | tail -n 3 | tr '\n' ' ' | head -c 300)"
  finish
fi
j() { printf '%s' "$ANSWER" | jq -r "$@" 2>/dev/null; }

MISSING=""
for name in "${EXPECTED[@]}"; do
  # shellcheck disable=SC2016  # $n is jq's
  j --arg n "$name" '.names | index($n) != null' | grep -qx true || MISSING="$MISSING $name"
done
RUNTIME=$(board_runtime 2>/dev/null || echo unknown)
if [ -z "$MISSING" ]; then
  ok "the MCP server lists all ${#EXPECTED[@]} vault tools on this $RUNTIME box ($(j '.names | length') tools in all)"
else
  not_ok "the MCP server does not list:$MISSING"
fi
EXTRA=""
for name in "${CARD_TOOLS[@]}"; do
  # shellcheck disable=SC2016  # $n is jq's
  j --arg n "$name" '.names | index($n) != null' | grep -qx true && EXTRA="$EXTRA $name"
done
if [ -z "$EXTRA" ] && [ "$(j '.card.isError')" = true ]; then
  ok "no card tool is registered, and calling one is refused"
else
  not_ok "card tools on this box:${EXTRA:- none listed}; a call answered: $(j '.card.text' | head -c 200)"
fi
if [ "$PIN_SET" = true ]; then
  if [ "$(j '.list.isError')" = false ] && [ "$(j '.audit.isError')" = false ]; then
    ok "vault_list and vault_audit answer"
  else
    not_ok "vault_list / vault_audit failed: $(j '.list.text' | head -c 200)"
  fi
  case "$(j '.fill.text')" in
    no_entry*|no_tab*|extension_offline*|locked*) ok "vault_fill answers a status for a site with no login saved: $(j '.fill.text' | head -c 80)" ;;
    *) not_ok "vault_fill answered: $(j '.fill.text' | head -c 200)" ;;
  esac
else
  if [ "$(j '.list.isError')" = true ] && j '.list.text' | grep -q 'not set up' && j '.fill.text' | grep -q 'not set up'; then
    ok "no PIN chosen yet: the tools tell the assistant the vault is not set up and to ask the owner"
  else
    not_ok "no PIN is set, yet vault_list answered: $(j '.list.text' | head -c 200)"
  fi
fi
# Whatever they answered, no answer carries a field for a secret.
if printf '%s' "$ANSWER" | grep -qiE '\\"password\\"|"password":'; then
  not_ok "a tool answer has a password field in it"
else
  ok "no tool answer carries a password field"
fi

# ── Nothing secret in the service's log ─────────────────────────────────────
# shellcheck disable=SC2016  # expanded on the board
LEAKS=$(board '
  t=$(tr -d "\r\n" < "$HOME/.clawbox-vault/agent-token")
  s=$(jq -r ".secret // empty" "$HOME/.clawbox-vault/extension/pairing.json" 2>/dev/null)
  log=$(journalctl -u clawbox-vault.service --no-pager 2>/dev/null)
  n=0
  [ -n "$t" ] && n=$((n + $(printf "%s" "$log" | grep -cF -- "$t")))
  [ -n "$s" ] && n=$((n + $(printf "%s" "$log" | grep -cF -- "$s")))
  printf "%s %s\n" "$n" "$(printf "%s\n" "$log" | wc -l)"
')
if [ "$(printf '%s' "$LEAKS" | cut -d' ' -f1)" = 0 ]; then
  ok "neither the agent token nor the pairing secret is in the service's journal ($(printf '%s' "$LEAKS" | cut -d' ' -f2) lines read)"
else
  not_ok "the service's journal contains a token or the pairing secret"
fi

finish
