import keysymdef from "@novnc/novnc/lib/input/keysymdef";

export type TrackedKey = {
  code: string | null;
  keysym: number;
};

const SPECIAL_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Insert: 0xff63,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  MetaLeft: 0xffe7,
  MetaRight: 0xffe8,
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  " ": 0x0020,
};

const MODIFIER_KEYSYMS: Record<string, number> = {
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffe7,
};

export function getTrackedVncKey(event: Pick<KeyboardEvent, "code" | "key">): TrackedKey | null {
  const code = event.code && event.code !== "Unidentified" ? event.code : null;
  let keysym: number | null = null;

  if (code && code in SPECIAL_KEYSYMS) {
    keysym = SPECIAL_KEYSYMS[code];
  } else if (event.key in MODIFIER_KEYSYMS) {
    keysym = MODIFIER_KEYSYMS[event.key];
  } else if (event.key in SPECIAL_KEYSYMS) {
    keysym = SPECIAL_KEYSYMS[event.key];
  } else if (event.key.length === 1) {
    const codepoint = event.key.codePointAt(0);
    if (codepoint !== undefined) {
      const lookedUpKeysym = keysymdef.lookup(codepoint);
      if (typeof lookedUpKeysym === "number") {
        keysym = lookedUpKeysym;
      }
    }
  }

  if (keysym === null) return null;
  return { code, keysym };
}
