import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { attachmentAcceptAttribute, classifyStagingFailure } from "@/lib/chat-attachments";
import { splitUserAttachments } from "@/lib/chat-media";
import { attachmentLine } from "@/lib/harness/openclaw-gateway-adapter";
import { hermesDocumentPrompt, INLINE_DOCUMENT_MAX_BYTES } from "@/lib/harness/hermes-document-prompt";

/**
 * How each runtime's agent gets an office document's content (TASK-2435): the
 * staging route left its text beside it (`<path>.txt`); the Hermes prompt
 * quotes it, the OpenClaw turn names it with a hint — and the transcript still
 * shows the file's name alone. The composer offers the five kinds and says
 * plainly when one cannot be read.
 */

let dir: string;
const DOCX = () => path.join(dir, "11111111-2222-3333-4444-555555555555-report.docx");
const XLSX = () => path.join(dir, "11111111-2222-3333-4444-555555555555-budget.xlsx");

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-office-prompt-"));
  fs.writeFileSync(DOCX(), "PK…");
  fs.writeFileSync(`${DOCX()}.txt`, "Quarterly report\nRevenue grew by 12 %.\n");
  fs.writeFileSync(XLSX(), "PK…");
  fs.writeFileSync(`${XLSX()}.txt`, "=== Sheet: Costs ===\nItem,Amount\nRent,1500\n");
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the composer", () => {
  it("offers the five office kinds wherever documents are taken", () => {
    const accept = attachmentAcceptAttribute({ canAttachImages: true, canAttachDocuments: true });
    for (const ext of [".docx", ".xlsx", ".pptx", ".odt", ".ods", ".pdf", ".csv"]) expect(accept, ext).toContain(ext);
    expect(attachmentAcceptAttribute({ canAttachImages: true, canAttachDocuments: false })).toBe("image/*");
  });

  it("says a file could not be read when the box answers 422 unreadable_document, with the box's reason", () => {
    const failure = classifyStagingFailure(422, { error: "The file is password-protected, so its text cannot be read.", code: "unreadable_document" });
    expect(failure.reason).toBe("unreadable");
    expect(failure.detail).toMatch(/password-protected/);
    // Any other 422 stays the generic refusal.
    expect(classifyStagingFailure(422, { error: "x" }).reason).toBe("rejected");
  });
});

describe("OpenClaw", () => {
  it("names a document's extracted text, and a spreadsheet's CSV, in the turn", () => {
    const line = attachmentLine({ path: DOCX(), type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, false);
    expect(line).toBe(`[Attached file: ${DOCX()} — ClawBox saved its text in ${DOCX()}.txt; read that file to answer from the document]`);
    expect(attachmentLine({ path: XLSX(), type: "" }, true)).toContain(`its sheets as CSV in ${XLSX()}.txt`);
    // Every other file is named as before.
    expect(attachmentLine({ path: "/m/a.pdf", type: "application/pdf" }, false)).toBe("[Attached file: /m/a.pdf]");
  });

  it("is read back by the transcript as the file's name, the hint stripped", () => {
    const turn = `${attachmentLine({ path: DOCX(), type: "" }, false)}\nWhat grew?`;
    expect(splitUserAttachments(turn)).toEqual({ text: "What grew?", images: [], files: ["report.docx"] });
  });
});

describe("Hermes", () => {
  it("quotes a document's extracted text under its line", async () => {
    const prompt = await hermesDocumentPrompt([DOCX(), XLSX()]);
    expect(prompt).toContain(`[Attached file: ${DOCX()} — ClawBox saved its text in ${DOCX()}.txt]`);
    expect(prompt).toContain("Revenue grew by 12 %.");
    expect(prompt).toContain("----- its sheets as CSV of 11111111-2222-3333-4444-555555555555-budget.xlsx -----");
    expect(prompt).toContain("Item,Amount\nRent,1500");
  });

  it("quotes the beginning of a long document and points at the rest", async () => {
    const long = path.join(dir, "long.docx");
    fs.writeFileSync(long, "PK…");
    fs.writeFileSync(`${long}.txt`, "word ".repeat(INLINE_DOCUMENT_MAX_BYTES));
    const prompt = await hermesDocumentPrompt([long]);
    expect(prompt).toContain("word word");
    expect(prompt).toContain(`[… it goes on: open ${long}.txt for the rest]`);
    expect(prompt.length).toBeLessThan(INLINE_DOCUMENT_MAX_BYTES + 1024);
  });

  it("still names a document whose text has gone (aged out of staging)", async () => {
    const gone = path.join(dir, "gone.pptx");
    const prompt = await hermesDocumentPrompt([gone]);
    expect(prompt).toContain(`[Attached file: ${gone} — ClawBox saved its text in ${gone}.txt]`);
    expect(prompt).toContain("Not shown here");
  });
});
