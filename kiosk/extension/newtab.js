// ClawBox Kiosk Tabs — the start page (chrome_url_overrides.newtab, and where
// the bar's "+" lands). Mounts the same bar every web page gets, and sends
// the centered box through the bar's own Enter rule: an address goes there,
// anything else is a DuckDuckGo search.

clawboxKioskBar.mount({ startPage: true });

const form = document.querySelector(".search");
const input = document.getElementById("q");
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const to = webAddress(clawboxKioskBar.destinationFor(input.value));
  if (to) location.assign(to);
});

// destinationFor answers only http(s) addresses and searches. Checked again
// here, where the navigation is, and rebuilt behind a fixed scheme, so nothing
// typed into this page can ever become a javascript: or data: URL.
function webAddress(to) {
  if (!to) return null;
  let url;
  try { url = new URL(to); } catch { return null; }
  if (url.protocol === "https:") return "https://" + url.href.slice("https://".length);
  if (url.protocol === "http:") return "http://" + url.href.slice("http://".length);
  return null;
}
// `autofocus` is ignored when the page opens in the background; ask again.
window.addEventListener("pageshow", () => input.focus());
