"use client";

import { useEffect, useMemo, useState } from "react";
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

  return (
    <iframe
      src={ready ? src : undefined}
      style={FRAME_STYLE}
      sandbox={proxied ? undefined : WEBAPP_IFRAME_SANDBOX}
      data-webapp-id={appId}
      title={title}
    />
  );
}
