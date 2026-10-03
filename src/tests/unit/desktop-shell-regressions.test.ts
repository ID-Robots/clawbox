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
    // The strip is the width the chat is DRAWN at (held to the main monitor
    // over a row of monitors, the owner's own width on one screen).
    expect(src).toMatch(/const chatPanelInset = !isMobile && chatPanelWidth > 0 \? dockedChatWidth\(chatPanelWidth, deskScreens !== null\) \+ CHAT_PANEL_GAP : 0;/);
  });

  it("brings a docked chat back after a reload, closed or not", () => {
    // The X leaves `ui_chat_open` at 0 while keeping the width: restoring the
    // dock on the width alone is what makes the layout survive a reload, so
    // this restore must NOT start gating on the open flag.
    const restore = src.match(/const phone = typeof window[\s\S]{0,600}/)?.[0] ?? "";
    expect(restore).not.toMatch(/data\.ui_chat_open/);
  });
});

describe("chat-first on a phone", () => {
  it("opens the chat once on load where src/lib/mobile-chat-first.ts says the page lands in it", () => {
    expect(src).toMatch(/import \{ readChatFirstEnvironment, shouldOpenChatFirst \} from "@\/lib\/mobile-chat-first";/);
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(shouldOpenChatFirst\(readChatFirstEnvironment\(window\)\)\) setChatOpen\(true\);\s*\}, \[\]\);/);
  });

  it("lets Android's Back take a phone from the chat to the desktop", () => {
    const handler = src.match(/const handleBack = [\s\S]*?window\.addEventListener\("popstate", handleBack\);/)?.[0] ?? "";
    expect(handler).toMatch(/if \(isMobile && chatOpen\) \{ setChatOpen\(false\); return; \}/);
    // Before any window: on a phone the chat is drawn above all of them.
    expect(handler.indexOf("isMobile && chatOpen")).toBeLessThan(handler.indexOf("closeWindow(top.id)"));
    expect(src).toMatch(/\}, \[launcherOpen, trayOpen, openWindows, closeWindow, isMobile, chatOpen\]\);/);
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

  it("is how a power request reaches the confirmation prompt, without a poll of its own", () => {
    // PowerApprovalPrompt asked the approval route every 5 s on every owner
    // desktop, all day, for a request that almost never exists.
    // src/lib/power-approval.ts now pushes a `power_approval` notice when a
    // request is asked or settled; the ring turns it into the prompt's event,
    // and the prompt asks the owner-only route itself — the notice is the
    // word to ask, never what to show.
    expect(src).toMatch(/import PowerApprovalPrompt, \{ POWER_APPROVAL_EVENT \} from "@\/components\/PowerApprovalPrompt";/);
    expect(src).toMatch(/\} else if \(action\.type === "power_approval"\) \{[\s\S]{0,400}?window\.dispatchEvent\(new Event\(POWER_APPROVAL_EVENT\)\);/);
  });
});

describe("the always-on polls", () => {
  // Behind a hidden tab — a phone, a laptop tab left open, the tunnel — the
  // desktop kept asking the box at the full rate for answers nobody was
  // reading. Each poll now waits there and asks at once on the way back
  // (src/lib/visible-interval.ts, unit-tested beside it).
  it("waits behind a hidden tab, every one of them", () => {
    expect(src).not.toMatch(/\bsetInterval\(/);
    expect(src).toMatch(/const stop = setVisibleInterval\(poll, 20000\);/);
    expect(src).toMatch(/const stop = setVisibleInterval\(checkVersions, 30 \* 60 \* 1000\);/);
  });

  it("keeps reading the notice ring while hidden, inside the life of an entry", () => {
    // The ring carries EVENTS (register_webapp is the only way a new web app's
    // icon reaches an open desktop), dropped once older than a minute: paused
    // outright, a desktop away for longer would miss them for good.
    expect(src).toMatch(/const stop = setVisibleInterval\(poll, RING_POLL_MS, \{ hiddenMs: ringHiddenPollMs \}\);/);
    const visible = Number(src.match(/const RING_POLL_MS = ([0-9_]+);/)?.[1].replace(/_/g, ""));
    const hidden = Number(src.match(/const RING_HIDDEN_POLL_MS = ([0-9_]+);/)?.[1].replace(/_/g, ""));
    const ttl = Number(src.match(/const PENDING_ACTION_MAX_AGE_MS = ([0-9_]+);/)?.[1].replace(/_/g, ""));
    expect(visible).toBe(2000);
    expect(hidden).toBeGreaterThan(visible);
    expect(hidden * 2).toBeLessThan(ttl);
  });

  it("keeps the 2 s while hidden on the box's own screen, where its entries act on what the owner sees", () => {
    // In the kiosk the desktop is a hidden tab whenever the owner is on another
    // of the kiosk's tabs, and an `open_app` for an external app or a
    // `launch: "window"` web app opens a new tab THERE: at 20 s the page the
    // agent said it had opened arrived up to 20 s later. The monitor session's
    // app window is the same screen. Elsewhere — a browser tab on a phone or a
    // laptop — the hidden rate stays 20 s. The question is asked at every tick
    // (a getter, not a value), because the kiosk bar arrives after mount.
    expect(src).toMatch(/import \{ isBoxOwnScreen, setVisibleInterval \} from "@\/lib\/visible-interval";/);
    expect(src).toMatch(/function ringHiddenPollMs\(\): number \{\s*return isBoxOwnScreen\(\) \? RING_POLL_MS : RING_HIDDEN_POLL_MS;\s*\}/);
    expect(src).not.toMatch(/hiddenMs: RING_HIDDEN_POLL_MS/);
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
    expect(src).toMatch(/className="desktop-notice-stack pointer-events-none fixed flex w-\[320px\] flex-col gap-3"/);
    // The column's top is the same margin, below the laptop's kiosk bar while
    // that bar is up (0 everywhere else), and on the main monitor's own top
    // over a row of monitors (0 everywhere else).
    expect(src).toMatch(/top: NOTICE_MARGIN \+ kioskBarInset \+ mainIns\.top \}/);
    expect(src).toMatch(/right: NOTICE_MARGIN \+ noticeRightInset \+ mainIns\.right,/);
  });

  it("stand exactly where they always did without a monitor layout", () => {
    // `mainIns` is what monitor mode adds to the column (and the upload
    // toast): nothing at all on a Jetson or in a browser tab, which have no
    // layout.
    expect(src).toMatch(/const mainIns = deskScreens \? mainInsets\(\) : \{ left: 0, top: 0, right: 0, bottom: 0 \};/);
    expect(src).toMatch(/const mainRect = deskScreens \? mainScreen\(\) : null;/);
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
    // It walks up one in-app level before it closes the app (lib/mobile-back).
    expect(src).toMatch(/aria-label=\{t\("back"\)\}/);
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
    expect(src).toMatch(/window\.history\.pushState\(\{ clawbox: true, clawboxDepth: d \}, ""\)/);
  });

  it("knows its own entry by the marker field, so a Back can close the top window", () => {
    // After the first Back the restored entry is Next's, and `handleBack`
    // re-pushes FIRST: with a string that push threw before the window-closing
    // code below it, so Back closed nothing on the desktop and the Android
    // back gesture did nothing on the phone. Next adds its fields to the
    // object it is handed, so the entry is known by the marker, not compared
    // whole.
    expect(src).not.toMatch(/window\.history\.state !== "clawbox"/);
    // One entry per thing Back can close, each carrying its depth: the entry
    // a Back lands on says how many levels are still open.
    expect(src).toMatch(/state && state\.clawbox === true && typeof state\.clawboxDepth === "number" \? state\.clawboxDepth : 0/);
    expect(src).toMatch(/if \(runMobileBack\(\)\) return;/);
  });
});

describe("the shelf clock", () => {
  // The shelf's and the power menu's clock live in src/lib/use-desktop-clock.ts
  // since the performance sweep of 2026-10-02: as state of the desktop root,
  // every new minute rebuilt the whole desktop to change one label.
  const clock = fs.readFileSync(path.join(process.cwd(), "src/lib/use-desktop-clock.ts"), "utf8");

  it("is not the desktop root's state any more", () => {
    expect(src).not.toMatch(/toLocale(Time|Date)String/);
    expect(src).not.toMatch(/const \[time, setTime\]/);
    expect(src).not.toMatch(/time=\{time\}/);
  });

  it("is written in the desktop's language, not the browser's", () => {
    // `[]` is navigator.language: a German box opened from an en-US browser
    // showed "09:27 AM" on the shelf and "Monday, September 7" in the power
    // menu, while About's build date beside them was in German.
    expect(clock).not.toMatch(/toLocale(Time|Date)String\(\[\]/);
    expect(clock).toMatch(/now\.toLocaleTimeString\(tag, \{ hour: "2-digit", minute: "2-digit" \}\)/);
    expect(clock).toMatch(/now\.toLocaleDateString\(tag, \{ weekday: "long", month: "long", day: "numeric" \}\)/);
    // The locale the desktop already reads, and a re-format once it resolves,
    // since every provider starts on a provisional "en": the tag is the
    // store's key, so a new one is formatted at once.
    expect(clock).toMatch(/const \{ locale \} = useT\(\);/);
    expect(clock).toMatch(/const tag = clockLocaleTag\(locale, typeof navigator === "undefined" \? undefined : navigator\.languages\);/);
  });

  // The expression the pin below holds the source to: `locale` is a bare
  // language tag, and a bare "en" is en-US to Intl.
  const regionalTag = (languages: readonly string[] | undefined, locale: string) =>
    languages?.find((l) => l.toLowerCase().startsWith(`${locale}-`)) ?? locale;

  it("takes the browser's region for that language, so a UK browser keeps its 24-hour clock", () => {
    // `locale` alone made "09:27 AM" of every English desktop — the en-GB,
    // en-IE and en-ZA browsers that read "09:27" until then included — and
    // ~52px of it inside the phone bar's 40px clock button.
    expect(clock).toMatch(/return languages\?\.find\(\(l\) => l\.toLowerCase\(\)\.startsWith\(`\$\{locale\}-`\)\) \?\? locale;/);
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

describe("the file-drop overlay over a row of monitors", () => {
  it("centres its card on the main monitor, and leaves it to the flex centring without a layout", () => {
    // `fixed inset-0 … justify-center` alone put the card on the seam
    // between two equal monitors, half of it on each.
    const overlay = src.match(/\{desktopDragOver && \([\s\S]{0,1200}?files\.dropToUpload/)?.[0] ?? "";
    // No backdrop blur under the dim (a full-screen blur is redone over the
    // whole 5120x1440 desktop on every frame the mascot moves beneath it); one
    // step darker keeps the look.
    expect(overlay).toMatch(/className="fixed inset-0 flex items-center justify-center bg-black\/65 pointer-events-none"/);
    expect(overlay).toMatch(/style=\{mainRect \? \{ position: "absolute", left: mainRect\.x \+ mainRect\.width \/ 2, top: mainRect\.y \+ mainRect\.height \/ 2, transform: "translate\(-50%, -50%\)" \} : undefined\}/);
  });
});

describe("the desktop's full-screen scrims", () => {
  it("dim without a backdrop blur, one step darker", () => {
    // The file-drop overlay and the uninstall confirmation: a blur under a
    // 60% black scrim is 40% of what is seen, and costs a whole-viewport pass
    // per frame while anything underneath animates.
    expect(src).not.toMatch(/backdrop-blur/);
    expect(src).toMatch(/<div className="fixed inset-0 flex items-center justify-center bg-black\/65" style=\{\{ zIndex: DESKTOP_LAYERS\.modal \}\} onClick=\{dismissUninstall\}>/);
  });
});

describe("the launcher and the power menu", () => {
  // Both are memoized (ChromeLauncher.tsx, SystemTray.tsx); their memo holds
  // only while every prop keeps its identity. Counted, not just pinned, in
  // src/tests/components/desktop-shell-renders.test.tsx.
  it("are handed the launcher's apps as one memoized list, not rebuilt inline", () => {
    expect(src).toMatch(/const launcherApps = useMemo\(\(\) => allApps/);
    expect(src).toMatch(/\}\)\), \[allApps, t, isAppPinned\]\);/);
    expect(src).toMatch(/apps=\{launcherApps\}/);
    expect(src).not.toMatch(/apps=\{allAppsForLauncher\.map/);
  });

  it("are handed handlers with one identity for the page's life", () => {
    expect(src).toMatch(/const closeLauncher = useCallback\(\(\) => setLauncherOpen\(false\), \[\]\);/);
    expect(src).toMatch(/const closeTray = useCallback\(\(\) => setTrayOpen\(false\), \[\]\);/);
    const launcher = src.match(/<ChromeLauncher[\s\S]{0,400}?\/>/)?.[0] ?? "";
    expect(launcher).toMatch(/onClose=\{closeLauncher\}/);
    // openApp is rebuilt on every window open, focus and move.
    expect(launcher).toMatch(/onAppClick=\{openAppStable\}/);
    const tray = src.match(/<SystemTray[\s\S]{0,200}?\/>/)?.[0] ?? "";
    expect(tray).toMatch(/onClose=\{closeTray\}/);
  });
});
