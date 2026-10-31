// Runs ON the board, for scripts/nano-tests/tests/66-background-task-card.sh:
// the flow the background-task card exists for, through the board's own
// desktop in a browser of the test's own.
//
//   1. A headless Chromium of its own (its own profile and DevTools port —
//      never the kiosk's or the shared browser) opens the desktop at
//      http://127.0.0.1/ signed in as the owner (the cookie the test minted
//      from the box's session secret, set through DevTools, never on a
//      command line).
//   2. Settings → Local AI: the memory-search model download is started the
//      way the owner starts it — the embeddings row's Install, or the card's
//      "Download again" when the model is already here — and Settings must
//      draw it inline (steps, percentage, log).
//   3. The Settings window is CLOSED.
//   4. Every 3 s until it ends: the desktop's corner card for the task (its
//      state, percentage, time left, headline) and the box's own record of it
//      (GET /setup-api/background-jobs/tasks). The work must keep running with
//      Settings closed, the card must move with it, and both must end
//      `succeeded`.
//
// Prints `RESULT ok - …` / `RESULT not ok - …` / `RESULT skip - …` lines the
// test turns into TAP, and `NOTE …` lines for the log.
//
// Env: OWNER_COOKIE, CHROME (the browser binary), PROFILE_DIR (an empty
// folder it may use), FORCE ("1": the model is here, use "Download again"),
// DEADLINE_S (how long the download may take before the end is not waited
// for), NO_SANDBOX ("1": start Chromium without its sandbox at once; it is
// otherwise tried only when the sandbox refuses to start).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectTarget, listTargets } from "../../bench/lib/cdp.mjs";

const BASE = "http://127.0.0.1";
const KIND = "embed-model-download";
const env = process.env;
const deadlineMs = Number(env.DEADLINE_S || 600) * 1000;
const force = env.FORCE === "1";

const say = (line) => console.log(`RESULT ${line}`);
const note = (line) => console.log(`NOTE ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(what, test, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await test().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

function startChrome(noSandbox) {
  const args = [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--disable-extensions", "--mute-audio", "--window-size=1600,1000",
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

/** The port Chromium picked, from the file it writes into its profile. */
async function devtoolsPort(chrome) {
  const file = path.join(env.PROFILE_DIR, "DevToolsActivePort");
  return waitFor("Chromium's DevTools port", async () => {
    if (chrome.child.exitCode !== null) throw new Error(`Chromium exited: ${chrome.stderr().trim().split("\n").at(-1) ?? ""}`);
    const first = fs.readFileSync(file, "utf8").split("\n")[0];
    return Number(first) || null;
  }, 30_000);
}

/** What the desktop and the box say about the task, in one read from the page. */
const SAMPLE = `(async () => {
  const card = document.querySelector('[data-testid="background-task-card"][data-task-kind="${KIND}"]');
  const text = (id) => card?.querySelector('[data-testid="' + id + '"]')?.textContent?.trim() ?? null;
  const answer = await fetch("/setup-api/background-jobs/tasks?kind=${KIND}", { cache: "no-store" }).then((r) => r.json()).catch(() => null);
  const task = answer?.tasks?.[0] ?? null;
  return {
    settingsOpen: !!document.querySelector('[data-testid="chrome-window-settings"]'),
    card: card ? { state: card.dataset.taskState, headline: text("background-task-headline"), percent: text("background-task-percent"), eta: text("background-task-eta") } : null,
    task: task ? { id: task.id, state: task.state, percent: task.percent, completed: task.completed, total: task.total, eta: task.etaSeconds, status: task.status, error: task.error } : null,
  };
})()`;

const mb = (n) => (typeof n === "number" ? `${Math.round(n / 1e6)} MB` : "?");
const percentOf = (text) => {
  const m = /(\d+)%/.exec(text ?? "");
  return m ? Number(m[1]) : null;
};

async function run() {
  let chrome = startChrome(env.NO_SANDBOX === "1");
  let page = null;
  try {
    let port;
    try {
      port = await devtoolsPort(chrome);
    } catch (err) {
      // A board whose kernel refuses Chromium's sandbox to this account: the
      // page it loads is this box's own loopback desktop, nothing else.
      if (env.NO_SANDBOX === "1" || !/sandbox/i.test(chrome.stderr())) throw err;
      note("Chromium's sandbox could not start here; trying again without it");
      fs.rmSync(path.join(env.PROFILE_DIR, "DevToolsActivePort"), { force: true });
      chrome = startChrome(true);
      port = await devtoolsPort(chrome);
    }
    const target = await waitFor("a page in Chromium", async () => (await listTargets(port)).find((t) => t.type === "page"), 15_000);
    page = await connectTarget(target.webSocketDebuggerUrl);
    await page.send("Network.enable");
    await page.send("Network.setCookie", { name: "clawbox_session", value: env.OWNER_COOKIE, url: `${BASE}/`, httpOnly: true });
    await page.send("Page.enable");
    await page.send("Page.navigate", { url: `${BASE}/` });

    try {
      await waitFor("the desktop", () => page.evaluate(`!!document.querySelector('[data-testid="desktop-root"]')`), 120_000, 1000);
    } catch {
      const where = await page.evaluate("location.pathname").catch(() => "?");
      say(`not ok - the desktop did not load for the owner (the page is at ${where})`);
      return;
    }
    say("ok - the board's desktop loads for the owner in a browser of the test's own");

    // 2. Settings -> Local AI, and the download as the owner starts it.
    await page.evaluate(`window.__clawboxPendingSettingsSection = "localAi";
      window.dispatchEvent(new CustomEvent("clawbox:open-app", { detail: { appId: "settings" } })); true`);
    const button = force ? "local-ai-embed-download" : "local-model-action-embeddings-install";
    try {
      await waitFor(`Settings -> Local AI's ${button}`, () => page.evaluate(`!!document.querySelector('[data-testid="${button}"]:not([disabled])')`), 90_000, 1000);
    } catch {
      say(`not ok - Settings -> Local AI never offered ${force ? "Download again on the memory-model card" : "Install on the memory-search row"}`);
      return;
    }
    await page.evaluate(`document.querySelector('[data-testid="${button}"]').click(); true`);
    say(`ok - the download was started from Settings -> Local AI (${force ? "the card's Download again: the model was already here" : "the memory-search row's Install"})`);

    const inline = await waitFor("Settings' inline progress", () => page.evaluate(`(() => {
      const view = document.querySelector('[data-testid="local-model-task-embeddings"], [data-testid="local-ai-embed-task"]');
      return view ? { id: view.getAttribute("data-testid"), text: view.textContent.replace(/\\s+/g, " ").trim().slice(0, 240) } : null;
    })()`), 30_000, 500).catch(() => null);
    if (inline) say(`ok - Settings draws the download inline under the control that started it (${inline.id}): ${inline.text}`);
    else say("not ok - Settings did not draw the download's progress inline within 30 s");

    // 3. Close Settings.
    await page.evaluate(`(() => {
      const win = document.querySelector('[data-testid="chrome-window-settings"]');
      const close = win && [...win.querySelectorAll("button")].find((b) => b.textContent.trim() === "close");
      close?.click();
      return !!close;
    })()`);
    try {
      await waitFor("Settings to close", () => page.evaluate(`!document.querySelector('[data-testid="chrome-window-settings"]')`), 15_000);
      say("ok - the Settings window was closed while the download ran");
    } catch {
      say("not ok - the Settings window did not close");
      return;
    }

    // 4. Follow the card and the record to the end.
    const started = Date.now();
    const samples = [];
    let endedAt = null;
    for (;;) {
      const s = await page.evaluate(SAMPLE).catch((err) => ({ error: err.message }));
      s.t = Math.round((Date.now() - started) / 1000);
      samples.push(s);
      const ended = s.task && s.task.state !== "running";
      if (ended && endedAt === null) endedAt = Date.now();
      // The card catches the ending at its next poll (2 s); a success then
      // stays for 30 s. Read until it has drawn it, or 25 s after the end.
      if (ended && (s.card?.state === s.task.state || Date.now() - endedAt > 25_000)) break;
      if (Date.now() - started > deadlineMs) break;
      await sleep(3_000);
    }

    for (const [i, s] of samples.entries()) {
      if (i % 5 !== 0 && i !== samples.length - 1) continue;
      const card = s.card ? `card=${s.card.state} "${s.card.percent ?? ""}" ${s.card.eta ?? ""} | ${s.card.headline ?? ""}` : "card=none";
      const task = s.task ? `task=${s.task.state} ${s.task.percent ?? "?"}% ${mb(s.task.completed)}/${mb(s.task.total)} eta=${s.task.eta ?? "-"}s` : "task=none";
      note(`t+${s.t}s settings=${s.settingsOpen ? "open" : "closed"} ${card} || ${task}`);
    }

    const first = samples[0];
    const last = samples.at(-1);
    if (first?.task?.state === "running" && first.settingsOpen === false) say(`ok - with Settings closed the download kept running (task ${first.task.id.slice(0, 8)})`);
    else say(`not ok - the first read after Settings closed found the task ${first?.task?.state ?? "missing"}`);

    const running = samples.filter((s) => s.card?.state === "running");
    const shown = running.map((s) => percentOf(s.card.percent)).filter((p) => p !== null);
    const rose = shown.length >= 2 && Math.max(...shown) > Math.min(...shown);
    if (running.length >= 2 && rose) say(`ok - the desktop's corner card drew the running download and its percentage rose from ${Math.min(...shown)}% to ${Math.max(...shown)}% over ${running.length} reads`);
    else say(`not ok - the corner card was seen running ${running.length} time(s), percentages ${JSON.stringify(shown)}`);

    const withEta = running.find((s) => s.card.eta);
    if (withEta) say(`ok - the card said how long was left ("${withEta.card.eta}")`);
    else note("the card never showed a time left (the download may have been too quick to have a rate)");

    if (!last?.task || last.task.state === "running") {
      say(`skip - the download had not finished after ${Math.round(deadlineMs / 1000)} s on this board's link (it runs on: ${last?.task?.percent ?? "?"}%)`);
      return;
    }
    if (last.task.state === "succeeded") say(`ok - the download ran to the end with Settings closed: ${mb(last.task.total)} in ${Math.round((endedAt - started) / 1000)} s`);
    else say(`not ok - the download ended ${last.task.state}: ${last.task.error ?? ""}`);
    if (last.card?.state === last.task.state) say(`ok - the corner card drew the ending: ${last.card.state}, "${last.card.headline}"`);
    else say(`not ok - the corner card did not draw the ending (it said ${last.card?.state ?? "nothing"})`);
  } finally {
    page?.close();
    chrome.child.kill("SIGTERM");
    await sleep(1000);
    if (chrome.child.exitCode === null) chrome.child.kill("SIGKILL");
  }
}

run().catch((err) => {
  say(`not ok - the card check could not run: ${err instanceof Error ? err.message : String(err)}`);
});
