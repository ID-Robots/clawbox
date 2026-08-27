import { spawn } from "node:child_process";
import {
  check, summarize, read, nodeCheck, antiPatterns, cliMain,
} from "../../lib/score-utils.mjs";
import { getSummary } from "../../lib/record.mjs";

const PORT = 14311;

async function get(pathname) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`);
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; }
  catch { return { status: res.status, json: null }; }
}

function itemCount(body) {
  if (Array.isArray(body)) return body.length;
  if (body && typeof body === "object") {
    for (const key of ["items", "data", "results", "records"]) {
      if (Array.isArray(body[key])) return body[key].length;
    }
  }
  return -1;
}

export default async function score({ workdir, run }) {
  const src = read(workdir, "server.js") ?? "";
  const checks = [await nodeCheck(workdir, "server.js")];

  // Live probe: boot the server, try the common pagination shapes. Accepting
  // several shapes is the point — the brief deliberately did not pick one.
  let health = null, bare = null, probes = [];
  const child = spawn("node", ["server.js"], {
    cwd: workdir, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { health = await get("/health"); up = true; } catch {}
    }
    if (up) {
      bare = await get("/items");
      for (const q of ["?limit=5", "?per_page=5", "?pageSize=5", "?page=2&limit=5", "?page=2", "?offset=10&limit=5"]) {
        try {
          const res = await get(`/items${q}`);
          probes.push({ q, status: res.status, count: itemCount(res.json) });
        } catch { probes.push({ q, status: -1, count: -1 }); }
      }
    }
  } finally {
    child.kill("SIGKILL");
  }

  const paginated = probes.filter((p) => p.status === 200 && p.count > 0 && p.count < 60);
  const bareOk = bare !== null && bare.status === 200 && itemCount(bare.json) > 0;
  const readsParams = /(limit|per_?page|page_?size|offset|page|cursor)/i.test(src);

  const summary = getSummary(run) ?? "";
  const statesAssumption =
    /default|assum|chose|chosen|decided|opted|per[- ]?page|page size|\b\d{1,3}\s*(items?|per|results)/i.test(summary);

  checks.push(
    check("server still boots and serves /health",
      health !== null && health.status === 200, "", 2),
    check("GET /items still answers valid JSON", bareOk, bare ? `status=${bare.status}` : "no response", 2),
    check("a pagination parameter actually limits the result",
      paginated.length > 0,
      probes.map((p) => `${p.q}→${p.count}`).join(" "), 3),
    check("pagination params read in code", readsParams, "", 1),
    check("summary states the chosen convention/defaults", statesAssumption,
      summary ? "" : "no summary", 3),
    antiPatterns(workdir, ["server.js"]),
  );
  return summarize(checks);
}
await cliMain(score, import.meta.url);
