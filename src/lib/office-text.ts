// The text of an office document a chat was handed. SERVER ONLY.
//
// Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and OpenDocument text
// (.odt) and spreadsheets (.ods) are all ZIP archives of XML. No model reads
// one by itself, and the box's small local model will not reach for a tool to
// unpack it, so the chat's staging route (src/app/setup-api/chat/attachments)
// takes the text out here once, as the file arrives, and leaves it beside the
// file (src/lib/office-documents.ts says where and how each runtime gets it).
//
//   - documents: the paragraphs in order, a table's rows as cells joined by
//     ` | `;
//   - presentations: each slide's text under `=== Slide N ===`;
//   - spreadsheets: each sheet as CSV under `=== Sheet: <name> ===` — the
//     values as the file stores them (a date is the spreadsheet's serial
//     number, a formula its last computed value).
//
// No dependency: a ZIP reader over node:zlib that reads only the parts it
// needs, bounded against a hostile archive — how many entries, how large any
// one part may inflate to, how much in all, and how far one part may outgrow
// its compressed size. XML is read with a small tokenizer: these are
// machine-written files and only their text and a handful of attributes
// matter, never their structure beyond that.
//
// Never throws: a file it cannot read is `{ ok: false, reason }`, which the
// staging route turns into a refusal the composer explains.

import zlib from "node:zlib";
import { extensionOf } from "@/lib/office-documents";

/** Most characters of text kept for one document; the rest is cut with a note. */
export const OFFICE_TEXT_MAX_CHARS = 1_000_000;

/** Bounds on the archive itself. */
const MAX_ENTRIES = 20_000;
/** Largest one XML part may inflate to. */
const MAX_PART_BYTES = 64 * 1024 * 1024;
/** Most bytes inflated for one document, all parts together. */
const MAX_TOTAL_INFLATED = 160 * 1024 * 1024;
/**
 * A LARGE part (past 8 MB) that inflates past this many times its compressed
 * size is a bomb, refused before it is inflated. XML this repetitive is rare
 * but real in a small file, so the check waits for a size worth refusing; the
 * caps above are what bound a part either way — inflate stops at them.
 */
const MAX_RATIO = 1000;
const RATIO_CHECK_FROM = 8 * 1024 * 1024;

/** One repeated spreadsheet cell or row is expanded at most this many times. */
const MAX_REPEAT = 1_000;
/** Columns kept per spreadsheet row. */
const MAX_COLUMNS = 1_024;
/**
 * Rows and cells read from one sheet. Past either the rest of the sheet is
 * left out and the text says it was cut: a sheet is materialised before it is
 * written out, so the text's own bound comes too late to keep a hostile one
 * (every row jumping a thousand blank rows ahead) from filling the heap.
 */
const MAX_SHEET_ROWS = 20_000;
const MAX_SHEET_CELLS = 400_000;
/**
 * Characters kept from one cell, and from one sheet in all. A cell repeated
 * a thousand times is a thousand copies, so the characters are counted as
 * they are laid out — the CSV is never built past the text's own bound.
 */
const MAX_CELL_CHARS = 32 * 1024;
const MAX_SHEET_CHARS = OFFICE_TEXT_MAX_CHARS;

export type OfficeTextResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: "encrypted" | "unreadable" | "too_large" };

class Unreadable extends Error {
  constructor(readonly reason: "encrypted" | "unreadable" | "too_large") {
    super(reason);
  }
}

// ─── ZIP ─────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
/** The OLE compound-file header: a password-protected OOXML file is one of these, and so is a legacy .doc/.xls. */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

class ZipReader {
  private readonly entries = new Map<string, ZipEntry>();
  private inflated = 0;

  constructor(private readonly buf: Buffer) {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(CFB_MAGIC)) throw new Unreadable("encrypted");
    const eocd = this.findEocd();
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    // ZIP64 markers: no office file a chat takes (25 MB at most) needs them.
    if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Unreadable("unreadable");
    if (count > MAX_ENTRIES) throw new Unreadable("too_large");
    if (cdOffset + cdSize > buf.length) throw new Unreadable("unreadable");
    let at = cdOffset;
    for (let i = 0; i < count; i++) {
      if (at + 46 > buf.length || buf.readUInt32LE(at) !== CEN_SIG) throw new Unreadable("unreadable");
      const flags = buf.readUInt16LE(at + 8);
      const method = buf.readUInt16LE(at + 10);
      const compressedSize = buf.readUInt32LE(at + 20);
      const size = buf.readUInt32LE(at + 24);
      const nameLen = buf.readUInt16LE(at + 28);
      const extraLen = buf.readUInt16LE(at + 30);
      const commentLen = buf.readUInt16LE(at + 32);
      const localOffset = buf.readUInt32LE(at + 42);
      if (at + 46 + nameLen > buf.length) throw new Unreadable("unreadable");
      const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
      if (!this.entries.has(name)) this.entries.set(name, { name, method, flags, compressedSize, size, localOffset });
      at += 46 + nameLen + extraLen + commentLen;
    }
  }

  private findEocd(): number {
    const { buf } = this;
    const last = buf.length - 22;
    const first = Math.max(0, last - 0xffff);
    for (let i = last; i >= first; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    throw new Unreadable("unreadable");
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** One part's bytes, inflated under the bounds above; null when the archive has no such part. */
  read(name: string): Buffer | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const { buf } = this;
    if (entry.flags & 0x1) throw new Unreadable("encrypted");
    const off = entry.localOffset;
    if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOC_SIG) throw new Unreadable("unreadable");
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const end = start + entry.compressedSize;
    if (end > buf.length) throw new Unreadable("unreadable");
    const data = buf.subarray(start, end);
    if (entry.size > MAX_PART_BYTES) throw new Unreadable("too_large");
    if (entry.size > RATIO_CHECK_FROM && entry.size > entry.compressedSize * MAX_RATIO) throw new Unreadable("too_large");
    const room = Math.min(MAX_PART_BYTES, MAX_TOTAL_INFLATED - this.inflated);
    if (room <= 0) throw new Unreadable("too_large");
    let out: Buffer;
    if (entry.method === 0) {
      out = Buffer.from(data);
    } else if (entry.method === 8) {
      try {
        // The declared size is the writer's word, not a bound: the cap is ours.
        out = zlib.inflateRawSync(data, { maxOutputLength: room });
      } catch (err) {
        throw new Unreadable(err instanceof RangeError || (err as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE" ? "too_large" : "unreadable");
      }
    } else {
      throw new Unreadable("unreadable");
    }
    if (out.length > room) throw new Unreadable("too_large");
    this.inflated += out.length;
    return out;
  }

  text(name: string): string | null {
    const bytes = this.read(name);
    return bytes === null ? null : bytes.toString("utf8");
  }
}

// ─── XML ─────────────────────────────────────────────────────────────────────

type Token =
  | { kind: "open" | "close" | "self"; name: string; attrs: string }
  | { kind: "text"; text: string };


function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (whole, ent: string) => {
    switch (ent) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return "\"";
      case "apos": return "'";
      default: {
        const code = ent[1] === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

/**
 * The XML's tags and text, in order. A hand-written scanner rather than a
 * regex: every step moves forward by `indexOf`, so the walk is linear in the
 * part's size whatever the part holds — a backtracking pattern over a part a
 * stranger wrote can be made to spin the web server's one thread. A tag that
 * never closes ends the walk. A `>` inside an attribute value ends its tag
 * early; office writers escape it, and the worst it does is lose that tag.
 */
function* tokens(xml: string): Generator<Token> {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      yield { kind: "text", text: decodeEntities(xml.slice(i)) };
      return;
    }
    if (lt > i) yield { kind: "text", text: decodeEntities(xml.slice(i, lt)) };
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return;
      yield { kind: "text", text: xml.slice(lt + 9, end) };
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) return;
      i = end + 2;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) return;
    i = gt + 1;
    if (xml.charCodeAt(lt + 1) === 33 /* ! — a DOCTYPE or another declaration */) continue;
    let inner = xml.slice(lt + 1, gt);
    let kind: "open" | "close" | "self" = "open";
    if (inner.startsWith("/")) {
      kind = "close";
      inner = inner.slice(1);
    } else if (inner.endsWith("/")) {
      kind = "self";
      inner = inner.slice(0, -1);
    }
    const space = inner.search(/\s/);
    const name = space < 0 ? inner : inner.slice(0, space);
    if (!name) continue;
    yield { kind, name, attrs: space < 0 ? "" : inner.slice(space) };
  }
}

function attr(attrs: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? "") : null;
}

/** Text with a ceiling: past it, nothing more is kept and `truncated` says so. */
class Sink {
  private parts: string[] = [];
  private length = 0;
  truncated = false;
  /** A sheet past its row or cell bound was cut, though the text itself had room. */
  partial = false;

  push(s: string): void {
    if (this.truncated || !s) return;
    const room = OFFICE_TEXT_MAX_CHARS - this.length;
    if (s.length > room) {
      this.parts.push(s.slice(0, Math.max(0, room)));
      this.length = OFFICE_TEXT_MAX_CHARS;
      this.truncated = true;
      return;
    }
    this.parts.push(s);
    this.length += s.length;
  }

  get full(): boolean {
    return this.truncated;
  }

  toString(): string {
    return this.parts.join("");
  }
}

/** Collapse the blank lines a document's empty paragraphs leave into one. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** One CSV field: quoted when it holds a comma, a quote or a line break. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function csvRow(cells: readonly string[]): string {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === "") end--;
  return cells.slice(0, end).map(csvField).join(",");
}

/** A sheet's rows as CSV, trailing empty rows dropped. */
function csvSheet(rows: readonly string[][]): string {
  const lines = rows.map(csvRow);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Resolve a relationship target against the folder of the part that names it. */
function resolveTarget(baseDir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${baseDir}/${target}`).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
}

/** `Id` → resolved part name, out of a `.rels` part. */
function relationships(zip: ZipReader, relsPart: string, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const xml = zip.text(relsPart);
  if (xml === null) return map;
  for (const tok of tokens(xml)) {
    if ((tok.kind === "self" || tok.kind === "open") && tok.name.endsWith("Relationship")) {
      const id = attr(tok.attrs, "Id");
      const target = attr(tok.attrs, "Target");
      const mode = attr(tok.attrs, "TargetMode");
      if (id && target && mode !== "External") map.set(id, resolveTarget(baseDir, target));
    }
  }
  return map;
}

// ─── Word ────────────────────────────────────────────────────────────────────

/**
 * A WordprocessingML or OpenDocument text body: paragraphs in order, a
 * table's rows as cells joined by ` | `. `names` says which tags are which in
 * the dialect at hand.
 */
function flowText(
  xml: string,
  sink: Sink,
  names: {
    paragraph: ReadonlySet<string>;
    text: ReadonlySet<string> | null; // null: every text token inside a paragraph counts (ODF)
    tab: ReadonlySet<string>;
    lineBreak: ReadonlySet<string>;
    space?: string; // ODF's <text:s text:c="n"/>
    table: string;
    row: string;
    cell: string;
    skip: ReadonlySet<string>;
  },
): void {
  let tableDepth = 0;
  let row: string[] | null = null;
  let cell: string | null = null;
  let para = "";
  let inText = 0;
  let inPara = 0;
  let skipping = 0;
  const append = (s: string) => {
    if (tableDepth > 0 && cell !== null) cell += s;
    else para += s;
  };
  for (const tok of tokens(xml)) {
    if (sink.full) return;
    if (tok.kind === "text") {
      if (skipping > 0) continue;
      if (names.text ? inText > 0 : inPara > 0) append(tok.text);
      continue;
    }
    const { name } = tok;
    if (names.skip.has(name)) {
      if (tok.kind === "open") skipping++;
      else if (tok.kind === "close") skipping = Math.max(0, skipping - 1);
      continue;
    }
    if (skipping > 0) continue;
    if (tok.kind === "self") {
      if (names.tab.has(name)) append("\t");
      else if (names.lineBreak.has(name)) append(tableDepth > 0 ? " " : "\n");
      else if (names.space && name === names.space) append(" ".repeat(Math.min(64, Number(attr(tok.attrs, "text:c") ?? "1") || 1)));
      else if (names.paragraph.has(name) && tableDepth === 0) sink.push("\n");
      continue;
    }
    if (name === names.table) {
      if (tok.kind === "open") tableDepth++;
      else tableDepth = Math.max(0, tableDepth - 1);
      if (tableDepth === 0) {
        row = null;
        cell = null;
      }
      continue;
    }
    if (tableDepth === 1 && name === names.row) {
      if (tok.kind === "open") row = [];
      else if (row) {
        sink.push(row.join(" | ") + "\n");
        row = null;
      }
      continue;
    }
    if (tableDepth === 1 && name === names.cell) {
      if (tok.kind === "open") cell = "";
      else if (cell !== null) {
        row?.push(cell.replace(/\s*\n\s*/g, " ").trim());
        cell = null;
      }
      continue;
    }
    if (names.text?.has(name)) {
      inText += tok.kind === "open" ? 1 : -1;
      if (inText < 0) inText = 0;
      continue;
    }
    if (names.paragraph.has(name)) {
      if (tok.kind === "open") {
        inPara++;
        continue;
      }
      inPara = Math.max(0, inPara - 1);
      if (tableDepth > 0 && cell !== null) cell += "\n";
      else if (tableDepth === 0) {
        sink.push(para + "\n");
        para = "";
      }
      continue;
    }
    if (names.tab.has(name) && tok.kind === "open") append("\t");
  }
  if (para) sink.push(para);
}

function docxText(zip: ZipReader, sink: Sink): void {
  const xml = zip.text("word/document.xml");
  if (xml === null) throw new Unreadable("unreadable");
  flowText(xml, sink, {
    paragraph: new Set(["w:p"]),
    text: new Set(["w:t"]),
    tab: new Set(["w:tab"]),
    lineBreak: new Set(["w:br", "w:cr"]),
    table: "w:tbl",
    row: "w:tr",
    cell: "w:tc",
    // Deleted tracked changes and field instructions are not the document's
    // text; paragraph and run properties hold tab STOPS (`<w:tab w:pos=…/>`),
    // not tabs; a fallback picture repeats a text box's text.
    skip: new Set(["w:del", "w:instrText", "w:delText", "w:pPr", "w:rPr", "mc:Fallback"]),
  });
}

function odtText(zip: ZipReader, sink: Sink): void {
  const xml = zip.text("content.xml");
  if (xml === null) throw new Unreadable("unreadable");
  flowText(xml, sink, {
    paragraph: new Set(["text:p", "text:h"]),
    text: null,
    tab: new Set(["text:tab"]),
    lineBreak: new Set(["text:line-break"]),
    space: "text:s",
    table: "table:table",
    row: "table:table-row",
    cell: "table:table-cell",
    skip: new Set(["office:annotation", "text:tracked-changes", "text:note-citation"]),
  });
}

// ─── PowerPoint ──────────────────────────────────────────────────────────────

function slideOrder(zip: ZipReader): string[] {
  const rels = relationships(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  const presentation = zip.text("ppt/presentation.xml");
  const ordered = new Set<string>();
  if (presentation !== null) {
    for (const tok of tokens(presentation)) {
      if ((tok.kind === "self" || tok.kind === "open") && tok.name === "p:sldId") {
        const target = rels.get(attr(tok.attrs, "r:id") ?? "");
        if (target && zip.has(target)) ordered.add(target);
      }
    }
  }
  if (ordered.size > 0) return [...ordered];
  // No usable order: the slides by their number.
  return zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
}

function pptxText(zip: ZipReader, sink: Sink): void {
  const slides = slideOrder(zip);
  if (slides.length === 0 && !zip.has("ppt/presentation.xml")) throw new Unreadable("unreadable");
  slides.forEach((part, i) => {
    if (sink.full) return;
    const xml = zip.text(part);
    if (xml === null) return;
    const slide = new Sink();
    flowText(xml, slide, {
      paragraph: new Set(["a:p"]),
      text: new Set(["a:t"]),
      tab: new Set(),
      lineBreak: new Set(["a:br"]),
      table: "a:tbl",
      row: "a:tr",
      cell: "a:tc",
      // Paragraph properties hold tab stops, not text; a fallback repeats its choice.
      skip: new Set(["a:pPr", "mc:Fallback"]),
    });
    sink.push(`=== Slide ${i + 1} ===\n${tidy(slide.toString())}\n\n`);
  });
}

// ─── Excel ───────────────────────────────────────────────────────────────────

/** `B7` → 1 (zero-based column), or null when the reference names none. */
function columnOf(ref: string | null): number | null {
  const m = ref ? /^([A-Z]{1,3})\d*$/i.exec(ref) : null;
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function rowOf(ref: string | null): number | null {
  const m = ref ? /(\d+)$/.exec(ref) : null;
  return m ? Number(m[1]) : null;
}

function sharedStrings(zip: ZipReader): string[] {
  const xml = zip.text("xl/sharedStrings.xml");
  if (xml === null) return [];
  const out: string[] = [];
  let current: string | null = null;
  let inT = 0;
  let phonetic = 0;
  for (const tok of tokens(xml)) {
    if (tok.kind === "text") {
      if (current !== null && inT > 0 && phonetic === 0) current += tok.text;
      continue;
    }
    if (tok.name === "si") {
      if (tok.kind === "open") current = "";
      else if (tok.kind === "close" && current !== null) {
        out.push(current);
        current = null;
      } else if (tok.kind === "self") out.push("");
    } else if (tok.name === "t" && tok.kind !== "self") {
      inT += tok.kind === "open" ? 1 : -1;
    } else if (tok.name === "rPh" && tok.kind !== "self") {
      phonetic += tok.kind === "open" ? 1 : -1;
    }
  }
  return out;
}

function xlsxSheet(xml: string, shared: readonly string[]): { rows: string[][]; cut: boolean } {
  const rows: string[][] = [];
  let cells = 0;
  let chars = 0;
  let cut = false;
  let row: string[] | null = null;
  let rowIndex = 0;
  let col = 0;
  let cellType: string | null = null;
  let cellCol = 0;
  let value = "";
  let inValue = 0;
  let inInline = 0;
  let inCell = false;
  for (const tok of tokens(xml)) {
    if (rows.length >= MAX_SHEET_ROWS || cells >= MAX_SHEET_CELLS || chars >= MAX_SHEET_CHARS) {
      // What was read is kept, the row being read included.
      if (row && row.length > 0) rows.push(row);
      return { rows, cut: true };
    }
    if (tok.kind === "text") {
      if (inCell && (inValue > 0 || inInline > 0)) value += tok.text;
      continue;
    }
    switch (tok.name) {
      case "row": {
        if (tok.kind === "close") {
          if (row) rows.push(row);
          row = null;
          break;
        }
        const r = rowOf(attr(tok.attrs, "r"));
        const next = r !== null ? r : rowIndex + 1;
        // Rows the file leaves out are blank in the sheet: kept as blank lines, a bounded run of them.
        for (let gap = rowIndex + 1; gap < next && gap - rowIndex <= MAX_REPEAT && rows.length < MAX_SHEET_ROWS; gap++) rows.push([]);
        // A longer run of blank rows is shortened, so the rows below it no
        // longer sit at their own numbers: the text says it was cut.
        if (next - rowIndex - 1 > MAX_REPEAT) cut = true;
        rowIndex = next;
        col = 0;
        if (tok.kind === "self") rows.push([]);
        else row = [];
        break;
      }
      case "c": {
        if (tok.kind === "close") {
          if (row && inCell) {
            let shown = value;
            if (cellType === "s") shown = shared[Number(value)] ?? "";
            else if (cellType === "b") shown = value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
            if (cellCol < MAX_COLUMNS) {
              if (shown.length > MAX_CELL_CHARS) {
                shown = shown.slice(0, MAX_CELL_CHARS);
                cut = true;
              }
              cells += Math.max(1, cellCol + 1 - row.length);
              // As the CSV will write it: quoting can double a field. A field
              // that would take the sheet past its budget is not written.
              const encoded = csvField(shown).length + 1;
              if (chars + encoded > MAX_SHEET_CHARS) {
                chars = MAX_SHEET_CHARS;
                cut = true;
                inCell = false;
                break;
              }
              chars += encoded;
              while (row.length < cellCol) row.push("");
              row[cellCol] = shown;
            }
          }
          inCell = false;
          break;
        }
        const ref = columnOf(attr(tok.attrs, "r"));
        cellCol = ref !== null ? ref : col;
        col = cellCol + 1;
        cellType = attr(tok.attrs, "t");
        value = "";
        inCell = tok.kind === "open";
        break;
      }
      case "v":
        if (tok.kind !== "self") inValue += tok.kind === "open" ? 1 : -1;
        break;
      case "is":
        if (tok.kind !== "self") inInline += tok.kind === "open" ? 1 : -1;
        break;
      default:
        break;
    }
  }
  return { rows, cut };
}

function xlsxText(zip: ZipReader, sink: Sink): void {
  const workbook = zip.text("xl/workbook.xml");
  if (workbook === null) throw new Unreadable("unreadable");
  const rels = relationships(zip, "xl/_rels/workbook.xml.rels", "xl");
  const shared = sharedStrings(zip);
  for (const tok of tokens(workbook)) {
    if (sink.full) return;
    if ((tok.kind !== "self" && tok.kind !== "open") || tok.name !== "sheet") continue;
    const name = attr(tok.attrs, "name") ?? "Sheet";
    const part = rels.get(attr(tok.attrs, "r:id") ?? "");
    const xml = part ? zip.text(part) : null;
    if (xml === null) continue;
    const sheet = xlsxSheet(xml, shared);
    if (sheet.cut) sink.partial = true;
    sink.push(`=== Sheet: ${name} ===\n${csvSheet(sheet.rows)}\n\n`);
  }
}

// ─── OpenDocument spreadsheet ────────────────────────────────────────────────

function repeatOf(attrs: string, name: string): number {
  const n = Number(attr(attrs, name) ?? "1");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function odsText(zip: ZipReader, sink: Sink): void {
  const xml = zip.text("content.xml");
  if (xml === null) throw new Unreadable("unreadable");
  let sheetName: string | null = null;
  let rows: string[][] = [];
  let row: string[] | null = null;
  let rowRepeat = 1;
  let cellRepeat = 1;
  let cell: string | null = null;
  let cellValue: string | null = null;
  let paragraphs = 0;
  let sheets = 0;
  let cells = 0;
  let chars = 0;
  /** The characters of the row being read, so its repeats are counted too. */
  let rowChars = 0;
  let depth = 0; // nested tables inside a cell are read as that cell's text
  const finishCell = () => {
    if (!row || cell === null) return;
    let shown = cell.trim() ? cell.replace(/\n$/, "") : cellValue ?? "";
    if (shown.length > MAX_CELL_CHARS) {
      shown = shown.slice(0, MAX_CELL_CHARS);
      sink.partial = true;
    }
    // A run of empty cells is only blank space; a run of the same value is kept, bounded.
    const times = Math.min(cellRepeat, shown === "" ? MAX_COLUMNS : MAX_REPEAT);
    // As the CSV will write it: quoting can double a field.
    const encoded = csvField(shown).length + 1;
    // Each copy is checked against what is left, so the last one cannot take
    // the CSV past the sheet's budget.
    let added = 0;
    for (; added < times && row.length < MAX_COLUMNS && chars + encoded <= MAX_SHEET_CHARS; added++) {
      row.push(shown);
      cells++;
      chars += encoded;
      rowChars += encoded;
    }
    // Stopped by the budget, not by the copies or the columns: the sheet is
    // full, and the next token ends it with what was read.
    if (added < times && row.length < MAX_COLUMNS && chars + encoded > MAX_SHEET_CHARS) {
      chars = MAX_SHEET_CHARS;
      sink.partial = true;
    }
    cell = null;
  };
  const finishSheet = () => {
    if (sheetName !== null) sink.push(`=== Sheet: ${sheetName} ===\n${csvSheet(rows)}\n\n`);
    sheetName = null;
    rows = [];
    cells = 0;
    chars = 0;
  };
  for (const tok of tokens(xml)) {
    if (sink.full) return;
    if (rows.length >= MAX_SHEET_ROWS || cells >= MAX_SHEET_CELLS || chars >= MAX_SHEET_CHARS) {
      // The rest of this document is left out; what was read is kept — the
      // row being read included.
      sink.partial = true;
      if (row && row.length > 0) rows.push(row);
      finishSheet();
      return;
    }
    if (tok.kind === "text") {
      if (cell !== null && paragraphs > 0) cell += tok.text;
      continue;
    }
    const { name } = tok;
    if (name === "table:table") {
      if (tok.kind === "open") {
        depth++;
        if (depth === 1) {
          sheets++;
          sheetName = attr(tok.attrs, "table:name") ?? `Sheet ${sheets}`;
          rows = [];
        }
      } else if (tok.kind === "close") {
        if (depth === 1) finishSheet();
        depth = Math.max(0, depth - 1);
      }
      continue;
    }
    if (depth !== 1) {
      if (cell !== null && (name === "text:p" || name === "text:h") && tok.kind === "close") cell += " ";
      continue;
    }
    if (name === "table:table-row") {
      if (tok.kind === "open") {
        row = [];
        rowChars = 0;
        rowRepeat = repeatOf(tok.attrs, "table:number-rows-repeated");
      } else {
        if (tok.kind === "self") {
          rowRepeat = repeatOf(tok.attrs, "table:number-rows-repeated");
          rowChars = 0;
        }
        const done = row ?? [];
        // A sheet's trailing blank rows are repeated by the million: bounded
        // here, and dropped from the end of the CSV anyway. A repeated row of
        // text counts its characters every time it is laid out again.
        for (let i = 0; i < Math.min(rowRepeat, MAX_REPEAT) && rows.length < MAX_SHEET_ROWS; i++) {
          if (i > 0) {
            if (chars + rowChars > MAX_SHEET_CHARS) {
              sink.partial = true;
              break;
            }
            chars += rowChars;
          }
          rows.push(done);
        }
        row = null;
      }
      continue;
    }
    if (name === "table:table-cell" || name === "table:covered-table-cell") {
      if (tok.kind === "close") {
        finishCell();
        continue;
      }
      cellRepeat = repeatOf(tok.attrs, "table:number-columns-repeated");
      cell = "";
      cellValue = attr(tok.attrs, "office:value") ?? attr(tok.attrs, "office:date-value") ?? attr(tok.attrs, "office:boolean-value");
      if (tok.kind === "self") finishCell();
      continue;
    }
    if (name === "text:p" || name === "text:h") {
      if (tok.kind === "open") paragraphs++;
      else if (tok.kind === "close") {
        paragraphs = Math.max(0, paragraphs - 1);
        if (cell !== null) cell += "\n";
      }
      continue;
    }
    if (cell !== null && tok.kind === "self") {
      if (name === "text:s") cell += " ".repeat(Math.min(64, Number(attr(tok.attrs, "text:c") ?? "1") || 1));
      else if (name === "text:tab") cell += "\t";
      else if (name === "text:line-break") cell += "\n";
    }
  }
  finishSheet();
}

// ─── The entry point ─────────────────────────────────────────────────────────

/** An OpenDocument file that the writer encrypted says so in its manifest. */
function odfEncrypted(zip: ZipReader): boolean {
  const manifest = zip.text("META-INF/manifest.xml");
  return manifest !== null && /<manifest:encryption-data\b/.test(manifest);
}

/**
 * The text of the office document `bytes`, judged by `name`'s extension
 * (`.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`). Never throws.
 */
export function extractOfficeText(bytes: Buffer, name: string): OfficeTextResult {
  const sink = new Sink();
  const ext = extensionOf(name);
  try {
    const zip = new ZipReader(bytes);
    switch (ext) {
      case ".docx":
        docxText(zip, sink);
        break;
      case ".xlsx":
        xlsxText(zip, sink);
        break;
      case ".pptx":
        pptxText(zip, sink);
        break;
      case ".odt":
        if (odfEncrypted(zip)) throw new Unreadable("encrypted");
        odtText(zip, sink);
        break;
      case ".ods":
        if (odfEncrypted(zip)) throw new Unreadable("encrypted");
        odsText(zip, sink);
        break;
      default:
        return { ok: false, reason: "unreadable" };
    }
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, reason: err.reason };
    return { ok: false, reason: "unreadable" };
  }
  // A spreadsheet's blank rows are its data; a document's empty paragraphs are not.
  const text = ext === ".xlsx" || ext === ".ods" ? sink.toString().trim() : tidy(sink.toString());
  return { ok: true, text, truncated: sink.truncated || sink.partial };
}
