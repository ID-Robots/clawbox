"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "@/lib/i18n";
import type { VaultGraph } from "@/lib/prime-radiant/graph";
import type { GraphInsights } from "@/lib/prime-radiant/graph-communities";
import { BTN_PRIMARY, BTN_QUIET, BTN_SECONDARY, CARD_SURFACE, FIELD } from "./coding-agent-ui";
import { API, errorText, prJson } from "./prime-radiant-ui";
import { STATE_DIM, STATE_HIDDEN, STATE_MATCH, STATE_SELECTED } from "./prime-radiant-map/renderer-gl";
import { MapView, type CameraState, type MapKind } from "./prime-radiant-map/view";

/**
 * Map: the vault as a 3D knowledge graph — Prime Radiant's start page.
 *
 * Every page is a node (sized by how connected it is, coloured by domain or
 * by Louvain community) and every link or shared source an edge. The layout
 * runs in a Web Worker, the picture in WebGL2 (prime-radiant-map/); without
 * WebGL2, or for an owner who asked for less motion, it is a still 2D
 * canvas, and a screen reader gets the pages as a list.
 *
 * Hover names a page, a click picks it out with its neighbours, a double
 * click (or Enter) opens it in Browse. The search box lights up matching
 * pages and flies there; the Insights strip lists orphans, hubs and bridges.
 *
 * Loaded lazily by PrimeRadiantApp, so none of this weighs on the other tabs.
 */

interface Props {
  revision: number;
  onOpenPage: (path: string) => void;
  onIngest: () => void;
}

type Mode = MapKind | "none";

interface Model {
  revision: string | null;
  truncated: boolean;
  n: number;
  ids: string[];
  titles: string[];
  /** Title and path, lower-cased, for the search. */
  haystack: string[];
  index: Map<string, number>;
  /** Legend order: most pages first; "" is "no domain". */
  domains: string[];
  domainSize: number[];
  domainOf: Uint16Array;
  degree: Float32Array;
  sources: Uint16Array;
  sizes: Float32Array;
  ends: Uint32Array;
  weights: Float32Array;
  links: number;
  offsets: Int32Array;
  adj: Int32Array;
  /** The most connected pages, which keep a label. */
  hubs: number[];
}

interface Analysis {
  communities: Int32Array;
  insights: GraphInsights;
}

const PALETTE = ["#7aa2f7", "#f7768e", "#9ece6a", "#e0af68", "#bb9af7", "#7dcfff", "#ff9e64", "#73daca", "#f4b8e4", "#c0caf5", "#2ac3de", "#d4a373"];
const GREY: [number, number, number] = [128, 134, 146];
const HUB_LABELS = 20;
const LIST_LIMIT = 300;
const CHIPS = 6;

/** Colour k: the palette, then golden-angle hues. */
function rgb(k: number): [number, number, number] {
  if (k < PALETTE.length) {
    const h = PALETTE[k];
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  const hue = (k * 137.508) % 360;
  const f = (x: number) => {
    const a = 0.55 * Math.min(0.65, 1 - 0.65);
    const t = (x + hue / 30) % 12;
    return Math.round(255 * (0.65 - a * Math.max(-1, Math.min(t - 3, 9 - t, 1))));
  };
  return [f(0), f(8), f(4)];
}

const css = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** The route's JSON as typed arrays and lookups. O(nodes + edges). */
export function toModel(g: VaultGraph): Model {
  const n = g.nodes.length;
  const count = new Map<string, number>();
  for (const node of g.nodes) count.set(node.domain ?? "", (count.get(node.domain ?? "") ?? 0) + 1);
  const domains = [...count.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : count.get(b)! - count.get(a)! || a.localeCompare(b)));
  const domainIndex = new Map(domains.map((d, i) => [d, i]));
  const domainOf = new Uint16Array(n);
  const degree = new Float32Array(n);
  const sources = new Uint16Array(n);
  const sizes = new Float32Array(n);
  const index = new Map<string, number>();
  g.nodes.forEach((node, i) => {
    index.set(node.id, i);
    domainOf[i] = domainIndex.get(node.domain ?? "")!;
    degree[i] = node.degree;
    sources[i] = Math.min(65535, node.sources);
    sizes[i] = Math.min(16, 2.4 + 1.5 * Math.sqrt(node.degree));
  });
  const valid = g.edges.filter(([a, b]) => a >= 0 && b >= 0 && a < n && b < n && a !== b);
  const m = valid.length;
  const ends = new Uint32Array(m * 2);
  const weights = new Float32Array(m);
  const offsets = new Int32Array(n + 1);
  let links = 0;
  valid.forEach(([a, b, w], e) => {
    ends[e * 2] = a;
    ends[e * 2 + 1] = b;
    weights[e] = w;
    if (w >= 1) links++;
    offsets[a + 1]++;
    offsets[b + 1]++;
  });
  for (let i = 0; i < n; i++) offsets[i + 1] += offsets[i];
  const fill = offsets.slice(0, n);
  const adj = new Int32Array(m * 2);
  for (let e = 0; e < m; e++) {
    adj[fill[ends[e * 2]]++] = ends[e * 2 + 1];
    adj[fill[ends[e * 2 + 1]]++] = ends[e * 2];
  }
  const hubs = Array.from({ length: n }, (_, i) => i)
    .filter((i) => degree[i] > 0)
    .sort((a, b) => degree[b] - degree[a] || a - b)
    .slice(0, HUB_LABELS);
  return {
    revision: g.revision,
    truncated: g.truncated,
    n,
    ids: g.nodes.map((x) => x.id),
    titles: g.nodes.map((x) => x.title),
    haystack: g.nodes.map((x) => `${x.title}\n${x.id}`.toLowerCase()),
    index,
    domains,
    domainSize: domains.map((d) => count.get(d)!),
    domainOf,
    degree,
    sources,
    sizes,
    ends,
    weights,
    links,
    offsets,
    adj,
    hubs,
  };
}

/**
 * What the Map keeps between visits (one vault, so one entry): a reopened tab
 * on the same revision draws at once, where it was left, without laying out
 * again; a newer revision starts its known pages where they were.
 */
let kept: {
  revision: string | null;
  kind: MapKind;
  ids: string[];
  positions: Float32Array;
  settled: boolean;
  camera: CameraState;
  analysis: Analysis | null;
} | null = null;

function warmStart(model: Model, kind: MapKind) {
  if (!kept || kept.kind !== kind) return null;
  if (kept.revision === model.revision && kept.ids.length === model.n) {
    return { positions: kept.positions, known: new Uint8Array(model.n).fill(1), settled: kept.settled };
  }
  const positions = new Float32Array(model.n * 3);
  const known = new Uint8Array(model.n);
  kept.ids.forEach((id, j) => {
    const i = model.index.get(id);
    if (i === undefined || !kept) return;
    positions.set(kept.positions.subarray(j * 3, j * 3 + 3), i * 3);
    known[i] = 1;
  });
  return { positions, known, settled: false };
}

function prefersFlat(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

export default function PrimeRadiantMap({ revision, onOpenPage, onIngest }: Props) {
  const { t } = useT();
  const [data, setData] = useState<{ model: Model; analysis: Analysis | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [mode, setMode] = useState<Mode>(() => (prefersFlat() ? "2d" : "webgl"));
  const [colourMode, setColourMode] = useState<"domain" | "community">("domain");
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const [query, setQuery] = useState("");
  const [resultsOpen, setResultsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const labelEls = useRef(new Map<number, HTMLSpanElement>());
  const analysisRef = useRef<Analysis | null>(null);
  const matchCursor = useRef(-1);
  /** The latest opener, so a new callback from the app never rebuilds the view. */
  const openRef = useRef(onOpenPage);
  useEffect(() => {
    openRef.current = onOpenPage;
  }, [onOpenPage]);

  const model = data?.model ?? null;
  const analysis = data?.analysis ?? null;
  const selected = model && selectedId !== null ? (model.index.get(selectedId) ?? null) : null;

  useEffect(() => {
    analysisRef.current = analysis;
  }, [analysis]);

  // The graph: fetched again when the vault changed; the same revision keeps what is on screen.
  useEffect(() => {
    const ctl = new AbortController();
    prJson<VaultGraph>(`${API}/graph`, { signal: ctl.signal })
      .then((g) => {
        if (ctl.signal.aborted) return;
        setError(null);
        setData((old) => {
          if (old && old.model.revision !== null && old.model.revision === g.revision) return old;
          return { model: toModel(g), analysis: kept && kept.revision === g.revision ? kept.analysis : null };
        });
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError" || ctl.signal.aborted) return;
        setError(errorText(err, t));
      });
    return () => ctl.abort();
  }, [revision, reload, t]);

  // The view: one per graph and mode.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model || model.n === 0 || mode === "none") return;
    const view = MapView.create(canvas, mode, {
      onHover(i, x, y) {
        setHovered(i);
        const tip = tipRef.current;
        if (tip) tip.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y + 14)}px)`;
      },
      onSelect(i) {
        setSelectedId(i === null ? null : model.ids[i]);
      },
      onOpen(i) {
        openRef.current(model.ids[i]);
      },
      onFrame() {
        const out = [0, 0];
        for (const [i, el] of labelEls.current) {
          const w = view?.project(i, out) ?? -1;
          const off = w < 0 || out[0] < 0 || out[1] < 0 || out[0] > canvas.clientWidth || out[1] > canvas.clientHeight;
          el.style.opacity = off ? "0" : "1";
          if (!off) el.style.transform = `translate(${Math.round(out[0])}px, ${Math.round(out[1]) - 8}px) translate(-50%, -100%)`;
        }
      },
      onCommunities(communities, insights) {
        setData((d) => (d && d.model === model && communities.length === model.n ? { ...d, analysis: { communities, insights } } : d));
      },
      onSettled: setSettled,
      onContextLost() {
        setMode("2d");
      },
    });
    if (!view) {
      // This canvas cannot draw in this mode (known only once it is asked):
      // a fresh canvas draws flat, or the page list stands in.
      setMode(mode === "webgl" ? "2d" : "none");
      return;
    }
    viewRef.current = view;
    const warm = warmStart(model, mode);
    view.load({ n: model.n, ends: model.ends, weights: model.weights, groups: model.domainOf, degree: model.degree, sizes: model.sizes }, warm);
    if (kept && kept.revision === model.revision && kept.kind === mode) view.restoreCamera(kept.camera);
    return () => {
      kept = {
        revision: model.revision,
        kind: mode,
        ids: model.ids,
        positions: view.positions().slice(),
        settled: view.settled,
        camera: view.camera(),
        analysis: analysisRef.current,
      };
      view.dispose();
      viewRef.current = null;
    };
  }, [mode, model]);

  const colours = useMemo(() => {
    if (!model) return null;
    const out = new Uint8Array(model.n * 4);
    const comm = colourMode === "community" ? analysis?.communities : null;
    const size = new Int32Array(model.n);
    if (comm) for (let i = 0; i < model.n; i++) size[comm[i]]++;
    const domainRgb = model.domains.map((d, k) => (d === "" ? GREY : rgb(k)));
    for (let i = 0; i < model.n; i++) {
      const c = comm ? (size[comm[i]] > 1 ? rgb(comm[i]) : GREY) : domainRgb[model.domainOf[i]];
      out.set([c[0], c[1], c[2], 255], i * 4);
    }
    return out;
  }, [model, colourMode, analysis]);

  const needle = useDeferredValue(query.trim().toLowerCase());
  const matches = useMemo(() => {
    if (!model || needle === "") return null;
    const out: number[] = [];
    for (let i = 0; i < model.n; i++) {
      if (!hidden.has(model.domainOf[i]) && model.haystack[i].includes(needle)) out.push(i);
    }
    return out.sort((a, b) => model.degree[b] - model.degree[a] || a - b);
  }, [model, needle, hidden]);

  const states = useMemo(() => {
    if (!model) return null;
    const s = new Uint8Array(model.n);
    const focus = selected !== null || matches !== null;
    for (let i = 0; i < model.n; i++) s[i] = hidden.has(model.domainOf[i]) ? STATE_HIDDEN : focus ? STATE_DIM : 0;
    const light = (i: number, flag: number) => {
      if (!(s[i] & STATE_HIDDEN)) s[i] = flag;
    };
    if (selected !== null) {
      for (let k = model.offsets[selected]; k < model.offsets[selected + 1]; k++) light(model.adj[k], STATE_MATCH);
      light(selected, STATE_SELECTED);
    } else if (matches) {
      for (const i of matches) light(i, STATE_MATCH);
    }
    return s;
  }, [model, selected, matches, hidden]);

  const edges = useMemo(() => {
    if (!model) return null;
    const keep = (e: number) => !hidden.has(model.domainOf[model.ends[e * 2]]) && !hidden.has(model.domainOf[model.ends[e * 2 + 1]]);
    const visible: number[] = [];
    const lit: number[] = [];
    for (let e = 0; e < model.ends.length / 2; e++) {
      if (!keep(e)) continue;
      const a = model.ends[e * 2], b = model.ends[e * 2 + 1];
      visible.push(a, b);
      if (selected !== null && (a === selected || b === selected)) lit.push(a, b);
    }
    return { visible: Uint32Array.from(visible), lit: Uint32Array.from(lit) };
  }, [model, hidden, selected]);

  // Hand the view what React decided. Declared after the view's own effect, so a new view gets all three.
  useEffect(() => {
    if (colours) viewRef.current?.setColors(colours);
  }, [colours, mode, model]);
  useEffect(() => {
    if (states) viewRef.current?.setStates(states);
  }, [states, mode, model]);
  useEffect(() => {
    if (edges) viewRef.current?.setEdges(edges.visible, edges.lit);
  }, [edges, mode, model]);
  useEffect(() => {
    matchCursor.current = -1;
    if (matches && matches.length > 0) viewRef.current?.flyTo(matches.slice(0, 500));
  }, [matches]);

  const labels = useMemo(() => {
    if (!model) return [];
    const list = model.hubs.filter((i) => !hidden.has(model.domainOf[i]));
    if (selected !== null && !list.includes(selected)) list.push(selected);
    return list;
  }, [model, hidden, selected]);

  const listed = useMemo(() => {
    if (!model) return [];
    return Array.from({ length: model.n }, (_, i) => i)
      .sort((a, b) => model.degree[b] - model.degree[a] || model.titles[a].localeCompare(model.titles[b]))
      .slice(0, LIST_LIMIT);
  }, [model]);

  /** Pick a page out and bring it into view. */
  const focusNode = (i: number) => {
    if (!model) return;
    setResultsOpen(false);
    setSelectedId(model.ids[i]);
    viewRef.current?.flyTo([i]);
  };

  const domainLabel = (d: string) => (d === "" ? t("primeRadiant.map.noDomain") : d);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setQuery("");
      setResultsOpen(false);
      return;
    }
    if (e.key !== "Enter" || !matches || matches.length === 0) return;
    e.preventDefault();
    matchCursor.current = (matchCursor.current + 1) % matches.length;
    focusNode(matches[matchCursor.current]);
  };

  const onCanvasKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const view = viewRef.current;
    if (!view || !model) return;
    const step: Record<string, [number, number]> = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] };
    if (e.key === "Enter" && selected !== null) onOpenPage(model.ids[selected]);
    else if (e.key === "Escape") setSelectedId(null);
    else if (step[e.key]) view.orbit(...step[e.key]);
    else if (e.key === "+" || e.key === "=") view.zoomBy(0.85);
    else if (e.key === "-" || e.key === "_") view.zoomBy(1 / 0.85);
    else if (e.key === "0") view.resetView();
    else return;
    e.preventDefault();
  };

  if (error && !model) {
    return (
      <div className="max-w-md mx-auto py-10 text-center space-y-3" data-testid="prime-radiant-map-error">
        <p role="alert" className="text-xs text-red-300">{error}</p>
        <button type="button" className={BTN_PRIMARY} onClick={() => setReload((r) => r + 1)}>{t("primeRadiant.retry")}</button>
      </div>
    );
  }

  if (!model) {
    return (
      <div className="h-full flex items-center justify-center gap-2 py-10 text-sm text-[var(--text-muted)]" role="status" data-testid="prime-radiant-map-loading">
        <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 16 }} aria-hidden="true">progress_activity</span>
        {t("primeRadiant.map.loading")}
      </div>
    );
  }

  if (model.n === 0) {
    return (
      <div className={`${CARD_SURFACE} p-6 text-center space-y-3`} data-testid="prime-radiant-map-empty">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 36 }} aria-hidden="true">hub</span>
        <p className="text-sm text-[var(--text-primary)]">{t("primeRadiant.map.emptyTitle")}</p>
        <p className="text-xs text-[var(--text-muted)]">{t("primeRadiant.map.emptyBody")}</p>
        <button type="button" className={BTN_PRIMARY} onClick={onIngest}>{t("primeRadiant.browse.addDocuments")}</button>
      </div>
    );
  }

  const insights = analysis?.insights ?? null;
  const groups: Array<{ key: string; label: string; hint: string; nodes: number[] }> = insights
    ? [
        { key: "orphans", label: t("primeRadiant.map.orphans"), hint: t("primeRadiant.map.orphansHint"), nodes: insights.orphans },
        { key: "hubs", label: t("primeRadiant.map.hubs"), hint: t("primeRadiant.map.hubsHint"), nodes: insights.hubs },
        { key: "bridges", label: t("primeRadiant.map.bridges"), hint: t("primeRadiant.map.bridgesHint"), nodes: insights.bridges },
      ]
    : [];
  const card = selected !== null ? selected : null;

  return (
    <div className="h-full min-h-[420px] flex flex-col gap-2" data-testid="prime-radiant-map" data-mode={mode}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <span className="material-symbols-rounded absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" style={{ fontSize: 16 }} aria-hidden="true">search</span>
          <input
            type="search"
            className={`${FIELD} w-full pl-7 text-xs`}
            placeholder={t("primeRadiant.map.search")}
            aria-label={t("primeRadiant.map.search")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setResultsOpen(true);
            }}
            onFocus={() => setResultsOpen(true)}
            onKeyDown={onSearchKey}
            data-testid="prime-radiant-map-search"
          />
          {matches && resultsOpen && (
            <div className={`${CARD_SURFACE} absolute z-20 left-0 right-0 mt-1 p-1 bg-[var(--win-ground)] shadow-xl`} data-testid="prime-radiant-map-results">
              <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]" role="status" aria-live="polite" data-testid="prime-radiant-map-match-count">
                {matches.length > 0 ? t("primeRadiant.map.matches", { n: matches.length }) : t("primeRadiant.map.noMatches")}
              </p>
              <ul>
                {matches.slice(0, 8).map((i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="w-full flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-[var(--text-secondary)] hover:bg-white/[0.08] cursor-pointer"
                      onClick={() => focusNode(i)}
                      data-testid="prime-radiant-map-result"
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: css(model.domains[model.domainOf[i]] === "" ? GREY : rgb(model.domainOf[i])) }} aria-hidden="true" />
                      <span className="truncate">{model.titles[i]}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">{domainLabel(model.domains[model.domainOf[i]])}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="inline-flex rounded-lg border border-white/[0.08] p-0.5" role="group" aria-label={t("primeRadiant.map.colourBy")}>
          {(["domain", "community"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={colourMode === m}
              disabled={m === "community" && !analysis}
              onClick={() => setColourMode(m)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                colourMode === m ? "bg-white/[0.12] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              }`}
              data-testid={`prime-radiant-map-colour-${m}`}
            >
              {t(m === "domain" ? "primeRadiant.map.byDomain" : "primeRadiant.map.byCommunity")}
            </button>
          ))}
        </div>
        <button type="button" className={BTN_SECONDARY} onClick={() => viewRef.current?.resetView()} title={t("primeRadiant.map.resetView")} aria-label={t("primeRadiant.map.resetView")}>
          <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">fit_screen</span>
        </button>
      </div>

      <div className="flex flex-wrap gap-1 max-h-[3.25rem] overflow-y-auto" role="group" aria-label={t("primeRadiant.map.domains")} data-testid="prime-radiant-map-legend">
        {model.domains.map((d, k) => {
          const off = hidden.has(k);
          return (
            <button
              key={d || "-"}
              type="button"
              aria-pressed={!off}
              title={t("primeRadiant.map.toggleDomain", { domain: domainLabel(d) })}
              onClick={() =>
                setHidden((h) => {
                  const next = new Set(h);
                  if (off) next.delete(k);
                  else next.add(k);
                  return next;
                })
              }
              className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] cursor-pointer transition-opacity ${
                off ? "border-white/[0.06] text-[var(--text-muted)] opacity-50" : "border-white/[0.1] text-[var(--text-secondary)] hover:bg-white/[0.06]"
              }`}
              data-testid="prime-radiant-map-domain"
            >
              <span className="w-2 h-2 rounded-full" style={{ background: css(d === "" ? GREY : rgb(k)), opacity: colourMode === "domain" ? 1 : 0.35 }} aria-hidden="true" />
              {domainLabel(d)}
              <span className="text-[var(--text-muted)]">{model.domainSize[k]}</span>
            </button>
          );
        })}
      </div>

      <div className="relative flex-1 min-h-[240px] rounded-xl overflow-hidden border border-white/[0.06] bg-[radial-gradient(ellipse_at_center,rgba(122,162,247,0.07),transparent_70%)]">
        {mode !== "none" && (
          <canvas
            key={mode}
            ref={canvasRef}
            className="absolute inset-0 w-full h-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-ring)] cursor-grab active:cursor-grabbing"
            tabIndex={0}
            role="application"
            aria-label={t("primeRadiant.map.canvas", { n: model.n })}
            onKeyDown={onCanvasKey}
            data-testid="prime-radiant-map-canvas"
          />
        )}
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          {labels.map((i) => (
            <span
              key={i}
              ref={(el) => {
                if (el) labelEls.current.set(i, el);
                else labelEls.current.delete(i);
              }}
              className={`absolute left-0 top-0 max-w-[14rem] truncate whitespace-nowrap text-[11px] [text-shadow:0_1px_3px_rgba(0,0,0,0.9)] opacity-0 ${
                i === selected ? "font-semibold text-white" : "text-white/75"
              }`}
            >
              {model.titles[i]}
            </span>
          ))}
          <div ref={tipRef} className={`absolute left-0 top-0 ${hovered === null ? "hidden" : ""}`} data-testid="prime-radiant-map-tooltip">
            {hovered !== null && hovered < model.n && (
              <div className="rounded-lg border border-white/[0.1] bg-black/80 px-2.5 py-1.5 text-xs shadow-lg max-w-[16rem]">
                <p className="text-[var(--text-primary)] font-medium truncate">{model.titles[hovered]}</p>
                <p className="text-[11px] text-[var(--text-muted)]">{domainLabel(model.domains[model.domainOf[hovered]])}</p>
              </div>
            )}
          </div>
        </div>

        <div className="absolute left-2 top-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]" data-testid="prime-radiant-map-status">
          <span className="rounded-full bg-black/40 px-2 py-0.5">{t("primeRadiant.map.summary", { pages: model.n, links: model.links })}</span>
          {!settled && mode !== "none" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-black/40 px-2 py-0.5">
              <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 12 }} aria-hidden="true">progress_activity</span>
              {t("primeRadiant.map.arranging")}
            </span>
          )}
          {mode === "2d" && <span className="rounded-full bg-black/40 px-2 py-0.5">{t("primeRadiant.map.flat")}</span>}
        </div>
        {model.truncated && (
          <p className="absolute left-2 top-8 text-[11px] text-amber-200">{t("primeRadiant.map.truncated", { n: model.n })}</p>
        )}
        {mode === "none" && (
          <p className="absolute inset-x-0 top-1/3 text-center text-xs text-[var(--text-muted)]">{t("primeRadiant.map.noCanvas")}</p>
        )}

        {card !== null && (
          <div className={`${CARD_SURFACE} absolute right-2 top-2 w-[15rem] p-3 bg-black/70 backdrop-blur space-y-2`} data-testid="prime-radiant-map-selected">
            <div className="flex items-start gap-2">
              <span className="mt-1 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: css(model.domains[model.domainOf[card]] === "" ? GREY : rgb(model.domainOf[card])) }} aria-hidden="true" />
              <p className="text-sm font-medium text-[var(--text-primary)] break-words flex-1">{model.titles[card]}</p>
              <button type="button" className={`${BTN_QUIET} !px-1 !py-0.5`} onClick={() => setSelectedId(null)} aria-label={t("primeRadiant.map.close")} title={t("primeRadiant.map.close")}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">close</span>
              </button>
            </div>
            <p className="font-mono text-[10px] text-[var(--text-muted)] break-all">{model.ids[card]}</p>
            <p className="text-[11px] text-[var(--text-secondary)]">
              {domainLabel(model.domains[model.domainOf[card]])} · {t("primeRadiant.map.connections", { n: model.degree[card] })} · {t("primeRadiant.map.sources", { n: model.sources[card] })}
            </p>
            <button type="button" className={`${BTN_PRIMARY} w-full`} onClick={() => onOpenPage(model.ids[card])} data-testid="prime-radiant-map-open">
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
              {t("primeRadiant.map.open")}
            </button>
          </div>
        )}

        <p className="absolute right-2 bottom-2 hidden @md:block text-[10px] text-[var(--text-muted)]">
          {t(mode === "webgl" ? "primeRadiant.map.hint" : "primeRadiant.map.hintFlat")}
        </p>
      </div>

      <section className="flex gap-4 overflow-x-auto pb-1" aria-label={t("primeRadiant.map.insights")} data-testid="prime-radiant-map-insights">
        {groups.map((g) => (
          <div key={g.key} className="min-w-[12rem] flex-1" data-testid={`prime-radiant-map-insight-${g.key}`}>
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]" title={g.hint}>
              {g.label} <span className="font-normal">{g.nodes.length}</span>
            </h3>
            <div className="mt-1 flex flex-wrap gap-1">
              {g.nodes.length === 0 && <span className="text-[11px] text-[var(--text-muted)]">{t("primeRadiant.map.none")}</span>}
              {g.nodes.slice(0, CHIPS).map((i) => (
                <button
                  key={i}
                  type="button"
                  className="max-w-[11rem] truncate rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-white/[0.1] cursor-pointer"
                  onClick={() => focusNode(i)}
                  title={model.titles[i]}
                >
                  {model.titles[i]}
                </button>
              ))}
              {g.nodes.length > CHIPS && <span className="px-1 text-[11px] text-[var(--text-muted)]">{t("primeRadiant.map.more", { n: g.nodes.length - CHIPS })}</span>}
            </div>
          </div>
        ))}
      </section>

      <div className={mode === "none" ? "max-h-64 overflow-y-auto" : "sr-only"} data-testid="prime-radiant-map-list">
        <h3 className="text-xs text-[var(--text-muted)]">{t("primeRadiant.map.list")}</h3>
        <ul>
          {listed.map((i) => (
            <li key={i}>
              <button type="button" className="text-left text-xs text-[var(--coral-bright)] hover:underline cursor-pointer" onClick={() => onOpenPage(model.ids[i])}>
                {model.titles[i]} — {domainLabel(model.domains[model.domainOf[i]])}, {t("primeRadiant.map.connections", { n: model.degree[i] })}
              </button>
            </li>
          ))}
        </ul>
        {model.n > LIST_LIMIT && <p className="text-xs text-[var(--text-muted)]">{t("primeRadiant.map.listMore", { n: model.n - LIST_LIMIT })}</p>}
      </div>
    </div>
  );
}
