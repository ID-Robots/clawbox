// The Screenshot app's own renderer: a picture of the desktop made from the
// page itself, with no browser permission and no secure context — which is
// what the box is opened in when it is reached over plain http on the LAN,
// where getDisplayMedia does not exist.
//
// How it works. The live document is cloned, stylesheets and the fonts the
// page has loaded are embedded, and the clone is laid inside an SVG
// <foreignObject>; the browser draws that SVG onto a canvas with the same
// layout engine that drew the page. What an SVG image cannot hold is put there
// first, in place, so stacking and clipping stay right:
//
//   <canvas>            read with drawImage (the terminal, the noVNC screen
//                       behind Browser and Remote Desktop) and laid in as the
//                       element's background
//   <img>, backgrounds  fetched and inlined as data URLs
//   same-origin frame   rendered the same way, recursively
//   <video>             its current frame
//
// What cannot be read is an iframe from another origin — every installed web
// app is one, sandboxed to an opaque origin on purpose — and a plugin
// document (the PDF viewer). No script on this page may look inside those, so
// each is drawn as a labelled tile and REPORTED to the caller, which tells the
// owner; it is never left as an unexplained blank.
//
// Scroll offsets, form values and the current frame of running animations are
// copied onto the clone, because none of them are in the markup.

import { type Point, type Rect, type Size, rectsIntersect } from "@/lib/screenshot/geometry";
import type { SkippedKind, SkippedSurface } from "@/lib/screenshot/session";
import {
  type LoadedFonts,
  cssPropertyName,
  cssUrls,
  isXmlAttributeName,
  normalizeFontFamily,
  normalizeUnicodeRange,
  parseFontFaces,
  fontFaceIsUsed,
  replaceCssUrls,
  rewriteFontFaces,
  sanitizeXml,
} from "@/lib/screenshot/capture-css";

/** Put on anything that must not appear in a capture: the app's own overlay, its countdown. */
export const IGNORE_ATTRIBUTE = "data-screenshot-ignore";

export type { SkippedKind, SkippedSurface } from "@/lib/screenshot/session";

export type CaptureFailure = "render" | "unsupported" | "denied" | "busy";

export class CaptureError extends Error {
  constructor(
    public readonly code: CaptureFailure,
    message: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

export interface DomCaptureOptions {
  /** Bitmap pixels per CSS pixel. */
  scale: number;
  /** The words drawn on the tile that stands in for a surface that cannot be read. */
  blockedLabel: string;
  /** Called once the page has been read — whatever was hidden for the capture can come back. */
  onRead?: () => void;
}

export interface DomCaptureResult {
  bitmap: HTMLCanvasElement;
  scale: number;
  skipped: SkippedSurface[];
}

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Kept as empty elements so sibling selectors (:first-child, +, ~) still count the same. */
const EMPTY_TAGS = new Set(["script", "noscript", "template", "style", "link", "meta", "title", "base"]);
const FRAME_TAGS = new Set(["iframe", "frame", "object", "embed"]);
/** Attributes of a frame that mean nothing on the box that stands in for it. */
const FRAME_ATTRIBUTES = new Set(["src", "srcdoc", "data", "name", "sandbox", "allow", "loading", "type", "width", "height", "nonce"]);
const URL_PROPERTIES = ["background-image", "mask-image", "border-image-source", "list-style-image"];

const MAX_INLINE_BYTES = 12 * 1024 * 1024;
const MAX_SURFACE_SIDE = 4096;
const MAX_FRAME_DEPTH = 3;
const FETCH_TIMEOUT_MS = 8000;

const FREEZE_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;" +
  "caret-color:transparent!important;scroll-behavior:auto!important}";

interface StyleTask {
  clone: Element;
  property: string;
  value: string;
}

interface ImageTask {
  clone: Element;
  attribute: string;
  url: string;
  source: HTMLImageElement | null;
}

interface FrameTask {
  clone: Element;
  size: Size;
  label: string;
  rect: Rect;
  inner: Snapshot | null;
}

interface Snapshot {
  doc: Document;
  win: Window;
  work: Document;
  size: Size;
  /** This document's top-left corner in the top-level viewport. */
  origin: Point;
  depth: number;
  root: Element;
  backdrop: string;
  styles: StyleTask[];
  images: ImageTask[];
  frames: FrameTask[];
  clones: WeakMap<Element, Element>;
}

interface Context {
  scale: number;
  blockedLabel: string;
  viewport: Size;
  skipped: SkippedSurface[];
  inlined: Map<string, Promise<string | null>>;
}

/** Font files are static and large; one fetch serves every capture of the session. */
const fontCache = new Map<string, Promise<string | null>>();

// ── Small helpers ───────────────────────────────────────────────────────────

/** Appends an inline declaration. A string, not `.style`: the clone lives in a document with no view. */
function addStyle(el: Element, property: string, value: string): void {
  const existing = el.getAttribute("style")?.trim() ?? "";
  const separator = existing && !existing.endsWith(";") ? ";" : "";
  el.setAttribute("style", `${existing}${separator}${property}:${value} !important;`);
}

function absoluteUrl(url: string, base: string): string | null {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

async function fetchWithTimeout(url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "force-cache", signal: controller.signal });
    return response.ok ? response : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDataUrl(url: string): Promise<string | null> {
  if (url.startsWith("data:")) return url;
  const response = await fetchWithTimeout(url);
  if (!response) return null;
  try {
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > MAX_INLINE_BYTES) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

function inline(url: string, ctx: Context): Promise<string | null> {
  let pending = ctx.inlined.get(url);
  if (!pending) {
    pending = fetchDataUrl(url);
    ctx.inlined.set(url, pending);
  }
  return pending;
}

function fontDataUrl(url: string): Promise<string | null> {
  let pending = fontCache.get(url);
  if (!pending) {
    pending = fetchDataUrl(url);
    fontCache.set(url, pending);
    // A failed fetch is not remembered: the next capture tries again.
    void pending.then((data) => {
      if (!data) fontCache.delete(url);
    });
  }
  return pending;
}

function scratchCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/** The pixels of a canvas or a video frame as a PNG, or null when the browser will not hand them over. */
function readSurface(source: HTMLCanvasElement | HTMLVideoElement, width: number, height: number): string | null {
  if (width < 1 || height < 1) return null;
  try {
    const fit = Math.min(1, MAX_SURFACE_SIDE / Math.max(width, height));
    const canvas = scratchCanvas(width * fit, height * fit);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } catch {
    // A tainted canvas (it drew something cross-origin) refuses to be read.
    return null;
  }
}

function paintBackground(clone: Element, dataUrl: string, fit: "fill" | "contain"): void {
  addStyle(clone, "background-image", `url("${dataUrl}")`);
  addStyle(clone, "background-repeat", "no-repeat");
  addStyle(clone, "background-position", "center");
  addStyle(clone, "background-size", fit === "fill" ? "100% 100%" : "contain");
  addStyle(clone, "background-origin", "content-box");
  addStyle(clone, "background-clip", "content-box");
}

/** The tile drawn where a surface could not be read: visibly not the real thing, and says so. */
function blockedTile(size: Size, label: string, ctx: Context): string {
  const width = Math.min(Math.max(1, size.width), 2048);
  const height = Math.min(Math.max(1, size.height), 2048);
  const scale = Math.min(Math.max(ctx.scale, 1), 2);
  const canvas = scratchCanvas(width * scale, height * scale);
  const g = canvas.getContext("2d");
  if (!g) return "";
  g.scale(scale, scale);
  g.fillStyle = "#161b26";
  g.fillRect(0, 0, width, height);
  g.strokeStyle = "rgba(255,255,255,0.055)";
  g.lineWidth = 10;
  for (let x = -height; x < width; x += 30) {
    g.beginPath();
    g.moveTo(x, height);
    g.lineTo(x + height, 0);
    g.stroke();
  }
  g.strokeStyle = "rgba(255,255,255,0.3)";
  g.lineWidth = 2;
  g.setLineDash([8, 6]);
  g.strokeRect(6, 6, Math.max(0, width - 12), Math.max(0, height - 12));
  g.setLineDash([]);
  if (width >= 140 && height >= 56) {
    const family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "rgba(255,255,255,0.88)";
    g.font = `600 14px ${family}`;
    const title = label.trim();
    g.fillText(ctx.blockedLabel, width / 2, height / 2 - (title ? 10 : 0), width - 32);
    if (title) {
      g.fillStyle = "rgba(255,255,255,0.6)";
      g.font = `400 12px ${family}`;
      g.fillText(title.length > 60 ? `${title.slice(0, 59)}…` : title, width / 2, height / 2 + 12, width - 32);
    }
  }
  return canvas.toDataURL("image/png");
}

function report(ctx: Context, kind: SkippedKind, label: string, rect: Rect): void {
  // Something off screen or a few pixels wide is not a hole anyone will see.
  if (rect.width < 16 || rect.height < 16) return;
  if (!rectsIntersect(rect, { x: 0, y: 0, width: ctx.viewport.width, height: ctx.viewport.height })) return;
  ctx.skipped.push({ kind, label, rect });
}

function scrubAttributes(clone: Element): void {
  for (const attr of Array.from(clone.attributes)) {
    // A name XML cannot parse, or a prefix bound to nothing, would stop the whole image decoding.
    if (!isXmlAttributeName(attr.name) || (attr.name.includes(":") && attr.namespaceURI === null)) {
      clone.removeAttribute(attr.name);
    }
  }
  clone.removeAttribute("nonce");
}

function frameLabel(el: Element): string {
  const named = el.getAttribute("title") || el.getAttribute("aria-label");
  if (named) return named.trim();
  const src = el.getAttribute("src") || el.getAttribute("data") || "";
  try {
    return src ? new URL(src, el.ownerDocument.baseURI).host : "";
  } catch {
    return "";
  }
}

/** A frame whose document is only a plugin (the PDF viewer): reachable, but with nothing in it to draw. */
function isPluginDocument(doc: Document): boolean {
  const only = doc.body?.children.length === 1 ? doc.body.firstElementChild : null;
  return !!only && (only.localName === "embed" || only.localName === "object");
}

function isScrollable(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function offsetRect(rect: DOMRect, origin: Point): Rect {
  return { x: origin.x + rect.left, y: origin.y + rect.top, width: rect.width, height: rect.height };
}

// ── The snapshot: everything read from the live page, in one synchronous pass ─

/**
 * What stands in the picture for an <iframe>, <object> or <embed>. Not a clone
 * of the element: even inside an SVG image a frame paints its own (empty)
 * document over whatever is laid in behind it, which is how a first version of
 * this drew every frame as a blank box. A <div> with the frame's classes, its
 * box and its border paints only what it is given.
 */
function frameStandIn(el: Element, style: CSSStyleDeclaration, snap: Snapshot): Element {
  const box = snap.work.createElement("div");
  for (const attr of Array.from(el.attributes)) {
    if (FRAME_ATTRIBUTES.has(attr.name) || !isXmlAttributeName(attr.name) || attr.name.includes(":")) continue;
    box.setAttribute(attr.name, attr.value);
  }
  const html = el as HTMLElement;
  addStyle(box, "display", style.display === "inline" ? "inline-block" : style.display);
  addStyle(box, "box-sizing", "border-box");
  addStyle(box, "width", `${html.offsetWidth}px`);
  addStyle(box, "height", `${html.offsetHeight}px`);
  for (const side of ["top", "right", "bottom", "left"]) {
    const width = style.getPropertyValue(`border-${side}-width`);
    const line = style.getPropertyValue(`border-${side}-style`);
    const color = style.getPropertyValue(`border-${side}-color`);
    addStyle(box, `border-${side}`, `${width} ${line} ${color}`);
  }
  return box;
}

function cloneFrame(el: Element, clone: Element, snap: Snapshot, ctx: Context): void {
  const box = el.getBoundingClientRect();
  const html = el as HTMLElement;
  const size = { width: html.clientWidth || box.width, height: html.clientHeight || box.height };
  const rect = offsetRect(box, snap.origin);
  let inner: Snapshot | null = null;
  if ((el.localName === "iframe" || el.localName === "frame") && size.width >= 1 && size.height >= 1) {
    let innerDoc: Document | null = null;
    try {
      innerDoc = (el as HTMLIFrameElement).contentDocument;
    } catch {
      innerDoc = null;
    }
    if (innerDoc?.documentElement && innerDoc.body && innerDoc.defaultView && snap.depth < MAX_FRAME_DEPTH && !isPluginDocument(innerDoc)) {
      try {
        inner = takeSnapshot(
          innerDoc,
          size,
          { x: rect.x + html.clientLeft, y: rect.y + html.clientTop },
          snap.depth + 1,
          ctx,
        );
      } catch {
        inner = null;
      }
    }
  }
  const label = frameLabel(el);
  if (!inner) report(ctx, "frame", label, rect);
  snap.frames.push({ clone, size, label, rect, inner });
}

function cloneElement(el: Element, snap: Snapshot, ctx: Context, parentScroll: Point | null): Element | null {
  if (el.hasAttribute(IGNORE_ATTRIBUTE)) return null;
  const tag = el.localName;
  const isHtml = el.namespaceURI === XHTML_NS;
  if (isHtml && tag === "head") return null;
  if (isHtml && EMPTY_TAGS.has(tag)) return snap.work.createElement(tag);

  const style = snap.win.getComputedStyle(el);
  const isFrame = isHtml && FRAME_TAGS.has(tag);
  const clone = isFrame ? frameStandIn(el, style, snap) : (snap.work.importNode(el, false) as Element);
  if (!isFrame) scrubAttributes(clone);
  snap.clones.set(el, clone);
  // Kept (so its siblings keep their positions) but not descended into.
  if (style.display === "none") return clone;

  if (parentScroll && style.position !== "fixed" && style.position !== "sticky") {
    addStyle(clone, "translate", `${-parentScroll.x}px ${-parentScroll.y}px`);
  }

  for (const property of URL_PROPERTIES) {
    const value = style.getPropertyValue(property);
    if (value && value.includes("url(") && cssUrls(value).some((u) => !u.startsWith("data:"))) {
      snap.styles.push({ clone, property, value });
    }
  }

  if (isHtml) {
    switch (tag) {
      case "input": {
        const input = el as HTMLInputElement;
        if (input.type === "checkbox" || input.type === "radio") {
          if (input.checked) clone.setAttribute("checked", "");
          else clone.removeAttribute("checked");
        } else if (input.type !== "file") {
          clone.setAttribute("value", input.value);
        }
        return clone;
      }
      case "textarea":
        clone.textContent = (el as HTMLTextAreaElement).value;
        return clone;
      case "option":
        if ((el as HTMLOptionElement).selected) clone.setAttribute("selected", "");
        else clone.removeAttribute("selected");
        break;
      case "img": {
        const img = el as HTMLImageElement;
        for (const name of ["srcset", "sizes", "loading", "decoding", "crossorigin"]) clone.removeAttribute(name);
        const url = img.currentSrc || img.src;
        if (url && !url.startsWith("data:")) snap.images.push({ clone, attribute: "src", url, source: img });
        else if (url) clone.setAttribute("src", url);
        return clone;
      }
      case "canvas": {
        const canvas = el as HTMLCanvasElement;
        const data = readSurface(canvas, canvas.width, canvas.height);
        if (data) paintBackground(clone, data, "fill");
        else if (canvas.width > 0 && canvas.height > 0) {
          const box = canvas.getBoundingClientRect();
          paintBackground(clone, blockedTile(box, "", ctx), "fill");
          report(ctx, "canvas", "", offsetRect(box, snap.origin));
        }
        return clone;
      }
      case "video": {
        const video = el as HTMLVideoElement;
        const box = video.getBoundingClientRect();
        for (const name of ["src", "poster", "controls", "autoplay", "preload"]) clone.removeAttribute(name);
        addStyle(clone, "width", `${box.width}px`);
        addStyle(clone, "height", `${box.height}px`);
        const data = video.readyState >= 2 ? readSurface(video, video.videoWidth, video.videoHeight) : null;
        if (data) paintBackground(clone, data, "contain");
        else if (video.readyState >= 2) {
          paintBackground(clone, blockedTile(box, "", ctx), "fill");
          report(ctx, "media", "", offsetRect(box, snap.origin));
        }
        return clone;
      }
      default:
        if (isFrame) {
          cloneFrame(el, clone, snap, ctx);
          return clone;
        }
    }
  } else if (el.namespaceURI === SVG_NS && tag === "image") {
    const href = el.getAttribute("href") || el.getAttributeNS("http://www.w3.org/1999/xlink", "href");
    const url = href ? absoluteUrl(href, snap.doc.baseURI) : null;
    if (url && !url.startsWith("data:")) {
      clone.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
      snap.images.push({ clone, attribute: "href", url, source: null });
    }
  }

  const html = el as HTMLElement;
  if (isHtml && tag !== "html" && tag !== "body" && (isScrollable(style.overflowX) || isScrollable(style.overflowY))) {
    // The clone cannot be scrolled, so its scrollbar would sit at the top
    // whatever the page shows — and, where the live page draws none (overlay
    // scrollbars), would also take width the live content has, re-wrapping
    // every line. Clip instead, and keep exactly the gutter the live one took.
    const gutterY = html.offsetWidth - html.clientWidth - px(style.borderLeftWidth) - px(style.borderRightWidth);
    const gutterX = html.offsetHeight - html.clientHeight - px(style.borderTopWidth) - px(style.borderBottomWidth);
    addStyle(clone, "overflow", "hidden");
    if (gutterY > 0.5) {
      const side = style.direction === "rtl" ? "left" : "right";
      addStyle(clone, `padding-${side}`, `${px(style.getPropertyValue(`padding-${side}`)) + gutterY}px`);
    }
    if (gutterX > 0.5) addStyle(clone, "padding-bottom", `${px(style.paddingBottom) + gutterX}px`);
  }
  const scroll = html.scrollLeft || html.scrollTop ? { x: html.scrollLeft, y: html.scrollTop } : null;
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === Node.TEXT_NODE) {
      clone.appendChild(snap.work.createTextNode((node as Text).data));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const child = cloneElement(node as Element, snap, ctx, scroll);
      if (child) clone.appendChild(child);
    }
  }
  return clone;
}

/** Writes the CURRENT value of every animated property onto the clone, which will not animate. */
function freezeAnimations(snap: Snapshot): void {
  const animations = typeof snap.doc.getAnimations === "function" ? snap.doc.getAnimations() : [];
  for (const animation of animations) {
    const effect = animation.effect as KeyframeEffect | null;
    const target = effect?.target;
    if (!effect || !target || effect.pseudoElement) continue;
    const clone = snap.clones.get(target);
    if (!clone) continue;
    let frames: ComputedKeyframe[];
    try {
      frames = effect.getKeyframes();
    } catch {
      continue;
    }
    const properties = new Set<string>();
    for (const frame of frames) {
      for (const key of Object.keys(frame)) {
        if (key === "offset" || key === "computedOffset" || key === "easing" || key === "composite") continue;
        properties.add(cssPropertyName(key));
      }
    }
    const style = snap.win.getComputedStyle(target);
    for (const property of properties) {
      const value = style.getPropertyValue(property);
      if (value) addStyle(clone, property, value);
    }
  }
}

function isTransparent(color: string): boolean {
  return !color || color === "transparent" || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(color);
}

function takeSnapshot(doc: Document, size: Size, origin: Point, depth: number, ctx: Context): Snapshot {
  const win = doc.defaultView;
  if (!win) throw new CaptureError("render", "The page has no view to capture.");
  const work = document.implementation.createHTMLDocument("");
  const snap: Snapshot = {
    doc,
    win,
    work,
    size,
    origin,
    depth,
    root: work.createElement("div"),
    backdrop: "transparent",
    styles: [],
    images: [],
    frames: [],
    clones: new WeakMap(),
  };
  const root = cloneElement(doc.documentElement, snap, ctx, null);
  if (root) {
    snap.root = root;
    // A page with a scrollbar of its own is laid out in the width that left it.
    const layoutWidth = doc.documentElement.clientWidth;
    if (layoutWidth > 0 && layoutWidth < Math.round(size.width)) addStyle(root, "width", `${layoutWidth}px`);
  }
  freezeAnimations(snap);

  // A page's background reaches the whole viewport even where its <body> does not.
  const htmlStyle = win.getComputedStyle(doc.documentElement);
  let backdrop = htmlStyle.backgroundColor;
  if (isTransparent(backdrop) && doc.body) backdrop = win.getComputedStyle(doc.body).backgroundColor;
  if (isTransparent(backdrop)) {
    const scheme = htmlStyle.getPropertyValue("color-scheme");
    backdrop = depth > 0 ? "transparent" : scheme.includes("dark") && !scheme.includes("light") ? "#121212" : "#ffffff";
  }
  snap.backdrop = backdrop;
  return snap;
}

// ── Finishing a snapshot: the asynchronous half ─────────────────────────────

function loadedFonts(doc: Document): LoadedFonts {
  const fonts = doc.fonts;
  if (!fonts || typeof fonts.forEach !== "function") return null;
  const loaded = new Map<string, Set<string>>();
  fonts.forEach((face) => {
    if (face.status !== "loaded") return;
    const family = normalizeFontFamily(face.family);
    const ranges = loaded.get(family) ?? new Set<string>();
    ranges.add(normalizeUnicodeRange(face.unicodeRange || "U+0-10FFFF"));
    loaded.set(family, ranges);
  });
  return loaded;
}

function rulesText(sheet: CSSStyleSheet, depth: number): string {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return "";
  }
  let text = "";
  for (const rule of Array.from(rules)) {
    // By type, not `instanceof`: a rule from a frame's document belongs to that frame's realm.
    if (rule.type === 3) {
      const imported = (rule as CSSImportRule).styleSheet;
      if (!imported || depth >= 8) continue;
      const inner = rulesText(imported, depth + 1);
      const media = (rule as CSSImportRule).media?.mediaText;
      text += media && media !== "all" ? `@media ${media}{${inner}}` : inner;
    } else {
      text += `${rule.cssText}\n`;
    }
  }
  return text;
}

async function sheetText(sheet: CSSStyleSheet): Promise<string> {
  const owner = sheet.ownerNode as Element | null;
  // The source as written is the most faithful copy; the parsed rules are the
  // fallback, and the only form that can follow an @import.
  if (owner && owner.nodeType === 1 && owner.localName === "style") {
    const raw = owner.textContent ?? "";
    if (raw.trim() && !/@import/i.test(raw)) return raw;
  } else if (sheet.href) {
    const response = await fetchWithTimeout(sheet.href);
    const raw = response ? await response.text().catch(() => "") : "";
    if (raw.trim() && !/@import/i.test(raw)) return raw;
  }
  return rulesText(sheet, 0);
}

async function embedFonts(css: string, base: string, loaded: LoadedFonts): Promise<string> {
  if (!/@font-face/i.test(css)) return css;
  const sources = new Map<string, string | null>();
  await Promise.all(
    parseFontFaces(css)
      .filter((block) => fontFaceIsUsed(block, loaded))
      .map(async (block) => {
        const url = block.url ? absoluteUrl(block.url, base) : null;
        if (block.url && !sources.has(block.url)) sources.set(block.url, url ? await fontDataUrl(url) : null);
      }),
  );
  return rewriteFontFaces(css, loaded, sources);
}

async function collectCss(doc: Document): Promise<string> {
  const loaded = loadedFonts(doc);
  const sheets: CSSStyleSheet[] = [...Array.from(doc.styleSheets), ...(doc.adoptedStyleSheets ?? [])];
  const parts = await Promise.all(
    sheets.map(async (sheet) => {
      if (sheet.disabled) return "";
      let text = await sheetText(sheet);
      if (!text) return "";
      text = await embedFonts(text, sheet.href || doc.baseURI, loaded);
      const media = sheet.media?.mediaText;
      return media && media !== "all" ? `@media ${media}{${text}}` : text;
    }),
  );
  return parts.filter(Boolean).join("\n");
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new CaptureError("render", "The browser could not draw the page."));
    img.src = url;
  });
}

async function finishImages(snap: Snapshot, ctx: Context): Promise<void> {
  await Promise.all(
    snap.images.map(async (task) => {
      let data = await inline(task.url, ctx);
      if (!data && task.source?.complete && task.source.naturalWidth > 0) {
        // Not fetchable (another origin without CORS); the decoded picture may still be readable.
        try {
          const canvas = scratchCanvas(task.source.naturalWidth, task.source.naturalHeight);
          canvas.getContext("2d")?.drawImage(task.source, 0, 0);
          data = canvas.toDataURL("image/png");
        } catch {
          data = null;
        }
      }
      if (data) task.clone.setAttribute(task.attribute, data);
      else task.clone.removeAttribute(task.attribute);
    }),
  );
}

async function finishStyles(snap: Snapshot, ctx: Context): Promise<void> {
  await Promise.all(
    snap.styles.map(async (task) => {
      const urls = cssUrls(task.value).filter((u) => !u.startsWith("data:"));
      const resolved = new Map<string, string | null>();
      await Promise.all(
        urls.map(async (url) => {
          const absolute = absoluteUrl(url, snap.doc.baseURI);
          resolved.set(url, absolute ? await inline(absolute, ctx) : null);
        }),
      );
      const value = replaceCssUrls(task.value, (url) => (url.startsWith("data:") ? null : (resolved.get(url) ?? "")));
      addStyle(task.clone, task.property, value);
      if (task.property === "mask-image") addStyle(task.clone, "-webkit-mask-image", value);
    }),
  );
}

async function finishFrames(snap: Snapshot, ctx: Context): Promise<void> {
  await Promise.all(
    snap.frames.map(async (frame) => {
      let data: string | null = null;
      if (frame.inner) {
        try {
          data = (await renderSnapshot(frame.inner, ctx)).toDataURL("image/png");
        } catch {
          data = null;
          report(ctx, "frame", frame.label, frame.rect);
        }
      }
      if (!data) data = blockedTile(frame.size, frame.label, ctx);
      if (data) paintBackground(frame.clone, data, "fill");
    }),
  );
}

async function renderSnapshot(snap: Snapshot, ctx: Context): Promise<HTMLCanvasElement> {
  const [css] = await Promise.all([
    collectCss(snap.doc),
    finishFrames(snap, ctx),
    finishImages(snap, ctx),
    finishStyles(snap, ctx),
  ]);

  const { work } = snap;
  const width = Math.max(1, Math.round(snap.size.width));
  const height = Math.max(1, Math.round(snap.size.height));

  const svg = work.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  // The page's own root carries its theme (classes, data attributes, inline
  // custom properties); `:root` rules now match the <svg>, so it gets them too.
  for (const attr of Array.from(snap.doc.documentElement.attributes)) {
    if (attr.name === "xmlns" || !isXmlAttributeName(attr.name) || attr.name.includes(":")) continue;
    if (attr.name === "width" || attr.name === "height" || attr.name === "viewBox") continue;
    svg.setAttribute(attr.name, attr.value);
  }
  const foreign = work.createElementNS(SVG_NS, "foreignObject");
  foreign.setAttribute("x", "0");
  foreign.setAttribute("y", "0");
  foreign.setAttribute("width", String(width));
  foreign.setAttribute("height", String(height));
  const stage = work.createElement("div");
  stage.setAttribute(
    "style",
    `position:relative;width:${width}px;height:${height}px;overflow:hidden;background-color:${snap.backdrop};`,
  );
  const sheet = work.createElement("style");
  sheet.textContent = `${css}\n${FREEZE_CSS}`;
  stage.appendChild(sheet);
  stage.appendChild(snap.root);
  foreign.appendChild(stage);
  svg.appendChild(foreign);

  const markup = sanitizeXml(new XMLSerializer().serializeToString(svg));
  // A data URL, not a blob URL: some engines taint a canvas for a foreignObject drawn from a blob.
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
  if (typeof image.decode === "function") await image.decode().catch(() => undefined);

  const canvas = scratchCanvas(width * ctx.scale, height * ctx.scale);
  const context = canvas.getContext("2d");
  if (!context) throw new CaptureError("render", "This browser cannot draw to a canvas.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  try {
    // Reading one pixel proves the picture can be exported at all.
    context.getImageData(0, 0, 1, 1);
  } catch {
    throw new CaptureError("unsupported", "This browser will not let a page read back its own picture.");
  }
  return canvas;
}

/** The next animation frame, or soon after if the tab is not being painted. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 250);
  });
}

/**
 * A picture of the page's viewport. The clone and every canvas are read inside
 * ONE animation frame, so the terminal's buffer, the remote screen and the
 * markup around them all belong to the same moment.
 */
export async function captureDocument(options: DomCaptureOptions): Promise<DomCaptureResult> {
  const viewport: Size = {
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight,
  };
  const scale = options.scale > 0 && Number.isFinite(options.scale) ? options.scale : 1;
  const ctx: Context = {
    scale,
    blockedLabel: options.blockedLabel,
    viewport,
    skipped: [],
    inlined: new Map(),
  };
  await nextFrame();
  let snap: Snapshot;
  try {
    snap = takeSnapshot(document, viewport, { x: 0, y: 0 }, 0, ctx);
  } finally {
    options.onRead?.();
  }
  const bitmap = await renderSnapshot(snap, ctx);
  return { bitmap, scale, skipped: ctx.skipped };
}
