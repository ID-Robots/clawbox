// Runs ON the board, for scripts/nano-tests/tests/92-update-raw-log.sh: the
// raw update log (TASK-2428) checked against what the box itself says, while a
// real update runs and after it ended.
//
//   node update-raw-log.mjs reader    a background reader of /setup-api/update/log
//                                     that reconnects the way a browser's
//                                     EventSource does (Last-Event-ID), through
//                                     the web server's restart, until `end`
//   node update-raw-log.mjs live      mid-update: the stream is the file, the
//                                     section of the unit running now is that
//                                     unit's journal, and the panel shows them
//   node update-raw-log.mjs after     the update is over: the stream, the
//                                     download and the background reader each
//                                     hold exactly the file; every unit section
//                                     is its journal; the panel after a reload
//
// Prints `RESULT ok - …` / `RESULT not ok - …` / `RESULT skip - …`, `NOTE …`,
// and — with SHOTS=1 — `SHOT <name> <sha256> <hex>` lines: a JPEG of the
// update screen's panel beside the matching journalctl and log-file lines.
//
// Env: CHROME, PROFILE_DIR, STATE_DIR (this run's folder under ~/.cache),
// REPO, SHOTS, LABEL (names the shot: "before-restart", "after-restart", …).
// The owner's cookie is minted here, from the box's session secret, for each
// request and for the browser (through DevTools): never printed, never on a
// command line.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { connectTarget, listTargets } from "../../bench/lib/cdp.mjs";

const BASE = "http://127.0.0.1";
const env = process.env;
const REPO = env.REPO || "/home/clawbox/clawbox";
const LOG_DIR = path.join(REPO, "data", "update-logs");
// The box account's own folder, never the shared temporary one: what is kept
// here is read back by the next check.
const STATE = env.STATE_DIR || path.join(env.HOME || "/home/clawbox", ".cache", "nano-update-raw-log");
const say = (line) => console.log(`RESULT ${line}`);
const note = (line) => console.log(`NOTE ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

/** A fresh owner cookie, minted here (the reader outlives the one it started with). */
function ownerCookie() {
  const secret = fs.readFileSync(path.join(REPO, "data", ".session-secret"), "utf8").trim();
  let gen = 0;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(REPO, "data", "config.json"), "utf8"));
    if (Number.isFinite(c.session_generation)) gen = c.session_generation;
  } catch { /* generation 0 */ }
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1800, gen })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/** The run the box started last (its `latest` pointer, else the newest id), with its record. */
function newestRun() {
  let names = [];
  try { names = fs.readdirSync(LOG_DIR); } catch { return null; }
  let id = null;
  try { id = fs.readFileSync(path.join(LOG_DIR, "latest"), "utf8").trim() || null; } catch { /* none yet */ }
  if (!id || !names.includes(`${id}.log`)) {
    id = names.filter((n) => n.endsWith(".log")).map((n) => n.slice(0, -4)).sort().at(-1) ?? null;
  }
  if (!id) return null;
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(path.join(LOG_DIR, `${id}.json`), "utf8")); } catch { /* none */ }
  return { id, meta, file: path.join(LOG_DIR, `${id}.log`) };
}

/**
 * Read the SSE stream. `onEvent(ev)` per event; resolves when it returns
 * true, the stream ends, or `ms` pass. Throws when nothing answered.
 */
async function readStream({ query = "", lastEventId = null, ms = 10_000, onEvent }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const headers = { Cookie: `clawbox_session=${ownerCookie()}`, Accept: "text/event-stream" };
  if (lastEventId) headers["Last-Event-ID"] = lastEventId;
  try {
    const res = await fetch(`${BASE}/setup-api/update/log${query}`, { headers, signal: ac.signal });
    if (res.status !== 200) throw new Error(`the log route answered ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return "closed";
      buf += decoder.decode(value, { stream: true });
      let at;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const ev = { event: "message", id: null, data: null };
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) ev.event = line.slice(7);
          else if (line.startsWith("id: ")) ev.id = line.slice(4);
          else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
        }
        if (ev.data === null) continue;
        if (onEvent(ev)) { ac.abort(); return "stopped"; }
      }
    }
  } catch (err) {
    if (ac.signal.aborted) return "timeout";
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The whole stream from byte 0 until `end` (or `ms`): its text, and whether it ended. */
async function streamWhole(ms) {
  let text = "";
  let ended = false;
  let run = null;
  await readStream({
    ms,
    onEvent: (ev) => {
      if (ev.event === "run") run = ev.data.id;
      if (ev.event === "message") text += ev.data;
      if (ev.event === "end") { ended = true; return true; }
      return false;
    },
  });
  return { text, ended, run };
}

// ---------------------------------------------------------------------------
// The background reader: what a browser's EventSource does through a restart.

async function reader() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const textFile = path.join(STATE, "reader.txt");
  const lastFile = path.join(STATE, "reader.last");
  const eventsFile = path.join(STATE, "reader.events");
  const deadline = Date.now() + Number(env.READER_S || 7200) * 1000;
  const record = (line) => fs.appendFileSync(eventsFile, `${new Date().toISOString()} ${line}\n`);
  // The run that was newest before the update started (an earlier update's
  // finished log): read past, never kept, so the reader waits for this one.
  const before = env.READER_IGNORE_RUN || null;
  let run = null;
  while (Date.now() < deadline) {
    let last = null;
    try { last = fs.readFileSync(lastFile, "utf8").trim() || null; } catch { /* from 0 */ }
    record(`connect ${last ?? "from-0"}`);
    let ended = false;
    try {
      await readStream({
        lastEventId: last,
        ms: 600_000,
        onEvent: (ev) => {
          if (ev.event === "run") {
            const prev = last ? last.slice(0, last.lastIndexOf(":")) : null;
            run = ev.data.id;
            record(`run ${run}${prev && prev !== run ? " (another run: from 0)" : ""}${run === before ? " (the previous update's: waiting for this one)" : ""}`);
            if (prev && prev !== run) fs.writeFileSync(textFile, "");
          } else if (ev.event === "message") {
            if (run !== before) fs.appendFileSync(textFile, ev.data);
            fs.writeFileSync(lastFile, ev.id);
            last = ev.id;
          } else if (ev.event === "end") {
            record(`end ${JSON.stringify(ev.data)}`);
            if (run !== before) ended = true;
            return true;
          }
          return false;
        },
      });
    } catch (err) {
      record(`dropped: ${err instanceof Error ? err.message : err}`);
    }
    if (ended) {
      fs.writeFileSync(path.join(STATE, "reader.done"), "1");
      return;
    }
    await sleep(3000); // EventSource's retry
  }
  record("gave up: deadline");
}

function startReader() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(STATE, "reader.out"), "a");
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "reader"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...env, READER_IGNORE_RUN: newestRun()?.id ?? "" },
  });
  child.unref();
  fs.writeFileSync(path.join(STATE, "reader.pid"), String(child.pid));
  say(`ok - a background reader follows /setup-api/update/log the way a browser does (pid ${child.pid})`);
}

// ---------------------------------------------------------------------------
// The journal, section by section.

const SECTION_RE = /^\x1b\[2m\$ journalctl -u (\S+) --since @([0-9.]+) -o cat( \(continued\))?\x1b\[0m$/;
// The runner's own lines always open with a colour (update-raw-log.ts): a
// step's "==> …" without one is the step's.
const HEADER_RE = /^\x1b\[[0-9;]*m(==>|===|\$ )/;

/** Every unit section of the log: `unit@since` -> its lines, the continued parts joined on. */
function unitSections(text) {
  const sections = new Map();
  let current = null;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  // Empty lines are held until the next line says whose they are: the
  // runner's headers start with one ("\n==> [3/9] …"), a unit's output can
  // hold some of its own.
  let held = 0;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m) {
      current = `${m[1]}@${m[2]}`;
      if (!sections.has(current)) sections.set(current, []);
      held = 0;
      continue;
    }
    if (line === "") { held++; continue; }
    // Any other header ends the section (a step result, a command, a banner).
    if (HEADER_RE.test(line)) { current = null; held = 0; continue; }
    if (current) {
      const into = sections.get(current);
      for (; held > 0; held--) into.push("");
      into.push(line);
    }
    held = 0;
  }
  return sections;
}

function journalOf(unit, since) {
  return execFileSync("journalctl", ["-q", "-u", unit, "--since", `@${since}`, "--no-pager", "-o", "cat"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).split("\n").slice(0, -1);
}

/**
 * Does the log's section say what the journal says? Line for line, in order,
 * from the first; a line the log redacted is allowed to differ there only.
 * The journal may have more at the end (it went on after the read).
 */
function compareSection(logLines, journalLines) {
  let redacted = 0;
  for (let i = 0; i < logLines.length; i++) {
    if (logLines[i] === journalLines[i]) continue;
    if (logLines[i]?.includes("[redacted]") && journalLines[i] !== undefined) { redacted++; continue; }
    return { ok: false, at: i, log: logLines[i], journal: journalLines[i], redacted };
  }
  return { ok: true, lines: logLines.length, redacted, more: journalLines.length - logLines.length };
}

function checkSections(text, { only = null } = {}) {
  const sections = unitSections(text);
  const results = [];
  for (const [key, lines] of sections) {
    const [unit, since] = [key.slice(0, key.lastIndexOf("@")), key.slice(key.lastIndexOf("@") + 1)];
    if (only && unit !== only) continue;
    let journal;
    try { journal = journalOf(unit, since); } catch (err) { results.push({ unit, since, ok: false, error: String(err) }); continue; }
    results.push({ unit, since, ...compareSection(lines, journal), journalTail: journal.slice(Math.max(0, lines.length - 14), lines.length) });
  }
  return results;
}

// ---------------------------------------------------------------------------
// The screen.

function startChrome(noSandbox) {
  const args = [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--disable-extensions", "--mute-audio", "--window-size=1600,1000", "--hide-scrollbars",
    `--user-data-dir=${env.PROFILE_DIR}`,
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    ...(noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child = spawn(env.CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  return { child, stderr: () => stderr };
}

async function waitFor(what, test, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await test().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function openBrowser() {
  let chrome = startChrome(env.NO_SANDBOX === "1");
  const portOf = (c) => waitFor("Chromium's DevTools port", async () => {
    if (c.child.exitCode !== null) throw new Error(`Chromium exited: ${c.stderr().trim().split("\n").at(-1) ?? ""}`);
    return Number(fs.readFileSync(path.join(env.PROFILE_DIR, "DevToolsActivePort"), "utf8").split("\n")[0]) || null;
  }, 30_000);
  let port;
  try {
    port = await portOf(chrome);
  } catch (err) {
    if (env.NO_SANDBOX === "1" || !/sandbox/i.test(chrome.stderr())) throw err;
    fs.rmSync(path.join(env.PROFILE_DIR, "DevToolsActivePort"), { force: true });
    chrome = startChrome(true);
    port = await portOf(chrome);
  }
  const target = await waitFor("a page in Chromium", async () => (await listTargets(port)).find((t) => t.type === "page"), 15_000);
  const page = await connectTarget(target.webSocketDebuggerUrl);
  await page.send("Network.enable");
  await page.send("Network.setCookie", { name: "clawbox_session", value: ownerCookie(), url: `${BASE}/`, httpOnly: true });
  await page.send("Page.enable");
  return { page, close: () => { page.close(); chrome.child.kill("SIGKILL"); } };
}

/** The panel's rows and where the steps panel is, or null when the panel is not on the page. */
const READ_PANEL = `(() => {
  const panel = document.querySelector('[data-testid="update-raw-log"]');
  const steps = document.querySelector('[data-testid="update-steps-panel"]');
  if (location.pathname !== "/updating") return { left: true };
  if (!panel || !steps) return null;
  const rows = [...panel.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent.replace(/\\u00a0/g, " ").trimEnd());
  const r = steps.getBoundingClientRect();
  return { status: panel.dataset.status, rows, clip: { x: r.x, y: r.y, width: r.width, height: r.height } };
})()`;

/**
 * The update screen, freshly loaded (a reload), with the raw log panel open
 * and drawn, and its picture.
 *
 * `settle`: how long to let the stream fill the panel first. Mid-update there
 * is time. After a COMPLETED update there is not: /updating shows the result
 * for RETURN_AFTER_COMPLETE_MS (3 s, src/app/updating/page.tsx) and then
 * replaces itself with the desktop, so the panel is read and drawn the moment
 * its first rows are there — and the page is loaded again if it left first.
 */
async function openPanel(page, { settle, attempts = 1 }) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.send("Page.navigate", { url: `${BASE}/updating` });
      await waitFor("the update screen's terminal button", () => page.evaluate(`!!document.querySelector('[data-testid="update-log-toggle"]')`), 120_000, 100);
      await page.evaluate(`document.querySelector('[data-testid="update-log-toggle"]').click(), true`);
      const drawn = await waitFor("the panel's first rows", async () => {
        const seen = await page.evaluate(READ_PANEL);
        if (seen?.left) return "left";
        return seen && seen.rows.join("").trim().length > 40 ? "drawn" : null;
      }, 60_000, 100);
      if (drawn === "left") throw new Error("the update screen left before the panel drew");
      if (settle) await sleep(settle);
      const panel = await page.evaluate(READ_PANEL);
      if (!panel || panel.left) throw new Error("the update screen left before the panel was read");
      const jpeg = await shot(page, panel.clip);
      // The rows as the picture has them: the stream may have moved the
      // panel on between the first read and the shot.
      const shown = await page.evaluate(READ_PANEL).catch(() => null);
      return { ...panel, ...(shown && !shown.left ? { rows: shown.rows } : {}), jpeg, attempt };
    } catch (err) {
      lastError = err;
      note(`panel attempt ${attempt}: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw lastError;
}

async function shot(page, clip) {
  const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 72, clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
  return data;
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/** The panel's picture beside the journal's lines and the log file's lines it shows. */
async function composite(page, name, panelJpeg, columns) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0b0f14;color:#d6dde6;font:12px/1.35 "DejaVu Sans Mono",monospace;display:flex;gap:16px;padding:16px}
    img{display:block;max-width:900px;border:1px solid #333}
    .col{display:flex;flex-direction:column;gap:12px;min-width:0;width:880px}
    h2{font:600 13px sans-serif;margin:0 0 4px;color:#f0a070}
    pre{margin:0;padding:8px;background:#11161d;border:1px solid #2a323c;white-space:pre-wrap;word-break:break-all}
  </style><body><div><h2>${escapeHtml(name)}: the update screen's raw log panel</h2><img src="data:image/jpeg;base64,${panelJpeg}"></div>
  <div class="col">${columns.map((c) => `<div><h2>${escapeHtml(c.title)}</h2><pre>${escapeHtml(c.lines.join("\n"))}</pre></div>`).join("")}</div></body>`;
  const file = path.join(STATE, `${name}.html`);
  fs.writeFileSync(file, html);
  await page.send("Page.navigate", { url: `file://${file}` });
  await sleep(1500);
  const size = await page.evaluate(`({ width: Math.ceil(document.body.scrollWidth), height: Math.ceil(document.body.scrollHeight) })`);
  await page.send("Emulation.setDeviceMetricsOverride", { width: Math.min(size.width, 2000), height: Math.min(size.height, 4000), deviceScaleFactor: 1, mobile: false });
  const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: true });
  await page.send("Emulation.clearDeviceMetricsOverride");
  const bytes = Buffer.from(data, "base64");
  fs.writeFileSync(path.join(STATE, `${name}.jpg`), bytes);
  return env.SHOTS === "1"
    ? `SHOT ${name} ${crypto.createHash("sha256").update(bytes).digest("hex")} ${bytes.toString("hex")}`
    : `NOTE screenshot ${name}.jpg kept on the board in ${STATE} (not printed here)`;
}

/** The panel's rows that are lines (or wrapped parts of lines) of the log file. */
function rowsInFile(rows, fileText) {
  const plain = strip(fileText).split("\n").flatMap((l) => l.split("\r"));
  const hay = plain.join("\n");
  const shown = rows.filter((r) => r.trim().length > 0);
  const found = shown.filter((r) => hay.includes(r.trim()));
  return { shown: shown.length, found: found.length, missing: shown.filter((r) => !hay.includes(r.trim())).slice(0, 3) };
}

/**
 * The panel on a freshly loaded update screen: its rows against the log file,
 * and the picture beside the journal's and the file's lines. Answers the lines
 * to print — results without "RESULT ", NOTE and SHOT lines with theirs —
 * and prints them itself unless `quiet`.
 */
async function panelEvidence(name, run, text, sectionCheck, { after = false, quiet = false } = {}) {
  const out = [];
  if (!env.CHROME) {
    out.push(`skip - ${name}: no Chromium on this board to draw the update screen with`);
  } else {
    const browser = await openBrowser();
    try {
      const panel = await openPanel(browser.page, after ? { settle: 0, attempts: 4 } : { settle: 2500 });
      if (panel.attempt > 1) out.push(`NOTE ${name}: the panel was read on load ${panel.attempt}`);
      // The file as it is now: the panel was drawn from it a moment ago.
      const fileNow = fs.readFileSync(run.file, "utf8");
      const match = rowsInFile(panel.rows, fileNow);
      if (match.shown > 0 && match.found >= Math.ceil(match.shown * 0.9)) {
        out.push(`ok - ${name}: ${match.found} of the ${match.shown} rows the panel shows are lines of the log file on the box (${run.id}.log)`);
      } else {
        out.push(`not ok - ${name}: only ${match.found} of ${match.shown} panel rows are in the log file; e.g. ${JSON.stringify(match.missing)}`);
      }
      const shownRows = panel.rows.filter((r) => r.trim()).slice(-24);
      const fileTail = strip(fileNow).split("\n").filter((l) => l.trim()).slice(-24);
      const columns = [
        { title: `tail -n 24 data/update-logs/${run.id}.log (ANSI stripped)`, lines: fileTail },
      ];
      if (sectionCheck) {
        columns.unshift({
          title: `journalctl -u ${sectionCheck.unit} --since @${sectionCheck.since} -o cat (the lines the log section holds, last 14)`,
          lines: sectionCheck.journalTail.map(strip),
        });
      }
      columns.push({ title: "the panel's rows (xterm DOM text)", lines: shownRows });
      out.push(await composite(browser.page, name, panel.jpeg, columns));
    } finally {
      browser.close();
    }
  }
  if (!quiet) {
    for (const line of out) {
      if (line.startsWith("SHOT ") || line.startsWith("NOTE ")) console.log(line);
      else say(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

/** The box's web server answers at all (it is replaced half-way through an update). */
async function serverUp() {
  try {
    const res = await fetch(`${BASE}/setup-api/update/status`, { signal: AbortSignal.timeout(5_000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Mid-update: the stream is the start of the file, the newest unit section is
 * that unit's journal, and the panel shows lines of the file. Everything is
 * said at the end, or nothing but "not yet" — the next poll asks again — so a
 * check the web server's restart cut short leaves no half a verdict behind.
 *
 * LABEL "before-restart" is answered only before the rebuild's restart (the
 * log then has no "ClawBox restarted" line), "after-restart" only after it.
 */
async function live() {
  const run = newestRun();
  if (!run || !run.meta || run.meta.finished) {
    say("skip - not yet: no unfinished update log on the box");
    return;
  }
  const textNow = fs.readFileSync(run.file, "utf8");
  const restarted = textNow.includes("ClawBox restarted on the new build");
  if (env.LABEL === "after-restart" && !restarted) {
    say("skip - not yet: the web server has not been restarted by the update yet");
    return;
  }
  if (env.LABEL === "before-restart" && restarted) {
    say("skip - before-restart: the update was past its restart before a check could run");
    return;
  }
  // The newest unit section that has lines: what the panel shows at the bottom.
  const sections = [...unitSections(textNow)].filter(([, lines]) => lines.length > 0);
  if (sections.length === 0) {
    say("skip - not yet: no root step has written anything yet");
    return;
  }
  const [key] = sections.at(-1);
  const unit = key.slice(0, key.lastIndexOf("@"));
  const results = [];
  const keep = (line) => results.push(line);
  try {
    // 1. The stream is the file: what it sends is the file's start, byte for byte.
    const streamed = await streamWhole(6_000);
    const file = fs.readFileSync(run.file);
    const sent = Buffer.from(streamed.text, "utf8");
    if (streamed.run === run.id && sent.length > 0 && file.subarray(0, sent.length).equals(sent)) {
      keep(`ok - ${env.LABEL}: mid-update, the stream sent ${sent.length} bytes of ${run.id}.log, exactly the file's (${file.length} bytes now, still growing)`);
    } else {
      keep(`not ok - ${env.LABEL}: the stream (${sent.length} bytes, run ${streamed.run}) is not the start of ${run.id}.log (${file.length} bytes)`);
    }
    // 2. That unit's section is its journal.
    const check = checkSections(file.toString("utf8"), { only: unit }).at(-1);
    if (check?.ok) {
      keep(`ok - ${env.LABEL}: the log's ${check.lines} lines of ${unit} are its journal (journalctl -u ${unit} --since @${check.since} -o cat), line for line${check.redacted ? `, ${check.redacted} redacted` : ""}`);
    } else {
      keep(`not ok - ${env.LABEL}: line ${(check?.at ?? 0) + 1} of ${unit} differs: log ${JSON.stringify(check?.log)} journal ${JSON.stringify(check?.journal)}${check?.error ? ` (${check.error})` : ""}`);
    }
    // 3. The panel.
    const shotLines = await panelEvidence(env.LABEL, run, file.toString("utf8"), check?.ok ? check : null, { quiet: true });
    results.push(...shotLines);
  } catch (err) {
    if (!(await serverUp())) {
      say(`skip - not yet: the web server went away during the check (${err instanceof Error ? err.message : err})`);
      return;
    }
    throw err;
  }
  for (const line of results) {
    if (line.startsWith("SHOT ") || line.startsWith("NOTE ")) console.log(line);
    else say(line);
  }
}

async function after() {
  const run = newestRun();
  if (!run) {
    say("not ok - no update log on the box after the update");
    return;
  }
  const meta = run.meta ?? {};
  if (meta.finished) say(`ok - ${run.id}.log is complete: the run ended ${meta.outcome}`);
  else say(`not ok - ${run.id}.log is not marked finished after the update ended`);
  const file = fs.readFileSync(run.file);
  const text = file.toString("utf8");
  note(`log: ${file.length} bytes, ${text.split("\n").length} lines, ${(text.match(/^\x1b\[1;36m==> \[/gm) ?? []).length} step headers`);

  // The stream from byte 0, read to its end, after the run: exactly the file.
  const whole = await streamWhole(60_000);
  if (whole.ended && Buffer.from(whole.text, "utf8").equals(file)) say(`ok - after the update, the stream from byte 0 is ${run.id}.log byte for byte (${file.length} bytes) and then says it ended`);
  else say(`not ok - after the update, the stream (${Buffer.byteLength(whole.text)} bytes, ended: ${whole.ended}) is not the file (${file.length} bytes)`);

  // The download.
  const res = await fetch(`${BASE}/setup-api/update/log?download=1`, { headers: { Cookie: `clawbox_session=${ownerCookie()}` } });
  const body = Buffer.from(await res.arrayBuffer());
  if (res.status === 200 && body.equals(file)) say(`ok - "Download log" answers the file itself (${res.headers.get("content-disposition")})`);
  else say(`not ok - the download answered ${res.status} with ${body.length} bytes, not the file`);

  // The background reader, through the restart.
  const done = await waitFor("the background reader to see the end", async () => fs.existsSync(path.join(STATE, "reader.done")), 90_000, 2000).catch(() => false);
  let readerText = null;
  try { readerText = fs.readFileSync(path.join(STATE, "reader.txt")); } catch { /* none */ }
  const events = (() => { try { return fs.readFileSync(path.join(STATE, "reader.events"), "utf8").trim().split("\n"); } catch { return []; } })();
  // A reconnect that resumed: a `connect <run>:<offset>` the server answered.
  const resumes = events.filter((l, i) => /connect \S+:\d+$/.test(l) && /^\S+ run /.test(events[i + 1] ?? ""));
  const attempts = events.filter((l) => /connect \S+:\d+$/.test(l)).length;
  for (const l of events.slice(-12)) note(`reader: ${l}`);
  if (done && readerText && readerText.equals(file)) {
    say(`ok - the reader that followed the whole update live holds the file byte for byte, after ${resumes.length} reconnect(s) that resumed from Last-Event-ID${resumes.length ? ` at byte ${resumes.map((l) => l.split(" ").at(-1).split(":")[1]).join(", ")}` : ""} (${attempts} attempt(s) while the web server restarted)`);
  } else {
    say(`not ok - the live reader (${readerText ? readerText.length : "no"} bytes, ended: ${Boolean(done)}) does not hold the file (${file.length} bytes)`);
  }
  if (resumes.length === 0) note("the reader never had to reconnect: no web server restart happened while it read");

  // Every unit section against its journal.
  const checks = checkSections(text);
  const bad = checks.filter((c) => !c.ok);
  for (const c of checks) note(`${c.ok ? "same" : "DIFFERS"}: ${c.unit} since @${c.since}: ${c.lines ?? c.at} lines${c.redacted ? `, ${c.redacted} redacted` : ""}${c.more ? ` (journal has ${c.more} more since)` : ""}`);
  if (checks.length > 0 && bad.length === 0) say(`ok - all ${checks.length} root-step sections of the log are their units' journals (journalctl -u <unit> --since <dispatch> -o cat), line for line`);
  else if (checks.length === 0) say("not ok - the log holds no root-step journal section");
  else say(`not ok - ${bad.length} of ${checks.length} sections differ from the journal; first: ${bad[0].unit} line ${bad[0].at + 1}: log ${JSON.stringify(bad[0].log)} journal ${JSON.stringify(bad[0].journal)}`);

  // journald drops a unit's lines past its rate limit and says so in its own
  // line; config/clawbox-root-update@.service turns that limit off.
  const suppressed = text.match(/^Suppressed \d+ messages from \S+$/gm) ?? [];
  if (suppressed.length === 0) say("ok - journald dropped none of the steps' lines (no \"Suppressed … messages\" in the log)");
  else say(`not ok - journald dropped lines of the update: ${suppressed.join("; ")}`);

  const colourful = /\x1b\[[0-9;]*m/.test(text.replace(/^\x1b\[[0-9;]*m(==>|===|\$ )/gm, ""));
  note(`ANSI sequences from the steps themselves in the log: ${colourful ? "yes" : "none (the steps printed none)"}; carriage returns: ${text.includes("\r") ? "yes" : "none"}`);

  const last = [...checks].reverse().find((c) => c.ok && c.journalTail.length > 0) ?? null;
  await panelEvidence(env.LABEL || "after-reload", run, text, last, { after: true });
}

const mode = process.argv[2];
const main = mode === "reader" ? reader : mode === "reader-start" ? async () => startReader() : mode === "live" ? live : mode === "after" ? after : null;
if (!main) {
  console.error("usage: update-raw-log.mjs reader-start|reader|live|after");
  process.exit(2);
}
main().catch((err) => {
  say(`not ok - ${mode}: ${err instanceof Error ? err.message : String(err)}`);
}).finally(() => {
  // Out once stdout has taken every line: a pipe is written asynchronously,
  // and exiting with a picture's line still queued cut it short.
  if (mode !== "reader") process.stdout.write("", () => process.exit(0));
});
