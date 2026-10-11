"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/file-icons";
import ScreenshotEditor, { type EditorImage } from "@/components/ScreenshotEditor";
import ScreenshotOverlay from "@/components/ScreenshotOverlay";
import { displayCaptureSupported, prepareDisplayCapture } from "@/components/screenshot/display-capture";
import { blobToBitmap, resizeBitmap } from "@/components/screenshot/render";
import { useT } from "@/lib/i18n";
import { SCREENSHOTS_DIR, formatByteSize, isValidScreenshotName, screenshotUrl } from "@/lib/screenshot/files";
import { MAX_IMAGE_SIDE, resizeDimensions } from "@/lib/screenshot/geometry";
import {
  type CaptureEngineId,
  type IncomingImage,
  desktopOverlayMounted,
  requestCapture,
  subscribeImages,
  subscribeOverlays,
  takeImage,
} from "@/lib/screenshot/session";
import { type CaptureMode, CAPTURE_SHORTCUTS } from "@/lib/screenshot/shortcuts";
import { dispatchOpenApp } from "@/lib/ui-events";

/**
 * The Screenshot app (TASK-1475): take a picture of the ClawBox desktop — the
 * whole screen or a region, now or after a delay — mark it up, and save it
 * into the Screenshots folder the Files app shows.
 *
 * This window is the app's FRONT: the capture buttons, the recent screenshots
 * and the editor. The capture itself belongs to ScreenshotOverlay, which the
 * desktop mounts once so the keys work with this window closed; a finished
 * capture is left in src/lib/screenshot/session.ts for this window to take.
 */

interface RecentEntry {
  name: string;
  size: number;
  modified: number;
}

const BRAND = "#be123c";
const DELAYS = [0, 3, 5] as const;
const OPENABLE = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif";

let imageSeq = 0;

/** For a value that never changes while the page lives. */
const noSubscription = () => () => {};

function filesUrl(relPath: string): string {
  return `/setup-api/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

/** A picture file as something the editor can open; one over the editor's limit is scaled to fit it. */
async function toEditorImage(blob: Blob, name: string | null): Promise<EditorImage> {
  let bitmap = await blobToBitmap(blob);
  let scaledDown = false;
  if (bitmap.width > MAX_IMAGE_SIDE || bitmap.height > MAX_IMAGE_SIDE) {
    bitmap = resizeBitmap(bitmap, resizeDimensions(bitmap, { width: bitmap.width }, true));
    scaledDown = true;
  }
  imageSeq += 1;
  return { id: imageSeq, bitmap, name, skipped: [], regionApplied: true, scaledDown };
}

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
      <div className="flex rounded-lg bg-black/25 p-0.5" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
            className={`min-h-9 cursor-pointer rounded-md px-3 text-sm transition-colors ${
              option.value === value
                ? "bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ScreenshotApp() {
  const { t, locale } = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [current, setCurrentState] = useState<EditorImage | null>(null);
  const currentRef = useRef<EditorImage | null>(null);
  const dirtyRef = useRef(false);
  /** A picture that arrived while the one in the editor still had unsaved work. */
  const [queued, setQueued] = useState<EditorImage | null>(null);

  const [delay, setDelay] = useState<number>(0);
  const [hideWindow, setHideWindow] = useState(true);
  const [engine, setEngine] = useState<CaptureEngineId>("dom");
  // Whether the browser's own capture exists here: a fact of the page's context, read on the client.
  const browserCapture = useSyncExternalStore(noSubscription, displayCaptureSupported, () => false);
  // Whether the DESKTOP has its overlay up. Followed, not read once: a window
  // restored on a refresh can draw before the desktop has learnt its user is
  // the owner and mounted the overlay. Reading it once left this window with
  // an overlay of its own beside the desktop's — two takers for one Print
  // Screen — and with its desktop-only buttons hidden for good.
  const onDesktop = useSyncExternalStore(subscribeOverlays, desktopOverlayMounted, () => true);
  /** No desktop under the app (the standalone /app/screenshot page): it brings the overlay itself. */
  const ownOverlay = !onDesktop;

  // Where the browser's own capture is offered, this tab is marked now so a later frame of it can be recognised.
  useEffect(() => {
    if (browserCapture) prepareDisplayCapture();
  }, [browserCapture]);

  const [recent, setRecent] = useState<RecentEntry[] | null>(null);
  const [recentError, setRecentError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((image: EditorImage | null) => {
    dirtyRef.current = false;
    currentRef.current = image;
    setQueued(null);
    setError(null);
    setCurrentState(image);
  }, []);

  const receive = useCallback(
    (image: EditorImage) => {
      // Unsaved work is never replaced behind the owner's back: the newcomer waits to be asked for.
      if (currentRef.current && dirtyRef.current) setQueued(image);
      else show(image);
    },
    [show],
  );

  const openBlob = useCallback(
    async (load: () => Promise<Blob>, name: string | null) => {
      setOpening(true);
      setError(null);
      try {
        receive(await toEditorImage(await load(), name));
      } catch {
        setError(t("screenshot.openFailed"));
      } finally {
        setOpening(false);
      }
    },
    [receive, t],
  );

  const fetchBlob = useCallback(async (url: string): Promise<Blob> => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.blob();
  }, []);

  const accept = useCallback(
    (incoming: IncomingImage) => {
      if (incoming.kind === "capture") {
        imageSeq += 1;
        receive({
          id: imageSeq,
          bitmap: incoming.bitmap,
          name: null,
          skipped: incoming.skipped,
          regionApplied: incoming.regionApplied,
          scaledDown: false,
        });
      } else {
        void openBlob(() => fetchBlob(filesUrl(incoming.relPath)), incoming.name);
      }
    },
    [fetchBlob, openBlob, receive],
  );

  // Whatever is waiting when the window opens, and whatever arrives while it is up.
  useEffect(() => {
    const pull = () => {
      const incoming = takeImage();
      if (incoming) accept(incoming);
    };
    pull();
    return subscribeImages(pull);
  }, [accept]);

  const loadRecent = useCallback(async () => {
    try {
      const response = await fetch("/setup-api/screenshots", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { files?: RecentEntry[] };
      setRecent(Array.isArray(data.files) ? data.files.filter((entry) => isValidScreenshotName(entry?.name)) : []);
      setRecentError(false);
    } catch {
      setRecentError(true);
      setRecent((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const capture = useCallback(
    (mode: CaptureMode, withEngine: CaptureEngineId = engine) => {
      // On the desktop the app sits in a ChromeWindow; on a phone it IS the screen.
      const host = rootRef.current?.closest<HTMLElement>("[data-window-id], .mobile-app-window") ?? null;
      // No delay with the browser's own capture: its prompt would only appear
      // AFTER the wait (closing the menu the wait was for), and past a few
      // seconds the browser refuses the call for want of a fresh click.
      requestCapture({ mode, delay: withEngine === "display" ? 0 : delay, engine: withEngine, hide: hideWindow ? host : null });
    },
    [delay, engine, hideWindow],
  );

  const remove = async (name: string) => {
    setConfirmDelete(null);
    try {
      const response = await fetch(`/setup-api/screenshots?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      setRecent((prev) => prev?.filter((entry) => entry.name !== name) ?? prev);
    } catch {
      setError(t("screenshot.deleteFailed"));
    }
  };

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);
  // Leaving the editor with a capture still waiting behind it opens that
  // capture: it was taken on purpose, and going home would drop it unseen.
  const onBack = useCallback(() => show(queued), [queued, show]);
  const onBrowserCapture = useCallback(() => capture("full", "display"), [capture]);

  const formatWhen = (modified: number) => {
    try {
      return new Date(modified).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return new Date(modified).toLocaleString();
    }
  };

  const overlay = ownOverlay ? <ScreenshotOverlay owner="app" /> : null;

  if (current) {
    return (
      <div ref={rootRef} className="flex h-full min-h-0 flex-col" data-testid="screenshot-app">
        {overlay}
        {queued && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-sky-500/30 bg-sky-500/15 px-3 py-2 text-sm text-[var(--text-primary)]" role="status" data-testid="screenshot-queued">
            <Icon name="photo_camera" size={18} className="shrink-0" />
            <span className="min-w-0 flex-1">{t("screenshot.incomingReady")}</span>
            <button
              type="button"
              onClick={() => show(queued)}
              className="cursor-pointer rounded-lg bg-[var(--coral-bright)] px-3 py-1.5 text-sm font-medium text-white hover:brightness-110"
              data-testid="screenshot-queued-open"
            >
              {t("screenshot.incomingOpen")}
            </button>
            <button type="button" onClick={() => setQueued(null)} className="cursor-pointer rounded-lg bg-white/[0.08] px-3 py-1.5 text-sm hover:bg-white/[0.14]">
              {t("screenshot.dismiss")}
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ScreenshotEditor
            key={current.id}
            image={current}
            onBack={onBack}
            onDirtyChange={onDirtyChange}
            onSaved={loadRecent}
            canUseBrowserCapture={browserCapture}
            onBrowserCapture={onBrowserCapture}
            canShowInFiles={!ownOverlay}
          />
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="h-full overflow-y-auto bg-[var(--bg-deep)] text-[var(--text-primary)]" data-testid="screenshot-app">
      {overlay}
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
        <header className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl" style={{ backgroundColor: BRAND }}>
            <Icon name="screenshot_monitor" size={26} color="#ffffff" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold leading-tight">{t("app.screenshot")}</h2>
            <p className="text-sm text-[var(--text-secondary)]">{t("screenshot.tagline")}</p>
          </div>
        </header>

        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert">
            <Icon name="error" size={18} className="shrink-0" />
            <span className="min-w-0 flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              title={t("screenshot.dismiss")}
              aria-label={t("screenshot.dismiss")}
              className="cursor-pointer rounded-md p-1 hover:bg-white/[0.08]"
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        )}

        {/* New capture */}
        <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t("screenshot.captureTitle")}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => capture("full")}
              className="flex cursor-pointer items-center gap-3 rounded-xl bg-[var(--coral-bright)] p-4 text-left text-white transition hover:brightness-110"
              data-testid="screenshot-capture-full"
            >
              <Icon name="screenshot_monitor" size={30} className="shrink-0" />
              <span className="min-w-0">
                <span className="block text-base font-semibold">{t("screenshot.captureFull")}</span>
                <span className="block text-sm text-white/85">{t("screenshot.captureFullHint")}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => capture("region")}
              className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4 text-left transition hover:bg-white/[0.08]"
              data-testid="screenshot-capture-region"
            >
              <Icon name="screenshot_region" size={30} className="shrink-0" color="var(--coral-bright)" />
              <span className="min-w-0">
                <span className="block text-base font-semibold">{t("screenshot.captureRegion")}</span>
                <span className="block text-sm text-[var(--text-secondary)]">{t("screenshot.captureRegionHint")}</span>
              </span>
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
            {engine === "dom" && (
              <Segmented
                label={t("screenshot.delay")}
                value={delay}
                onChange={setDelay}
                options={DELAYS.map((seconds) => ({
                  value: seconds as number,
                  label: seconds === 0 ? t("screenshot.delayNone") : t("screenshot.delaySeconds", { seconds }),
                }))}
              />
            )}
            {browserCapture && (
              <Segmented
                label={t("screenshot.engine")}
                value={engine}
                onChange={setEngine}
                options={[
                  { value: "dom" as CaptureEngineId, label: t("screenshot.engineBuiltIn") },
                  { value: "display" as CaptureEngineId, label: t("screenshot.engineBrowser") },
                ]}
              />
            )}
            <label className="flex min-h-9 cursor-pointer items-center gap-2 text-sm text-[var(--text-secondary)]">
              <input type="checkbox" checked={hideWindow} onChange={(e) => setHideWindow(e.target.checked)} className="h-4 w-4 accent-[var(--coral-bright)]" />
              {t("screenshot.hideWindow")}
            </label>
          </div>

          <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-[var(--text-muted)]" data-testid="screenshot-engine-note">
            <Icon name="info" size={16} className="mt-px shrink-0" />
            <span>
              {engine === "display" && browserCapture ? t("screenshot.engineBrowserNote") : t("screenshot.engineBuiltInNote")}
              {!browserCapture && <> {t("screenshot.engineBrowserUnavailable")}</>}
            </span>
          </p>
        </section>

        {/* Recent */}
        <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="flex-1 text-sm font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t("screenshot.recent")}</h3>
            <button
              type="button"
              onClick={() => void loadRecent()}
              title={t("screenshot.refresh")}
              aria-label={t("screenshot.refresh")}
              className="cursor-pointer rounded-md p-1.5 text-[var(--text-secondary)] hover:bg-white/[0.08] hover:text-[var(--text-primary)]"
            >
              <Icon name="refresh" size={18} />
            </button>
          </div>
          {recent === null ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]">{t("screenshot.loading")}</p>
          ) : recentError && recent.length === 0 ? (
            <p className="py-6 text-center text-sm text-red-300" role="alert">{t("screenshot.recentLoadError")}</p>
          ) : recent.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]" data-testid="screenshot-recent-empty">{t("screenshot.recentEmpty")}</p>
          ) : (
            <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3" data-testid="screenshot-recent">
              {recent.map((entry) => (
                <li key={entry.name} className="overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                  <button
                    type="button"
                    onClick={() => void openBlob(() => fetchBlob(screenshotUrl(entry.name, entry.modified)), entry.name)}
                    title={t("screenshot.open")}
                    aria-label={`${t("screenshot.open")} ${entry.name}`}
                    className="block aspect-video w-full cursor-pointer bg-black/40"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={screenshotUrl(entry.name, entry.modified)} alt="" loading="lazy" className="h-full w-full object-contain" />
                  </button>
                  {/* The name gets the card's whole width and wraps rather than being cut
                      short: every name starts "Screenshot_<date>", and it is the time at
                      its END that tells two of them apart. */}
                  <p className="px-2.5 pt-1.5 text-xs leading-snug text-[var(--text-primary)] [overflow-wrap:anywhere]">{entry.name}</p>
                  <div className="flex items-center gap-1 pb-1 pl-2.5 pr-1">
                    <p className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--text-muted)]">
                      {formatWhen(entry.modified)} · {formatByteSize(entry.size)}
                    </p>
                    {confirmDelete === entry.name ? (
                      <button
                        type="button"
                        autoFocus
                        onClick={() => void remove(entry.name)}
                        onBlur={() => setConfirmDelete(null)}
                        className="min-h-9 shrink-0 cursor-pointer rounded-md bg-red-500/80 px-2 text-xs font-medium text-white hover:bg-red-500"
                        data-testid="screenshot-delete-confirm"
                      >
                        {t("screenshot.deleteConfirm")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(entry.name)}
                        title={t("screenshot.delete")}
                        aria-label={`${t("screenshot.delete")} ${entry.name}`}
                        className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-white/[0.08] hover:text-red-300"
                        data-testid="screenshot-delete"
                      >
                        <Icon name="delete" size={18} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Shortcuts */}
          <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t("screenshot.shortcuts")}</h3>
            <dl className="m-0 space-y-2">
              {CAPTURE_SHORTCUTS.map((shortcut) => (
                <div key={shortcut.id} className="flex items-center gap-2 text-sm">
                  <dt className="min-w-0 flex-1 text-[var(--text-secondary)]">{t(shortcut.labelKey)}</dt>
                  <dd className="m-0 flex flex-wrap justify-end gap-1">
                    {shortcut.keys.map((keys) => (
                      <kbd key={keys} className="rounded-md border border-white/15 bg-black/30 px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-primary)]">{keys}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">{t("screenshot.shortcutsNote")}</p>
          </section>

          {/* Open an existing picture */}
          <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-4">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{t("screenshot.openTitle")}</h3>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={opening}
                className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg bg-white/[0.08] px-3 text-sm hover:bg-white/[0.14] disabled:cursor-default disabled:opacity-50"
                data-testid="screenshot-open-image"
              >
                <Icon name={opening ? "progress_activity" : "upload_file"} size={18} className={opening ? "motion-safe:animate-spin" : ""} />
                {t("screenshot.openImage")}
              </button>
              {/* Only on the desktop: the standalone page has no window manager to open Files in. */}
              {!ownOverlay && (
                <button
                  type="button"
                  onClick={() => dispatchOpenApp("files", { forceNew: true, meta: { path: SCREENSHOTS_DIR } })}
                  className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg bg-white/[0.08] px-3 text-sm hover:bg-white/[0.14]"
                  data-testid="screenshot-open-folder"
                >
                  <Icon name="folder_open" size={18} />
                  {t("screenshot.showInFiles")}
                </button>
              )}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">{t("screenshot.openHint")}</p>
            <input
              ref={fileInput}
              type="file"
              accept={OPENABLE}
              className="hidden"
              data-testid="screenshot-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void openBlob(async () => file, file.name);
              }}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
