// ClawBox Kiosk Tabs — content script for every web page the desktop opened.
//
// The bar lives in bar.js and the page's room for it in offset.js, which the
// manifest lists before this file so all three run in the same isolated
// world; newtab.html loads the same bar.js with a script tag (content scripts
// do not run on chrome-extension:// pages, and the start page lays itself out
// under the bar). All this file does is mount the bar and, once it is up,
// move the page's own fixed furniture out from under it.

if (clawboxKioskBar.mount({ startPage: false })) {
  clawboxKioskOffset.start(clawboxKioskBar.BAR_H);
}
