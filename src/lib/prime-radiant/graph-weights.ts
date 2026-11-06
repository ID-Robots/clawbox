/**
 * The weight of each kind of edge in the Map's graph, shared by the server
 * that builds it (graph.ts), the layout and Louvain in the worker, and the
 * page that draws it:
 *   - a link: a `[[wikilink]]` or Markdown link between two pages;
 *   - a shared source: both pages name the same source document;
 *   - a related hint: two pages without links that share a subject, an
 *     entity or a tag — or, failing that, a domain. A guess at structure,
 *     not a connection: drawn fainter and never counted as one.
 *
 * Pure: no DOM, no Node API.
 */
export const LINK_WEIGHT = 1;
export const SOURCE_WEIGHT = 0.5;
export const RELATED_WEIGHT = 0.25;

/** A related hint, as opposed to a link or a shared source. */
export function isRelatedWeight(w: number): boolean {
  return w < SOURCE_WEIGHT;
}
