// ClawBox Kiosk Tabs — service worker.
//
// The kiosk Chrome on the x64 laptop runs --kiosk: no tab strip. The desktop's
// own shelf lists the tabs through the CDP port (src/lib/kiosk-tabs.ts), but
// a page the desktop OPENED has no shelf — so the content script draws a bar
// on it and asks this worker, which holds the `tabs` permission, to do the
// switching. Messages: { type: "list" } → { tabs, currentId, homeId };
// { type: "activate", id }; { type: "close", id }; { type: "home" }.
//
// The desktop is found by URL prefix: the origin of DESKTOP_ORIGINS, which is
// what the launcher's CLAWBOX_KIOSK_URL is on a laptop (a different URL means
// editing this list and manifest.json's exclude_matches together).

const DESKTOP_ORIGINS = [
  "http://localhost:3005/",
  "http://127.0.0.1:3005/",
  "http://localhost/",
  "http://127.0.0.1/",
];
// The pages the shell itself lands on. /app/<id> and /apps/<id>/ on the same
// origin are pages the desktop opened, and get a bar like any other.
const SHELL_PATH = /^\/(?:(?:login|setup|updating|portal)(?:\/.*)?)?$/;

function isDesktop(url) {
  if (!url) return false;
  for (const origin of DESKTOP_ORIGINS) {
    if (!url.startsWith(origin)) continue;
    const path = url.slice(origin.length - 1).split(/[?#]/)[0];
    if (SHELL_PATH.test(path)) return true;
  }
  return false;
}

async function listTabs(sender) {
  const all = await chrome.tabs.query({ windowType: "normal" });
  const home = all.find((t) => isDesktop(t.url));
  return {
    homeId: home ? home.id : null,
    currentId: sender.tab ? sender.tab.id : null,
    tabs: all
      .filter((t) => !isDesktop(t.url))
      .map((t) => ({ id: t.id, title: t.title || "", url: t.url || "", favicon: t.favIconUrl || "", active: !!t.active })),
  };
}

async function goHome() {
  const all = await chrome.tabs.query({ windowType: "normal" });
  const home = all.find((t) => isDesktop(t.url));
  if (home) {
    await chrome.tabs.update(home.id, { active: true });
  } else {
    // The desktop tab is gone (closed by hand): bring it back rather than
    // leave the owner on a page with no way out.
    await chrome.tabs.create({ url: DESKTOP_ORIGINS[0], active: true });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const run = async () => {
    switch (msg && msg.type) {
      case "list":
        return listTabs(sender);
      case "activate":
        await chrome.tabs.update(msg.id, { active: true });
        return { ok: true };
      case "close":
        await chrome.tabs.remove(msg.id);
        return { ok: true };
      case "home":
        await goHome();
        return { ok: true };
      default:
        return { ok: false, error: "unknown message" };
    }
  };
  run().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async sendResponse
});

// Tell every bar to refresh when the tab set changes, so a page closed from
// the desktop's shelf leaves the bars without waiting for their own poll.
function broadcast() {
  chrome.tabs.query({ windowType: "normal" }).then((tabs) => {
    for (const t of tabs) {
      if (t.id == null || isDesktop(t.url)) continue;
      chrome.tabs.sendMessage(t.id, { type: "changed" }).catch(() => {});
    }
  });
}
chrome.tabs.onCreated.addListener(broadcast);
chrome.tabs.onRemoved.addListener(broadcast);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.title || info.url || info.favIconUrl || info.status === "complete") broadcast();
});
chrome.tabs.onActivated.addListener(broadcast);
