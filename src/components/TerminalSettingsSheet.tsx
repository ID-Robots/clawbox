"use client";

/**
 * The Terminal's settings, as a sheet over the right of the Terminal window
 * (the gear in its title bar, or "Terminal settings…" in the right-click
 * menu). Everything applies to every open terminal the moment it changes and
 * is saved to the owner's preferences (src/lib/terminal-settings.ts); the
 * shell and the starting folder apply to tabs opened afterwards, because a
 * running shell cannot be swapped under what it is doing.
 *
 * Drawn with the desktop Settings app's own controls — its switch, its
 * segmented control, its slider — on the window chrome's palette, in the
 * chrome's dark or light face to match the terminal under it.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { useTr } from "@/lib/i18n-floor";
import { WINDOW_CHROME } from "@/lib/window-chrome";
import {
  DEFAULT_TERMINAL_SETTINGS,
  TERMINAL_FONTS,
  TERMINAL_FONT_IDS,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK_CHOICES,
  TERMINAL_THEMES,
  TERMINAL_THEME_IDS,
  resetTerminalSettings,
  terminalThemeFor,
  updateTerminalSettings,
  useTerminalSettings,
  type TerminalCursorStyle,
  type TerminalSettings,
} from "@/lib/terminal-settings";
import { isMacPlatform, shortcutFallbackLabel, shortcutLabel } from "@/lib/terminal-keys";

interface Look {
  panel: string;
  header: string;
  text: string;
  muted: string;
  label: string;
  field: string;
  segment: string;
  segmentOn: string;
  segmentOff: string;
  divider: string;
  toggleOff: string;
  row: string;
  kbd: string;
  closeHover: string;
}

/** The two faces of the sheet, as the window chrome has two. */
const LOOK: Record<"dark" | "light", Look> = {
  dark: {
    panel: WINDOW_CHROME.dark.titleBarInactive,
    header: WINDOW_CHROME.dark.strip,
    text: "text-white/90",
    muted: "text-white/55",
    label: "text-white/45",
    field: "bg-white/[0.05] border-white/10 text-white/90 focus:border-orange-500/70",
    segment: "bg-white/[0.04]",
    segmentOn: "bg-orange-500/15 text-[var(--coral-bright)] shadow-sm",
    segmentOff: "text-white/50 hover:text-white/80 hover:bg-white/[0.05]",
    divider: "border-white/[0.06]",
    toggleOff: "bg-white/15",
    row: "hover:bg-white/[0.04]",
    kbd: "bg-white/[0.06] border-white/10 text-white/70",
    closeHover: "hover:bg-white/10 text-white/60 hover:text-white/90",
  },
  light: {
    panel: WINDOW_CHROME.light.titleBarInactive,
    header: WINDOW_CHROME.light.strip,
    text: "text-black/85",
    muted: "text-black/55",
    label: "text-black/50",
    field: "bg-white border-black/15 text-black/85 focus:border-orange-500/70",
    segment: "bg-black/[0.05]",
    segmentOn: "bg-orange-500/15 text-orange-700 shadow-sm",
    segmentOff: "text-black/55 hover:text-black/80 hover:bg-black/[0.05]",
    divider: "border-black/[0.08]",
    toggleOff: "bg-black/20",
    row: "hover:bg-black/[0.04]",
    kbd: "bg-black/[0.05] border-black/10 text-black/70",
    closeHover: "hover:bg-black/[0.07] text-black/55 hover:text-black/85",
  },
};

const SLIDER = "w-full h-1.5 rounded-full appearance-none cursor-pointer accent-orange-500 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#fe6e00] [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(254,110,0,0.3),0_2px_6px_rgba(0,0,0,0.3)]";

interface ShellsAnswer { shells: string[]; defaultShell: string }

export default function TerminalSettingsSheet({ onClose }: { onClose: () => void }) {
  const { locale } = useT();
  const tr = useTr();
  const { settings, saveFailed } = useTerminalSettings();
  const theme = terminalThemeFor(settings.theme);
  const tone = theme.tone;
  const look = LOOK[tone];
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [mac] = useState(() => isMacPlatform());
  const [shells, setShells] = useState<ShellsAnswer | null>(null);
  const [cwdDraft, setCwdDraft] = useState(settings.cwd);
  const set = useCallback((patch: Partial<TerminalSettings>) => updateTerminalSettings(patch), []);

  // The keyboard comes into the sheet when it opens.
  useEffect(() => { closeRef.current?.focus(); }, []);

  // The shells this box has, for the default-shell list.
  useEffect(() => {
    let cancelled = false;
    fetch("/setup-api/terminal/shells")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ShellsAnswer | null) => {
        if (cancelled || !data || !Array.isArray(data.shells)) return;
        setShells({ shells: data.shells.filter((s) => typeof s === "string"), defaultShell: typeof data.defaultShell === "string" ? data.defaultShell : "/bin/bash" });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const commitCwd = useCallback(() => {
    if (cwdDraft.trim() !== settings.cwd) set({ cwd: cwdDraft.trim() });
  }, [cwdDraft, settings.cwd, set]);

  // Escape closes; Tab stays inside the sheet while it is open.
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }, [onClose]);

  const number = (n: number) => n.toLocaleString(locale || undefined);
  const defaultShell = shells?.defaultShell ?? "/bin/bash";
  const shellOptions = shells?.shells ?? [];
  // A chosen shell the list does not carry (the list failed to load, or the
  // shell was uninstalled) is still shown, so the select never lies about it.
  const listedShells = settings.shell && !shellOptions.includes(settings.shell) ? [...shellOptions, settings.shell] : shellOptions;

  // A stored length the list does not offer (set through the agent's
  // preferences_set) is shown as itself rather than as a different choice.
  const scrollbackChoices: number[] = (TERMINAL_SCROLLBACK_CHOICES as readonly number[]).includes(settings.scrollback)
    ? [...TERMINAL_SCROLLBACK_CHOICES]
    : [...TERMINAL_SCROLLBACK_CHOICES, settings.scrollback].sort((a, b) => a - b);

  const cursorChoices: Array<{ id: TerminalCursorStyle; label: string; glyph: string }> = [
    { id: "block", label: tr("terminal.settings.cursorBlock", "Block"), glyph: "█" },
    { id: "bar", label: tr("terminal.settings.cursorBar", "Bar"), glyph: "▏" },
    { id: "underline", label: tr("terminal.settings.cursorUnderline", "Underline"), glyph: "▁" },
  ];

  const shortcutRows: Array<{ label: string; keys: string[] }> = [
    { label: tr("terminal.newTab", "New tab"), keys: [shortcutLabel("newTab", mac), shortcutFallbackLabel("newTab")] },
    { label: tr("terminal.closeTab", "Close tab"), keys: [shortcutLabel("closeTab", mac), shortcutFallbackLabel("closeTab")] },
    { label: tr("terminal.nextTab", "Next tab"), keys: [shortcutLabel("nextTab", mac), shortcutFallbackLabel("nextTab")] },
    { label: tr("terminal.prevTab", "Previous tab"), keys: [shortcutLabel("prevTab", mac), shortcutFallbackLabel("prevTab")] },
    { label: tr("terminal.copy", "Copy"), keys: [shortcutLabel("copy", mac)] },
    { label: tr("terminal.paste", "Paste"), keys: [shortcutLabel("paste", mac)] },
  ];

  const isDefault = JSON.stringify(settings) === JSON.stringify(DEFAULT_TERMINAL_SETTINGS);

  return (
    <div className="absolute inset-0 z-20 flex justify-end" data-testid="terminal-settings">
      {/* The terminal stays visible, dimmed, so a theme change is seen as it is made. */}
      <div className="absolute inset-0 bg-black/25" onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="terminal-settings-sheet"
        onKeyDown={onKeyDown}
        className={`relative flex h-full w-[360px] max-w-full flex-col shadow-2xl border-l ${look.divider} ${look.text}`}
        style={{ background: look.panel }}
      >
        <div className={`flex items-center gap-2 h-11 shrink-0 pl-4 pr-2 border-b ${look.divider}`} style={{ background: look.header }}>
          <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }} aria-hidden="true">tune</span>
          <h2 id={titleId} className="flex-1 min-w-0 truncate text-sm font-semibold m-0">{tr("terminal.settings.title", "Terminal settings")}</h2>
          <button
            ref={closeRef}
            type="button"
            data-testid="terminal-settings-close"
            aria-label={tr("terminal.settings.close", "Close settings")}
            title={tr("terminal.settings.close", "Close settings")}
            onClick={onClose}
            className={`w-7 h-7 flex items-center justify-center rounded-full border-none bg-transparent cursor-pointer transition-colors ${look.closeHover}`}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 18 }} aria-hidden="true">close</span>
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-5">
          <Section title={tr("terminal.settings.appearance", "Appearance")} look={look}>
            <Field label={tr("terminal.settings.theme", "Theme")} look={look}>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={tr("terminal.settings.theme", "Theme")}>
                {TERMINAL_THEME_IDS.map((id) => {
                  const def = TERMINAL_THEMES[id];
                  const selected = settings.theme === id;
                  const c = def.colors;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`terminal-theme-${id}`}
                      onClick={() => set({ theme: id })}
                      className={`group rounded-lg p-1 text-left border cursor-pointer transition-colors ${
                        selected ? "border-orange-500 ring-1 ring-orange-500/60" : `${look.divider} ${look.row}`
                      } bg-transparent`}
                    >
                      <div className="rounded-md px-2 py-1.5 font-mono text-[10px] leading-[1.35] overflow-hidden" style={{ background: c.background, color: c.foreground }}>
                        <div className="truncate"><span style={{ color: c.green }}>~</span> <span style={{ color: c.blue }}>ls</span> -l</div>
                        <div className="truncate"><span style={{ color: c.blue }}>src</span> <span style={{ color: c.green }}>run.sh</span> <span style={{ color: c.red }}>x</span></div>
                        <div className="flex gap-[3px] mt-1" aria-hidden="true">
                          {[c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan].map((swatch, i) => (
                            <span key={i} className="w-2 h-2 rounded-sm" style={{ background: swatch }} />
                          ))}
                          <span className="w-1.5 h-2 ml-auto" style={{ background: c.cursor }} />
                        </div>
                      </div>
                      <div className={`px-1 pt-1 text-[11px] font-medium truncate ${selected ? "" : look.muted}`}>
                        {def.labelKey ? tr(def.labelKey, def.name) : def.name}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label={tr("terminal.settings.font", "Font")} look={look}>
              <div className="space-y-1" role="radiogroup" aria-label={tr("terminal.settings.font", "Font")}>
                {TERMINAL_FONT_IDS.map((id) => {
                  const def = TERMINAL_FONTS[id];
                  const selected = settings.font === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`terminal-font-${id}`}
                      onClick={() => set({ font: id })}
                      className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left border cursor-pointer transition-colors bg-transparent ${
                        selected ? "border-orange-500/70 bg-orange-500/10" : `border-transparent ${look.row}`
                      }`}
                    >
                      <span className="flex-1 min-w-0 truncate text-[13px]" style={{ fontFamily: def.family }}>
                        {def.labelKey ? tr(def.labelKey, def.name) : def.name}
                      </span>
                      <span className={`shrink-0 text-[12px] ${look.muted}`} style={{ fontFamily: def.family }} aria-hidden="true">{"{ 0O 1lI }"}</span>
                      {selected && <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 16 }} aria-hidden="true">check</span>}
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label={tr("terminal.settings.fontSize", "Font size")} look={look} value={`${settings.fontSize} px`}>
              <div className="flex items-center gap-2">
                <StepButton icon="remove" label={tr("terminal.settings.smaller", "Smaller")} look={look} disabled={settings.fontSize <= TERMINAL_FONT_SIZE.min} onClick={() => set({ fontSize: settings.fontSize - 1 })} />
                <input
                  type="range"
                  data-testid="terminal-font-size"
                  aria-label={tr("terminal.settings.fontSize", "Font size")}
                  min={TERMINAL_FONT_SIZE.min}
                  max={TERMINAL_FONT_SIZE.max}
                  step={1}
                  value={settings.fontSize}
                  onChange={(e) => set({ fontSize: Number(e.target.value) })}
                  className={SLIDER}
                  style={{ background: `color-mix(in srgb, currentColor 18%, transparent)` }}
                />
                <StepButton icon="add" label={tr("terminal.settings.larger", "Larger")} look={look} disabled={settings.fontSize >= TERMINAL_FONT_SIZE.max} onClick={() => set({ fontSize: settings.fontSize + 1 })} />
              </div>
            </Field>

            <Field label={tr("terminal.settings.lineHeight", "Line height")} look={look} value={settings.lineHeight.toFixed(2)}>
              <input
                type="range"
                data-testid="terminal-line-height"
                aria-label={tr("terminal.settings.lineHeight", "Line height")}
                min={TERMINAL_LINE_HEIGHT.min}
                max={TERMINAL_LINE_HEIGHT.max}
                step={TERMINAL_LINE_HEIGHT.step}
                value={settings.lineHeight}
                onChange={(e) => set({ lineHeight: Number(e.target.value) })}
                className={SLIDER}
                style={{ background: `color-mix(in srgb, currentColor 18%, transparent)` }}
              />
            </Field>

            <Field label={tr("terminal.settings.cursor", "Cursor")} look={look}>
              <Segmented
                look={look}
                label={tr("terminal.settings.cursor", "Cursor")}
                value={settings.cursorStyle}
                choices={cursorChoices.map((c) => ({ id: c.id, label: c.label, glyph: c.glyph }))}
                onChange={(id) => set({ cursorStyle: id })}
                testId="terminal-cursor"
              />
              <Toggle
                look={look}
                label={tr("terminal.settings.cursorBlink", "Blinking cursor")}
                on={settings.cursorBlink}
                onToggle={(on) => set({ cursorBlink: on })}
                testId="terminal-cursor-blink"
              />
            </Field>
          </Section>

          <Section title={tr("terminal.settings.behaviour", "Behaviour")} look={look}>
            <Field label={tr("terminal.settings.scrollback", "Scrollback")} look={look}>
              <select
                data-testid="terminal-scrollback"
                aria-label={tr("terminal.settings.scrollback", "Scrollback")}
                value={String(settings.scrollback)}
                onChange={(e) => set({ scrollback: Number(e.target.value) })}
                className={`w-full rounded-lg border px-2.5 py-1.5 text-sm outline-none cursor-pointer ${look.field}`}
              >
                {scrollbackChoices.map((n) => (
                  <option key={n} value={n} style={{ background: look.panel }}>
                    {tr("terminal.settings.scrollbackLines", "{n} lines", { n: number(n) })}
                  </option>
                ))}
              </select>
            </Field>
            <Toggle
              look={look}
              label={tr("terminal.settings.copyOnSelect", "Copy on select")}
              hint={tr("terminal.settings.copyOnSelectHint", "Selected text goes straight to the clipboard")}
              on={settings.copyOnSelect}
              onToggle={(on) => set({ copyOnSelect: on })}
              testId="terminal-copy-on-select"
            />
            <Field label={tr("terminal.settings.bell", "Bell")} look={look}>
              <Segmented
                look={look}
                label={tr("terminal.settings.bell", "Bell")}
                value={settings.bell}
                choices={[
                  { id: "off", label: tr("terminal.settings.bellOff", "Off") },
                  { id: "visual", label: tr("terminal.settings.bellVisual", "Visual") },
                ]}
                onChange={(id) => set({ bell: id })}
                testId="terminal-bell"
              />
            </Field>
          </Section>

          <Section title={tr("terminal.settings.shellSection", "Shell")} look={look} note={tr("terminal.settings.newTabsOnly", "Applies to tabs opened from now on")}>
            <Field label={tr("terminal.settings.shell", "Default shell")} look={look}>
              <select
                data-testid="terminal-shell"
                aria-label={tr("terminal.settings.shell", "Default shell")}
                value={settings.shell}
                onChange={(e) => set({ shell: e.target.value })}
                className={`w-full rounded-lg border px-2.5 py-1.5 text-sm font-mono outline-none cursor-pointer ${look.field}`}
              >
                <option value="" style={{ background: look.panel }}>{tr("terminal.settings.shellDefault", "Box default ({shell})", { shell: defaultShell })}</option>
                {listedShells.filter((s) => s !== defaultShell).map((s) => (
                  <option key={s} value={s} style={{ background: look.panel }}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label={tr("terminal.settings.cwd", "Starting folder")} look={look}>
              <input
                type="text"
                data-testid="terminal-cwd"
                aria-label={tr("terminal.settings.cwd", "Starting folder")}
                value={cwdDraft}
                placeholder={tr("terminal.settings.cwdPlaceholder", "~ (home folder)")}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setCwdDraft(e.target.value)}
                onBlur={commitCwd}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitCwd(); } }}
                className={`w-full rounded-lg border px-2.5 py-1.5 text-sm font-mono outline-none ${look.field}`}
              />
            </Field>
          </Section>

          <Section title={tr("terminal.settings.shortcuts", "Keyboard shortcuts")} look={look} note={tr("terminal.settings.shortcutsNote", "In a browser tab the browser keeps Ctrl+Shift+T, Ctrl+Shift+W and Ctrl+Tab for itself; the Alt+Shift keys work everywhere.")}>
            <dl className="m-0 space-y-1.5">
              {shortcutRows.map((row) => (
                <div key={row.label} className="flex items-center gap-2 text-[13px]">
                  <dt className={`flex-1 min-w-0 truncate ${look.muted}`}>{row.label}</dt>
                  <dd className="m-0 flex flex-wrap justify-end gap-1">
                    {row.keys.map((keys) => (
                      <kbd key={keys} className={`rounded-md border px-1.5 py-px font-mono text-[11px] ${look.kbd}`}>{keys}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>
        </div>

        <div className={`flex items-center gap-2 shrink-0 px-4 py-2.5 border-t ${look.divider}`}>
          {saveFailed ? (
            <span role="status" className="flex-1 min-w-0 text-xs text-amber-500">{tr("terminal.settings.saveFailed", "Not saved to this box — the change lasts until the page reloads")}</span>
          ) : (
            <span className={`flex-1 min-w-0 text-xs ${look.label}`}>{tr("terminal.settings.savedPerUser", "Saved to your ClawBox preferences")}</span>
          )}
          <button
            type="button"
            data-testid="terminal-settings-reset"
            disabled={isDefault}
            onClick={() => { resetTerminalSettings(); setCwdDraft(""); }}
            className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium border cursor-pointer bg-transparent transition-colors disabled:opacity-40 disabled:cursor-default ${look.divider} ${look.row}`}
          >
            {tr("terminal.settings.reset", "Reset to defaults")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, note, look, children }: { title: string; note?: string; look: Look; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className={`m-0 text-[11px] font-semibold uppercase tracking-wider ${look.label}`}>{title}</h3>
      {children}
      {note && <p className={`m-0 text-xs leading-snug ${look.label}`}>{note}</p>}
    </section>
  );
}

function Field({ label, value, look, children }: { label: string; value?: string; look: Look; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        {value && <span className={`text-xs font-mono tabular-nums ${look.muted}`}>{value}</span>}
      </div>
      {children}
    </div>
  );
}

function StepButton({ icon, label, look, disabled, onClick }: { icon: string; label: string; look: Look; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`w-7 h-7 shrink-0 flex items-center justify-center rounded-lg border cursor-pointer bg-transparent transition-colors disabled:opacity-35 disabled:cursor-default ${look.divider} ${look.row}`}
    >
      <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">{icon}</span>
    </button>
  );
}

/** The Settings app's segmented control. */
function Segmented<T extends string>({ look, label, value, choices, onChange, testId }: {
  look: Look;
  label: string;
  value: T;
  choices: Array<{ id: T; label: string; glyph?: string }>;
  onChange: (id: T) => void;
  testId: string;
}) {
  return (
    <div className={`flex gap-1 rounded-xl p-1 ${look.segment}`} role="radiogroup" aria-label={label}>
      {choices.map((choice) => {
        const on = choice.id === value;
        return (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-testid={`${testId}-${choice.id}`}
            onClick={() => onChange(choice.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium border-none cursor-pointer transition-colors ${on ? look.segmentOn : `bg-transparent ${look.segmentOff}`}`}
          >
            {choice.glyph && <span className="font-mono leading-none" aria-hidden="true">{choice.glyph}</span>}
            {choice.label}
          </button>
        );
      })}
    </div>
  );
}

/** The Settings app's switch. */
function Toggle({ look, label, hint, on, onToggle, testId }: { look: Look; label: string; hint?: string; on: boolean; onToggle: (on: boolean) => void; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className={`text-xs leading-snug ${look.muted}`}>{hint}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        data-testid={testId}
        onClick={() => onToggle(!on)}
        className={`relative inline-flex items-center w-10 h-5 rounded-full transition-colors cursor-pointer border-none shrink-0 ${on ? "bg-orange-500" : look.toggleOff}`}
      >
        <span
          className="absolute w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-200"
          style={{ left: 2, transform: on ? "translateX(18px)" : "translateX(0)" }}
        />
      </button>
    </div>
  );
}
