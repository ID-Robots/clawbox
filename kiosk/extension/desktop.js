// ClawBox Kiosk Tabs — content script for the ClawBox desktop page.
//
// The manifest injects this (after bar.js) on the desktop's origins; the bar
// goes on the DESKTOP only — "/" on one of DESKTOP_ORIGINS, the same list
// background.js names the desktop by (the extension test holds them equal).
// Chrome ignores the port in a match pattern, so `http://localhost/*` also
// reaches every other server on localhost: the origin is checked here, and
// a dev server's own "/" is left alone. The other ClawBox pages (login, setup,
// /app/<id>) get no bar from this script.
//
// On the desktop the bar is the tab strip, always up, in the shelf's glass,
// with no address box; see bar.js for what else it leaves out there and how
// the desktop makes room for it.

(() => {
  const DESKTOP_ORIGINS = [
    "http://localhost:3005/",
    "http://127.0.0.1:3005/",
    "http://localhost/",
    "http://127.0.0.1/",
  ];
  const here = location.origin + "/";
  if (location.pathname === "/" && DESKTOP_ORIGINS.includes(here)) {
    clawboxKioskBar.mount({ desktop: true });
  }
})();
