#!/usr/bin/env bash
# timeout: 300
# covers: mcp/clawbox-mcp.ts mcp/lib/* mcp/tools/prime-radiant.ts src/lib/prime-radiant/* src/app/setup-api/prime-radiant/*
#
# Prime Radiant through the box's own MCP server, on the real box: the server
# is started over stdio the way a harness starts it (`bun run
# mcp/clawbox-mcp.ts` from the checkout, the board's own edition lock and
# bearer file), its tool list must offer the whole `prime_radiant_*` family,
# and `prime_radiant_status`, `prime_radiant_search` and `prime_radiant_page`
# must answer over the board's own vault. Read-only: nothing is written.
# The search + page half is a SKIP on a board whose vault has no page yet
# (a reflashed board); the tool list and the status always run.
# shellcheck source=scripts/nano-tests/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

# Every tool the family registers (PRIME_RADIANT_TOOLS in mcp/tools/prime-radiant.ts).
EXPECTED=(
  prime_radiant_status prime_radiant_pages prime_radiant_page prime_radiant_search prime_radiant_map
  prime_radiant_lint prime_radiant_costs prime_radiant_settings prime_radiant_review_list prime_radiant_history
  prime_radiant_diff prime_radiant_ingest_status prime_radiant_page_create prime_radiant_page_edit
  prime_radiant_page_delete prime_radiant_page_merge prime_radiant_pages_bulk_edit prime_radiant_claim_add prime_radiant_claim_edit prime_radiant_claim_delete
  prime_radiant_claim_verify prime_radiant_review_resolve prime_radiant_review_raise prime_radiant_undo
  prime_radiant_ingest_preview prime_radiant_ingest_start prime_radiant_ingest_stop prime_radiant_ingest_retry
  prime_radiant_nightly_run prime_radiant_nightly_merge prime_radiant_connect_run prime_radiant_settings_update
)

# One MCP session: list the tools, then the read-only calls. Printed as one
# JSON line, the last line of the answer. The SDK resolves out of the
# checkout's node_modules, so it runs from there.
# shellcheck disable=SC2016  # JavaScript, not shell
SESSION='
(async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({ command: process.execPath, args: ["run", "mcp/clawbox-mcp.ts"], cwd: process.cwd(), stderr: "ignore" });
  const client = new Client({ name: "nano-ci", version: "1.0.0" });
  await client.connect(transport);
  const text = (r) => (Array.isArray(r.content) && r.content[0] && r.content[0].type === "text" ? r.content[0].text : "");
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { isError: r.isError === true, text: text(r) }; };
  const out = { names: (await client.listTools()).tools.map((t) => t.name) };
  out.status = await call("prime_radiant_status", {});
  let s = {};
  try { s = JSON.parse(out.status.text); } catch {}
  if (s.initialised && s.pages > 0) {
    out.pages = await call("prime_radiant_pages", { limit: 1 });
    let first = null;
    try { first = JSON.parse(out.pages.text).pages[0]; } catch {}
    if (first) {
      out.asked = first.path;
      out.page = await call("prime_radiant_page", { path: first.path, include_body: false });
      out.search = await call("prime_radiant_search", { query: first.title || first.path, limit: 3 });
    }
  }
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
if [ -z "$MISSING" ]; then
  ok "the MCP server lists all ${#EXPECTED[@]} prime_radiant tools ($(j '.names | length') tools in all)"
else
  not_ok "the MCP server does not list:$MISSING"
fi

if [ "$(j '.status.isError')" = false ]; then
  ok "prime_radiant_status answers: $(j '.status.text | fromjson? | {initialised, pages, claims} | tostring')"
else
  not_ok "prime_radiant_status failed: $(j '.status.text' | head -c 300)"
  finish
fi

if [ "$(j 'has("page")')" != true ]; then
  skip "the board's wiki has no page yet: search and page read have nothing to read"
  finish
fi

ASKED=$(j '.asked')
if [ "$(j '.page.isError')" = false ] && [ "$(j '.page.text | fromjson? | .path')" = "$ASKED" ]; then
  ok "prime_radiant_page reads $ASKED ($(j '.page.text | fromjson? | .claims | length') claims)"
else
  not_ok "prime_radiant_page did not read $ASKED: $(j '.page.text' | head -c 300)"
fi

SEARCH=$(j '.search.text')
if [ "$(j '.search.isError')" != false ]; then
  not_ok "prime_radiant_search failed: $(printf '%s' "$SEARCH" | head -c 300)"
elif printf '%s' "$SEARCH" | jq -e '.hits | length > 0' >/dev/null 2>&1; then
  ok "prime_radiant_search answers $(printf '%s' "$SEARCH" | jq -r '.hits | length') hit(s), first $(printf '%s' "$SEARCH" | jq -r '.hits[0].path')"
else
  # Memory Shard off, its index still building, or no match: an answer, not a fault.
  ok "prime_radiant_search answers without hits: $(printf '%s' "$SEARCH" | head -c 160)"
fi
finish
