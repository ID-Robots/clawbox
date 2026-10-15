"use client";

import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "@/lib/i18n";
import type { VaultGraph } from "@/lib/prime-radiant/graph";
import type { GraphInsights } from "@/lib/prime-radiant/graph-communities";
import { isRelatedWeight, LINK_WEIGHT } from "@/lib/prime-radiant/graph-weights";
import { BTN_PRIMARY, BTN_QUIET, BTN_SECONDARY, CARD_SURFACE, FIELD } from "./coding-agent-ui";
import { API, errorText, pageUrl, prJson } from "./prime-radiant-ui";
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
 * Hover names a page, a click picks it out with its neighbours and says what
 * it is about (its summary, asked for only then), a double click (or Enter)
 * opens it in Browse. One row above the map: the search box (it lights up
 * matching pages and flies there), the colouring and the fit button. On the
 * map itself, folded away until asked for: the domain legend (a click hides
 * or shows a domain) and the Insights — orphans, hubs and bridges.
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
  /** Related hints (a shared topic or domain): drawn, never counted as links. */
  related: number;
  offsets: Int32Array;
  adj: Int32Array;
  /** The most connected pages, which keep a label. */
  hubs: number[];
}

interface Analysis {
  communities: Int32Array;
  insights: GraphInsights;
}

/**
 * Domain and community colours, biggest first: ClawBox orange and a soft grey
 * lead, with warm and clear accents between them — all readable on the dark
 * ground. Past twelve, golden-angle hues.
 */
const PALETTE = [
  "#f97316", // ClawBox orange
  "#38bdf8", // sky
  "#fbbf24", // amber
  "#a8a29e", // warm grey
  "#2dd4bf", // teal
  "#fb7185", // rose
  "#a3e635", // lime
  "#a78bfa", // violet
  "#fdba74", // light orange
  "#d4d4d8", // light grey
  "#f0abfc", // fuchsia
  "#94a3b8", // slate grey
];
/** Pages with no domain, and communities of one: a quieter grey than the palette's. */
const GREY: [number, number, number] = [100, 106, 118];
const HUB_LABELS = 20;
/** Search matches that get a label of their own (more would be a wall of text). */
const MATCH_LABELS = 12;
const LIST_LIMIT = 300;
const CHIPS = 6;

/** Colour k: the palette, then golden-angle hues. */
function rgb(k: number): [number, number, number] {
  if (k < PALETTE.length) {
    const h = PALETTE[k];
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  const hue = (20 + k * 137.508) % 360;
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
  let related = 0;
  valid.forEach(([a, b, w], e) => {
    ends[e * 2] = a;
    ends[e * 2 + 1] = b;
    weights[e] = w;
    if (w >= LINK_WEIGHT) links++;
    else if (isRelatedWeight(w)) related++;
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
    related,
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
  /** The page picked out when the Map was left (opening it in Browse and coming back keeps it). */
  selectedId: string | null;
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

/**
 * The card's page summaries (`GET pages/<path>?view=summary`), per revision
 * and page: a page picked again says it at once. Oldest out past the cap.
 */
const summaries = new Map<string, string | null>();
const SUMMARY_CACHE = 500;
const summaryKey = (revision: string | null, id: string) => `${revision ?? ""}\n${id}`;

function keepSummary(key: string, text: string | null): void {
  summaries.delete(key);
  summaries.set(key, text);
  if (summaries.size > SUMMARY_CACHE) summaries.delete(summaries.keys().next().value!);
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
  /** Hidden domains by name: a new revision may order the legend differently. */
  const [hiddenNames, setHiddenNames] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [resultsOpen, setResultsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => kept?.selectedId ?? null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [settled, setSettled] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  /** Bumped when a summary arrives (they are kept outside React, in `summaries`). */
  const [, setSummaryArrived] = useState(0);
  /** The summary that could not be read, so the card stops saying it is reading. */
  const [summaryFailed, setSummaryFailed] = useState<string | null>(null);
  const legendId = useId();
  const insightsId = useId();
  const legendToggleRef = useRef<HTMLButtonElement>(null);
  const insightsToggleRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<MapView | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const labelEls = useRef(new Map<number, HTMLSpanElement>());
  /** Labels in the order they claim space: the selected page, then hubs by degree. */
  const labelOrder = useRef<number[]>([]);
  const labelWidths = useRef(new Map<number, number>());
  const analysisRef = useRef<Analysis | null>(null);
  const selectedRef = useRef<string | null>(null);
  const matchCursor = useRef(-1);
  /** The latest opener, so a new callback from the app never rebuilds the view. */
  const openRef = useRef(onOpenPage);
  useEffect(() => {
    openRef.current = onOpenPage;
  }, [onOpenPage]);

  const model = data?.model ?? null;
  const analysis = data?.analysis ?? null;
  const selected = model && selectedId !== null ? (model.index.get(selectedId) ?? null) : null;
  /** The hidden domains as indexes into this model's legend. */
  const hidden = useMemo(() => {
    const out = new Set<number>();
    model?.domains.forEach((d, k) => {
      if (hiddenNames.has(d)) out.add(k);
    });
    return out;
  }, [model, hiddenNames]);

  useEffect(() => {
    analysisRef.current = analysis;
    selectedRef.current = selectedId;
  }, [analysis, selectedId]);

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

  // The picked page's summary: asked for once it is picked, never with the graph (thousands of pages).
  useEffect(() => {
    if (!model || selectedId === null || !model.index.has(selectedId)) return;
    const key = summaryKey(model.revision, selectedId);
    if (summaries.has(key)) return;
    const ctl = new AbortController();
    prJson<{ summary?: unknown }>(`${pageUrl(`${API}/pages`, selectedId)}?view=summary`, { signal: ctl.signal })
      .then((answer) => {
        const text = typeof answer?.summary === "string" && answer.summary.trim() !== "" ? answer.summary.trim() : null;
        keepSummary(key, text);
        if (!ctl.signal.aborted) setSummaryArrived((k) => k + 1);
      })
      .catch((err) => {
        if ((err as Error)?.name === "AbortError" || ctl.signal.aborted) return;
        setSummaryFailed(key);
      });
    return () => ctl.abort();
  }, [model, selectedId]);

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
        // A label shows only where it does not cover one placed before it.
        const out = [0, 0];
        const placed: number[] = [];
        for (const i of labelOrder.current) {
          const el = labelEls.current.get(i);
          if (!el) continue;
          const w = view?.project(i, out) ?? -1;
          let show = !(w < 0 || out[0] < 0 || out[1] < 0 || out[0] > canvas.clientWidth || out[1] > canvas.clientHeight);
          // Clear of its own dot, however near the camera flew.
          const lift = show && view ? Math.min(60, view.radius(i, w)) + 3 : 8;
          if (show) {
            let width = labelWidths.current.get(i);
            if (width === undefined) labelWidths.current.set(i, (width = el.offsetWidth));
            const x0 = out[0] - width / 2 - 2, x1 = out[0] + width / 2 + 2, y1 = out[1] - lift + 2, y0 = y1 - 16;
            for (let k = 0; k < placed.length && show; k += 4) {
              show = x1 < placed[k] || x0 > placed[k + 2] || y1 < placed[k + 1] || y0 > placed[k + 3];
            }
            if (show) placed.push(x0, y0, x1, y1);
          }
          el.style.opacity = show ? "1" : "0";
          if (show) el.style.transform = `translate(${Math.round(out[0])}px, ${Math.round(out[1] - lift)}px) translate(-50%, -100%)`;
        }
      },
      onCommunities(communities, insights) {
        setData((d) => (d && d.model === model && communities.length === model.n ? { ...d, analysis: { communities, insights } } : d));
      },
      onSettled: setSettled,
      onContextLost() {
        setMode("2d");
      },
      onLayoutFailed() {
        // Nothing can place the pages: the page list stands in, as when no canvas draws.
        setMode("none");
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
      // Left before the layout said anything: every page is still at the origin, and pages with no
      // edge between them, started there together, could never part. Keep the last good picture.
      if (view.hasPositions) {
        kept = {
          revision: model.revision,
          kind: mode,
          ids: model.ids,
          positions: view.positions().slice(),
          settled: view.settled,
          camera: view.camera(),
          analysis: analysisRef.current,
          selectedId: selectedRef.current,
        };
      }
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
    const weak: number[] = [];
    const lit: number[] = [];
    for (let e = 0; e < model.ends.length / 2; e++) {
      if (!keep(e)) continue;
      const a = model.ends[e * 2], b = model.ends[e * 2 + 1];
      // A related hint (a shared topic or domain, not a link) is drawn fainter.
      (isRelatedWeight(model.weights[e]) ? weak : visible).push(a, b);
      if (selected !== null && (a === selected || b === selected)) lit.push(a, b);
    }
    return { visible: Uint32Array.from(visible), lit: Uint32Array.from(lit), weak: Uint32Array.from(weak) };
  }, [model, hidden, selected]);

  // Hand the view what React decided. Declared after the view's own effect, so a new view gets all three.
  useEffect(() => {
    if (colours) viewRef.current?.setColors(colours);
  }, [colours, mode, model]);
  useEffect(() => {
    if (states) viewRef.current?.setStates(states);
  }, [states, mode, model]);
  useEffect(() => {
    if (edges) viewRef.current?.setEdges(edges.visible, edges.lit, edges.weak);
  }, [edges, mode, model]);
  useEffect(() => {
    matchCursor.current = -1;
    if (matches && matches.length > 0) viewRef.current?.flyTo(matches.slice(0, 500));
  }, [matches]);

  const labels = useMemo(() => {
    if (!model) return [];
    const first = [...(selected !== null ? [selected] : []), ...(matches ?? []).slice(0, MATCH_LABELS).filter((i) => i !== selected)];
    return [...first, ...model.hubs.filter((i) => !hidden.has(model.domainOf[i]) && !first.includes(i))];
  }, [model, hidden, selected, matches]);
  useEffect(() => {
    labelOrder.current = labels;
    labelWidths.current.clear();
    viewRef.current?.invalidate();
  }, [labels]);

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
  const card = selected;
  const cardKey = card !== null ? summaryKey(model.revision, model.ids[card]) : null;
  /** Undefined while it is being read; null when the page has none (or it could not be read). */
  const cardSummary = cardKey === null ? null : summaries.has(cardKey) ? summaries.get(cardKey)! : summaryFailed === cardKey ? null : undefined;
  const dot = (k: number) => css(model.domains[k] === "" ? GREY : rgb(k));
  const pill = "inline-flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-black/60 px-2.5 py-1 text-[11px] text-[var(--text-secondary)] backdrop-blur hover:bg-black/80 hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
  const overlay = "rounded-xl border border-white/[0.1] bg-[var(--win-ground,#0d1117)] shadow-xl";
  // Escape folds an overlay away and hands the focus back to the button that opened it.
  const onLegendKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setLegendOpen(false);
    legendToggleRef.current?.focus();
  };
  const onInsightsKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setInsightsOpen(false);
    insightsToggleRef.current?.focus();
  };

  return (
    <div className="h-full min-h-[420px] flex flex-col gap-2" data-testid="prime-radiant-map" data-mode={mode}>
      <div className="flex items-center gap-2" data-testid="prime-radiant-map-toolbar">
        <div className="relative flex-1 min-w-0">
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
            onBlur={() => setResultsOpen(false)}
            onKeyDown={onSearchKey}
            data-testid="prime-radiant-map-search"
          />
          {matches && resultsOpen && (
            <div
              // Opaque (the window's own ground): the map must not show through.
              // A press here keeps the field focused, so its blur does not close the list under the click.
              className={`absolute z-30 left-0 right-0 mt-1 p-1 ${overlay}`}
              onMouseDown={(e) => e.preventDefault()}
              data-testid="prime-radiant-map-results"
            >
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
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot(model.domainOf[i]) }} aria-hidden="true" />
                      <span className="truncate">{model.titles[i]}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)]">{domainLabel(model.domains[model.domainOf[i]])}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {matches.length > 8 && (
                <p className="px-2 pt-1 pb-0.5 text-[11px] text-[var(--text-muted)]" data-testid="prime-radiant-map-results-more">
                  {t("primeRadiant.map.more", { n: matches.length - 8 })}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="inline-flex shrink-0 rounded-lg border border-white/[0.08] p-0.5" role="group" aria-label={t("primeRadiant.map.colourBy")}>
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
        <button
          type="button"
          className={`${BTN_SECONDARY} shrink-0`}
          onClick={() => viewRef.current?.resetView()}
          title={t("primeRadiant.map.resetView")}
          aria-label={t("primeRadiant.map.resetView")}
          data-testid="prime-radiant-map-fit"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">fit_screen</span>
        </button>
      </div>

      <div className="relative flex-1 min-h-[300px] rounded-xl overflow-hidden border border-white/[0.06] bg-[radial-gradient(ellipse_at_center,rgba(122,162,247,0.07),transparent_70%)]">
        {mode !== "none" && (
          <canvas
            key={mode}
            ref={canvasRef}
            // The view sets the pointer itself (a hand over a page, a move cross while dragging):
            // never the grab hand, which cursor themes such as DMZ-White do not draw at all.
            className="absolute inset-0 w-full h-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-ring)] cursor-default"
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

        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]" data-testid="prime-radiant-map-status">
          <span className="rounded-full bg-black/40 px-2 py-0.5">
            {t("primeRadiant.map.summary", { pages: model.n, links: model.links })}
            {model.related > 0 && (
              <span className="pointer-events-auto" title={t("primeRadiant.map.relatedHint")} data-testid="prime-radiant-map-related">
                {" · "}
                {t("primeRadiant.map.related", { n: model.related })}
              </span>
            )}
          </span>
          {!settled && mode !== "none" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-black/40 px-2 py-0.5">
              <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 12 }} aria-hidden="true">progress_activity</span>
              {t("primeRadiant.map.arranging")}
            </span>
          )}
          {mode === "2d" && <span className="rounded-full bg-black/40 px-2 py-0.5">{t("primeRadiant.map.flat")}</span>}
        </div>
        {model.truncated && (
          <p className="pointer-events-none absolute left-2 top-8 text-[11px] text-amber-200">{t("primeRadiant.map.truncated", { n: model.n })}</p>
        )}
        {mode === "none" && (
          <p className="absolute inset-x-0 top-1/3 text-center text-xs text-[var(--text-muted)]">{t("primeRadiant.map.noCanvas")}</p>
        )}

        {card !== null && (
          <div
            className={`${CARD_SURFACE} absolute right-2 top-2 z-20 flex w-[17rem] max-w-[calc(100%-1rem)] max-h-[calc(100%-1rem)] flex-col gap-2 p-3 !bg-black/75 backdrop-blur`}
            data-testid="prime-radiant-map-selected"
          >
            <div className="flex shrink-0 items-start gap-2">
              <span className="mt-1 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: dot(model.domainOf[card]) }} aria-hidden="true" />
              <p className="text-sm font-medium text-[var(--text-primary)] break-words flex-1">{model.titles[card]}</p>
              <button type="button" className={`${BTN_QUIET} !px-1 !py-0.5`} onClick={() => setSelectedId(null)} aria-label={t("primeRadiant.map.close")} title={t("primeRadiant.map.close")}>
                <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">close</span>
              </button>
            </div>
            <p className="shrink-0 font-mono text-[10px] text-[var(--text-muted)] break-all">{model.ids[card]}</p>
            <p className="shrink-0 text-[11px] text-[var(--text-secondary)]">
              {domainLabel(model.domains[model.domainOf[card]])} · {t("primeRadiant.map.connections", { n: model.degree[card] })} · {t("primeRadiant.map.sources", { n: model.sources[card] })}
            </p>
            {cardSummary === undefined && (
              <p className="shrink-0 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]" role="status" data-testid="prime-radiant-map-summary-loading">
                <span className="material-symbols-rounded motion-safe:animate-spin" style={{ fontSize: 12 }} aria-hidden="true">progress_activity</span>
                {t("primeRadiant.map.summaryLoading")}
              </p>
            )}
            {typeof cardSummary === "string" && (
              <p className="min-h-0 max-h-40 overflow-y-auto pr-1 text-xs leading-relaxed text-[var(--text-secondary)]" data-testid="prime-radiant-map-summary">
                {cardSummary}
              </p>
            )}
            <button type="button" className={`${BTN_PRIMARY} w-full shrink-0`} onClick={() => onOpenPage(model.ids[card])} data-testid="prime-radiant-map-open">
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">open_in_new</span>
              {t("primeRadiant.map.open")}
            </button>
          </div>
        )}

        <div className="absolute left-2 bottom-2 z-10 flex max-w-[calc(100%-1rem)] flex-col items-start gap-1.5">
          {legendOpen && (
            <div
              id={legendId}
              className={`w-[18rem] max-w-full max-h-56 overflow-y-auto p-2 ${overlay}`}
              role="group"
              aria-label={t("primeRadiant.map.domains")}
              onKeyDown={onLegendKey}
              data-testid="prime-radiant-map-legend"
            >
              <div className="flex flex-wrap gap-1">
                {model.domains.map((d, k) => {
                  const off = hidden.has(k);
                  return (
                    <button
                      key={d || "-"}
                      type="button"
                      aria-pressed={!off}
                      title={t("primeRadiant.map.toggleDomain", { domain: domainLabel(d) })}
                      onClick={() =>
                        setHiddenNames((h) => {
                          const next = new Set(h);
                          if (off) next.delete(d);
                          else next.add(d);
                          return next;
                        })
                      }
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] cursor-pointer transition-opacity ${
                        off ? "border-white/[0.06] text-[var(--text-muted)] opacity-50" : "border-white/[0.1] text-[var(--text-secondary)] hover:bg-white/[0.06]"
                      }`}
                      data-testid="prime-radiant-map-domain"
                    >
                      <span className="w-2 h-2 rounded-full" style={{ background: dot(k), opacity: colourMode === "domain" ? 1 : 0.35 }} aria-hidden="true" />
                      {domainLabel(d)}
                      <span className="text-[var(--text-muted)]">{model.domainSize[k]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <button
            ref={legendToggleRef}
            type="button"
            className={pill}
            aria-expanded={legendOpen}
            aria-controls={legendId}
            onClick={() => setLegendOpen((o) => !o)}
            data-testid="prime-radiant-map-legend-toggle"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">palette</span>
            {t("primeRadiant.map.domains")}
            <span className="text-[var(--text-muted)]">{model.domains.length}</span>
            {hidden.size > 0 && <span className="text-amber-200/90">· {t("primeRadiant.map.hiddenDomains", { n: hidden.size })}</span>}
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">{legendOpen ? "expand_more" : "expand_less"}</span>
          </button>
        </div>

        <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 hidden @3xl:block whitespace-nowrap rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-[var(--text-muted)]">
          {t(mode === "webgl" ? "primeRadiant.map.hint" : "primeRadiant.map.hintFlat")}
        </p>

        <div className="absolute right-2 bottom-2 z-10 flex max-w-[calc(100%-1rem)] flex-col items-end gap-1.5">
          {insightsOpen && insights && (
            <section
              id={insightsId}
              className={`w-[20rem] max-w-full max-h-72 overflow-y-auto p-3 space-y-3 ${overlay}`}
              aria-label={t("primeRadiant.map.insights")}
              onKeyDown={onInsightsKey}
              data-testid="prime-radiant-map-insights"
            >
              {groups.map((g) => (
                <div key={g.key} data-testid={`prime-radiant-map-insight-${g.key}`}>
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {g.label} <span className="font-normal">{g.nodes.length}</span>
                  </h3>
                  <p className="text-[10px] text-[var(--text-muted)]">{g.hint}</p>
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
          )}
          <button
            ref={insightsToggleRef}
            type="button"
            className={pill}
            aria-expanded={insightsOpen && !!insights}
            aria-controls={insightsId}
            disabled={!insights}
            title={insights ? t("primeRadiant.map.insightsHint") : t("primeRadiant.map.arranging")}
            onClick={() => setInsightsOpen((o) => !o)}
            data-testid="prime-radiant-map-insights-toggle"
          >
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">insights</span>
            {t("primeRadiant.map.insights")}
          </button>
        </div>
      </div>

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
