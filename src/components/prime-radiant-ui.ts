/**
 * Prime Radiant's client half: the shapes its routes answer, one fetch helper
 * and the error wording every tab shares.
 *
 * Types only cross from the server modules through `import type`, which the
 * build erases, so nothing here pulls `fs`, `node:sqlite` or git into the
 * desktop bundle (the BatteryIndicator precedent).
 */
import type { CommitInfo } from "@/lib/prime-radiant/git";
import type { LintFinding, LintReport } from "@/lib/prime-radiant/lint";
import type { ReviewItem, ReviewStatus } from "@/lib/prime-radiant/review-store";
import type { IngestJob, DeadLetter, FileStatus } from "@/lib/prime-radiant/ingest-store";
import type { SkipCounts, SkipReason } from "@/lib/prime-radiant/ingest-exclude";
import type { IngestPreview } from "@/lib/prime-radiant/ingest-sources";
import type { PageListEntry } from "@/lib/prime-radiant/vault";
import type { PageDetail, PrimeRadiantStatus } from "@/lib/prime-radiant/service";
import type { PrimeRadiantSettings } from "@/lib/prime-radiant/settings";
import type { CostSummary, RunRecord } from "@/lib/prime-radiant/runs";
import type { DiffResult } from "@/lib/prime-radiant/history";

export type {
  CommitInfo,
  CostSummary,
  DeadLetter,
  DiffResult,
  FileStatus,
  IngestJob,
  IngestPreview,
  LintFinding,
  LintReport,
  PageDetail,
  PageListEntry,
  PrimeRadiantSettings,
  PrimeRadiantStatus,
  ReviewItem,
  ReviewStatus,
  RunRecord,
  SkipCounts,
  SkipReason,
};

/** The order skip reasons are listed in (every reason `SkipCounts` holds). */
export const SKIP_ORDER: readonly SkipReason[] = [
  "codeProject",
  "excludedFolder",
  "boilerplate",
  "temp",
  "machineText",
  "tooLarge",
  "unsupported",
];

/** A job's or a preview's skips worth showing, in {@link SKIP_ORDER}: the reasons with a count. */
export function skipEntries(skips: Partial<SkipCounts> | null | undefined): Array<[SkipReason, number]> {
  if (!skips) return [];
  return SKIP_ORDER.flatMap((r) => {
    const n = skips[r];
    return typeof n === "number" && n > 0 ? [[r, n] as [SkipReason, number]] : [];
  });
}

export const API = "/setup-api/prime-radiant";

/**
 * Fired on the page when this window made or changed the vault, so another
 * window on the same desktop (Memory Shard's source line) reads it again.
 */
export const PRIME_RADIANT_CHANGED_EVENT = "clawbox:prime-radiant-changed";

export function announceVaultChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PRIME_RADIANT_CHANGED_EVENT));
}

/** A product name, the same in every language (like ClawKeep). */
export const PRODUCT_NAME = "Prime Radiant";

/** The page types and statuses the schema allows — the Browse filters offer exactly these. */
export const PAGE_TYPES = ["entity", "concept", "howto", "reference", "decision", "metric", "synthesis", "source"] as const;

/** A route's refusal: its stable `code` beside the English sentence. */
export class PrimeRadiantError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "PrimeRadiantError";
  }
}

/** JSON from a Prime Radiant route, or a {@link PrimeRadiantError} carrying its code. */
export async function prJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new PrimeRadiantError("network", "network", 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch (err) {
    // Aborted while the body was still arriving: that is the caller's abort,
    // not an empty answer — read as `null` it would be handed on as data.
    if ((err as Error)?.name === "AbortError") throw err;
    if (init?.signal?.aborted) throw new DOMException("The request was aborted.", "AbortError");
    body = null;
  }
  if (!res.ok) {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const message = typeof b.error === "string" ? b.error : `HTTP ${res.status}`;
    const code = typeof b.code === "string" ? b.code : res.status === 404 ? "not_found" : null;
    throw new PrimeRadiantError(message, code, res.status, b);
  }
  return body as T;
}

export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

type T = (key: string, params?: Record<string, string | number>) => string;

/**
 * `folder_not_found` → `folderNotFound`, `secret-ref` → `secretRef`: a
 * translation key segment is alphanumeric (translations.test.ts), so a value
 * from the server is camel-cased before it becomes part of one.
 */
export function keyPart(value: string): string {
  return value.replace(/[_-]([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * The owner's language for a refusal: the catalogue's line for a code it
 * knows, else the route's own English sentence — never a raw key.
 */
export function errorText(err: unknown, t: T): string {
  if (err instanceof PrimeRadiantError) {
    if (err.code) {
      const key = `primeRadiant.error.${keyPart(err.code)}`;
      const worded = t(key);
      if (worded !== key) return worded;
    }
    if (err.message && err.message !== "network") return err.message;
    return t("primeRadiant.error.network");
  }
  return t("primeRadiant.error.network");
}

/** A short commit id for display. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "—";
}

/** A date for display in the owner's locale. */
export function formatWhen(iso: string | number | null | undefined, locale: string): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * "12.4K" — a token count, compact, in the owner's locale. Usage is shown in
 * tokens only: the app never puts a price on screen.
 */
export function formatTokens(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(Math.max(0, n));
}

export function formatCount(n: number, locale: string): string {
  return n.toLocaleString(locale);
}

/** The page path without its folder and `.md`, for a compact link label. */
export function pageLabel(path: string): string {
  const leaf = path.split("/").pop() ?? path;
  return leaf.replace(/\.md$/, "");
}

/** Per-segment encoding, so a page path keeps its slashes in the route. */
export function pageUrl(base: string, path: string): string {
  return `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Tabs the app has, in order: Map (the start page of a vault with pages),
 * Pages (`browse`: the list, its search and each page with its history),
 * Review (open questions and failed checks), Add (`ingest`) and Settings
 * (with the token usage). The ids are stable; only the words changed.
 */
export const TABS = ["map", "browse", "review", "ingest", "settings"] as const;
export type Tab = (typeof TABS)[number];

export const TAB_ICONS: Record<Tab, string> = {
  map: "hub",
  browse: "description",
  review: "inbox",
  ingest: "add_circle",
  settings: "tune",
};
