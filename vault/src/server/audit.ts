// Append-only audit log (JSONL, mode 600). Records who did what to which entry
// name and host. It never receives passwords, 2FA secrets, notes, tokens,
// pairing codes or full URLs: callers pass only the fields of AuditRecord, and
// `record` drops anything else. Cards are recorded by label and last 4 only;
// as a last guard every field is run through the card-number/CVV redactor.
import { scrubCardData } from "../shared/card";
import { appendFileSync, chmodSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
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
    try {
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) {
        renameSync(this.file, `${this.file}.1`);
      }
      appendFileSync(this.file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch (err) {
      console.error(`audit log write failed: ${(err as Error).message}`);
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
