"use client";

/**
 * A project's MCP SERVERS on its page (src/lib/project-mcp-servers.ts): which
 * servers this project's coding runs start with beside the browser tools every
 * run has — the servers this box's harness is configured with (a project
 * tracker, say) and "ClawBox read-only tools".
 *
 * Every box is UNTICKED until the owner ticks it: a project nobody opened this
 * card for runs with exactly the tools it always had. Names only — a server's
 * credentials stay in the harness's own config and never reach this page.
 *
 * Folded to one line until opened, like the run notes above it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTr } from "@/lib/i18n-floor";
import { SECRET_SCOPE_RE } from "@/lib/project-secrets-shape";
import { INSET_SURFACE } from "./coding-agent-ui";

interface Option {
  id: string;
  kind: "clawbox" | "harness";
  harness?: "openclaw" | "hermes";
  transport?: "stdio" | "http" | "sse" | null;
  usable: boolean;
  reason?: string;
}

interface Answer {
  selected: string[];
  options: Option[];
  unreadable: string[];
}

export default function CodingProjectMcpServersCard({ project }: { project: string }) {
  const tr = useTr();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A read that started for another project must not paint over this one.
  const scope = useRef(0);

  const take = (data: Answer) => {
    setAnswer({
      selected: Array.isArray(data.selected) ? data.selected : [],
      options: Array.isArray(data.options) ? data.options : [],
      unreadable: Array.isArray(data.unreadable) ? data.unreadable : [],
    });
  };

  const load = useCallback(async () => {
    const mine = ++scope.current;
    try {
      const res = await fetch(`/setup-api/coding-agent/mcp-servers?project=${encodeURIComponent(project)}`, { cache: "no-store" });
      if (mine !== scope.current) return;
      if (!res.ok) {
        setError(tr("codingAgent.mcpServers.loadFailed", "Could not read this project's MCP servers."));
        return;
      }
      take(await res.json() as Answer);
      setError(null);
    } catch {
      if (mine === scope.current) setError(tr("codingAgent.mcpServers.loadFailed", "Could not read this project's MCP servers."));
    }
  }, [project, tr]);

  useEffect(() => {
    if (!SECRET_SCOPE_RE.test(project)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => { scope.current++; };
  }, [load, project]);

  const toggle = async (id: string, on: boolean) => {
    if (!answer) return;
    const next = on ? [...answer.selected, id] : answer.selected.filter((name) => name !== id);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/setup-api/coding-agent/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, servers: next }),
      });
      const data = await res.json().catch(() => null) as (Answer & { error?: unknown }) | null;
      if (!res.ok || !data) {
        setError(typeof data?.error === "string" && data.error ? data.error : tr("codingAgent.mcpServers.saveFailed", "The change could not be saved."));
        return;
      }
      take(data);
    } catch {
      setError(tr("codingAgent.mcpServers.saveFailed", "The change could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const ticked = answer?.selected.length ?? 0;
  const label = (option: Option) => option.kind === "clawbox" ? tr("codingAgent.mcpServers.clawboxReadOnly", "ClawBox read-only tools") : option.id;
  const detail = (option: Option): string => {
    if (option.kind === "clawbox") {
      return tr("codingAgent.mcpServers.clawboxReadOnlyHint", "This box's device status, logs, apps, projects and runs — tools that read and change nothing.");
    }
    const harness = option.harness === "hermes" ? "Hermes" : option.harness === "openclaw" ? "OpenClaw" : "";
    return [harness, option.transport ?? ""].filter(Boolean).join(" · ");
  };

  // A folder whose name is no project scope (a space, a dot) cannot have a
  // list of its own — the same rule its secrets live under.
  if (!SECRET_SCOPE_RE.test(project)) return null;

  return (
    <details className={`mt-2 ${INSET_SURFACE} px-3 py-1.5 text-[11px]`} data-testid="coding-project-mcp-servers">
      <summary className="cursor-pointer select-none flex items-center gap-2 text-[var(--text-muted)]">
        <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">hub</span>
        <span className="text-[var(--text-secondary)]">{tr("codingAgent.mcpServers.title", "MCP servers")}</span>
        <span data-testid="coding-project-mcp-servers-count">
          {answer === null
            ? (error ? <span className="text-red-300" role="alert">{error}</span> : "…")
            : ticked > 0
              ? tr("codingAgent.mcpServers.count", "{n} for this project's runs", { n: ticked })
              : tr("codingAgent.mcpServers.none", "browser tools only")}
        </span>
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-[var(--text-muted)] leading-relaxed">
          {tr(
            "codingAgent.mcpServers.help",
            "Servers this project's coding runs start with, beside the browser tools every run has. Nothing is ticked until you tick it. A server's credentials stay in the harness's own config: never in a run's prompt, log or evidence.",
          )}
        </p>
        {answer && answer.options.length === 0 && (
          <p className="text-[var(--text-muted)] italic" data-testid="coding-project-mcp-servers-empty">
            {tr("codingAgent.mcpServers.empty", "This box's harness has no other MCP server configured.")}
          </p>
        )}
        {answer && answer.options.length > 0 && (
          <ul className="space-y-1.5" data-testid="coding-project-mcp-servers-list">
            {answer.options.map((option) => {
              const checked = answer.selected.includes(option.id);
              const disabled = busy || (!option.usable && !checked);
              return (
                <li key={`${option.kind}-${option.id}`}>
                  <label className={`flex items-start gap-2 ${disabled ? "opacity-60" : "cursor-pointer"}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) => void toggle(option.id, e.target.checked)}
                      data-testid={`coding-project-mcp-server-${option.id}`}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className={option.kind === "clawbox" ? "text-[var(--text-primary)]" : "font-mono text-[var(--text-primary)]"}>{label(option)}</span>
                      {detail(option) && <span className="block text-[var(--text-muted)]">{detail(option)}</span>}
                      {!option.usable && option.reason && (
                        <span className="block text-amber-300">{tr("codingAgent.mcpServers.unusable", "A run cannot use it: {reason}", { reason: option.reason })}</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {answer && answer.unreadable.length > 0 && (
          <p className="text-amber-300" data-testid="coding-project-mcp-servers-unreadable">
            {tr("codingAgent.mcpServers.unreadable", "Could not read the {harness} config, so its servers are not listed.", { harness: answer.unreadable.map((h) => (h === "hermes" ? "Hermes" : "OpenClaw")).join(", ") })}
          </p>
        )}
        {error && answer && <p className="text-red-300" role="alert" data-testid="coding-project-mcp-servers-error">{error}</p>}
      </div>
    </details>
  );
}
