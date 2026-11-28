// Office documents a chat can take (Word, Excel, PowerPoint and their
// OpenDocument cousins), by name. Client-safe: no Node imports, so the chat
// composer and the OpenClaw adapter (which run in the browser) read the same
// list the staging route extracts from (src/lib/office-text.ts).
//
// A staged office document is a ZIP of XML no model reads by itself, so the
// staging route writes its text beside it — `<staged path>.txt`, spreadsheets
// as CSV one section per sheet — and refuses a file whose text cannot be had.
// The turn then hands the agent that text: quoted into a Hermes prompt
// (src/lib/harness/hermes-document-prompt.ts) and named, with a hint, in an
// OpenClaw turn (`attachmentLine`), whose agent opens it with its file tools.

/** The extensions the chat extracts text from. */
export const OFFICE_EXTENSIONS: readonly string[] = [".docx", ".xlsx", ".pptx", ".odt", ".ods"];

/** Spreadsheets: their text is CSV, one section per sheet. */
const SPREADSHEET_EXTENSIONS: readonly string[] = [".xlsx", ".ods"];

/** The extension of a file name or path, lower-cased (`""` for none). */
export function extensionOf(name: string): string {
  const leaf = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(dot).toLowerCase() : "";
}

/** Is this file name (or path) one of the office documents the chat reads? */
export function isOfficeDocumentName(name: string): boolean {
  return OFFICE_EXTENSIONS.includes(extensionOf(name));
}

/** Is it a spreadsheet, whose text is CSV? */
export function isSpreadsheetName(name: string): boolean {
  return SPREADSHEET_EXTENSIONS.includes(extensionOf(name));
}

/** Where the staging route leaves a staged office document's text. */
export function officeTextPath(stagedPath: string): string {
  return `${stagedPath}.txt`;
}

/** The picker's `accept` entries for them. */
export const OFFICE_ACCEPT = OFFICE_EXTENSIONS.join(",");
