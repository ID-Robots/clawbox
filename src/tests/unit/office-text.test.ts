import fs from "fs";
import path from "path";
import zlib from "zlib";
import { describe, expect, it } from "vitest";

import { extractOfficeText, OFFICE_TEXT_MAX_CHARS } from "@/lib/office-text";
import { isOfficeDocumentName, isSpreadsheetName, OFFICE_ACCEPT, officeTextPath } from "@/lib/office-documents";

/**
 * The text of an office document a chat was handed (src/lib/office-text.ts):
 * small real fixtures of each kind (src/tests/fixtures/office/), and the
 * archives a hostile or broken file can be.
 */

const FIXTURES = path.join(process.cwd(), "src", "tests", "fixtures", "office");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const text = (name: string) => {
  const result = extractOfficeText(fixture(name), name);
  if (!result.ok) throw new Error(`${name}: ${result.reason}`);
  return result.text;
};

/** A ZIP of the given parts, built by hand — what a writer of our own choosing would hand the reader. */
function zip(parts: { name: string; data: Buffer; method?: 0 | 8; flags?: number; declaredSize?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const method = part.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(part.data) : part.data;
    const name = Buffer.from(part.name);
    const size = part.declaredSize ?? part.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(part.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(part.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const docx = (body: string) => zip([{ name: "word/document.xml", data: Buffer.from(`<w:document><w:body>${body}</w:body></w:document>`) }]);

describe("the names", () => {
  it("knows the five office kinds, and which are spreadsheets", () => {
    for (const name of ["a.docx", "B.XLSX", "/x/y/c.pptx", "d.odt", "e.ods"]) expect(isOfficeDocumentName(name), name).toBe(true);
    for (const name of ["a.doc", "a.pdf", "a.txt", "docx", ".docx", "a.docx.txt"]) expect(isOfficeDocumentName(name), name).toBe(false);
    expect(isSpreadsheetName("b.xlsx")).toBe(true);
    expect(isSpreadsheetName("e.ods")).toBe(true);
    expect(isSpreadsheetName("a.docx")).toBe(false);
    expect(officeTextPath("/m/1-a.docx")).toBe("/m/1-a.docx.txt");
    expect(OFFICE_ACCEPT).toBe(".docx,.xlsx,.pptx,.odt,.ods");
  });
});

describe("a Word document", () => {
  it("gives its paragraphs in order and a table's rows as cells", () => {
    expect(text("report.docx")).toBe([
      "Quarterly report",
      "Revenue grew by 12 % & costs fell.",
      "",
      "Region | Sales",
      "North | 4200",
      "Old figure\tend.",
    ].join("\n"));
  });

  it("leaves out deleted tracked changes and tab stops", () => {
    const out = text("report.docx");
    expect(out).not.toContain("999");
    expect(out.startsWith("Quarterly report")).toBe(true);
  });
});

describe("a spreadsheet", () => {
  it("gives each Excel sheet as CSV, shared strings, numbers, formulas' values, booleans and gaps included", () => {
    expect(text("budget.xlsx")).toBe([
      "=== Sheet: Costs ===",
      "Item,Amount",
      "Rent,1500",
      "\"Coffee, \"\"good\"\"\",,3000",
      "",
      "Total,TRUE",
      "",
      "=== Sheet: Team, 2026 ===",
      "Name",
      "Иван Иванов",
    ].join("\n"));
  });

  it("gives each OpenDocument sheet as CSV, bounding the millions of repeated blank cells and rows", () => {
    expect(text("sales.ods")).toBe(["=== Sheet: Q1 ===", "Month,Units", "Jan,12", "Same", "Same"].join("\n"));
  });
});

describe("a presentation and an OpenDocument text", () => {
  it("gives each slide's text in the presentation's own order", () => {
    expect(text("deck.pptx")).toBe(["=== Slide 1 ===", "Acme roadmap", "", "=== Slide 2 ===", "Next steps", "Hire two engineers"].join("\n"));
  });

  it("gives an OpenDocument text's headings, paragraphs, spaces and tables", () => {
    expect(text("notes.odt")).toBe(["Meeting notes", "Attendees:  Globex team", "Task | Owner"].join("\n"));
  });
});

describe("a file whose text cannot be had", () => {
  it("names a password-protected file as such", () => {
    expect(extractOfficeText(fixture("protected.docx"), "protected.docx")).toEqual({ ok: false, reason: "encrypted" });
    const encryptedOdt = zip([
      { name: "META-INF/manifest.xml", data: Buffer.from("<manifest:manifest><manifest:file-entry><manifest:encryption-data/></manifest:file-entry></manifest:manifest>") },
      { name: "content.xml", data: Buffer.from("garbage") },
    ]);
    expect(extractOfficeText(encryptedOdt, "secret.odt")).toEqual({ ok: false, reason: "encrypted" });
    const flagged = zip([{ name: "word/document.xml", data: Buffer.from("<w:t>x</w:t>"), flags: 1 }]);
    expect(extractOfficeText(flagged, "x.docx")).toEqual({ ok: false, reason: "encrypted" });
  });

  it("refuses what is not an archive, or not the kind its name says", () => {
    expect(extractOfficeText(fixture("broken.xlsx"), "broken.xlsx")).toEqual({ ok: false, reason: "unreadable" });
    expect(extractOfficeText(Buffer.alloc(0), "empty.docx")).toEqual({ ok: false, reason: "unreadable" });
    // A real Word file renamed .xlsx has no workbook.
    expect(extractOfficeText(fixture("report.docx"), "report.xlsx")).toEqual({ ok: false, reason: "unreadable" });
    expect(extractOfficeText(fixture("report.docx"), "report.pdf")).toEqual({ ok: false, reason: "unreadable" });
  });

  it("refuses a zip bomb rather than inflate it", () => {
    // 100 MB of zeros deflates to about 100 KB: refused unread.
    const bomb = zip([{ name: "word/document.xml", data: Buffer.alloc(100 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(extractOfficeText(bomb, "bomb.docx")).toEqual({ ok: false, reason: "too_large" });
    // 20 MB that claims so, past the ratio a real document reaches.
    const dense = zip([{ name: "word/document.xml", data: Buffer.alloc(20 * 1024 * 1024) }]);
    expect(extractOfficeText(dense, "dense.docx")).toEqual({ ok: false, reason: "too_large" });
    // A part that LIES about its size is held to the box's bound all the same.
    const liar = zip([{ name: "word/document.xml", data: Buffer.alloc(80 * 1024 * 1024), declaredSize: 10 }]);
    expect(extractOfficeText(liar, "liar.docx")).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("a hostile part", () => {
  it("is walked in linear time, however its tags are broken", () => {
    for (const body of ["<".repeat(400_000), "<a" + "x".repeat(400_000), "<w:t " + "a=\"".repeat(100_000)]) {
      const started = Date.now();
      const result = extractOfficeText(docx(body), "hostile.docx");
      expect(result.ok, body.slice(0, 8)).toBe(true);
      expect(Date.now() - started, body.slice(0, 8)).toBeLessThan(3_000);
    }
  });

  it("bounds a sheet whose rows jump far ahead, rather than fill the heap with blank rows", () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => `<row r="${(i + 1) * 1000}"><c r="A${(i + 1) * 1000}"><v>${i}</v></c></row>`).join("");
    const workbook = zip([
      { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<worksheet><sheetData>${rows}</sheetData></worksheet>`) },
    ]);
    const started = Date.now();
    const result = extractOfficeText(workbook, "jumps.xlsx");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.text.split("\n").length).toBeLessThanOrEqual(20_002);
    }
  });
});

describe("a spreadsheet built to balloon", () => {
  const ods = (content: string) => zip([
    { name: "META-INF/manifest.xml", data: Buffer.from("<manifest:manifest/>") },
    { name: "content.xml", data: Buffer.from(`<office:document-content><office:body><office:spreadsheet>${content}</office:spreadsheet></office:body></office:document-content>`) },
  ]);

  it("never lays a big cell out a thousand times over", () => {
    const big = "y".repeat(1024 * 1024);
    const started = Date.now();
    const result = extractOfficeText(
      ods(`<table:table table:name="S"><table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="1000"><text:p>${big}</text:p></table:table-cell></table:table-row></table:table>`),
      "balloon.ods",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(OFFICE_TEXT_MAX_CHARS);
      // What was read is kept: the sheet's first cells, not only its heading.
      expect(result.text.startsWith("=== Sheet: S ===\n" + "y".repeat(1000))).toBe(true);
      expect(result.text.length).toBeGreaterThan(OFFICE_TEXT_MAX_CHARS / 2);
    }
  });

  it("counts a field as the CSV writes it: quotes double", () => {
    const quoted = '"'.repeat(30_000);
    const result = extractOfficeText(
      ods(`<table:table table:name="Q"><table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="100"><text:p>${quoted}</text:p></table:table-cell></table:table-row></table:table>`),
      "quotes.ods",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(OFFICE_TEXT_MAX_CHARS);
      expect(result.text).toContain('""""');
    }
  });

  it("keeps an Excel sheet's row in progress when the budget cuts it, and never writes past the budget", () => {
    const shared = Array.from({ length: 40 }, (_, i) => `<si><t>${String(i).padStart(2, "0")}${"z".repeat(40_000)}</t></si>`).join("");
    const cells = Array.from({ length: 40 }, (_, i) => `<c r="${String.fromCharCode(65 + (i % 26))}${i < 26 ? "" : "A"}1" t="s"><v>${i}</v></c>`).join("");
    const workbook = zip([
      { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="Wide" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/sharedStrings.xml", data: Buffer.from(`<sst>${shared}</sst>`) },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`) },
    ]);
    const result = extractOfficeText(workbook, "wide.xlsx");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(OFFICE_TEXT_MAX_CHARS);
      // The one row is kept, not dropped for the heading alone.
      expect(result.text).toContain("00" + "z".repeat(100));
      expect(result.text.length).toBeGreaterThan(OFFICE_TEXT_MAX_CHARS / 2);
    }
  });

  it("checks each OpenDocument field against what is left, so the last one cannot overshoot", () => {
    const field = "w".repeat(30_000);
    const result = extractOfficeText(
      ods(`<table:table table:name="F"><table:table-row table:number-rows-repeated="100"><table:table-cell table:number-columns-repeated="50"><text:p>${field}</text:p></table:table-cell></table:table-row></table:table>`),
      "fields.ods",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(OFFICE_TEXT_MAX_CHARS);
      // Every field written is whole: the budget drops fields, it never cuts one.
      const fields = result.text.split("\n").slice(1).flatMap((line) => line.split(","));
      expect(fields.length).toBeGreaterThan(10);
      for (const f of fields) expect(f.length, "a field was cut").toBe(field.length);
    }
  });

  it("counts the commas of an Excel row's empty columns against the budget", () => {
    const value = "v".repeat(32 * 1024);
    // Column AMJ is the 1,024th: each row is 1,023 commas before its one value.
    const rows = Array.from({ length: 30 }, (_, i) => `<row r="${i + 1}"><c r="AMJ${i + 1}" t="inlineStr"><is><t>${value}</t></is></c></row>`).join("");
    const workbook = zip([
      { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="Far" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<worksheet><sheetData>${rows}</sheetData></worksheet>`) },
    ]);
    const result = extractOfficeText(workbook, "far.xlsx");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(OFFICE_TEXT_MAX_CHARS);
      // Each row that was written is whole: its commas and its value.
      const lines = result.text.split("\n").slice(1);
      expect(lines.length).toBeGreaterThan(20);
      for (const line of lines) expect(line).toBe(",".repeat(1023) + value);
    }
  });

  it("says so when a run of blank rows was shortened", () => {
    const workbook = zip([
      { name: "xl/workbook.xml", data: Buffer.from('<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
      { name: "xl/worksheets/sheet1.xml", data: Buffer.from('<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="3000"><c r="A3000"><v>2</v></c></row></sheetData></worksheet>') },
    ]);
    const result = extractOfficeText(workbook, "gap.xlsx");
    expect(result.ok && result.truncated).toBe(true);
  });

  it("reads a presentation that names its slides a hundred thousand times without a quadratic walk", () => {
    const ids = Array.from({ length: 100_000 }, () => '<p:sldId r:id="rId1"/>').join("");
    const deck = zip([
      { name: "ppt/presentation.xml", data: Buffer.from(`<p:presentation><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`) },
      { name: "ppt/_rels/presentation.xml.rels", data: Buffer.from('<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>') },
      { name: "ppt/slides/slide1.xml", data: Buffer.from("<p:sld><a:p><a:r><a:t>Only slide</a:t></a:r></a:p></p:sld>") },
    ]);
    const started = Date.now();
    const result = extractOfficeText(deck, "deck.pptx");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result).toEqual({ ok: true, text: "=== Slide 1 ===\nOnly slide", truncated: false });
  });
});

describe("bounds", () => {
  it("keeps the beginning of a document past the text bound, and says it was cut", () => {
    const run = "<w:p><w:r><w:t>" + "x".repeat(1000) + "</w:t></w:r></w:p>";
    const result = extractOfficeText(docx(run.repeat(OFFICE_TEXT_MAX_CHARS / 1000 + 50)), "long.docx");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(OFFICE_TEXT_MAX_CHARS);
  });

  it("reads a document with no text as an empty one, not a broken one", () => {
    expect(extractOfficeText(docx("<w:p/>"), "pictures.docx")).toEqual({ ok: true, text: "", truncated: false });
  });

  it("decodes the XML's entities and keeps stored (uncompressed) parts", () => {
    const stored = zip([{ name: "word/document.xml", data: Buffer.from("<w:p><w:r><w:t>&lt;a&gt; &#x41;&#66; &quot;q&quot;</w:t></w:r></w:p>"), method: 0 }]);
    expect(extractOfficeText(stored, "s.docx")).toEqual({ ok: true, text: "<a> AB \"q\"", truncated: false });
  });
});
