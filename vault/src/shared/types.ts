// Types shared by the service, the extension and the MCP server.

/** Outcome of an agent fill command, as reported to the MCP tool. */
export type FillStatus =
  | "filled" // credentials were put into the real inputs
  | "no_form" // a matching tab exists but has no login form
  | "no_tab" // no open tab matches the entry
  | "origin_mismatch" // the form sits in a frame whose origin differs from the entry, or the page is plain http
  | "no_entry" // no vault entry matches the URL / name
  | "locked" // the extension is locked by the human
  | "extension_offline" // no paired extension is connected
  | "timeout" // the extension did not answer in time (card fills: nobody confirmed in time)
  | "declined" // the human declined (or closed) the browser confirmation of an agent card fill
  | "error";

export const EXTENSION_STATUSES = ["filled", "no_form", "no_tab", "origin_mismatch", "error"] as const;
export type ExtensionReportedStatus = (typeof EXTENSION_STATUSES)[number];

/** What a card confirmation, a list or a status may show: never the number or the code. */
export interface CardSummary {
  label: string;
  brand: string;
  last4: string;
  exp?: string;
}

export interface FillCommand {
  id: string;
  /** "card": an agent card fill that runs only after the human confirms it in the browser. */
  kind?: "login" | "card";
  /** The URL the agent asked for (the tab must match the entry; card fills: its exact origin). */
  url: string;
  /** The entry to fill. */
  name: string;
  /** URL the entry is matched by; frames must match it (card fills: the requested origin). */
  entryUrl: string;
  submit: boolean;
  createdAt: string;
  /** Card fills: what the confirmation shows. */
  card?: CardSummary;
  /** Card fills: the confirmation is dropped (status timeout) after this time. */
  confirmBy?: string;
}

export interface FillResult {
  status: FillStatus;
  name?: string;
  /** Non-secret detail, e.g. "username step" or "submitted". */
  detail?: string;
  card?: CardSummary;
}

export interface AuditRecord {
  ts: string;
  actor: "ui" | "extension" | "agent" | "system";
  action: string;
  name?: string;
  host?: string;
  status?: string;
  detail?: string;
}

/** Message the save prompt check returns for a captured login. */
export type SaveCheck =
  | { kind: "new"; suggestedName: string }
  | { kind: "update"; name: string }
  | { kind: "same"; name: string };
