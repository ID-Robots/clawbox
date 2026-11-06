/**
 * The `summary` a page carries and who wrote it: the summaries pass
 * (node-summary.ts) keeps `summary_meta` beside the text it wrote — how, from
 * which neighbourhood, from which facts, and a digest of the text, so a
 * person's edit tells (their `summary` is theirs from then on).
 *
 * Kept apart from the pass so the page list and the page view read it without
 * pulling the pass in. Pure apart from hashing.
 */

import crypto from "crypto";

export const SUMMARIES_BY = "summaries";
/** The marker the summaries call's node list follows (its own: the writer's and the judge's are theirs). */
export const SUMMARY_ITEMS_MARKER = "NODES (JSON):";

/** What the page keeps beside its `summary`: who wrote it, from what, and a digest that tells a person's edit. */
export interface SummaryMeta {
  by: string;
  method: "model" | "facts";
  /** The neighbourhood hash it was written from. */
  hash: string;
  /** Digest of the `summary` text as written: a different text is a person's edit. */
  digest: string;
  at: string;
  /** Per sentence, what it traces to (claim ids, page paths, sources). */
  from: string[][];
  /** The model was asked for this neighbourhood and every sentence it wrote was rejected: not asked again until the neighbourhood changes. */
  tried?: boolean;
}

/** The summary of ours on a page (its text unchanged since we wrote it), or null. */
export function readSummaryMeta(fm: Record<string, unknown>): SummaryMeta | null {
  const raw = fm.summary_meta;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.by !== SUMMARIES_BY || (r.method !== "model" && r.method !== "facts") || typeof r.hash !== "string" || typeof r.digest !== "string") return null;
  const from = Array.isArray(r.from) ? r.from.map((x) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : [])) : [];
  return { by: SUMMARIES_BY, method: r.method, hash: r.hash, digest: r.digest, at: typeof r.at === "string" ? r.at : "", from, ...(r.tried === true ? { tried: true } : {}) };
}

export function summaryDigest(text: string): string {
  return crypto.createHash("sha256").update(text.trim()).digest("hex").slice(0, 12);
}

/** Whose the page's `summary` is: ours (unchanged since written), a person's, or none. */
export function summaryOwner(fm: Record<string, unknown>): "ours" | "person" | "none" {
  const text = typeof fm.summary === "string" ? fm.summary.trim() : "";
  const meta = readSummaryMeta(fm);
  if (text === "") return "none";
  return meta && meta.digest === summaryDigest(text) ? "ours" : "person";
}

/** The generated summary a page carries, for the page header: ours only, with how it was written. */
export function generatedSummary(fm: Record<string, unknown>): { text: string; method: "model" | "facts"; at: string } | null {
  if (summaryOwner(fm) !== "ours") return null;
  const meta = readSummaryMeta(fm)!;
  return { text: (fm.summary as string).trim(), method: meta.method, at: meta.at };
}

/** The node list of a summary prompt (the stub model answers from it), or null when `user` is no summary prompt. */
export function readSummaryItems(user: string): Array<{ i: number; title: string; facts: Array<{ id: string; text: string }> }> | null {
  const at = user.indexOf(`${SUMMARY_ITEMS_MARKER}\n`);
  if (at < 0) return null;
  try {
    const parsed = JSON.parse(user.slice(at + SUMMARY_ITEMS_MARKER.length + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
