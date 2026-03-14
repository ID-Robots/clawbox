"use client";

/**
 * BrowserApp — Remote browser automation via Playwright.
 * Full input mapping: clicks, double-clicks, scroll, keyboard, mouse move.
 * Streams screenshots from a headless Chromium instance.
 */

import React, { useEffect, useRef, useState, useCallback } from "react";

interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export default function BrowserApp() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [browserState, setBrowserState] = useState<BrowserState>({
    url: "https://www.google.com",
    title: "New Tab",
    loading: false,
    canGoBack: false,
    canGoForward: false,
  });
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState("https://www.google.com");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastScreenshotRef = useRef<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pendingRef = useRef(false);
  const urlBarRef = useRef<HTMLInputElement>(null);

  const api = useCallback(async (action: string, params: Record<string, unknown> = {}) => {
    const res = await fetch("/setup-api/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sessionId, ...params }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(data.error || res.statusText);
    }
    return res.json();
  }, [sessionId]);

  const updateFromResponse = useCallback((data: Record<string, unknown>) => {
    if (data.screenshot && data.screenshot !== lastScreenshotRef.current) {
      lastScreenshotRef.current = data.screenshot as string;
      setScreenshot(data.screenshot as string);
    }
    if (data.url) {
      setBrowserState((s) => ({
        ...s,
        url: data.url as string,
        title: (data.title as string) || s.title,
        loading: false,
        canGoBack: (data.canGoBack as boolean) ?? s.canGoBack,
        canGoForward: (data.canGoForward as boolean) ?? s.canGoForward,
      }));
      setUrlInput(data.url as string);
    }
  }, []);

  // Map viewport pixel coords to browser coords (1280x720)
  const mapCoords = useCallback((e: React.MouseEvent | MouseEvent): { x: number; y: number } | null => {
    if (!imgRef.current) return null;
    const rect = imgRef.current.getBoundingClientRect();
    // Account for object-contain: image may have letterboxing
    const imgAspect = 1280 / 720;
    const boxAspect = rect.width / rect.height;
    let imgLeft = rect.left, imgTop = rect.top, imgW = rect.width, imgH = rect.height;
    if (boxAspect > imgAspect) {
      // Letterboxed horizontally
      imgW = rect.height * imgAspect;
      imgLeft = rect.left + (rect.width - imgW) / 2;
    } else {
      // Letterboxed vertically
      imgH = rect.width / imgAspect;
      imgTop = rect.top + (rect.height - imgH) / 2;
    }
    const x = Math.round(((e.clientX - imgLeft) / imgW) * 1280);
    const y = Math.round(((e.clientY - imgTop) / imgH) * 720);
    if (x < 0 || x > 1280 || y < 0 || y > 720) return null;
    return { x, y };
  }, []);

  // Start browser session
  useEffect(() => {
    let cancelled = false;
    setStarting(true);
    setError(null);

    fetch("/setup-api/browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "launch" }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) { setError(data.error); setStarting(false); return; }
        setSessionId(data.sessionId);
        if (data.screenshot) setScreenshot(data.screenshot);
        setStarting(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setStarting(false);
      });

    return () => { cancelled = true; };
  }, []);

  // Poll for screenshots
  useEffect(() => {
    if (!sessionId) return;

    const poll = async () => {
      if (pendingRef.current) return; // Skip if user interaction in progress
      try {
        const data = await api("screenshot");
        updateFromResponse(data);
      } catch { /* ignore */ }
    };

    poll();
    pollRef.current = setInterval(poll, 800);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [sessionId, api, updateFromResponse]);

  // Cleanup session on unmount
  useEffect(() => {
    const sid = sessionId;
    return () => {
      if (sid) {
        fetch("/setup-api/browser", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "close", sessionId: sid }),
        }).catch(() => {});
      }
    };
  }, [sessionId]);

  const navigate = useCallback(async (url: string) => {
    if (!sessionId) return;
    let target = url.trim();
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = "https://" + target;
    }
    setBrowserState((s) => ({ ...s, loading: true }));
    try {
      const data = await api("navigate", { url: target });
      updateFromResponse(data);
    } catch (err) {
      setBrowserState((s) => ({ ...s, loading: false }));
      setError(err instanceof Error ? err.message : "Navigation failed");
    }
  }, [sessionId, api, updateFromResponse]);

  // Click handler
  const handleClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!sessionId) return;
    const coords = mapCoords(e);
    if (!coords) return;
    pendingRef.current = true;
    try {
      const data = await api("click", coords);
      updateFromResponse(data);
    } catch { /* ignore */ }
    pendingRef.current = false;
  }, [sessionId, api, mapCoords, updateFromResponse]);

  // Double click
  const handleDoubleClick = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!sessionId) return;
    const coords = mapCoords(e);
    if (!coords) return;
    pendingRef.current = true;
    try {
      const data = await api("dblclick", coords);
      updateFromResponse(data);
    } catch { /* ignore */ }
    pendingRef.current = false;
  }, [sessionId, api, mapCoords, updateFromResponse]);

  // Scroll handler
  const handleWheel = useCallback(async (e: React.WheelEvent<HTMLDivElement>) => {
    if (!sessionId) return;
    e.preventDefault();
    const coords = mapCoords(e);
    if (!coords) return;
    pendingRef.current = true;
    try {
      const data = await api("scroll", { ...coords, deltaX: e.deltaX, deltaY: e.deltaY });
      updateFromResponse(data);
    } catch { /* ignore */ }
    pendingRef.current = false;
  }, [sessionId, api, mapCoords, updateFromResponse]);

  // Keyboard handler — capture keys when viewport is focused
  const handleKeyDown = useCallback(async (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!sessionId) return;
    // Don't capture when URL bar is focused
    if (document.activeElement === urlBarRef.current) return;

    e.preventDefault();
    e.stopPropagation();

    pendingRef.current = true;
    try {
      const data = await api("keydown", { key: e.key, code: e.code });
      updateFromResponse(data);
    } catch { /* ignore */ }
    pendingRef.current = false;
  }, [sessionId, api, updateFromResponse]);

  // Mouse move (hover) — throttled
  const lastMoveRef = useRef(0);
  const handleMouseMove = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!sessionId) return;
    const now = Date.now();
    if (now - lastMoveRef.current < 200) return; // Throttle to 5/sec
    lastMoveRef.current = now;
    const coords = mapCoords(e);
    if (!coords) return;
    // Fire and forget — don't wait for response
    api("hover", coords).catch(() => {});
  }, [sessionId, api, mapCoords]);

  const handleNavAction = useCallback(async (action: "back" | "forward" | "refresh") => {
    if (!sessionId) return;
    try {
      const data = await api(action);
      updateFromResponse(data);
    } catch { /* ignore */ }
  }, [sessionId, api, updateFromResponse]);

  if (starting) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#202124] text-white/70 gap-4">
        <span className="material-symbols-rounded animate-spin" style={{ fontSize: 48 }}>progress_activity</span>
        <p className="text-sm">Launching browser...</p>
      </div>
    );
  }

  if (error && !sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#202124] text-white/70 gap-4 p-8">
        <span className="material-symbols-rounded text-red-400" style={{ fontSize: 48 }}>error</span>
        <p className="text-sm text-center max-w-md">{error}</p>
        <p className="text-xs text-white/40 text-center">
          Make sure Playwright is installed: <code className="bg-white/10 px-1.5 py-0.5 rounded">bunx playwright install chromium</code>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#202124]">
      {/* Browser toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[#35363a] border-b border-white/5">
        <button
          onClick={() => handleNavAction("back")}
          disabled={!browserState.canGoBack}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30 text-white/70"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>arrow_back</span>
        </button>
        <button
          onClick={() => handleNavAction("forward")}
          disabled={!browserState.canGoForward}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30 text-white/70"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>arrow_forward</span>
        </button>
        <button
          onClick={() => handleNavAction("refresh")}
          className="p-1 rounded hover:bg-white/10 text-white/70"
        >
          <span className="material-symbols-rounded" style={{ fontSize: 18 }}>
            {browserState.loading ? "close" : "refresh"}
          </span>
        </button>

        <form className="flex-1 flex" onSubmit={(e) => { e.preventDefault(); navigate(urlInput); }}>
          <input
            ref={urlBarRef}
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="w-full px-3 py-1 text-sm bg-[#202124] text-white/90 rounded-full border border-white/10 focus:border-blue-500 focus:outline-none"
            placeholder="Enter URL..."
          />
        </form>
      </div>

      {/* Page title */}
      <div className="px-3 py-1 bg-[#292a2d] text-xs text-white/50 truncate border-b border-white/5">
        {browserState.title}
      </div>

      {/* Viewport — captures all input */}
      <div
        ref={viewportRef}
        className="flex-1 relative overflow-hidden bg-black outline-none"
        tabIndex={0}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onMouseMove={handleMouseMove}
        onContextMenu={(e) => e.preventDefault()}
      >
        {screenshot ? (
          <img
            ref={imgRef}
            src={`data:image/png;base64,${screenshot}`}
            alt="Browser viewport"
            className="w-full h-full object-contain"
            draggable={false}
            style={{ pointerEvents: "none" }}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-white/30">
            <span className="material-symbols-rounded animate-pulse" style={{ fontSize: 64 }}>language</span>
          </div>
        )}
        {browserState.loading && (
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-blue-500 animate-pulse" />
        )}
      </div>
    </div>
  );
}
