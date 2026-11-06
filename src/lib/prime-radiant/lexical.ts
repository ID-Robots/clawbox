/**
 * Lexical neighbours: the pages a page shares its rarer words with. The
 * connect pass asks for them for the pages the search index holds no vector
 * for, and to find a link for a page nothing else reaches.
 *
 * TF-IDF over a page's own words (its title, claims and summary), compared by
 * cosine through an inverted index: only pages that share a word with the
 * asking page are ever scored, and only its {@link LEXICAL_QUERY_TERMS}
 * heaviest words ask. A word on too many pages ({@link maxDocumentFrequency})
 * ties nothing and is left out of the index, so one question costs at most
 * terms × that many postings, and the whole index is a few typed arrays — a
 * vault of 20k pages is a few MB, never an n² matrix.
 *
 * Words are Latin or Cyrillic letters (and digits inside a word), lowercased;
 * stopwords, bare numbers and words under {@link LEXICAL_MIN_WORD} letters are
 * dropped. Deterministic: pages are taken in path order and ties go by path.
 *
 * Pure.
 */

/** The fewest letters a word needs. */
export const LEXICAL_MIN_WORD = 3;
/** A word on more pages than this ties nothing (see {@link maxDocumentFrequency}). */
export const LEXICAL_MAX_DF = 400;
/** The heaviest words of a page that look for its neighbours. */
export const LEXICAL_QUERY_TERMS = 48;
/** A neighbour in the page's own domain ranks as if this much closer. */
export const SAME_DOMAIN_BOOST = 1.25;
/** Words read from one page, at most. */
const MAX_WORDS = 4_000;

const WORD_RE = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Nd}]+/gu;
const NUMBER_RE = /^\p{Nd}+$/u;

const STOPWORDS: ReadonlySet<string> = new Set(
  (
    // English
    "the and for with that this from are was were been being has have had not but its our their they them you your his her she him " +
    "who whom which what when where why how all any each can will would should could may might must into onto over under about after " +
    "before than then there here these those also only such more most other some one two per via out off own same very just both " +
    "between during while does did doing because upon etc yes nor too again further once whose within without across against along " +
    "among around behind below above since until unless though although whether either neither every many much few less least " +
    // Bulgarian
    "това този тази тези онзи онази онова които който която което как като кога къде защо какво какъв каква какви със към при във " +
    "без още много може трябва има няма бъде беше бяха сме сте съм той тя те ние вие нас вас тях него нея ако когато където защото " +
    "така тук там всички всеки всяка всяко само през над под около след преди между чрез също вече нито или но да не се са ще за от по на"
  ).split(/\s+/),
);

/** A text's words, in order, as the index reads them. */
export function lexicalTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize("NFKC").toLowerCase().matchAll(WORD_RE)) {
    const w = m[0];
    if (w.length < LEXICAL_MIN_WORD || NUMBER_RE.test(w) || STOPWORDS.has(w)) continue;
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/** The most pages a word may be on and still tie two of `pages` together. */
export function maxDocumentFrequency(pages: number): number {
  return Math.max(50, Math.min(LEXICAL_MAX_DF, Math.floor(pages * 0.1)));
}

export interface LexicalDoc {
  path: string;
  domain: string | null;
  /** Title, claims and summary: what the page is about, in its own words. */
  text: string;
}

export interface LexicalNeighbour {
  path: string;
  /** TF-IDF cosine, 0..1. */
  similarity: number;
}

export interface LexicalIndex {
  readonly size: number;
  /** Whether the page has a word another page shares, so it can have neighbours at all. */
  hasText(path: string): boolean;
  /**
   * The page's `k` nearest pages at `minSimilarity` or above, best first: by
   * similarity, lifted by {@link SAME_DOMAIN_BOOST} in its own domain, ties by
   * path. `skip` leaves a page out.
   */
  neighbours(path: string, k: number, minSimilarity: number, skip?: (other: string) => boolean): LexicalNeighbour[];
}

/** Build the index over `docs`. Linear in their words. */
export function buildLexicalIndex(docs: readonly LexicalDoc[]): LexicalIndex {
  const sorted = [...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const n = sorted.length;
  const at = new Map(sorted.map((d, i) => [d.path, i]));

  // Each page's distinct words with their counts, as term ids.
  const vocab = new Map<string, number>();
  const df: number[] = [];
  const docTerms: Int32Array[] = [];
  const docCounts: Uint16Array[] = [];
  for (const d of sorted) {
    const counts = new Map<number, number>();
    for (const w of lexicalTokens(d.text)) {
      let id = vocab.get(w);
      if (id === undefined) {
        id = df.length;
        vocab.set(w, id);
        df.push(0);
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const terms = new Int32Array(counts.size);
    const tfs = new Uint16Array(counts.size);
    let k = 0;
    for (const [id, c] of counts) {
      df[id]++;
      terms[k] = id;
      tfs[k++] = Math.min(c, 65_535);
    }
    docTerms.push(terms);
    docCounts.push(tfs);
  }
  vocab.clear();

  // A word on one page ties nothing; one on too many is noise (and the cost).
  const maxDf = maxDocumentFrequency(n);
  const idf = new Float64Array(df.length);
  for (let t = 0; t < df.length; t++) idf[t] = df[t] >= 2 && df[t] <= maxDf && df[t] < n ? Math.log(n / df[t]) : 0;

  // Per page: its kept words, heaviest first, unit length (CSR).
  const docStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    let kept = 0;
    for (const t of docTerms[i]) if (idf[t] > 0) kept++;
    docStart[i + 1] = docStart[i] + kept;
  }
  const docTerm = new Int32Array(docStart[n]);
  const docWeight = new Float32Array(docStart[n]);
  const postingCount = new Int32Array(df.length);
  for (let i = 0; i < n; i++) {
    const entries: Array<{ t: number; w: number }> = [];
    const terms = docTerms[i];
    let norm = 0;
    for (let k = 0; k < terms.length; k++) {
      const t = terms[k];
      if (idf[t] === 0) continue;
      const w = (1 + Math.log(docCounts[i][k])) * idf[t];
      entries.push({ t, w });
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    entries.sort((a, b) => b.w - a.w || a.t - b.t);
    entries.forEach((e, k) => {
      docTerm[docStart[i] + k] = e.t;
      docWeight[docStart[i] + k] = e.w / norm;
      postingCount[e.t]++;
    });
  }
  docTerms.length = 0;
  docCounts.length = 0;

  // Per word: the pages it is on, in page order (CSR).
  const termStart = new Int32Array(df.length + 1);
  for (let t = 0; t < df.length; t++) termStart[t + 1] = termStart[t] + postingCount[t];
  const postDoc = new Int32Array(termStart[df.length]);
  const postWeight = new Float32Array(termStart[df.length]);
  const fill = termStart.slice(0, df.length);
  for (let i = 0; i < n; i++) {
    for (let k = docStart[i]; k < docStart[i + 1]; k++) {
      const t = docTerm[k];
      postDoc[fill[t]] = i;
      postWeight[fill[t]++] = docWeight[k];
    }
  }

  const scores = new Float64Array(n);
  const marked = new Uint8Array(n);
  const touched: number[] = [];
  return {
    size: n,
    hasText(path) {
      const i = at.get(path);
      return i !== undefined && docStart[i + 1] > docStart[i];
    },
    neighbours(path, k, minSimilarity, skip) {
      const i = at.get(path);
      if (i === undefined || k <= 0) return [];
      const end = Math.min(docStart[i + 1], docStart[i] + LEXICAL_QUERY_TERMS);
      for (let q = docStart[i]; q < end; q++) {
        const t = docTerm[q];
        const qw = docWeight[q];
        for (let p = termStart[t]; p < termStart[t + 1]; p++) {
          const j = postDoc[p];
          if (!marked[j]) {
            marked[j] = 1;
            touched.push(j);
          }
          scores[j] += qw * postWeight[p];
        }
      }
      const found: Array<{ j: number; s: number; rank: number }> = [];
      const domain = sorted[i].domain;
      for (const j of touched) {
        const s = Math.min(1, scores[j]);
        scores[j] = 0;
        marked[j] = 0;
        if (j === i || s < minSimilarity || (skip && skip(sorted[j].path))) continue;
        found.push({ j, s, rank: s * (domain !== null && sorted[j].domain === domain ? SAME_DOMAIN_BOOST : 1) });
      }
      touched.length = 0;
      found.sort((a, b) => b.rank - a.rank || b.s - a.s || a.j - b.j);
      return found.slice(0, k).map(({ j, s }) => ({ path: sorted[j].path, similarity: s }));
    },
  };
}
