// ClawBox Kiosk Tabs — content script for the ClawBox desktop's own hosts.
//
// The manifest injects this (after bar.js and offset.js) on localhost and
// 127.0.0.1, which the web-page script leaves out. Chrome ignores the port in
// a match pattern, so that is EVERY server on those hosts, and the origin is
// checked here:
//
//  - the desktop — "/" on one of DESKTOP_ORIGINS, the same list background.js
//    names the desktop by (the extension test holds them equal) — gets the
//    bar as its tab strip: always up, in the shelf's flat tint and hairline,
//    no address box (see bar.js for what else it leaves out, why a tint and
//    not a blur, and how the desktop makes room);
//  - the shell's own pages there (login, setup, updating, portal — SHELL_PATH,
//    also background.js's) get nothing;
//  - every other page is one the desktop OPENED — /app/<id>, /apps/<id>/,
//    /chat, another local server such as the Hermes dashboard or a dev
//    server — and gets the bar every web page gets, laid out below it the same
//    way (content.css keys on the class that mount adds). In --kiosk a tab
//    without it has no Home and no Close: no way back to the desktop.

(() => {
  const DESKTOP_ORIGINS = [
    "http://localhost:3005/",
    "http://127.0.0.1:3005/",
    "http://localhost/",
    "http://127.0.0.1/",
  ];
  const SHELL_PATH = /^\/(?:(?:login|setup|updating|portal)(?:\/.*)?)?$/;
  const here = location.origin + "/";
  if (DESKTOP_ORIGINS.includes(here)) {
    if (location.pathname === "/") {
      clawboxKioskBar.mount({ desktop: true });
      return;
    }
    if (SHELL_PATH.test(location.pathname)) return;
  }
  if (clawboxKioskBar.mount({ startPage: false })) {
    clawboxKioskOffset.start(clawboxKioskBar.BAR_H);
  }
})();
