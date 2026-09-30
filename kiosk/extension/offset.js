// ClawBox Kiosk Tabs — lay a web page out BELOW the bar.
//
// content.css pushes the document down by the bar's height (`margin-top` on
// <html>), which moves the normal flow and nothing else. Three kinds of box
// are placed against the viewport or the canvas instead, and stayed under the
// bar: a `position: fixed` or `sticky` header at `top: 0` (YouTube's masthead,
// Stack Overflow's top bar — the page's own search box hidden behind ours), an
// app shell sized to the viewport (`height: 100vh`, `html { height: 100% }`),
// whose last 40 px — often the input row — fell off the bottom, and an
// absolutely positioned header on a page with no positioned ancestor, which
// sits on the canvas the margin does not move.
//
// There is no way for an extension to make the viewport itself shorter, so
// this does what that would have done, box by box, with inline `!important`
// declarations it can take back:
//
//  - fixed (against the viewport) with a `top`: top + BAR_H, and when the box
//    reached the viewport's bottom edge, height and max-height - BAR_H so it
//    still ends there. A box anchored at the bottom (`top: auto`) is left
//    alone, and so is one in the top layer (a modal dialog, full screen),
//    which is drawn over the bar anyway;
//  - sticky (against the viewport's scroller) with a `top`: top + BAR_H;
//  - absolute against the initial containing block with a `top` under the
//    bar: top + BAR_H, and a viewport-tall one loses BAR_H as below (its
//    percentages are of the viewport: YouTube's app root is `min-height:
//    100%`). One already below the bar is left alone — a menu or a tooltip a
//    script placed from getBoundingClientRect() is in page coordinates that
//    already include the margin;
//  - any other box as tall as the viewport, by an explicit height or
//    min-height (not `auto`, not a replaced element such as a canvas a script
//    sized): that height - BAR_H;
//  - <html>: scroll-padding-top + BAR_H, so a #fragment or a focused field
//    does not land under the bar.
//
// Every declaration is written over what the page had, and the page's own
// inline value is kept to be put back: before a box is judged again (it
// changed, the window resized, a stylesheet arrived) ours are taken off, the
// cascade is read as the page left it, and the verdict is written afresh. A
// page that rewrites one of these properties itself is taken at its word and
// judged from the new value. Transitions are held off while ours are
// swapped, so a header with `transition: top` does not slide on every pass.
//
// A pass is two steps. The SCAN walks the boxes that may have changed and
// keeps the few worth judging — positioned (not static or relative), at least
// as tall as the viewport, or already carrying ours — for the price of one
// computed `position` and one `offsetHeight` each; it yields every
// SLICE_MS, so a 20,000-element page never blocks the tab for long. The
// JUDGING (take ours off, read, write) then runs on those few in one go, so
// nothing is painted between a box losing its offset and getting it back.
//
// What prompts a pass: the first one at start and another at `load`; a
// MutationObserver over the document (and every open shadow root) — an added
// subtree, a class change (the box and its descendants) or a style change
// (the box alone); a resize; a stylesheet added or loaded. Those run in a
// requestAnimationFrame, so a header that turned fixed on scroll is moved
// before it is painted. A whole-document pass (resize, a stylesheet, a class
// on <html> or <body>) runs at most every FULL_GAP_MS: a page that injects
// <style> tags as it renders asks for one constantly.

(() => {
  // Replaced elements keep the height a script gave them: shrinking a canvas
  // the page sized to innerHeight would stretch it and skew its pointer maths.
  const REPLACED = new Set(["CANVAS", "VIDEO", "IMG", "EMBED", "OBJECT", "AUDIO", "PICTURE"]);
  const BAR_HOST_ID = "clawbox-kiosk-bar";
  // Within this many px of the viewport's height counts as "the viewport's".
  const SLACK = 1.5;
  const SLICE_MS = 8;
  const FULL_GAP_MS = 800;
  // An adjusted box with more descendants than this is HEAVY: changing its
  // inline style restyles its whole subtree (~40 ms for <html> on a 20,000-
  // element page), so it is judged again only on a resize or a change of its
  // own, never as a bystander to someone else's.
  const HEAVY_SUBTREE = 400;

  function start(barH) {
    const BAR_H = barH;
    const html = document.documentElement;
    // el -> Map(prop -> { wrote, site: { value, priority } | null })
    const managed = new WeakMap();
    const adjusted = new Set();
    const heavy = new WeakSet();
    const observedRoots = new WeakSet();

    const parentOf = (el) => el.assignedSlot || el.parentElement || (el.parentNode && el.parentNode.host) || null;
    const isAuto = (v) => !v || (v.constructor && v.constructor.name === "CSSKeywordValue" && v.value === "auto");
    const typed = (el, prop) => {
      try { return el.computedStyleMap().get(prop); } catch { return null; }
    };
    const inTopLayer = (el) => {
      try { return el.matches(":modal, :fullscreen, :popover-open"); } catch { return false; }
    };

    // Does this ancestor make itself the containing block of fixed (and
    // absolute) descendants, where a positioned one would not be needed?
    function establishesContainingBlock(cs) {
      return cs.transform !== "none" || cs.translate !== "none" || cs.rotate !== "none" || cs.scale !== "none" ||
        cs.perspective !== "none" || cs.filter !== "none" || (cs.backdropFilter && cs.backdropFilter !== "none") ||
        /\b(?:transform|perspective|filter|translate|rotate|scale)\b/.test(cs.willChange) ||
        /\b(?:paint|layout|strict|content)\b/.test(cs.contain) ||
        (cs.containerType && cs.containerType !== "normal") ||
        (cs.contentVisibility && cs.contentVisibility !== "visible");
    }

    // Is this fixed box placed against the viewport (no ancestor contains it)?
    function againstViewport(el) {
      for (let p = parentOf(el); p && p !== html; p = parentOf(p)) {
        if (establishesContainingBlock(getComputedStyle(p))) return false;
      }
      return true;
    }

    // Is this absolute box placed against the initial containing block?
    function againstCanvas(el) {
      if (el.offsetParent !== document.body) return false;
      for (let p = parentOf(el); p; p = parentOf(p)) {
        const cs = getComputedStyle(p);
        if (cs.position !== "static" || establishesContainingBlock(cs)) return false;
      }
      return true;
    }

    // Does this sticky box stick to the viewport's scroller, not an inner one?
    function sticksToViewport(el) {
      const htmlScrolls = getComputedStyle(html).overflowY !== "visible";
      for (let p = parentOf(el); p && p !== html; p = parentOf(p)) {
        // The body's overflow belongs to the viewport unless <html> has its own.
        if (p === document.body && !htmlScrolls) continue;
        const cs = getComputedStyle(p);
        if (/auto|scroll|hidden/.test(cs.overflowX + cs.overflowY)) return false;
      }
      return true;
    }

    // A box as tall as the viewport by an explicit height or min-height (not
    // `auto`) is as tall as what the bar leaves of it. `icb`: the box's
    // percentages are of the viewport (it is <html>, or absolute on the
    // canvas); anyone else's are of its parent, which is dealt with in its own
    // right, so they are left to follow it. The values track the viewport
    // (`100vh`, `100%` of it), so a resize does not make them wrong.
    function viewportTall(el, cs, out, icb) {
      const vh = window.innerHeight;
      const full = icb ? "100%" : "100vh";
      const h = parseFloat(cs.height);
      if (Number.isFinite(h) && Math.abs(h - vh) < SLACK) {
        const t = typed(el, "height");
        if (!isAuto(t) && (icb || !(t && t.unit === "percent"))) out.push(["height", `calc(${full} - ${BAR_H}px)`]);
      }
      const minH = parseFloat(cs.minHeight);
      if (cs.minHeight.endsWith("%")) {
        if (icb && Math.abs((minH / 100) * vh - vh) < SLACK) out.push(["min-height", `calc(100% - ${BAR_H}px)`]);
      } else if (Number.isFinite(minH) && Math.abs(minH - vh) < SLACK) {
        out.push(["min-height", `calc(${full} - ${BAR_H}px)`]);
      }
    }

    // What this box should carry, judged from the cascade as the page left it.
    function verdict(el) {
      if (el.id === BAR_HOST_ID) return null;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.display === "contents") return null;
      const out = [];
      if (el === html) {
        const sp = cs.scrollPaddingTop;
        out.push(["scroll-padding-top", !sp || sp === "auto" ? `${BAR_H}px` : `calc(${sp} + ${BAR_H}px)`]);
      }
      const pos = cs.position;
      if (pos === "fixed") {
        if (inTopLayer(el) || isAuto(typed(el, "top")) || !againstViewport(el)) return out;
        const vh = window.innerHeight;
        const top = parseFloat(cs.top) || 0;
        out.push(["top", `${top + BAR_H}px`]);
        if (isAuto(typed(el, "bottom"))) {
          const reach = top + (parseFloat(cs.marginTop) || 0);
          const h = parseFloat(cs.height);
          if (!isAuto(typed(el, "height")) && Number.isFinite(h) && reach + el.offsetHeight >= vh - SLACK) {
            out.push(["height", `${Math.max(0, h - BAR_H)}px`]);
          }
          const mh = parseFloat(cs.maxHeight);
          if (Number.isFinite(mh) && reach + mh >= vh - SLACK) out.push(["max-height", `${Math.max(0, mh - BAR_H)}px`]);
        }
        return out;
      }
      if (pos === "sticky") {
        if (isAuto(typed(el, "top")) || !sticksToViewport(el)) return out;
        out.push(["top", `${(parseFloat(cs.top) || 0) + BAR_H}px`]);
        return out;
      }
      if (pos === "absolute") {
        const top = parseFloat(cs.top);
        if (!Number.isFinite(top) || top >= BAR_H || isAuto(typed(el, "top")) || !againstCanvas(el)) return out;
        out.push(["top", `${top + BAR_H}px`]);
        viewportTall(el, cs, out, true);
        return out;
      }
      if (REPLACED.has(el.tagName)) return out;
      viewportTall(el, cs, out, el === html);
      return out;
    }

    // Take ours off, so the cascade can be read as the page has it. A value
    // the page wrote over ours since is the page's now, and stays.
    function release(el) {
      const props = managed.get(el);
      if (!props) return;
      for (const [prop, rec] of props) {
        const mine = el.style.getPropertyValue(prop) === rec.wrote && el.style.getPropertyPriority(prop) === "important";
        if (mine) {
          if (rec.site) el.style.setProperty(prop, rec.site.value, rec.site.priority);
          else el.style.removeProperty(prop);
        }
      }
      managed.delete(el);
      adjusted.delete(el);
    }

    function write(el, entries) {
      const props = new Map();
      for (const [prop, value] of entries) {
        const siteValue = el.style.getPropertyValue(prop);
        const site = siteValue ? { value: siteValue, priority: el.style.getPropertyPriority(prop) } : null;
        el.style.setProperty(prop, value, "important");
        // Compare later with what the style attribute says, not with what was
        // asked for: serialisation may differ.
        props.set(prop, { wrote: el.style.getPropertyValue(prop), site });
      }
      managed.set(el, props);
      adjusted.add(el);
      if (el === html || el === document.body || el.getElementsByTagName("*").length > HEAVY_SUBTREE) heavy.add(el);
      else heavy.delete(el);
    }

    // Judge the candidates: ours off (transitions held, so a swap does not
    // animate), every verdict read before any is written (one box's new size
    // is not another's starting point), ours on, transitions back once the
    // new values are the computed ones.
    function judge(candidates) {
      const els = [...candidates].filter((el) => el.isConnected);
      // Only a box that transitions needs holding; touching one that does
      // not would cost a restyle for nothing.
      const moves = new Set(els.filter((el) => /[1-9]/.test(getComputedStyle(el).transitionDuration)));
      const held = new Map();
      const hold = (el) => {
        if (held.has(el) || !moves.has(el)) return;
        held.set(el, [el.style.getPropertyValue("transition"), el.style.getPropertyPriority("transition")]);
        el.style.setProperty("transition", "none", "important");
      };
      for (const el of els) if (managed.has(el)) { hold(el); release(el); }
      const plan = [];
      for (const el of els) {
        const v = verdict(el);
        if (v && v.length) plan.push([el, v]);
      }
      for (const [el, v] of plan) { hold(el); write(el, v); }
      if (held.size) {
        // A style read, not a geometry one: the new values must be the
        // computed ones before the transitions come back, and that takes a
        // style recalc — a layout of the whole page would be wasted here.
        for (const el of held.keys()) void getComputedStyle(el).transitionDuration;
        for (const [el, [value, priority]] of held) {
          if (value) el.style.setProperty("transition", value, priority);
          else el.style.removeProperty("transition");
        }
      }
      // What we just wrote is not a change of the page's.
      mo.takeRecords();
    }

    // --- the scan -------------------------------------------------------

    let fullWanted = true;
    // A resize: the heavy boxes are judged again too.
    let resized = false;
    let lastFull = -Infinity;
    // Subtrees to look at again (added, or a class changed: descendant
    // selectors can move anything under it), and single boxes (their own
    // style attribute changed, which moves nothing else).
    const dirty = new Set();
    const dirtySelf = new Set();
    let scan = null; // { stack: [ArrayLike<Element>, index][], candidates: Set, own: Set | null }
    let frameAsked = false;
    let fullTimer = 0;

    // `own`: the boxes whose own attributes changed (null: every box, on a
    // resize) — the only heavy ones that are judged again.
    function considers(el, s) {
      if (adjusted.has(el)) {
        if (!heavy.has(el) || !s.own || s.own.has(el)) s.candidates.add(el);
        return;
      }
      const pos = getComputedStyle(el).position;
      if (pos !== "static" && pos !== "relative") s.candidates.add(el);
      else if (el.offsetHeight >= window.innerHeight - SLACK) s.candidates.add(el);
    }

    function beginScan() {
      const now = performance.now();
      const stack = [];
      const candidates = new Set();
      // The boxes whose own class or style changed, heavy or not.
      const own = new Set([...dirty, ...dirtySelf]);
      if (fullWanted && now - lastFull >= FULL_GAP_MS) {
        fullWanted = false;
        lastFull = now;
        const all = resized;
        resized = false;
        dirty.clear();
        dirtySelf.clear();
        for (const el of adjusted) if (!el.isConnected) adjusted.delete(el);
        if (all || !adjusted.has(html) || own.has(html)) candidates.add(html);
        if (document.body) stack.push([[document.body], 0], [document.body.getElementsByTagName("*"), 0]);
        return { stack, candidates, own: all ? null : own };
      } else {
        if (fullWanted && !fullTimer) {
          // Too soon after the last one: come back when it is due.
          fullTimer = setTimeout(() => { fullTimer = 0; askFrame(); }, FULL_GAP_MS - (now - lastFull));
        }
        for (const el of dirty) if (el.isConnected) stack.push([[el], 0], [el.getElementsByTagName("*"), 0]);
        for (const el of dirtySelf) if (el.isConnected) stack.push([[el], 0]);
        dirty.clear();
        dirtySelf.clear();
      }
      if (!stack.length) return null;
      return { stack, candidates, own };
    }

    // Walk until done or out of time; true when done.
    function advance(s) {
      const t0 = performance.now();
      let n = 0;
      while (s.stack.length) {
        const top = s.stack[s.stack.length - 1];
        const list = top[0];
        if (top[1] >= list.length) { s.stack.pop(); continue; }
        const el = list[top[1]++];
        considers(el, s);
        if (el.shadowRoot) {
          watch(el.shadowRoot);
          s.stack.push([el.shadowRoot.querySelectorAll("*"), 0]);
        }
        if ((++n & 255) === 0 && performance.now() - t0 > SLICE_MS) return false;
      }
      return true;
    }

    function run() {
      note(mo.takeRecords());
      if (!scan) scan = beginScan();
      if (!scan) return;
      if (!advance(scan)) {
        setTimeout(run, 0);
        return;
      }
      const done = scan;
      scan = null;
      judge(done.candidates);
      if (dirty.size || dirtySelf.size || (fullWanted && !fullTimer)) askFrame();
    }

    function askFrame() {
      if (frameAsked) return;
      frameAsked = true;
      requestAnimationFrame(() => {
        frameAsked = false;
        // A scan in progress carries on from its own timer.
        if (!scan) run();
      });
    }
    const rescanAll = () => { fullWanted = true; askFrame(); };
    const onResize = () => { resized = true; rescanAll(); };

    function note(records) {
      for (const r of records) {
        const t = r.target;
        if (r.type === "childList") {
          if (t.nodeName === "STYLE") { fullWanted = true; continue; }
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.nodeName === "STYLE" || n.nodeName === "LINK") fullWanted = true;
            else dirty.add(n);
          }
        } else if (r.type === "attributes") {
          if (t.id === BAR_HOST_ID) continue;
          // A class or style on <html> or <body> can move anything; and it is
          // theirs, so they are judged again themselves.
          if (t === html || t === document.body) { fullWanted = true; dirtySelf.add(t); }
          else if (r.attributeName === "style") dirtySelf.add(t);
          else dirty.add(t);
        }
      }
    }

    function watch(root) {
      if (observedRoots.has(root)) return;
      observedRoots.add(root);
      mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    }

    const mo = new MutationObserver((records) => { note(records); askFrame(); });
    watch(document);
    window.addEventListener("resize", onResize);
    window.addEventListener("load", rescanAll);
    // A stylesheet that finishes loading after the pass changes the cascade.
    document.addEventListener("load", (e) => { if (e.target && e.target.nodeName === "LINK") rescanAll(); }, true);
    askFrame();
  }

  globalThis.clawboxKioskOffset = { start };
})();
