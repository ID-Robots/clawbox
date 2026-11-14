// Linked ClawBoxes — the stored list. SERVER ONLY.
//
// The owner's other boxes, in the order Ctrl+Shift+2 … Ctrl+Shift+9 switch
// to them (slot 1 is always this box: see linked-boxes-shape.ts for the
// rules, box-switcher.ts for the switch). One small file in the data
// directory, written whole by `PUT /setup-api/linked-boxes` — the Settings
// panel sends the entire list on every add, remove and move — through a
// temporary file and a rename, so a reader never sees half a list.

import crypto from "crypto";
import os from "os";
import { promises as fsp } from "fs";
import path from "@/lib/runtime-path";
import { DATA_DIR, get } from "@/lib/config-store";
import { createSerialLock } from "@/lib/serial-lock";
import { parseLinkedBoxesRead, type LinkedBox } from "@/lib/linked-boxes-shape";
import { linkedBoxesTranslations } from "@/lib/linked-boxes-translations";
import type { Locale } from "@/lib/i18n";

export const LINKED_BOXES_FILE = path.join(DATA_DIR, "linked-boxes.json");

export class LinkedBoxesStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkedBoxesStoreError";
  }
}

/**
 * The stored list. A missing file is the empty list; a file that cannot be
 * read THROWS (the route says so rather than draw an empty list the owner
 * would then save over); a file that is not JSON, or entries that are not
 * good, read as what is left of it.
 */
export async function readLinkedBoxes(file: string = LINKED_BOXES_FILE): Promise<LinkedBox[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw new LinkedBoxesStoreError("the linked boxes list could not be read");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parseLinkedBoxesRead((parsed as { boxes?: unknown } | null)?.boxes);
  } catch {
    return [];
  }
}

const writeLock = createSerialLock();

/** Replace the list (already checked by `parseLinkedBoxesWrite`). */
export function writeLinkedBoxes(boxes: LinkedBox[], file: string = LINKED_BOXES_FILE): Promise<LinkedBox[]> {
  return writeLock(async () => {
    const kept = parseLinkedBoxesRead(boxes);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await fsp.writeFile(temp, `${JSON.stringify({ version: 1, boxes: kept }, null, 2)}\n`, { mode: 0o600 });
      await fsp.rename(temp, file);
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
    }
    return kept;
  });
}

/**
 * The words the kiosk extension's indicator needs, in the box's language
 * (`pref:ui_language`, the owner's; English when unset or unreadable). The
 * extension has no catalogue of its own, so the list's answer carries them.
 */
export async function boxSwitcherLabels(): Promise<{ empty: string }> {
  let lang: unknown;
  try {
    lang = await get("pref:ui_language");
  } catch {
    lang = undefined;
  }
  const en = linkedBoxesTranslations.en;
  const table = typeof lang === "string" && Object.prototype.hasOwnProperty.call(linkedBoxesTranslations, lang)
    ? linkedBoxesTranslations[lang as Locale]
    : en;
  return { empty: table["desktop.boxSwitcher.empty"] ?? en["desktop.boxSwitcher.empty"] };
}

/**
 * What slot 1 is called: the box's hostname as Settings → Network sets it
 * (the same reading `GET /setup-api/system/hostname` answers), else the
 * system's own.
 */
export async function thisBoxName(): Promise<string> {
  let configured: unknown;
  try {
    configured = await get("hostname");
  } catch {
    configured = undefined;
  }
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return os.hostname() || "ClawBox";
}
