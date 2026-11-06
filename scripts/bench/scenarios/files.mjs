// Files: the path the Files app takes — list the root, make a folder of the
// bench's own, upload a 200 KB file into it the way the app does (PUT with
// a raw body), read it back, search for it, delete it all. Every route is
// called from inside the signed-in page; the folder is removed in `finally`
// so the owner's home is left as it was found.
import { median } from "../lib/score.mjs";

export const id = "files";
export const title = "Files app";
export const weight = 7;
export const order = 50;
// The upload and the read-back run inside the desktop page (a Blob body, the
// app\'s own download path), so the token client cannot run this area.
export const needs = ["page"];

const UPLOAD_BYTES = 200 * 1024;
const LIST_CALLS = 3;

const encPath = (rel) => rel.split("/").map(encodeURIComponent).join("/");

/**
 * The app's upload: `PUT /setup-api/files?dir=&name=` with the file as the
 * body. The bench's `http` helper stringifies non-string bodies, so the
 * upload is written as a page expression with a Blob body of its own.
 */
async function uploadFromPage(client, dir, name, bytes) {
  const expr = `(async () => {
    const url = ${JSON.stringify(`/setup-api/files?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`)};
    const n = ${bytes};
    const line = 'clawbox-bench 0123456789 abcdefghijklmnopqrstuvwxyz\\n';
    let s = ''; while (s.length < n) s += line; s = s.slice(0, n);
    const blob = new Blob([s], { type: 'application/octet-stream' });
    const t0 = performance.now();
    let res, text = '', error = null;
    try {
      res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob, cache: 'no-store', credentials: 'same-origin' });
      text = await res.text();
    } catch (e) { error = String(e && e.message || e); }
    const ms = performance.now() - t0;
    if (error) return { ok: false, status: 0, ms, error, text: '' };
    return { ok: res.ok, status: res.status, ms, error: null, text: text.slice(0, 500), sent: blob.size };
  })()`;
  return client.page.evaluate(expr, { timeoutMs: 60_000 });
}

/** Read the file the way the app downloads it: the body's length and a hash of it, timed in the page. */
async function readFromPage(client, rel) {
  const expr = `(async () => {
    const t0 = performance.now();
    let res, buf, error = null;
    try {
      res = await fetch(${JSON.stringify(`/setup-api/files/${encPath(rel)}`)}, { cache: 'no-store', credentials: 'same-origin' });
      buf = await res.arrayBuffer();
    } catch (e) { error = String(e && e.message || e); }
    const ms = performance.now() - t0;
    if (error) return { ok: false, status: 0, ms, bytes: 0, error };
    const view = new Uint8Array(buf);
    let h = 2166136261; for (let i = 0; i < view.length; i++) { h ^= view[i]; h = Math.imul(h, 16777619) >>> 0; }
    return { ok: res.ok, status: res.status, ms, bytes: view.length, hash: h, error: null, contentType: res.headers.get('content-type') };
  })()`;
  return client.page.evaluate(expr, { timeoutMs: 60_000 });
}

/** The same FNV-1a the page computes, over the bytes the upload sent. */
function expectedHash(bytes) {
  const line = "clawbox-bench 0123456789 abcdefghijklmnopqrstuvwxyz\n";
  let s = ""; while (s.length < bytes) s += line; s = s.slice(0, bytes);
  const view = Buffer.from(s, "utf8");
  let h = 2166136261; for (let i = 0; i < view.length; i++) { h ^= view[i]; h = Math.imul(h, 16777619) >>> 0; }
  return { hash: h, bytes: view.length };
}

export async function run({ client, opts, log }) {
  const folder = `clawbox-bench-${Date.now()}`;
  const fileName = "bench-upload.txt";
  const rel = `${folder}/${fileName}`;
  const errors = [];
  const details = { folder, uploadBytes: UPLOAD_BYTES };

  // 1. The root listing, a few times: the app's first screen.
  const listSamples = [];
  let rootEntries = [];
  for (let i = 0; i < (opts.quick ? LIST_CALLS : LIST_CALLS + 2); i++) {
    const r = await client.http("/setup-api/files?dir=", { timeoutMs: 30_000 });
    listSamples.push(r.ms);
    if (!r.ok) errors.push(`list root → ${r.status}${r.error ? " " + r.error : ""}`);
    else rootEntries = Array.isArray(r.json?.files) ? r.json.files : [];
  }
  const listMs = median(listSamples);
  details.root = { entries: rootEntries.length, samplesMs: listSamples.map((v) => Math.round(v)) };

  let mkdirMs = null, uploadMs = null, readMs = null, searchMs = null, deleteFileMs = null, deleteFolderMs = null;
  let bytesMatch = 0, searchFound = 0;
  let created = false;
  try {
    // 2. A folder of the bench's own in the root.
    const mk = await client.http("/setup-api/files?dir=", { method: "POST", body: { action: "mkdir", name: folder }, timeoutMs: 30_000 });
    mkdirMs = mk.ms;
    if (!mk.ok) { errors.push(`mkdir → ${mk.status} ${mk.text || mk.json?.error || ""}`); }
    else created = true;

    if (created) {
      // 3. Upload 200 KB the way the app does.
      const up = await uploadFromPage(client, folder, fileName, UPLOAD_BYTES);
      uploadMs = up.ms;
      if (!up.ok) errors.push(`upload → ${up.status} ${up.error || up.text || ""}`);
      details.upload = { ok: up.ok, status: up.status, ms: Math.round(up.ms) };

      // 4. Read it back and check every byte came back.
      if (up.ok) {
        const rd = await readFromPage(client, rel);
        readMs = rd.ms;
        const want = expectedHash(UPLOAD_BYTES);
        bytesMatch = rd.ok && rd.bytes === want.bytes && rd.hash === want.hash ? 1 : 0;
        if (!rd.ok) errors.push(`read → ${rd.status} ${rd.error || ""}`);
        else if (!bytesMatch) errors.push(`read back ${rd.bytes} bytes (hash ${rd.hash}), uploaded ${want.bytes} (hash ${want.hash})`);
        details.read = { ok: rd.ok, status: rd.status, ms: Math.round(rd.ms), bytes: rd.bytes, contentType: rd.contentType ?? null, match: bytesMatch === 1 };
      }

      // 5. Search the root for the file's name (the app's search box).
      const term = "bench-upload";
      const sr = await client.http(`/setup-api/files?dir=&search=${encodeURIComponent(term)}&hidden=0`, { timeoutMs: 60_000 });
      searchMs = sr.ms;
      if (!sr.ok) errors.push(`search → ${sr.status}${sr.error ? " " + sr.error : ""}`);
      const hits = Array.isArray(sr.json?.files) ? sr.json.files : [];
      searchFound = hits.some((f) => f.path === rel || f.name === fileName) ? 1 : 0;
      details.search = { ms: Math.round(sr.ms), matches: hits.length, truncated: !!sr.json?.truncated, stoppedBy: sr.json?.stoppedBy ?? null, found: searchFound === 1 };
      if (sr.ok && !searchFound) errors.push(`search did not find ${rel} (${hits.length} matches${sr.json?.truncated ? ", truncated" : ""})`);
    }
  } finally {
    // 6. Delete the file, then the folder — whatever happened above.
    if (created) {
      const df = await client.http(`/setup-api/files/${encPath(rel)}`, { method: "DELETE", timeoutMs: 30_000 }).catch((e) => ({ ok: false, status: 0, ms: null, error: String(e) }));
      deleteFileMs = df.ms;
      if (!df.ok && df.status !== 404) errors.push(`delete file → ${df.status} ${df.error || df.text || ""}`);
      const dd = await client.http(`/setup-api/files/${encPath(folder)}`, { method: "DELETE", timeoutMs: 30_000 }).catch((e) => ({ ok: false, status: 0, ms: null, error: String(e) }));
      deleteFolderMs = dd.ms;
      if (!dd.ok) errors.push(`delete folder → ${dd.status} ${dd.error || dd.text || ""}`);
      // Make sure nothing is left behind.
      const check = await client.http(`/setup-api/files?dir=${encodeURIComponent(folder)}`, { timeoutMs: 30_000 }).catch(() => null);
      details.cleanedUp = check ? check.status === 404 : null;
      if (check && check.status !== 404) errors.push(`bench folder still listed after delete (${check.status})`);
    }
  }

  // 7. Details only: the fullest top-level folder, as the app would list it.
  const dirs = rootEntries.filter((f) => f.type === "directory" && !f.name.startsWith(".")).slice(0, 12);
  let fullest = null;
  for (const d of dirs) {
    const r = await client.http(`/setup-api/files?dir=${encodeURIComponent(d.name)}`, { timeoutMs: 30_000 }).catch(() => null);
    if (!r?.ok) continue;
    const n = Array.isArray(r.json?.files) ? r.json.files.length : 0;
    if (!fullest || n > fullest.entries) fullest = { name: d.name, entries: n, ms: Math.round(r.ms), bytes: r.bytes };
  }
  details.fullestFolder = fullest;
  details.errors = errors;

  log(`root list ${listMs?.toFixed(0)} ms (${rootEntries.length} entries), upload ${uploadMs?.toFixed(0) ?? "—"} ms, read ${readMs?.toFixed(0) ?? "—"} ms (match ${bytesMatch}), search ${searchMs?.toFixed(0) ?? "—"} ms (found ${searchFound})${fullest ? `, fullest folder ${fullest.name}: ${fullest.entries} entries in ${fullest.ms} ms` : ""}${errors.length ? `, errors: ${errors.join("; ")}` : ""}`);

  const metrics = {
    list_root_ms: { value: listMs, unit: "ms", dir: "lower", good: 15, bad: 400, label: "list the browse root (median)" },
    mkdir_ms: { value: mkdirMs, unit: "ms", dir: "lower", good: 15, bad: 400, label: "create a folder" },
    upload_200kb_ms: { value: uploadMs, unit: "ms", dir: "lower", good: 60, bad: 1500, label: "upload 200 KB (PUT, as the app does)" },
    read_200kb_ms: { value: readMs, unit: "ms", dir: "lower", good: 20, bad: 800, label: "read the 200 KB back" },
    read_bytes_match: { value: bytesMatch, unit: "", dir: "higher", good: 1, bad: 0, weight: 2, label: "read back equals what was uploaded (1/0)" },
    search_ms: { value: searchMs, unit: "ms", dir: "lower", good: 100, bad: 5000, label: "search the home tree for the file's name" },
    search_found: { value: searchFound, unit: "", dir: "higher", good: 1, bad: 0, label: "search found the file (1/0)" },
    delete_ms: { value: deleteFileMs !== null && deleteFolderMs !== null ? deleteFileMs + deleteFolderMs : null, unit: "ms", dir: "lower", good: 20, bad: 600, label: "delete the file and the folder" },
    errors: { value: errors.length, unit: "", dir: "lower", good: 0, bad: 3, weight: 2, label: "failed steps" },
  };
  return { metrics, details };
}
