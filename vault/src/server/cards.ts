// Card catalog: payment cards stored as pass entries under cards/<label>. The
// metadata cache (keyed by file mtime) holds label, brand, last 4, expiry and
// cardholder only; the number and the security code are decrypted on demand
// for one reveal or one fill and never cached, logged or put in an error.
// Writes share the login catalog's lock: pass commits must not race.
import {
  CARD_PREFIX,
  cardBrand,
  cardLast4,
  cardMetaOf,
  cardNameFor,
  defaultLabel,
  isCardName,
  parseCard,
  serializeCard,
  validateCardNumber,
  validateCardText,
  validateCvv,
  validateExpiry,
  type CardMeta,
  type ParsedCard,
} from "../shared/card";
import { validateName, ValidationError } from "../shared/entry";
import type { Catalog } from "./catalog";
import { PassError, type PassStore } from "./pass";

interface CacheItem {
  mtimeMs: number;
  number4: string;
  brand: CardMeta["brand"];
  cardholder: string;
  exp: string;
  label: string;
}

export interface CardSaveInput {
  label?: string;
  /** Omitted on an update: keep the stored number. */
  number?: string;
  cardholder?: string;
  exp?: string;
  /** Omitted on an update: keep the stored code. */
  cvv?: string;
  clearCvv?: boolean;
  note?: string;
}

export interface CardSaveOutcome {
  name: string;
  created: boolean;
  meta: CardMeta;
}

/** A card entry name: valid and under cards/. */
export function validateCardName(name: unknown): string {
  const n = validateName(name);
  if (!isCardName(n) || n === CARD_PREFIX) throw new ValidationError(`card names live under ${CARD_PREFIX}/`);
  return n;
}

export class CardCatalog {
  private cache = new Map<string, CacheItem>();

  constructor(
    readonly store: PassStore,
    private readonly lock: Pick<Catalog, "exclusive">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(opts: { query?: string } = {}): Promise<CardMeta[]> {
    const names = await this.store.list({ under: CARD_PREFIX });
    const live = new Set(names);
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);
    const metas: CardMeta[] = [];
    for (const name of names) {
      const meta = await this.meta(name).catch(() => null);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
    const q = opts.query?.trim().toLowerCase();
    if (!q) return metas;
    return metas.filter((m) => [m.label, m.name, m.brand, m.last4, m.cardholder].some((f) => f.toLowerCase().includes(q)));
  }

  private async meta(name: string): Promise<CardMeta> {
    const mtime = await this.store.mtime(name);
    const cached = this.cache.get(name);
    if (cached && cached.mtimeMs === mtime.getTime()) return this.metaFromCache(name, cached, mtime);
    let item: CacheItem = { mtimeMs: mtime.getTime(), number4: "", brand: "unknown", cardholder: "", exp: "", label: "" };
    try {
      const card = parseCard(await this.store.show(name));
      // Only the last four digits and the brand stay in memory.
      item = {
        mtimeMs: mtime.getTime(),
        number4: cardLast4(card.number),
        brand: cardBrand(card.number),
        cardholder: card.cardholder,
        exp: card.exp,
        label: card.label || defaultLabel(card.number),
      };
    } catch (err) {
      if (err instanceof PassError && err.code === "not_found") throw err;
      // Unreadable cards still list by name; the adapter logged why.
    }
    this.cache.set(name, item);
    return this.metaFromCache(name, item, mtime);
  }

  private metaFromCache(name: string, c: CacheItem, mtime: Date): CardMeta {
    const meta = cardMetaOf(name, { number: c.number4, cardholder: c.cardholder, exp: c.exp, label: c.label || name.slice(CARD_PREFIX.length + 1) }, mtime, this.now());
    return { ...meta, brand: c.brand };
  }

  async metaFor(name: string): Promise<CardMeta> {
    return this.meta(validateCardName(name));
  }

  async exists(name: string): Promise<boolean> {
    return this.store.exists(validateCardName(name));
  }

  /** Full decrypted card. Secret: only for one fill or one PIN-session reveal. */
  async read(name: string): Promise<ParsedCard> {
    return parseCard(await this.store.show(validateCardName(name)));
  }

  /** Cards whose number equals `number` (compared after decryption, never cached). */
  async findByNumber(number: string): Promise<string[]> {
    const last4 = cardLast4(number);
    const out: string[] = [];
    for (const meta of await this.list()) {
      if (meta.last4 !== last4) continue;
      const card = await this.read(meta.name).catch(() => null);
      if (card && card.number === number) out.push(meta.name);
    }
    return out;
  }

  /** Resolve what an agent or a client calls a card: entry name, label or last 4. */
  async resolve(ref: string): Promise<CardMeta[]> {
    const r = ref.trim();
    const all = await this.list();
    const lower = r.toLowerCase();
    const byName = all.filter((c) => c.name === r || c.name === `${CARD_PREFIX}/${r}`);
    if (byName.length) return byName;
    const byLabel = all.filter((c) => c.label.toLowerCase() === lower);
    if (byLabel.length) return byLabel;
    const digits = r.replace(/\D/g, "");
    if (digits.length === 4 && /^[•*.\s-]*\d{4}$/.test(r)) return all.filter((c) => c.last4 === digits);
    return [];
  }

  /** `base`, or `base-2`, `base-3`, …; the card's own current name (`self`) counts as free. */
  private async freeName(base: string, self?: string): Promise<string> {
    if (base === self || !(await this.store.exists(base))) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}`;
      if (candidate === self || !(await this.store.exists(candidate))) return candidate;
    }
    throw new ValidationError("could not find a free card name");
  }

  /**
   * Create (`name` omitted) or update the card `name`. Validates Luhn, brand
   * length, expiry and the security code; a changed label renames the entry
   * (pass mv). Unknown lines of an existing entry are kept.
   */
  save(input: CardSaveInput, opts: { name?: string } = {}): Promise<CardSaveOutcome> {
    return this.lock.exclusive(async () => {
      const now = this.now();
      let card: ParsedCard;
      let source: string | null = null;
      if (opts.name) {
        source = validateCardName(opts.name);
        if (!(await this.store.exists(source))) throw new PassError("entry not found", "not_found");
        card = await this.read(source);
        if (input.number !== undefined && input.number !== "") card.number = validateCardNumber(input.number);
        else validateCardNumber(card.number);
      } else {
        card = { number: validateCardNumber(input.number), cardholder: "", exp: "", cvv: "", label: "", note: "", extra: [] };
      }
      const brand = cardBrand(card.number);
      if (input.cardholder !== undefined) card.cardholder = validateCardText(input.cardholder, "cardholder", 100);
      if (input.exp !== undefined || !source) card.exp = validateExpiry(input.exp, now);
      if (input.clearCvv) card.cvv = "";
      else if (input.cvv !== undefined && input.cvv !== "") card.cvv = validateCvv(input.cvv, brand);
      else if (card.cvv) card.cvv = validateCvv(card.cvv, brand);
      if (input.note !== undefined) card.note = validateCardText(input.note, "note", 1000);
      const label = input.label !== undefined ? validateCardText(input.label, "label", 60) : card.label;
      card.label = label || defaultLabel(card.number);

      let name = source ?? (await this.freeName(cardNameFor(card.label)));
      if (source && input.label !== undefined) {
        const wanted = cardNameFor(card.label);
        if (wanted !== source) {
          name = await this.freeName(wanted, source);
          if (name !== source) {
            await this.store.move(source, name);
            this.cache.delete(source);
          }
        }
      }
      await this.store.insert(name, serializeCard(card));
      this.cache.delete(name);
      return { name, created: !source, meta: cardMetaOf(name, card, now, now) };
    });
  }

  remove(name: string): Promise<CardMeta> {
    return this.lock.exclusive(async () => {
      const n = validateCardName(name);
      const meta = await this.meta(n);
      await this.store.remove(n);
      this.cache.delete(n);
      return meta;
    });
  }
}
