// What the box paid while the bench ran: the web server's and the gateway's
// CPU share, resident memory and disk writes over the whole bench, and what
// is left for everything else.
export const id = "resources";
export const title = "Box resources";
export const weight = 8;
export const order = 90;
export const needs = ["host"];

export async function run({ host, hostStart, log }) {
  const now = host.snapshot();
  const d = host.delta(hostStart, now);
  const web = d.web, gw = d.gateway;
  const webRssMb = web.rssKb != null ? web.rssKb / 1024 : null;
  const gwRssMb = gw.rssKb != null ? gw.rssKb / 1024 : null;
  const writeMbPerMin = (web.writeBytesPerSec ?? 0) * 60 / 1048576 + (gw.writeBytesPerSec ?? 0) * 60 / 1048576;
  const memAvailMb = d.system.memAvailableKb / 1024;
  const memTotalMb = now.system.memTotalKb / 1024;
  log(`web ${web.cpuPct ?? "?"}% CPU / ${webRssMb?.toFixed(0)} MB, gateway ${gw.cpuPct ?? "?"}% / ${gwRssMb?.toFixed(0)} MB, writes ${writeMbPerMin.toFixed(1)} MB/min, free ${memAvailMb.toFixed(0)} MB`);
  return {
    metrics: {
      web_cpu_pct: { value: web.cpuPct, unit: "%", dir: "lower", good: 3, bad: 40, label: "web server CPU over the bench (of one core)" },
      gateway_cpu_pct: { value: gw.cpuPct, unit: "%", dir: "lower", good: 5, bad: 60, label: "gateway CPU over the bench (of one core)" },
      web_rss_mb: { value: webRssMb, unit: "MB", dir: "lower", good: 250, bad: 1500, label: "web server resident memory at the end" },
      gateway_rss_mb: { value: gwRssMb, unit: "MB", dir: "lower", good: 600, bad: 3000, label: "gateway resident memory at the end" },
      disk_write_mb_min: { value: writeMbPerMin, unit: "MB/min", dir: "lower", good: 1, bad: 60, label: "bytes the two services wrote per minute" },
      mem_available_pct: { value: (memAvailMb / memTotalMb) * 100, unit: "%", dir: "higher", good: 50, bad: 8, label: "memory still available at the end" },
    },
    details: { delta: d, pids: { web: now.web?.pid, gateway: now.gateway?.pid }, restarted: { web: web.restarted, gateway: gw.restarted } },
  };
}
