// Prime Radiant, the "living wiki", as a person feels it: how fast the app
// opens (status, the page list, one page, a page's history), how fast a
// search answers and whether it answers at all, the round trip of ClawBox's
// own write path (create one page, read it back, wait until search finds it,
// delete it) and the whole-vault lint.
//
// The one page it writes is a `concept` titled "ClawBox bench <stamp>" (the
// route derives the path from the type and the title: concepts/clawbox-bench-
// <stamp>.md) and it is deleted in a finally, so the vault's files are left as
// they were; the two commits (create, delete) are the write path itself.
// Skipped, never failed, when the vault is not initialised.
import { median } from "../lib/score.mjs";

export const id = "prime-radiant";
export const title = "Prime Radiant (living wiki)";
export const weight = 10;
export const order = 40;

const BASE = "/setup-api/prime-radiant";
// A query every vault can answer something to; the results count is what matters.
const FIXED_QUERY = "what are the main topics and people in this knowledge base";
const FOUND_POLL_MS = 20_000;
const FOUND_STEP_MS = 1000;

const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

/** `n` timed calls; the median, the first and the answers' status. */
async function timed(client, path, n, init = {}) {
  const samples = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    last = await client.http(path, { timeoutMs: 60_000, ...init });
    samples.push(last.ms);
  }
  return { p50: median(samples), first: samples[0], max: Math.max(...samples), status: last.status, ok: last.ok, bytes: last.bytes, json: last.json, error: last.error };
}

export async function run({ client, opts, log }) {
  const n = opts.quick ? 2 : 3;
  const errors = [];
  const note = (path, r) => { if (!r.ok) errors.push(`${path} → ${r.status}${r.error ? " " + r.error : ""}`); };
  const details = { calls: n, errors };

  // Status first: no vault → skip the area rather than score it.
  const status = await timed(client, `${BASE}/status`, n);
  note("status", status);
  if (!status.ok) {
    if (status.status === 401 || status.status === 403) return { skipped: `status answered ${status.status} (not the owner?)`, metrics: {} };
    return { skipped: `status answered ${status.status}${status.error ? " " + status.error : ""}`, metrics: {} };
  }
  if (!status.json?.initialised) return { skipped: "the vault is not initialised", metrics: {} };
  const vault = status.json.vault ?? {};
  details.vault = { pages: vault.pages, claims: vault.claims, verifiedPages: vault.verifiedPages, domains: vault.domains?.length ?? 0, commits: status.json.git?.commits, index: status.json.index, lint: status.json.lint };
  log(`vault: ${vault.pages} pages, ${vault.claims} claims, ${status.json.git?.commits ?? "?"} commits; status ${status.p50.toFixed(0)} ms`);

  // The page list, and one existing page with its history.
  const list = await timed(client, `${BASE}/pages?limit=100`, n);
  note("pages", list);
  const firstPage = list.json?.pages?.[0]?.path ?? null;
  details.list = { p50: list.p50, bytes: list.bytes, total: list.json?.total ?? null, firstPage };
  let read = null, history = null;
  if (firstPage) {
    read = await timed(client, `${BASE}/pages/${enc(firstPage)}`, n);
    note(`pages/${firstPage}`, read);
    history = await timed(client, `${BASE}/history/${enc(firstPage)}?limit=20`, n);
    note(`history/${firstPage}`, history);
    details.read = { p50: read.p50, bytes: read.bytes, body: read.json?.body?.length ?? null, backlinks: read.json?.backlinks?.length ?? null };
    details.history = { p50: history.p50, commits: history.json?.commits?.length ?? null };
  }

  // Search for a fixed query: the latency, and whether it answered at all.
  const search = await timed(client, `${BASE}/search?q=${encodeURIComponent(FIXED_QUERY)}&limit=10`, n);
  note("search", search);
  const shardEnabled = search.json?.shardEnabled !== false;
  const indexing = search.json?.indexing === true;
  const searchResults = Array.isArray(search.json?.results) ? search.json.results.length : null;
  details.search = { p50: search.p50, first: search.first, shardEnabled, indexing, results: searchResults, index: search.json?.index ?? null };
  log(`search ${search.p50.toFixed(0)} ms, ${searchResults ?? "?"} results${shardEnabled ? "" : " (Memory Shard off)"}${indexing ? " (index building)" : ""}`);

  // The write path: one page of the bench's own, read back, found by search, deleted.
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const marker = `benchmarker${stamp}`;
  const write = { created: null, path: null, createMs: null, readBackMs: null, readBackOk: null, foundMs: null, found: null, polls: 0, deleteMs: null, deleted: null, marker };
  details.write = write;
  const body = {
    type: "concept",
    title: `ClawBox bench ${stamp}`,
    domain: "clawbox-bench",
    summary: `A throwaway page the ClawBox bench wrote to time the vault's write path and search; its marker word is ${marker}.`,
    body: `This page measures how long Prime Radiant takes to commit a new page and make it searchable. The marker word is ${marker}. The bench deletes it as soon as the measurement is done.`,
    status: "draft",
    privacy: "internal",
    sources: ["clawbox-bench"],
  };
  try {
    const created = await client.http(`${BASE}/pages`, { method: "POST", body, timeoutMs: 60_000 });
    write.createMs = created.ms;
    write.created = created.status;
    if (!created.ok || !created.json?.path) {
      note("POST pages", created);
      write.error = created.json?.error ?? created.text?.slice(0, 200) ?? created.error;
      log(`create refused: ${created.status} ${write.error ?? ""}`);
    } else {
      write.path = created.json.path;
      write.commit = created.json.commit;
      log(`created ${write.path} in ${created.ms.toFixed(0)} ms`);
      const back = await client.http(`${BASE}/pages/${enc(write.path)}`, { timeoutMs: 30_000 });
      write.readBackMs = back.ms;
      write.readBackOk = back.ok && typeof back.json?.body === "string" && back.json.body.includes(marker);
      if (!back.ok) note(`pages/${write.path}`, back);
      if (shardEnabled) {
        const t0 = Date.now();
        let found = false;
        const q = encodeURIComponent(`ClawBox bench page marker ${marker} write path timing`);
        while (Date.now() - t0 < FOUND_POLL_MS) {
          write.polls += 1;
          const r = await client.http(`${BASE}/search?q=${q}&limit=20`, { timeoutMs: 30_000 });
          if (!r.ok) note("search (poll)", r);
          const hits = Array.isArray(r.json?.results) ? r.json.results : [];
          if (hits.some((h) => h?.path === write.path)) { found = true; break; }
          await new Promise((res) => setTimeout(res, FOUND_STEP_MS));
        }
        write.found = found;
        write.foundMs = found ? Date.now() - t0 : null;
        log(found ? `searchable after ${write.foundMs} ms (${write.polls} polls)` : `not found by search within ${FOUND_POLL_MS} ms`);
      }
    }
  } finally {
    if (write.path) {
      let del = await client.http(`${BASE}/pages/${enc(write.path)}`, { method: "DELETE", timeoutMs: 60_000 });
      if (!del.ok && del.status !== 404) {
        log(`delete answered ${del.status}; trying once more`);
        del = await client.http(`${BASE}/pages/${enc(write.path)}`, { method: "DELETE", timeoutMs: 60_000 });
      }
      write.deleteMs = del.ms;
      write.deleted = del.ok || del.status === 404;
      if (!write.deleted) { note(`DELETE pages/${write.path}`, del); log(`WARNING: ${write.path} could not be deleted (${del.status}); remove it by hand`); }
    }
  }

  // The whole-vault lint, after the page is gone.
  const lint = await timed(client, `${BASE}/lint`, n);
  note("lint", lint);
  details.lint = { p50: lint.p50, first: lint.first, errors: lint.json?.errors ?? null, warnings: lint.json?.warnings ?? null, bytes: lint.bytes };
  log(`lint ${lint.p50.toFixed(0)} ms (${lint.json?.errors ?? "?"} errors, ${lint.json?.warnings ?? "?"} warnings)`);

  const metrics = {
    status_ms: { value: status.p50, unit: "ms", dir: "lower", good: 50, bad: 1500, label: "GET status (median)" },
    list_ms: { value: list.p50, unit: "ms", dir: "lower", good: 50, bad: 1500, label: "GET pages, the first 100 (median)" },
    search_ms: { value: search.p50, unit: "ms", dir: "lower", good: 150, bad: 3000, label: "GET search, a fixed query (median)" },
    lint_ms: { value: lint.p50, unit: "ms", dir: "lower", good: 300, bad: 6000, label: "GET lint over the whole vault (median)" },
    errors: { value: errors.length, unit: "", dir: "lower", good: 0, bad: 3, weight: 2, label: "non-2xx answers" },
  };
  if (read) metrics.page_read_ms = { value: read.p50, unit: "ms", dir: "lower", good: 30, bad: 800, label: "GET one existing page (median)" };
  if (history) metrics.history_ms = { value: history.p50, unit: "ms", dir: "lower", good: 50, bad: 1500, label: "GET a page's git history (median)" };
  // An empty vault has nothing to find; Memory Shard off or a building index is not the search's speed.
  if (vault.pages > 0 && shardEnabled && !indexing && searchResults !== null) {
    metrics.search_answered = { value: searchResults > 0 ? 1 : 0, unit: "", dir: "higher", good: 1, bad: 0, label: "the fixed query returned at least one hit" };
  }
  if (typeof write.createMs === "number") {
    metrics.page_create_ms = { value: write.createMs, unit: "ms", dir: "lower", good: 500, bad: 8000, label: "POST pages: lint + commit of one page" };
  }
  if (write.created === 201 && typeof write.readBackOk === "boolean") {
    metrics.page_read_back = { value: write.readBackOk ? 1 : 0, unit: "", dir: "higher", good: 1, bad: 0, label: "the new page read back with its marker" };
  }
  if (write.created === 201 && shardEnabled) {
    metrics.write_found = { value: write.found ? 1 : 0, unit: "", dir: "higher", good: 1, bad: 0, weight: 2, label: "search found the new page within 20 s" };
    if (write.found) metrics.write_searchable_ms = { value: write.foundMs, unit: "ms", dir: "lower", good: 2000, bad: 20000, label: "commit → the page shows up in search" };
  }
  if (typeof write.deleteMs === "number") {
    metrics.page_delete_ms = { value: write.deleteMs, unit: "ms", dir: "lower", good: 500, bad: 8000, label: "DELETE pages/<path>: one commit" };
  }
  return { metrics, details };
}
