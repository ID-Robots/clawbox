// ClawBox Kiosk Tabs — content script for every web page the desktop opened.
//
// The bar lives in bar.js, which the manifest lists before this file so both
// run in the same isolated world; newtab.html loads the same bar.js with a
// script tag (content scripts do not run on chrome-extension:// pages). All
// this file does is mount it.

clawboxKioskBar.mount({ startPage: false });
