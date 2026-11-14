// Entry catalog on top of the pass adapter: metadata listing with an in-memory
// cache (login/url per entry, keyed by file mtime), search, URL matching, and
// merge-on-save that keeps unknown lines of the pass format intact.
// Nothing here is written to disk except through `pass insert`.
// Payment cards live under their own prefix (cards/) and are managed by
// CardCatalog: this login catalog neither lists nor reads nor writes them, so a
// card can never be matched, filled or copied as a login.
import { CARD_PREFIX, isCardName } from "../shared/card";
import { entryMatchUrl, rankMatches, type MatchKind } from "../shared/domain";
import {
  metaOf,
  parseEntry,
  serializeEntry,
  validateLine,
  validateName,
  validatePassword,
  ValidationError,
  type EntryMeta,
  type ParsedEntry,
} from "../shared/entry";
import { PassError, type PassStore } from "./pass";

interface CacheItem {
  mtimeMs: number;
  login: string;
  url: string;
}

export interface SaveInput {
  name: string;
  login?: string;
  url?: string;
  /** Omitted: keep the existing password (an error for new entries). */
  password?: string;
  note?: string;
  twofa?: string;
  clearTwofa?: boolean;
}

export interface SaveOutcome {
  name: string;
  created: boolean;
}

/** A login entry name: valid, and not under the card prefix. */
export function validateLoginName(name: unknown): string {
  const n = validateName(name);
  if (isCardName(n)) throw new ValidationError(`${CARD_PREFIX}/ holds payment cards; manage them under Cards`);
  return n;
}

export class Catalog {
  private cache = new Map<string, CacheItem>();
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(readonly store: PassStore) {}

  /**
   * Serialize writes: pass commits must not race each other in the store repo.
   * Shared with the card catalog, which writes to the same store.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  async list(opts: { query?: string; prefix?: string } = {}): Promise<EntryMeta[]> {
    let names = await this.store.list({ skip: [CARD_PREFIX] });
    if (opts.prefix) {
      const p = opts.prefix.endsWith("/") ? opts.prefix : `${opts.prefix}/`;
      names = names.filter((n) => n.startsWith(p));
    }
    const live = new Set(names);
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);

    const metas: EntryMeta[] = [];
    let i = 0;
    const worker = async () => {
      while (i < names.length) {
        const name = names[i++]!;
        const meta = await this.meta(name).catch(() => null);
        if (meta) metas.push(meta);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, names.length) }, worker));
    metas.sort((a, b) => a.name.localeCompare(b.name));

    const q = opts.query?.trim().toLowerCase();
    if (!q) return metas;
    return metas.filter((m) => [m.name, m.login, m.url].some((f) => f.toLowerCase().includes(q)));
  }

  private async meta(name: string): Promise<EntryMeta> {
    const mtime = await this.store.mtime(name);
    const cached = this.cache.get(name);
    if (cached && cached.mtimeMs === mtime.getTime()) return metaOf(name, cached, mtime);
    let login = "";
    let url = "";
    try {
      const parsed = parseEntry(await this.store.show(name));
      login = parsed.login;
      url = parsed.url;
    } catch (err) {
      if (err instanceof PassError && err.code === "not_found") throw err;
      // Unreadable entries still list by name; the error is logged by the adapter.
    }
    this.cache.set(name, { mtimeMs: mtime.getTime(), login, url });
    return metaOf(name, { login, url }, mtime);
  }

  async match(pageUrl: string, opts: { prefix?: string } = {}): Promise<Array<EntryMeta & { match: MatchKind }>> {
    return rankMatches(await this.list({ prefix: opts.prefix }), pageUrl);
  }

  /** Full decrypted entry. Secret: only for the paired extension or an unlocked UI. */
  async read(name: string): Promise<ParsedEntry> {
    return parseEntry(await this.store.show(validateLoginName(name)));
  }

  async exists(name: string): Promise<boolean> {
    return this.store.exists(validateLoginName(name));
  }

  async metaFor(name: string): Promise<EntryMeta> {
    return this.meta(validateLoginName(name));
  }

  /** URL the entry is matched by (its url field, or a domain-like name). */
  async matchUrlFor(name: string): Promise<string | null> {
    const meta = await this.metaFor(name);
    return entryMatchUrl(meta);
  }

  save(input: SaveInput, opts: { mustBeNew?: boolean; renameFrom?: string } = {}): Promise<SaveOutcome> {
    return this.exclusive(async () => {
      const name = validateLoginName(input.name);
      const login = validateLine(input.login, "login", { max: 500 });
      const url = validateLine(input.url, "url", { max: 2000 });
      const note = validateLine(input.note, "note", { max: 4000 });
      const twofa = validateLine(input.twofa, "2fa", { max: 1000 });
      const password = input.password === undefined || input.password === "" ? undefined : validatePassword(input.password);

      let source = name;
      if (opts.renameFrom && opts.renameFrom !== name) {
        const from = validateLoginName(opts.renameFrom);
        if (await this.store.exists(name)) throw new ValidationError("an entry with the new name already exists");
        await this.store.move(from, name);
        this.cache.delete(from);
        source = name;
      }

      const exists = await this.store.exists(source);
      if (exists && opts.mustBeNew) throw new ValidationError("entry already exists");
      let entry: ParsedEntry;
      if (exists) {
        entry = await this.read(source);
        if (password !== undefined) entry.password = password;
        if (input.login !== undefined) entry.login = login;
        if (input.url !== undefined) entry.url = url;
        if (input.note !== undefined) entry.note = note;
        if (input.clearTwofa) entry.twofa = "";
        else if (twofa) entry.twofa = twofa;
      } else {
        if (password === undefined) throw new ValidationError("password is required for a new entry");
        entry = { password, login, url, twofa, note, extra: [] };
      }
      await this.store.insert(name, serializeEntry(entry));
      this.cache.delete(name);
      return { name, created: !exists };
    });
  }

  remove(name: string): Promise<void> {
    return this.exclusive(async () => {
      const n = validateLoginName(name);
      await this.store.remove(n);
      this.cache.delete(n);
    });
  }
}
