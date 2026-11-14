// Append-only audit log (JSONL, mode 600). Records who did what to which entry
// name and host. It never receives passwords, 2FA secrets, notes, tokens,
// pairing codes or full URLs: callers pass only the fields of AuditRecord, and
// `record` drops anything else. Cards are recorded by label and last 4 only;
// as a last guard every field is run through the card-number/CVV redactor.
import { scrubCardData } from "../shared/card";
import { closeSync, existsSync, fchmodSync, fstatSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AuditRecord } from "../shared/types";

const MAX_BYTES = 5 * 1024 * 1024;

export class AuditLog {
  readonly file: string;

  constructor(configDir: string) {
    this.file = join(configDir, "audit.jsonl");
  }

  record(entry: Omit<AuditRecord, "ts">): void {
    const clean = (v: unknown, max: number) => scrubCardData(String(v)).slice(0, max);
    const rec: AuditRecord = { ts: new Date().toISOString(), actor: entry.actor, action: clean(entry.action, 60) };
    if (entry.name) rec.name = clean(entry.name, 200);
    if (entry.host) rec.host = clean(entry.host, 255);
    if (entry.status) rec.status = clean(entry.status, 40);
    if (entry.detail) rec.detail = clean(entry.detail, 200);
    let fd = -1;
    try {
      // The size is read from the open descriptor, so the file that is rotated
      // or appended to is the one that was measured.
      fd = openSync(this.file, "a", 0o600);
      if (fstatSync(fd).size > MAX_BYTES) {
        closeSync(fd);
        fd = -1;
        renameSync(this.file, `${this.file}.1`);
        fd = openSync(this.file, "a", 0o600);
      }
      fchmodSync(fd, 0o600);
      writeSync(fd, `${JSON.stringify(rec)}\n`);
    } catch (err) {
      console.error(`audit log write failed: ${(err as Error).message}`);
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  }

  recent(limit = 50): AuditRecord[] {
    const n = Math.min(500, Math.max(1, Math.floor(limit) || 50));
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").trim().split("\n").filter(Boolean);
    const out: AuditRecord[] = [];
    for (const line of lines.slice(-n).reverse()) {
      try {
        out.push(JSON.parse(line) as AuditRecord);
      } catch {
        // skip a torn line
      }
    }
    return out;
  }
}
