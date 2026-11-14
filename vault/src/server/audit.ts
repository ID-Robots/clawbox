// Append-only audit log (JSONL, mode 600). Records who did what to which entry
// name and host. It never receives passwords, 2FA secrets, notes, tokens,
// pairing codes or full URLs: callers pass only the fields of AuditRecord, and
// `record` drops anything else. Cards are recorded by label and last 4 only;
// as a last guard every field is run through the card-number/CVV redactor.
import { scrubCardData } from "../shared/card";
import { closeSync, existsSync, fchmodSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
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
      // Measured, rotated and appended to through one descriptor, so the file
      // that is rotated is the one that was measured.
      fd = openSync(this.file, "a+", 0o600);
      fchmodSync(fd, 0o600);
      const size = fstatSync(fd).size;
      if (size > MAX_BYTES) {
        this.rotate(fd, size);
        ftruncateSync(fd, 0);
      }
      writeSync(fd, `${JSON.stringify(rec)}\n`);
    } catch (err) {
      console.error(`audit log write failed: ${(err as Error).message}`);
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  }

  /** Copies the open log into `<file>.1` (replacing it), mode 600. */
  private rotate(fd: number, size: number): void {
    const old = Buffer.alloc(size);
    let got = 0;
    while (got < size) {
      const n = readSync(fd, old, got, size - got, got);
      if (n === 0) break;
      got += n;
    }
    const out = openSync(`${this.file}.1`, "w", 0o600);
    try {
      fchmodSync(out, 0o600);
      writeSync(out, old, 0, got);
    } finally {
      closeSync(out);
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
