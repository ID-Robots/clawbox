// Runs ON the board, for scripts/nano-tests/tests/69-external-engine-reasoning.sh:
// the chat's reasoning picker over an external engine that reasons (TASK-2497),
// in a headless Chromium of the test's own (its own profile and DevTools port,
// never the kiosk's), signed in as the owner through DevTools — the cookie
// never on a command line. The PROFILE persists between phases, so the level
// the owner picked is carried across a page reload and a runtime restart the
// way the owner's browser carries it.
//
// PHASE:
//   levels  open the desktop chat in a NEW tab, list the picker's levels, then
//           pick each in turn in that one conversation (switching mid-chat)
//           and send a turn at it; reload the page and send one more at the
//           level the picker comes back with.
//   check   (after a restart) the picker's level, and one turn at it.
//   off     the picker as an engine without reasoning shows it, and one turn.
//   card    Settings → Local AI → External engine: Edit, then Save untouched;
//           the reasoning line must still be there.
//
// Prints, for the test to judge against the mock's request log:
//   LEVELS <label>|<label>|…        what the picker offers ("" = no picker)
//   PICKER <label>                  the picker's value when the phase began
//   TURN <label> <marker> thinking=yes|no
//                                   a turn sent at <label>; whether the reply
//                                   shows a reasoning part carrying the mock's
//                                   NANO-THINK[<marker>] text
// and `RESULT ok - …` / `RESULT not ok - …` / `NOTE …` lines.
//
// Env: OWNER_COOKIE, CHROME, PROFILE_DIR, PHASE, MARK (a per-run prefix for
// the turn markers), SHOTS_DIR (optional), NO_SANDBOX ("1").
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectTarget, listTargets } from "../../bench/lib/cdp.mjs";

const BASE = "http://127.0.0.1";
const env = process.env;
const PHASE = env.PHASE || "levels";
const MARK = env.MARK || "NANO-RSN";
const say = (line) => console.log(`RESULT ${line}`);
const note = (line) => console.log(`NOTE ${line}`);
const out = (line) => console.log(line);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (v) => JSON.stringify(v);

class Fatal extends Error {}

async function waitFor(what, test, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await test().catch((err) => {
      if (err instanceof Fatal) throw err;
      return null;
    });
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

function startChrome(noSandbox) {
  const args = [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--disable-extensions", "--mute-audio", "--window-size=1440,900",
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

async function devtoolsPort(chrome) {
  const file = path.join(env.PROFILE_DIR, "DevToolsActivePort");
  return waitFor("Chromium's DevTools port", async () => {
    if (chrome.child.exitCode !== null) throw new Fatal(`Chromium exited: ${chrome.stderr().trim().split("\n").at(-1) ?? ""}`);
    return Number(fs.readFileSync(file, "utf8").split("\n")[0]) || null;
  }, 30_000);
}

async function shot(page, name) {
  if (!env.SHOTS_DIR) return;
  try {
    const { data } = await page.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(env.SHOTS_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    note(`screenshot ${file}`);
  } catch (err) {
    note(`no screenshot of ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

let current = null;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    try { current?.child.kill("SIGKILL"); } catch { /* gone */ }
    say(`not ok - the browser check was stopped (${signal}) before it finished`);
    process.exit(1);
  });
}

// ── The chat ──────────────────────────────────────────────────────────────

const TRIGGER = `button.header-dropdown-trigger[aria-label^="Reasoning effort:"]`;
const LISTBOX = `[role="listbox"][aria-label="Reasoning effort"]`;

async function openChat(page, { newTab }) {
  await page.send("Page.navigate", { url: `${BASE}/` });
  await waitFor("the desktop", () => page.evaluate(`!!document.querySelector('[data-testid="desktop-root"]')`), 120_000, 1000);
  const whatsNew = `!!document.querySelector('[data-testid="whats-new-card"]')`;
  if (await waitFor("the What's new card", () => page.evaluate(whatsNew), 8_000).catch(() => false)) {
    await waitFor("the What's new card to leave", async () => !(await page.evaluate(whatsNew)), 60_000, 1000).catch(() => null);
  }
  await page.evaluate(`window.dispatchEvent(new CustomEvent("clawbox:open-chat"))`);
  await waitFor("the chat composer", () => page.evaluate(`!!document.querySelector('[data-testid="chat-composer"] textarea')`), 120_000, 1000);
  if (newTab) {
    const clicked = await page.evaluate(`(() => { const b = document.querySelector('[data-testid="chat-new-tab"]'); if (!b) return false; b.click(); return true; })()`);
    note(clicked ? "opened a new chat tab for this run" : "no New tab button; using the open chat");
    await sleep(1500);
  }
  // The header's model state (and with it the picker) loads after the composer.
  await sleep(3000);
}

async function pickerLabel(page) {
  return page.evaluate(`(() => {
    const t = document.querySelector(${json(TRIGGER)});
    return t ? t.getAttribute("aria-label").replace(/^Reasoning effort:\\s*/, "") : null;
  })()`);
}

async function readLevels(page) {
  const present = await waitFor("the reasoning picker", async () => (await pickerLabel(page)) !== null, 30_000, 1000).catch(() => false);
  if (!present) return [];
  await page.evaluate(`document.querySelector(${json(TRIGGER)}).click()`);
  const labels = await waitFor("the reasoning levels", () => page.evaluate(`(() => {
    const rows = [...document.querySelectorAll(${json(`${LISTBOX} [role="option"] .header-dropdown-option-label`)})].map((el) => el.innerText.trim());
    return rows.length ? rows : null;
  })()`), 10_000);
  await page.evaluate(`document.querySelector(${json(TRIGGER)}).click()`);
  await sleep(300);
  return labels;
}

async function selectLevel(page, label) {
  await page.evaluate(`document.querySelector(${json(TRIGGER)}).click()`);
  await waitFor(`the ${label} row`, () => page.evaluate(`(() => {
    const row = [...document.querySelectorAll(${json(`${LISTBOX} [role="option"]`)})]
      .find((el) => el.querySelector(".header-dropdown-option-label")?.innerText.trim() === ${json(label)});
    if (!row) return false;
    row.click();
    return true;
  })()`), 10_000);
  await waitFor(`the picker to read ${label}`, async () => (await pickerLabel(page)) === label, 10_000);
}

const transcriptText = (page) => page.evaluate(`document.querySelector('[data-testid="chat-transcript"]')?.innerText ?? ""`);
const count = (hay, needle) => hay.split(needle).length - 1;

async function sendTurn(page, label, marker) {
  const toggles = `document.querySelectorAll('[data-testid="chat-transcript"] [data-testid="chat-reasoning-toggle"]').length`;
  const before = await page.evaluate(toggles);
  await page.evaluate(`document.querySelector('[data-testid="chat-composer"] textarea').focus()`);
  await page.send("Input.insertText", { text: `Reply with exactly this text and nothing else: ${marker}` });
  await sleep(300);
  await page.evaluate(`document.querySelector('[data-testid="chat-send"]').click()`);
  try {
    await waitFor(`the reply to ${marker}`, async () => count(await transcriptText(page), marker) >= 2, 240_000, 1000);
    await waitFor("the turn to end", async () => !(await page.evaluate(`!!document.querySelector('[data-testid="chat-stop"]')`)), 60_000, 1000).catch(() => null);
  } catch (err) {
    await shot(page, `turn-${label}-missing`);
    out(`TURN ${label} ${marker} thinking=no reply=none`);
    say(`not ok - no reply to the ${label} turn in the chat (${err instanceof Error ? err.message : err})`);
    return;
  }
  await sleep(1500);
  const after = await page.evaluate(toggles);
  if (after > before) {
    // The reasoning part is collapsed; open the newest one to read it.
    await page.evaluate(`(() => { const all = document.querySelectorAll('[data-testid="chat-transcript"] [data-testid="chat-reasoning-toggle"]'); const b = all[all.length - 1]; if (b && b.getAttribute("aria-expanded") === "false") b.click(); })()`);
    await sleep(500);
  }
  const thinking = (await transcriptText(page)).includes(`NANO-THINK[${marker}]`);
  out(`TURN ${label} ${marker} thinking=${thinking ? "yes" : "no"} disclosures=${before}->${after}`);
}

const slug = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function phaseLevels(page) {
  await openChat(page, { newTab: true });
  const levels = await readLevels(page);
  out(`LEVELS ${levels.join("|")}`);
  out(`PICKER ${(await pickerLabel(page)) ?? ""}`);
  await shot(page, "reasoning-picker");
  if (levels.length === 0) {
    say("not ok - the chat shows no reasoning picker for the engine");
    return;
  }
  // Every level the picker offers, one after another in the SAME conversation.
  for (const label of levels) {
    await selectLevel(page, label);
    await sendTurn(page, label, `${MARK}-${slug(label)}`);
  }
  await shot(page, "reasoning-levels-chat");
  // A reload: the picker must come back on the level last picked.
  await page.send("Page.reload", {});
  await sleep(2000);
  await openChat(page, { newTab: false });
  const afterReload = (await pickerLabel(page)) ?? "";
  out(`RELOAD ${afterReload}`);
  if (afterReload) await sendTurn(page, afterReload, `${MARK}-reload`);
  await shot(page, "reasoning-after-reload");
}

async function phaseCheck(page) {
  await openChat(page, { newTab: false });
  await waitFor("the reasoning picker", async () => (await pickerLabel(page)) !== null, 60_000, 1000).catch(() => null);
  const label = (await pickerLabel(page)) ?? "";
  out(`PICKER ${label}`);
  out(`LEVELS ${(await readLevels(page)).join("|")}`);
  if (label) await sendTurn(page, label, `${MARK}-check`);
  await shot(page, "reasoning-after-restart");
}

async function phaseOff(page) {
  await openChat(page, { newTab: true });
  const levels = await readLevels(page);
  out(`LEVELS ${levels.join("|")}`);
  out(`PICKER ${(await pickerLabel(page)) ?? ""}`);
  await sendTurn(page, (await pickerLabel(page)) || "none", `${MARK}-off`);
  await shot(page, "reasoning-switch-off-chat");
}

async function phaseCard(page) {
  await page.send("Page.navigate", { url: `${BASE}/app/settings?section=localAi` });
  const summary = `document.querySelector('[data-testid="local-ai-external-summary"]')`;
  await waitFor("the External engine card's summary", () => page.evaluate(`!!${summary}`), 120_000, 1000);
  const before = await page.evaluate(`!!document.querySelector('[data-testid="local-ai-external-reasoning-on"]')`);
  await page.evaluate(`document.querySelector('[data-testid="local-ai-external-edit"]').click()`);
  const checked = await waitFor("the reasoning switch", () => page.evaluate(`(() => { const b = document.querySelector('[data-testid="local-ai-external-reasoning"]'); return b ? (b.checked ? "on" : "off") + (b.disabled ? "/disabled" : "") : null; })()`), 10_000);
  out(`CARD_SWITCH ${checked}`);
  await shot(page, "card-edit-reasoning");
  await page.evaluate(`document.querySelector('[data-testid="local-ai-external-save"]').click()`);
  await waitFor("the save to finish", () => page.evaluate(`!!${summary}`), 180_000, 1000);
  await sleep(2000);
  const after = await page.evaluate(`!!document.querySelector('[data-testid="local-ai-external-reasoning-on"]')`);
  const result = await page.evaluate(`document.querySelector('[data-testid="local-ai-external-result"]')?.innerText ?? ""`);
  out(`CARD_LINE before=${before ? "yes" : "no"} after=${after ? "yes" : "no"}`);
  note(`card result: ${result.replace(/\s+/g, " ").slice(0, 160)}`);
  await shot(page, "card-after-resave");
}

async function run() {
  // The profile persists between phases, and so does the DevToolsActivePort
  // file the last phase's Chromium left in it: read before this Chromium
  // writes its own, it names a port nobody listens on any more.
  fs.mkdirSync(env.PROFILE_DIR, { recursive: true });
  fs.rmSync(path.join(env.PROFILE_DIR, "DevToolsActivePort"), { force: true });
  let chrome = startChrome(env.NO_SANDBOX === "1");
  current = chrome;
  let page = null;
  try {
    let port;
    try {
      port = await devtoolsPort(chrome);
    } catch (err) {
      if (env.NO_SANDBOX === "1" || !/sandbox/i.test(chrome.stderr())) throw err;
      note("Chromium's sandbox could not start here; trying again without it");
      fs.rmSync(path.join(env.PROFILE_DIR, "DevToolsActivePort"), { force: true });
      chrome = startChrome(true);
      current = chrome;
      port = await devtoolsPort(chrome);
    }
    const target = await waitFor("a page in Chromium", async () => (await listTargets(port)).find((t) => t.type === "page"), 15_000);
    page = await connectTarget(target.webSocketDebuggerUrl);
    await page.send("Network.enable");
    await page.send("Network.setCookie", { name: "clawbox_session", value: env.OWNER_COOKIE, url: `${BASE}/`, httpOnly: true });
    await page.send("Page.enable");
    if (PHASE === "levels") await phaseLevels(page);
    else if (PHASE === "check") await phaseCheck(page);
    else if (PHASE === "off") await phaseOff(page);
    else if (PHASE === "card") await phaseCard(page);
    else say(`not ok - unknown PHASE ${PHASE}`);
    out("DONE");
  } catch (err) {
    if (page) await shot(page, `phase-${PHASE}-failed`);
    say(`not ok - the ${PHASE} browser phase failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    page?.close();
    try { chrome.child.kill("SIGTERM"); } catch { /* gone */ }
  }
}

run().catch((err) => {
  say(`not ok - the browser check could not run: ${err instanceof Error ? err.message : err}`);
});
