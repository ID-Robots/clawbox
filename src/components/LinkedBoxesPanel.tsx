"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StatusMessage from "./StatusMessage";
import { useT } from "@/lib/i18n";
import { copyToClipboard } from "@/lib/clipboard";
import { LINKED_BOXES_CHANGED_EVENT, LINKED_BOXES_URL } from "@/lib/box-switcher";
import {
  MAX_BOX_NAME_LENGTH,
  MAX_BOX_URL_LENGTH,
  MAX_LINKED_BOXES,
  boxOrigin,
  isLoopbackHost,
  normalizeBoxName,
  normalizeBoxUrl,
  parseLinkedBoxesRead,
  type LinkedBox,
} from "@/lib/linked-boxes-shape";

/**
 * Settings → Linked ClawBoxes (TASK-2519): the owner's other boxes, in the
 * order Ctrl+Shift+2 … Ctrl+Shift+9 switch to them. Slot 1 is this box and
 * cannot move. Every add, remove and move saves the whole list at once
 * (`PUT /setup-api/linked-boxes`) and tells the desktop's switcher — and, in
 * the kiosk Chrome, the extension — to read it again.
 *
 * No other source knows the owner's other boxes (the portal heartbeat names
 * only this box's own address), so a box is added by hand; what this panel
 * can offer is THIS box's own addresses, to add on the others so the
 * shortcut leads back here.
 */

type ErrorKey =
  | "invalidName"
  | "invalidUrl"
  | "duplicate"
  | "self"
  | "tooMany"
  | "loadFailed"
  | "saveFailed";

const CODE_KEYS: Record<string, ErrorKey> = {
  invalid_name: "invalidName",
  invalid_url: "invalidUrl",
  duplicate: "duplicate",
  too_many: "tooMany",
  self: "self",
};

interface ListState {
  selfName: string;
  boxes: LinkedBox[];
}

function shortcutLabel(slot: number): string {
  return `Ctrl+Shift+${slot}`;
}

/** This box's own addresses, as another box would reach it. */
function useOwnAddresses(): string[] {
  const [addresses, setAddresses] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const port = window.location.protocol === "http:" && window.location.port ? `:${window.location.port}` : "";
    const found: string[] = [];
    const add = (url: string | null) => {
      if (url && !found.includes(url)) found.push(url);
    };
    void Promise.all([
      fetch("/setup-api/tunnel/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/setup-api/system/hostname", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([tunnel, host]: [{ mode?: unknown; hostname?: unknown } | null, { fqdn?: unknown; ipv4?: unknown } | null]) => {
      if (!live) return;
      // The named tunnel's address is this box's for good; a quick tunnel's
      // changes with every start, so it is never offered.
      if (tunnel?.mode === "named" && typeof tunnel.hostname === "string") add(normalizeBoxUrl(`https://${tunnel.hostname}`));
      if (typeof host?.fqdn === "string") add(normalizeBoxUrl(`http://${host.fqdn}${port}`));
      if (typeof host?.ipv4 === "string") add(normalizeBoxUrl(`http://${host.ipv4}${port}`));
      setAddresses(found);
    });
    return () => {
      live = false;
    };
  }, []);
  return addresses;
}

export default function LinkedBoxesPanel() {
  const { t } = useT();
  const [list, setList] = useState<ListState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const ownAddresses = useOwnAddresses();
  const hereOrigin = typeof window !== "undefined" ? window.location.origin : "";

  // Every read and every save takes the next number; a read's answer is drawn
  // only while its number is still the newest, so a read that was on its way
  // when a save (or a newer read) started can never put an older list back.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const res = await fetch(LINKED_BOXES_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { self?: { name?: unknown }; boxes?: unknown };
      if (mine !== generation.current) return;
      setList({ selfName: normalizeBoxName(body?.self?.name) ?? "ClawBox", boxes: parseLinkedBoxesRead(body?.boxes) });
    } catch {
      if (mine === generation.current) setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (next: LinkedBox[]): Promise<boolean> => {
    if (!list) return false;
    const before = list;
    generation.current += 1;
    setSaving(true);
    setError(null);
    setList({ ...list, boxes: next });
    try {
      const res = await fetch(LINKED_BOXES_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ boxes: next }),
      });
      const body = (await res.json().catch(() => null)) as { code?: unknown; boxes?: unknown; self?: { name?: unknown } } | null;
      if (!res.ok) {
        setList(before);
        setError((typeof body?.code === "string" && CODE_KEYS[body.code]) || "saveFailed");
        return false;
      }
      if (Array.isArray(body?.boxes)) {
        setList({ selfName: normalizeBoxName(body?.self?.name) ?? before.selfName, boxes: parseLinkedBoxesRead(body?.boxes) });
      } else {
        // Saved, but the answer could not be read: keep what was sent and
        // ask the box for its list rather than draw (and later save) none —
        // awaited, so no edit starts (and no later save lands) before the
        // box's list is on screen.
        await load();
      }
      window.dispatchEvent(new Event(LINKED_BOXES_CHANGED_EVENT));
      return true;
    } catch {
      setList(before);
      setError("saveFailed");
      return false;
    } finally {
      setSaving(false);
    }
  }, [list, load]);

  const ownOrigins = useMemo(() => {
    const set = new Set<string>();
    if (hereOrigin) set.add(hereOrigin);
    for (const a of ownAddresses) {
      const o = boxOrigin(a);
      if (o) set.add(o);
    }
    return set;
  }, [hereOrigin, ownAddresses]);

  const boxes = list?.boxes ?? [];
  const full = boxes.length >= MAX_LINKED_BOXES;

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!list || saving) return;
    const cleanName = normalizeBoxName(name);
    if (!cleanName) return setError("invalidName");
    const cleanUrl = normalizeBoxUrl(url);
    if (!cleanUrl) return setError("invalidUrl");
    const origin = boxOrigin(cleanUrl);
    if ((origin && ownOrigins.has(origin)) || isLoopbackHost(new URL(cleanUrl).hostname)) return setError("self");
    if (boxes.some((b) => boxOrigin(b.url) === origin)) return setError("duplicate");
    if (full) return setError("tooMany");
    if (await save([...boxes, { name: cleanName, url: cleanUrl }])) {
      setName("");
      setUrl("");
    }
  };

  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= boxes.length) return;
    const next = [...boxes];
    [next[index], next[to]] = [next[to], next[index]];
    void save(next);
  };

  const remove = (index: number) => {
    void save(boxes.filter((_, i) => i !== index));
  };

  const copy = async (address: string) => {
    if (await copyToClipboard(address)) {
      setCopied(address);
      setTimeout(() => setCopied((c) => (c === address ? null : c)), 1500);
    }
  };

  const slotBadge = (slot: number, self = false) => (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
        self ? "bg-[var(--coral-bright)] text-white" : "bg-white/10 text-white/80"
      }`}
      aria-hidden="true"
    >
      {slot}
    </span>
  );

  const shortcutChip = (slot: number) => (
    <kbd className="hidden sm:inline-block shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
      {shortcutLabel(slot)}
    </kbd>
  );

  const iconButton = (icon: string, label: string, onClick: () => void, disabled: boolean, testId: string) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      data-testid={testId}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-white/[0.06] hover:text-[var(--text-primary)] disabled:opacity-25 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default border-none bg-transparent"
    >
      <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">{icon}</span>
    </button>
  );

  return (
    <div className="max-w-2xl space-y-5" data-testid="linked-boxes-panel">
      <div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">{t("settings.linkedBoxes.title")}</h3>
        <p className="text-sm text-[var(--text-muted)]">{t("settings.linkedBoxes.intro")}</p>
      </div>

      {loadFailed && (
        <div className="flex items-center gap-3">
          <StatusMessage type="error" message={t("settings.linkedBoxes.error.loadFailed")} />
          <button type="button" onClick={() => { setLoadFailed(false); void load(); }} className="text-sm text-[var(--coral-bright)] cursor-pointer bg-transparent border-none">
            {t("settings.linkedBoxes.retry")}
          </button>
        </div>
      )}

      {!list && !loadFailed && (
        <p className="text-sm text-[var(--text-muted)]">{t("settings.linkedBoxes.loading")}</p>
      )}

      {list && (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-2" data-testid="linked-boxes-list">
          <ol className="m-0 list-none p-0">
            <li className="flex items-center gap-3 rounded-xl px-3 py-2.5" data-testid="linked-boxes-row-1">
              {slotBadge(1, true)}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-[var(--text-primary)]">{list.selfName}</span>
                  <span className="shrink-0 rounded-full bg-[var(--coral-bright)]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--coral-bright)]">
                    {t("settings.linkedBoxes.thisBox")}
                  </span>
                </div>
                <div className="truncate text-xs text-[var(--text-muted)]">{hereOrigin ? `${hereOrigin}/` : ""}</div>
              </div>
              {shortcutChip(1)}
              {/* As wide as the three buttons of the other rows, so the shortcuts line up. */}
              <span className="w-24 shrink-0" aria-hidden="true" />
            </li>
            {boxes.map((box, i) => {
              const slot = i + 2;
              return (
                <li key={box.url} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-white/[0.03]" data-testid={`linked-boxes-row-${slot}`}>
                  {slotBadge(slot)}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--text-primary)]">{box.name}</div>
                    <div className="truncate text-xs text-[var(--text-muted)]">{box.url}</div>
                  </div>
                  {shortcutChip(slot)}
                  <div className="flex shrink-0 items-center">
                    {iconButton("arrow_upward", t("settings.linkedBoxes.moveUp", { name: box.name }), () => move(i, -1), saving || i === 0, `linked-boxes-up-${slot}`)}
                    {iconButton("arrow_downward", t("settings.linkedBoxes.moveDown", { name: box.name }), () => move(i, 1), saving || i === boxes.length - 1, `linked-boxes-down-${slot}`)}
                    {iconButton("delete", t("settings.linkedBoxes.remove", { name: box.name }), () => remove(i), saving, `linked-boxes-remove-${slot}`)}
                  </div>
                </li>
              );
            })}
          </ol>
          {boxes.length === 0 && (
            <p className="px-3 pb-2 pt-1 text-xs text-[var(--text-muted)]" data-testid="linked-boxes-empty">{t("settings.linkedBoxes.empty")}</p>
          )}
        </div>
      )}

      {list && (
        <form onSubmit={add} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 space-y-3" data-testid="linked-boxes-add-form">
          <div className="flex items-center gap-2">
            <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">add_link</span>
            <h4 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.linkedBoxes.addTitle")}</h4>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="flex flex-col gap-1 sm:w-44">
              <span className="text-[11px] text-[var(--text-muted)]">{t("settings.linkedBoxes.name")}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(null); }}
                maxLength={MAX_BOX_NAME_LENGTH}
                placeholder={t("settings.linkedBoxes.namePlaceholder")}
                disabled={full || saving}
                data-testid="linked-boxes-name-input"
                className="px-3.5 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none placeholder-white/20 focus:border-orange-400/60 disabled:opacity-40"
              />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[11px] text-[var(--text-muted)]">{t("settings.linkedBoxes.url")}</span>
              <input
                type="text"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(null); }}
                maxLength={MAX_BOX_URL_LENGTH}
                placeholder="https://laptop.example.com"
                disabled={full || saving}
                data-testid="linked-boxes-url-input"
                className="px-3.5 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-xl text-sm text-[var(--text-primary)] outline-none placeholder-white/20 focus:border-orange-400/60 disabled:opacity-40"
              />
            </label>
            <button
              type="submit"
              disabled={saving || full || !name.trim() || !url.trim()}
              data-testid="linked-boxes-add"
              className="self-end px-4 py-2.5 bg-[#fe6e00] hover:bg-[#ff8b1a] disabled:opacity-30 text-white rounded-xl text-sm font-semibold cursor-pointer border-none transition-all"
            >
              {saving ? t("settings.linkedBoxes.saving") : t("settings.linkedBoxes.add")}
            </button>
          </div>
          {full && <p className="text-xs text-[var(--text-muted)]">{t("settings.linkedBoxes.full")}</p>}
          {error && (
            <div data-testid="linked-boxes-error">
              <StatusMessage type="error" message={t(`settings.linkedBoxes.error.${error}`)} />
            </div>
          )}
        </form>
      )}

      {ownAddresses.length > 0 && (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="linked-boxes-own-addresses">
          <div className="flex items-center gap-2 mb-2">
            <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">link</span>
            <h4 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.linkedBoxes.ownAddressTitle")}</h4>
          </div>
          <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">{t("settings.linkedBoxes.ownAddressHint")}</p>
          <ul className="m-0 list-none space-y-1.5 p-0">
            {ownAddresses.map((address, i) => (
              <li key={address} className="flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-primary)]" data-testid={`linked-boxes-own-address-${i}`}>{address}</span>
                <button
                  type="button"
                  onClick={() => void copy(address)}
                  className="shrink-0 text-xs text-[var(--coral-bright)] cursor-pointer bg-transparent border-none"
                >
                  {copied === address ? t("settings.linkedBoxes.copied") : t("settings.linkedBoxes.copy")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5" data-testid="linked-boxes-help">
        <div className="flex items-center gap-2 mb-3">
          <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">keyboard</span>
          <h4 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t("settings.linkedBoxes.howTitle")}</h4>
        </div>
        <ul className="m-0 list-disc space-y-2 pl-5 text-xs leading-relaxed text-[var(--text-muted)]">
          <li>{t("settings.linkedBoxes.howBrowser")}</li>
          <li>{t("settings.linkedBoxes.howReturn")}</li>
          <li>{t("settings.linkedBoxes.howKiosk")}</li>
          <li>{t("settings.linkedBoxes.howFrames")}</li>
        </ul>
      </div>
    </div>
  );
}
