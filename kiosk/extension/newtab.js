// ClawBox Kiosk Tabs — the start page (chrome_url_overrides.newtab, and where
// the bar's "+" lands). Mounts the same bar every web page gets, and sends
// the centered box through the bar's own Enter rule: an address goes there,
// anything else is a DuckDuckGo search.

clawboxKioskBar.mount({ startPage: true });

const form = document.querySelector(".search");
const input = document.getElementById("q");
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const to = clawboxKioskBar.destinationFor(input.value);
  if (to) location.assign(to);
});
// `autofocus` is ignored when the page opens in the background; ask again.
window.addEventListener("pageshow", () => input.focus());
