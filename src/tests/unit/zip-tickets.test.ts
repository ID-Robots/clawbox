/**
 * The selection ZIP's tickets (TASK-1273): a POST hands one out, the download
 * link redeems it — until it expires, and only in the shape it was issued.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_ZIP_TICKETS,
  ZIP_TICKET_TTL_MS,
  issueZipTicket,
  redeemZipTicket,
  uniqueArchiveNames,
} from "@/lib/zip-tickets";

const ticket = { rels: ["a.txt"], names: ["a.txt"], archiveName: "x.zip" };

describe("zip tickets", () => {
  it("redeems a ticket it issued, more than once, until it expires", () => {
    const now = 1_000_000;
    const id = issueZipTicket(ticket, now);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(redeemZipTicket(id, now + 1)).toMatchObject(ticket);
    expect(redeemZipTicket(id, now + 2)).toMatchObject(ticket);
    expect(redeemZipTicket(id, now + ZIP_TICKET_TTL_MS + 1)).toBeNull();
  });

  it("refuses anything that is not a ticket's shape", () => {
    for (const bad of [undefined, null, 42, "", "../../etc", "ABCDEF0123456789ABCDEF0123456789", "0".repeat(33)]) {
      expect(redeemZipTicket(bad)).toBeNull();
    }
  });

  it("keeps at most MAX_ZIP_TICKETS, dropping the oldest first", () => {
    const now = 5_000_000;
    const first = issueZipTicket(ticket, now);
    for (let i = 0; i < MAX_ZIP_TICKETS; i += 1) issueZipTicket(ticket, now);
    expect(redeemZipTicket(first, now)).toBeNull();
  });
});

describe("uniqueArchiveNames", () => {
  it("numbers the second of a name, before its extension", () => {
    expect(uniqueArchiveNames(["README.md", "README.md", "src", "src", "README (2).md"]))
      .toEqual(["README.md", "README (2).md", "src", "src (2)", "README (2) (2).md"]);
  });
});
