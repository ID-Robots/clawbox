"use client";

import { useState, useEffect, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface OverviewStats {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  arch: string;
  platform: string;
}

interface CpuStats {
  usage: number;
  model: string;
  cores: number;
  loadAvg: string[];
  speed: number;
}

interface SwapStats {
  used: number;
  total: number;
  percent: number;
}

interface MemoryStats {
  total: number;
  used: number;
  free: number;
  usedPercent: number;
  swap: SwapStats;
}

interface DiskMount {
  filesystem: string;
  size: string;
  used: string;
  avail: string;
  usePercent: number;
  mountpoint: string;
}

interface NetworkInterface {
  name: string;
  ip: string;
  rx: number;
  tx: number;
}

interface ProcessEntry {
  pid: string;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

interface SystemStats {
  overview: OverviewStats;
  cpu: CpuStats;
  memory: MemoryStats;
  storage: DiskMount[];
  network: NetworkInterface[];
  processes: ProcessEntry[];
  timestamp: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-4 border border-white/5" style={{ backgroundColor: "#2a2a3e" }}>
      <div className="flex items-center gap-2 mb-3">
        <span style={{ color: "#06b6d4" }}>{icon}</span>
        <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: "#06b6d4" }}>
          {title}
        </h2>
      </div>
      {children}
    </div>
  );
}

function ProgressBar({
  value,
  max = 100,
  color = "#06b6d4",
  animated = false,
}: {
  value: number;
  max?: number;
  color?: string;
  animated?: boolean;
}) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const barColor =
    pct >= 90 ? "#ef4444" : pct >= 70 ? "#f97316" : pct >= 50 ? "#eab308" : color;

  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height: 6, backgroundColor: "#1e1e2e" }}>
      <div
        className={animated ? "transition-all duration-700 ease-out" : ""}
        style={{
          width: `${pct}%`,
          height: "100%",
          backgroundColor: barColor,
          borderRadius: "9999px",
          boxShadow: animated ? `0 0 6px ${barColor}80` : "none",
        }}
      />
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 text-xs py-1">
      <span style={{ color: "#a0a0b0" }} className="shrink-0">
        {label}
      </span>
      <span style={{ color: "#e0e0e0" }} className="text-right font-mono break-all">
        {value}
      </span>
    </div>
  );
}

// ─── Section: Overview ────────────────────────────────────────────────────────

function OverviewSection({ data }: { data: OverviewStats }) {
  return (
    <Card title="Overview" icon={<OverviewIcon />}>
      <StatRow label="Hostname" value={data.hostname} />
      <StatRow label="OS" value={data.os} />
      <StatRow label="Kernel" value={data.kernel} />
      <StatRow label="Architecture" value={data.arch} />
      <StatRow
        label="Uptime"
        value={
          <span style={{ color: "#06b6d4" }} className="font-semibold">
            {data.uptime}
          </span>
        }
      />
    </Card>
  );
}

// ─── Section: CPU ─────────────────────────────────────────────────────────────

function CpuSection({ data }: { data: CpuStats }) {
  return (
    <Card title="CPU" icon={<CpuIcon />}>
      <div className="mb-3">
        <div className="flex justify-between items-center mb-1">
          <span className="text-xs" style={{ color: "#a0a0b0" }}>
            Usage
          </span>
          <span
            className="text-lg font-bold font-mono"
            style={{ color: data.usage >= 90 ? "#ef4444" : data.usage >= 70 ? "#f97316" : "#06b6d4" }}
          >
            {data.usage}%
          </span>
        </div>
        <ProgressBar value={data.usage} animated />
      </div>
      <StatRow label="Model" value={<span className="text-[10px]">{data.model}</span>} />
      <StatRow label="Cores" value={data.cores} />
      <StatRow label="Speed" value={`${data.speed} MHz`} />
      <div className="mt-2 pt-2 border-t border-white/5">
        <p className="text-xs mb-1" style={{ color: "#a0a0b0" }}>
          Load Average
        </p>
        <div className="flex gap-3">
          {["1m", "5m", "15m"].map((label, i) => (
            <div key={label} className="flex-1 text-center">
              <div className="text-xs font-mono font-semibold" style={{ color: "#e0e0e0" }}>
                {data.loadAvg[i]}
              </div>
              <div className="text-[10px]" style={{ color: "#a0a0b0" }}>
                {label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ─── Section: Memory ─────────────────────────────────────────────────────────

function MemorySection({ data }: { data: MemoryStats }) {
  return (
    <Card title="Memory" icon={<MemoryIcon />}>
      <div className="mb-3">
        <div className="flex justify-between items-center mb-1">
          <span className="text-xs" style={{ color: "#a0a0b0" }}>
            RAM Usage
          </span>
          <span className="text-xs font-mono" style={{ color: "#e0e0e0" }}>
            {formatBytes(data.used)} / {formatBytes(data.total)}
          </span>
        </div>
        <ProgressBar value={data.usedPercent} animated />
        <div className="mt-1 text-right text-[10px]" style={{ color: "#a0a0b0" }}>
          {data.usedPercent}% used · {formatBytes(data.free)} free
        </div>
      </div>
      {data.swap.total > 0 && (
        <div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-xs" style={{ color: "#a0a0b0" }}>
              Swap
            </span>
            <span className="text-xs font-mono" style={{ color: "#e0e0e0" }}>
              {formatBytes(data.swap.used)} / {formatBytes(data.swap.total)}
            </span>
          </div>
          <ProgressBar value={data.swap.percent} color="#a855f7" animated />
          <div className="mt-1 text-right text-[10px]" style={{ color: "#a0a0b0" }}>
            {data.swap.percent}% used
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Section: Storage ────────────────────────────────────────────────────────

function StorageSection({ data }: { data: DiskMount[] }) {
  return (
    <Card title="Storage" icon={<StorageIcon />}>
      {data.length === 0 ? (
        <p className="text-xs" style={{ color: "#a0a0b0" }}>
          No mounts found
        </p>
      ) : (
        <div className="space-y-3">
          {data.map((mount) => (
            <div key={mount.mountpoint}>
              <div className="flex justify-between items-center mb-1">
                <span className="text-xs font-mono" style={{ color: "#e0e0e0" }}>
                  {mount.mountpoint}
                </span>
                <span className="text-[10px] font-mono" style={{ color: "#a0a0b0" }}>
                  {mount.used} / {mount.size}
                </span>
              </div>
              <ProgressBar value={mount.usePercent} animated />
              <div className="mt-0.5 flex justify-between text-[10px]" style={{ color: "#a0a0b0" }}>
                <span>{mount.filesystem}</span>
                <span>{mount.usePercent}% · {mount.avail} free</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── Section: Network ────────────────────────────────────────────────────────

function NetworkSection({ data }: { data: NetworkInterface[] }) {
  return (
    <Card title="Network" icon={<NetworkIcon />}>
      {data.length === 0 ? (
        <p className="text-xs" style={{ color: "#a0a0b0" }}>
          No interfaces found
        </p>
      ) : (
        <div className="space-y-3">
          {data.map((iface) => (
            <div key={iface.name} className="rounded-lg px-3 py-2 border border-white/5" style={{ backgroundColor: "#1e1e2e" }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold font-mono" style={{ color: "#06b6d4" }}>
                  {iface.name}
                </span>
                {iface.ip ? (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ backgroundColor: "#2a2a3e", color: "#e0e0e0" }}>
                    {iface.ip}
                  </span>
                ) : (
                  <span className="text-[10px]" style={{ color: "#a0a0b0" }}>
                    no IP
                  </span>
                )}
              </div>
              <div className="flex gap-4 text-[10px]" style={{ color: "#a0a0b0" }}>
                <span>
                  ↓ <span className="font-mono" style={{ color: "#22c55e" }}>{formatBytes(iface.rx)}</span>
                </span>
                <span>
                  ↑ <span className="font-mono" style={{ color: "#f97316" }}>{formatBytes(iface.tx)}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ─── Section: Processes ──────────────────────────────────────────────────────

type SortKey = "cpu" | "mem" | "pid";

function ProcessesSection({ data }: { data: ProcessEntry[] }) {
  const [sortBy, setSortBy] = useState<SortKey>("cpu");

  const sorted = [...data].sort((a, b) => (b[sortBy] as number) - (a[sortBy] as number));

  return (
    <Card title="Processes" icon={<ProcessIcon />}>
      <div className="flex gap-1 mb-2">
        {(["cpu", "mem", "pid"] as SortKey[]).map((key) => (
          <button
            key={key}
            onClick={() => setSortBy(key)}
            className="text-[10px] px-2 py-0.5 rounded transition-colors"
            style={{
              backgroundColor: sortBy === key ? "#06b6d4" : "#1e1e2e",
              color: sortBy === key ? "#000" : "#a0a0b0",
              fontWeight: sortBy === key ? 700 : 400,
            }}
          >
            {key.toUpperCase()}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr style={{ color: "#a0a0b0" }}>
              <th className="text-left pb-1 pr-2 font-medium">PID</th>
              <th className="text-left pb-1 pr-2 font-medium">USER</th>
              <th className="text-right pb-1 pr-2 font-medium">CPU%</th>
              <th className="text-right pb-1 pr-2 font-medium">MEM%</th>
              <th className="text-left pb-1 font-medium">COMMAND</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((proc, i) => (
              <tr
                key={`${proc.pid}-${i}`}
                className="border-t border-white/5"
                style={{ color: i === 0 ? "#e0e0e0" : "#b0b0c0" }}
              >
                <td className="py-0.5 pr-2 font-mono">{proc.pid}</td>
                <td className="py-0.5 pr-2 font-mono truncate max-w-[60px]">{proc.user}</td>
                <td
                  className="py-0.5 pr-2 text-right font-mono font-semibold"
                  style={{ color: proc.cpu > 50 ? "#ef4444" : proc.cpu > 20 ? "#f97316" : "#06b6d4" }}
                >
                  {proc.cpu.toFixed(1)}
                </td>
                <td className="py-0.5 pr-2 text-right font-mono" style={{ color: "#a855f7" }}>
                  {proc.mem.toFixed(1)}
                </td>
                <td className="py-0.5 font-mono truncate max-w-[140px]" title={proc.command}>
                  {proc.command}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function OverviewIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function CpuIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <line x1="6" y1="10" x2="6" y2="14" /><line x1="10" y1="10" x2="10" y2="14" />
      <line x1="14" y1="10" x2="14" y2="14" /><line x1="18" y1="10" x2="18" y2="14" />
    </svg>
  );
}

function StorageIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </svg>
  );
}

function NetworkIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
      <line x1="12" y1="12" x2="12" y2="8" />
    </svg>
  );
}

function ProcessIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function SystemApp() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/setup-api/system/stats", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SystemStats = await res.json();
      setStats(data);
      setError(null);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 3000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  return (
    <div
      className="h-full overflow-y-auto overflow-x-hidden"
      style={{ backgroundColor: "#1e1e2e", color: "#e0e0e0", fontFamily: "system-ui, sans-serif" }}
    >
      {/* Header */}
      <div
        className="sticky top-0 z-10 flex items-center justify-between px-4 py-2 border-b border-white/5"
        style={{ backgroundColor: "#1e1e2e" }}
      >
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: "#06b6d4" }} />
          <span className="text-sm font-semibold" style={{ color: "#e0e0e0" }}>
            System Monitor
          </span>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-[10px]" style={{ color: "#a0a0b0" }}>
              Updated {lastUpdated}
            </span>
          )}
          <button
            onClick={fetchStats}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title="Refresh now"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "#06b6d4" }}>
              <polyline points="23 4 23 10 17 10" />
              <polyline points="1 20 1 14 7 14" />
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="p-4">
        {loading && !stats && (
          <div className="flex flex-col items-center justify-center gap-3 py-20">
            <div
              className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin"
              style={{ borderColor: "#06b6d4", borderTopColor: "transparent" }}
            />
            <span className="text-sm" style={{ color: "#a0a0b0" }}>
              Loading system stats…
            </span>
          </div>
        )}

        {error && (
          <div
            className="flex items-center gap-2 p-3 rounded-lg mb-4 border"
            style={{ backgroundColor: "#2d1a1a", borderColor: "#ef444440", color: "#ef4444" }}
          >
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="text-xs">{error}</span>
          </div>
        )}

        {stats && (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            <OverviewSection data={stats.overview} />
            <CpuSection data={stats.cpu} />
            <MemorySection data={stats.memory} />
            <StorageSection data={stats.storage} />
            <NetworkSection data={stats.network} />
            <div style={{ gridColumn: "1 / -1" }}>
              <ProcessesSection data={stats.processes} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
