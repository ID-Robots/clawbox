"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { APP_REOPEN_ACK, APP_REOPEN_MESSAGE, APP_REOPEN_REPEAT_MS, appReopenHref, appWindowIdOf, navigateAppFrame } from "@/lib/app-window";
import { browserImportPending, importBrowserStorage } from "@/lib/webapp-legacy-browser-import";
import { isProxiedAppUrl, WEBAPP_IFRAME_SANDBOX } from "@/lib/webapp-sandbox";

const FRAME_STYLE = { width: "100%", height: "100%", border: "none", background: "#fff" } as const;

/**
 * A webapp's frame, as the desktop and the standalone /app/[id] page both draw
 * it: the one sandbox (never allow-same-origin — src/lib/webapp-sandbox.ts),
 * and `data-webapp-id` (WEBAPP_FRAME_ID_ATTR), which is how the KV bridge
 * knows whose keys to serve.
 * A project's own server proxied under /apps/<id>/ is the exception to the
 * attribute: a sandboxed frame's navigation carries no cookie and that
 * document needs the owner's; the proxy serves it under a CSP sandbox instead.
 * The pages that document then navigates to ITSELF still arrive without the
 * cookie, so the frame reopens them with its own when the page the middleware
 * answers asks (src/lib/app-window.ts) — the app's own `/apps/<id>/…` only.
 *
 * On a browser that may still hold a pre-v4.0 app's localStorage, the frame
 * is loaded only once that storage has been brought over
 * (src/lib/webapp-legacy-browser-import.ts) — an app loaded first would find
 * its storage empty and could save its empty first screen over the data on
 * its way in. Every other browser, and every app it has already done, loads
 * at once.
 */
export default function WebappFrame({ appId, src, title }: { appId?: string; src: string; title: string }) {
  const proxied = isProxiedAppUrl(src);
  const mustImport = useMemo(() => !proxied && !!appId && browserImportPending(appId), [appId, proxied]);
  const [importedFor, setImportedFor] = useState<string | null>(null);
  const ready = !mustImport || importedFor === appId;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const windowAppId = useMemo(
    () => appWindowIdOf(src, typeof window === "undefined" ? "http://localhost" : window.location.origin, appId),
    [src, appId],
  );

  useEffect(() => {
    if (ready || !appId) return;
    let alive = true;
    void importBrowserStorage(appId).finally(() => {
      if (alive) setImportedFor(appId);
    });
    return () => {
      alive = false;
    };
  }, [appId, ready]);

  // The reopen request of the page this frame navigated to without a cookie.
  // Only from THIS frame (`event.source` is the one identity it cannot
  // forge), only for its own app's address, and not for the address just
  // reopened: asked again that soon, the desktop's cookie did not get it in
  // either, and the page goes on to /login by itself.
  useEffect(() => {
    if (!windowAppId) return;
    let last: { href: string; at: number } | null = null;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || !event.source || event.source !== frame.contentWindow) return;
      const ask = (event.data as Record<string, unknown> | null)?.[APP_REOPEN_MESSAGE];
      if (!ask || typeof ask !== "object") return;
      const href = appReopenHref((ask as { href?: unknown }).href, windowAppId, window.location.origin);
      if (!href) return;
      const now = Date.now();
      if (last && last.href === href && now - last.at < APP_REOPEN_REPEAT_MS) return;
      last = { href, at: now };
      (event.source as Window).postMessage({ [APP_REOPEN_ACK]: true }, "*");
      navigateAppFrame(frame, href);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [windowAppId]);

  return (
    <iframe
      ref={frameRef}
      src={ready ? src : undefined}
      style={FRAME_STYLE}
      sandbox={proxied ? undefined : WEBAPP_IFRAME_SANDBOX}
      data-webapp-id={appId}
      title={title}
    />
  );
}
