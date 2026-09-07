import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * The desktop shell's rules that live in `page.tsx` itself.
 *
 * The file is the whole desktop — every window, the shelf, the chat, the icon
 * grid — so it cannot be mounted in jsdom to be asked a question. These are
 * pinned the way the default-icon rules next door are: on the source, one
 * assertion per rule, each naming the way it failed on the box.
 */
const src = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");

describe("the docked chat's layout", () => {
  it("persists the last width the chat had while it was OPEN", () => {
    // ChatPopup leaves panel mode whenever it is closed — the X, Escape, a tap
    // on the crab — and reports a width of 0 on the way out. Writing that zero
    // erased the docked layout the desktop restores, so the panel came back on
    // one reload and was gone on the next.
    expect(src).toMatch(/if \(chatOpen\) dockWidthRef\.current = chatPanelWidth \|\| 0;/);
    expect(src).toMatch(/savePreferences\(\{ ui_chat_panel_width: dockWidthRef\.current, ui_chat_open: chatOpen \? 1 : 0 \}\)/);
    // …and never `chatPanelWidth || 0`, which is the value that was lost.
    expect(src).not.toMatch(/ui_chat_panel_width: chatPanelWidth/);
  });

  it("seeds that width from the device even where the panel is not restored", () => {
    // Otherwise opening the desktop on a phone would write the layout away.
    expect(src).toMatch(/dockWidthRef\.current = Number\(data\.ui_chat_panel_width\) \|\| 0;/);
  });

  it("does not restore a desktop-sized panel onto a phone", () => {
    // 765px anchored to the right edge put the panel at x=-381 over the whole
    // home screen, with its header — and every way back — off the left edge.
    expect(src).toMatch(/const phone = typeof window !== "undefined" && window\.innerWidth < 768;/);
    expect(src).toMatch(/if \(!phone && data\.ui_chat_panel_width && Number\(data\.ui_chat_panel_width\) > 0\)/);
  });

  it("reserves no strip for a panel a phone does not draw", () => {
    // The load-time guard above is not the whole answer: a desktop that is
    // narrowed to phone width keeps the width it was docked at, and the strip
    // was still reserved — pushing the notice column off the left edge and
    // insetting a mascot that is not drawn at all.
    expect(src).toMatch(/const chatPanelInset = !isMobile && chatPanelWidth > 0 \? chatPanelWidth \+ CHAT_PANEL_GAP : 0;/);
  });

  it("brings a docked chat back after a reload, closed or not", () => {
    // The X leaves `ui_chat_open` at 0 while keeping the width: restoring the
    // dock on the width alone is what makes the layout survive a reload, so
    // this restore must NOT start gating on the open flag.
    const restore = src.match(/const phone = typeof window[\s\S]{0,600}/)?.[0] ?? "";
    expect(restore).not.toMatch(/data\.ui_chat_open/);
  });
});

describe("the owner-notice ring", () => {
  it("judges an entry's age on the box's own clock, from the response's Date header", () => {
    expect(src).toMatch(/const serverNow = Date\.parse\(res\.headers\.get\("date"\) \?\? ""\);/);
    expect(src).toMatch(/const freshFrom = Number\.isFinite\(serverNow\) \? serverNow - PENDING_ACTION_MAX_AGE_MS : 0;/);
  });

  it("acts on nothing older than the ring's own TTL", () => {
    // The ring is pruned by its WRITER, and the poll baselines its watermark to
    // the ring's newest entry, so a two-hour-old "Coding agent finished" card
    // replayed on every fresh desktop and came back after every dismissal.
    expect(src).toMatch(/if \(!id \|\| ts < lastSeenTs \|\| ts < freshFrom\) continue;/);
    expect(src).toMatch(/const PENDING_ACTION_MAX_AGE_MS = 60_000;/);
  });
});

describe("installed app icons", () => {
  it("draws the app's own picture wherever an installed app is shown", () => {
    // An installed WEB APP has type "webapp", so every `type === "installed"`
    // branch fell through to AppIcon — which knows no `installed-*` id and drew
    // nothing. The launcher, the shelf and the phone header showed bare
    // coloured discs, two of them the same orange.
    expect(src).not.toMatch(/app\.type === "installed" && app\.storeApp/);
    // The window icon, the launcher tile, the shelf entry and the phone header.
    expect(src.match(/InstalledAppIcon appId=\{app\.storeApp\.id\}/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the top-right notices", () => {
  it("stack beside the chat rather than over its header", () => {
    // Both are anchored to the top-right corner, and the card covered the
    // chat's tab row and its +, dock and close buttons for the 30 s it takes
    // to hide itself.
    expect(src).toMatch(/right: NOTICE_MARGIN \+ noticeRightInset/);
    // The docked half is the strip the panel already reserves…
    expect(src).toMatch(/const noticeRightInset = chatPanelInset > 0/);
    // …and the floating half is the popup's own rect, which lands in the very
    // corner the cards do and had no way of being dodged at all.
    expect(src).toMatch(/noticeColumnInset\(chatFloatingRect, /);
  });

  it("measure the column against the width the markup actually draws", () => {
    // A card that dodges by a number the markup does not use is a card that
    // still lands on the chat's buttons.
    expect(src).toMatch(/const NOTICE_COLUMN_WIDTH = 320;/);
    expect(src).toMatch(/const NOTICE_MARGIN = 16;/);
    expect(src).toMatch(/className="pointer-events-none fixed top-4 flex w-\[320px\] flex-col gap-3"/);
  });

  it("ask the chat where it is standing only while a card is up", () => {
    // The popup reports its rect on every pointer move of a drag; nothing is
    // dodging it the rest of the time.
    expect(src).toMatch(/onFloatingRectChange=\{noticesUp \? handleChatFloatingRect : undefined\}/);
  });
});

describe("the floating chat's place among the windows", () => {
  it("draws from the same focus counter the windows do", () => {
    // At a constant 10010 against a window's 100-and-up, a window opened while
    // the chat was up had its minimize, maximize and close buttons underneath
    // the popup: the owner had to close the chat to reach the window they had
    // just asked for.
    expect(src).toMatch(/floatingZIndex=\{chatZIndex\}/);
    expect(src).toMatch(/const next = nextZIndexRef\.current;/);
    expect(src).toMatch(/nextZIndexRef\.current = next \+ 1;/);
    expect(src).toMatch(/setChatZIndex\(next\);/);
  });

  it("comes back to the front when it is opened or pressed", () => {
    expect(src).toMatch(/onFocus=\{raiseChat\}/);
    expect(src).toMatch(/if \(chatOpen\) raiseChat\(\);/);
    // …and when the shelf's chat button is pressed on a chat that is already
    // open: `setChatOpen(true)` is a no-op there, so without this the button is
    // dead on a chat a window is covering.
    const chatBranch = src.match(/if \(app\.type === "chat"\) \{[\s\S]{0,500}?\n {4}\}/)?.[0] ?? "";
    expect(chatBranch).toMatch(/raiseChat\(\);/);
  });

  it("spends no counter value on a chat that is already on top", () => {
    // Otherwise every pointer press inside the chat — every keystroke's click,
    // every scroll grab — spins the counter and re-renders the whole desktop.
    expect(src).toMatch(/if \(chatZIndexRef\.current === next - 1\) return;/);
  });
});

describe("keyboard and screen-reader reach", () => {
  it("closes the desktop context menu and the power menu on Escape", () => {
    expect(src).toMatch(/if \(e\.key === "Escape"\) setCtxMenu\(null\)/);
    expect(src).toMatch(/if \(e\.key === "Escape"\) setTrayOpen\(false\)/);
  });

  it("names the phone window header's icon-only buttons", () => {
    // The back chevron is the phone's only way out of an app and announced
    // nothing but "button"; "Switch app" was a hardcoded English title on a
    // shelf that speaks ten languages.
    expect(src).toMatch(/aria-label=\{t\("window\.close"\)\}/);
    expect(src).toMatch(/aria-label=\{tr\("window\.switchApp", "Switch app"\)\}/);
  });
});

describe("desktop icon labels", () => {
  it("wraps a long word instead of clipping it mid-word", () => {
    // German "Einstellungen" is 100px wide in an 80px box: line-clamp-2 cut it
    // to "Einstellung", with no ellipsis to say so.
    const labels = src.match(/text-\[13px\] leading-tight text-white font-semibold text-center [^"]*/g) ?? [];
    expect(labels.length).toBe(2);
    for (const label of labels) expect(label).toContain("break-words");
  });
});

describe("the browser's Back button", () => {
  // Next's app router patches `pushState`: while the current entry is its own,
  // it writes `__NA` and its route tree onto whatever is pushed
  // (`copyNextJsInternalHistoryState`). This is that write, in the strict mode
  // every module runs under.
  const nextWritesItsFields = (state: unknown) => {
    const data = (state ?? {}) as { __NA?: boolean };
    data.__NA = true;
    return data;
  };

  it("pushes an entry Next can write its own fields onto — an object, never a string", () => {
    // "Back to Desktop" is a client-side Link to `/`, so the desktop mounted
    // with Next's entry current; the mount pushed the string "clawbox", the
    // write threw, and Next's error page stood where the desktop should have.
    expect(() => nextWritesItsFields("clawbox")).toThrow(TypeError);
    expect(() => nextWritesItsFields({ clawbox: true })).not.toThrow();
    expect(src).not.toMatch(/pushState\("clawbox"/);
    expect(src).toMatch(/window\.history\.pushState\(\{ clawbox: true \}, ""\)/);
  });

  it("knows its own entry by the marker field, so a Back can close the top window", () => {
    // After the first Back the restored entry is Next's, and `handleBack`
    // re-pushes FIRST: with a string that push threw before the window-closing
    // code below it, so Back closed nothing on the desktop and the Android
    // back gesture did nothing on the phone. Next adds its fields to the
    // object it is handed, so the entry is known by the marker, not compared
    // whole.
    expect(src).not.toMatch(/window\.history\.state !== "clawbox"/);
    expect(src).toMatch(/\(state as \{ clawbox\?: unknown \}\)\.clawbox === true/);
    expect(src).toMatch(/if \(!isDesktopEntry\(window\.history\.state\)\) \{\n\s+window\.history\.pushState\(\{ clawbox: true \}, ""\);/);
  });
});

describe("the shelf clock", () => {
  it("is written in the desktop's language, not the browser's", () => {
    // `[]` is navigator.language: a German box opened from an en-US browser
    // showed "09:27 AM" on the shelf and "Monday, September 7" in the power
    // menu, while About's build date beside them was in German.
    expect(src).not.toMatch(/toLocale(Time|Date)String\(\[\]/);
    expect(src).toMatch(/now\.toLocaleTimeString\(tag, \{ hour: "2-digit", minute: "2-digit" \}\)/);
    expect(src).toMatch(/now\.toLocaleDateString\(tag, \{ weekday: "long", month: "long", day: "numeric" \}\)/);
    // The locale the desktop already reads, and a re-format once it resolves,
    // since every provider starts on a provisional "en".
    expect(src).toMatch(/const \{ t, locale \} = useT\(\);/);
    expect(src).toMatch(/return \(\) => clearInterval\(interval\);\n  \}, \[locale\]\);/);
  });

  // The expression the pin below holds the source to: `locale` is a bare
  // language tag, and a bare "en" is en-US to Intl.
  const regionalTag = (languages: readonly string[] | undefined, locale: string) =>
    languages?.find((l) => l.toLowerCase().startsWith(`${locale}-`)) ?? locale;

  it("takes the browser's region for that language, so a UK browser keeps its 24-hour clock", () => {
    // `locale` alone made "09:27 AM" of every English desktop — the en-GB,
    // en-IE and en-ZA browsers that read "09:27" until then included — and
    // ~52px of it inside the phone bar's 40px clock button.
    expect(src).toMatch(/const tag = navigator\.languages\?\.find\(\(l\) => l\.toLowerCase\(\)\.startsWith\(`\$\{locale\}-`\)\) \?\? locale;/);
    expect(regionalTag(["en-GB", "en"], "en")).toBe("en-GB");
    // Only a REGIONAL entry is worth taking: a bare "en" ahead of "en-GB"
    // adds nothing over `locale`.
    expect(regionalTag(["en", "en-GB"], "en")).toBe("en-GB");
    // The box's language still wins — the German box above, opened from an
    // en-US browser, finds no "de-…" entry and keeps "de".
    expect(regionalTag(["en-US", "en"], "de")).toBe("de");
    // A browser with no list at all (an old WebView) is the bare tag.
    expect(regionalTag(undefined, "en")).toBe("en");
  });
});
