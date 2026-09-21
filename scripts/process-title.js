// The box's web server's process title, reclaimed from Next.
//
// Next names the process `next-server (v…)` as it starts — which is also what
// a coding run's `pkill -f next-server`, meant for the dev server the run
// started, matches. It matched on 2026-09-05 and took the box's web server
// down with the run. So the title is ours again as soon as Next has set it —
// the assignment happens inside Next's async start, hence the retries — and
// nothing looking for "next" or "node" by name finds this process (on Linux
// the title is the command line AND, through libuv, the kernel's short name).
// Plain CommonJS: production-server.js is, and the test runs it in a child.
"use strict";

const CLAWBOX_PROCESS_TITLE = "clawbox-web";
const RETRY_DELAYS_MS = [250, 1000, 3000, 10000];

function reclaimProcessTitle() {
  if (process.title !== CLAWBOX_PROCESS_TITLE) process.title = CLAWBOX_PROCESS_TITLE;
}

/** Reclaim now and again a few times, so a later assignment by Next does not stand. */
function guardProcessTitle(delays = RETRY_DELAYS_MS) {
  reclaimProcessTitle();
  for (const delay of delays) setTimeout(reclaimProcessTitle, delay).unref();
}

module.exports = { CLAWBOX_PROCESS_TITLE, RETRY_DELAYS_MS, reclaimProcessTitle, guardProcessTitle };
