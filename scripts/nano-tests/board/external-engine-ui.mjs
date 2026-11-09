// Runs ON the board, for scripts/nano-tests/tests/69-external-engine.sh: what
// the owner SEES once an external AI engine is the Local AI (TASK-2376), in a
// headless Chromium of the test's own (its own profile and DevTools port, never
// the kiosk's), signed in as the owner through DevTools — the cookie never on a
// command line.
//
//   1. Settings → Local AI (`/app/settings?section=localAi`): the External
//      engine card says the model answers Local AI.
//   2. The chat (`/app/chat`): the header names the engine's model.
//
// Prints `RESULT ok - …` / `RESULT not ok - …` lines the test turns into TAP,
// and `NOTE …` lines. With SHOTS_DIR set, a PNG of each page is left there
// for the run's evidence.
//
// Env: OWNER_COOKIE, CHROME, PROFILE_DIR, MODEL_NAME (the name both pages must
// show), SHOTS_DIR (optional), NO_SANDBOX ("1": start without the sandbox).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectTarget, listTargets } from "../../bench/lib/cdp.mjs";

const BASE = "http://127.0.0.1";
const env = process.env;
const NAME = env.MODEL_NAME || "";
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
    if (chrome.child.exitCode !== null) throw new Error(`Chromium exited: ${chrome.stderr().trim().split("\n").at(-1) ?? ""}`);
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

const json = (v) => JSON.stringify(v);

async function run() {
  let chrome = startChrome(env.NO_SANDBOX === "1");
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
      port = await devtoolsPort(chrome);
    }
    const target = await waitFor("a page in Chromium", async () => (await listTargets(port)).find((t) => t.type === "page"), 15_000);
    page = await connectTarget(target.webSocketDebuggerUrl);
    await page.send("Network.enable");
    await page.send("Network.setCookie", { name: "clawbox_session", value: env.OWNER_COOKIE, url: `${BASE}/`, httpOnly: true });
    await page.send("Page.enable");

    // 1. Settings → Local AI → External engine.
    await page.send("Page.navigate", { url: `${BASE}/app/settings?section=localAi` });
    try {
      const text = await waitFor(
        "the External engine card's summary",
        () => page.evaluate(`document.querySelector('[data-testid="local-ai-external-summary"]')?.innerText ?? null`),
        120_000,
        1000,
      );
      await waitFor("the engine's status line", () => page.evaluate(
        `(() => { const s = document.querySelector('[data-testid="local-ai-external-status"]')?.innerText ?? ""; return s && !/Checking/.test(s) ? s : null; })()`,
      ), 30_000, 1000).catch(() => null);
      await shot(page, "settings-local-ai-external");
      if (text.includes(NAME)) say(`ok - Settings → Local AI shows the external engine answering with ${NAME}`);
      else say(`not ok - Settings → Local AI's External engine card does not name ${NAME}: ${json(text.slice(0, 200))}`);
      const status = await page.evaluate(`document.querySelector('[data-testid="local-ai-external-status"]')?.innerText ?? ""`);
      note(`Settings status line: ${status}`);
    } catch (err) {
      await shot(page, "settings-local-ai-external-missing");
      const where = await page.evaluate("location.pathname + location.search").catch(() => "?");
      say(`not ok - Settings → Local AI drew no External engine summary (${err instanceof Error ? err.message : err}; page ${where})`);
    }

    // 2. The chat header.
    await page.send("Page.navigate", { url: `${BASE}/app/chat` });
    try {
      const header = await waitFor(
        "the chat header naming the model",
        () => page.evaluate(`(() => {
          const pill = document.querySelector('[aria-label="Chat provider"], [aria-label="Provider"]');
          const text = document.body.innerText || "";
          return text.includes(${json(NAME)}) ? (pill?.innerText || "body") : null;
        })()`),
        120_000,
        1000,
      );
      await shot(page, "chat-header-external");
      say(`ok - the chat names ${NAME} as its model (${json(String(header).slice(0, 80))})`);
    } catch (err) {
      await shot(page, "chat-header-missing");
      const where = await page.evaluate("location.pathname").catch(() => "?");
      say(`not ok - the chat does not name ${NAME} (${err instanceof Error ? err.message : err}; page ${where})`);
    }
  } finally {
    page?.close();
    try { chrome.child.kill("SIGTERM"); } catch { /* gone */ }
  }
}

run().catch((err) => {
  say(`not ok - the browser check could not run: ${err instanceof Error ? err.message : err}`);
});
