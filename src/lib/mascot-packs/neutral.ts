// ── Neutral mascot pack (language-free) ──
//
// Emoji, punctuation and digits only: every entry classifies as `neutral`, so
// it is renderable in EVERY locale. This is what the crab says before the
// per-locale pack has loaded and what fills a category when a locale's pack is
// missing — the mascot must never fall back to English on a non-English box.
//
// Keep it strictly language-free: no words, in any language.

import type { MascotPhraseSet } from "@/lib/mascot-phrases";

export const neutral: MascotPhraseSet = {
  sass: ["🦀", "😒", "🙄", "🫡", "💅", "😤", "🦀💢", "🤷"],
  idle: ["🤔", "...", "💭", "🫥", "👀", "😐", "🦀💤", "✨", "🫧", "😶‍🌫️"],
  sleep: ["💤", "😴", "💤💤", "😴💭", "🌙", "💤🦀"],
  jump: ["🦘", "🚀", "⬆️", "🦀⬆️", "💫", "🎈"],
  dance: ["💃🕺", "🎶", "🪩", "🎵", "🕺", "🦀🎶"],
  facepalm: ["🤦", "😑", "🫠", "😮‍💨", "💀", "🙃"],
  nameGreetings: ["👋 {name}", "{name} 🦀", "{name}! ✨", "🫡 {name}", "{name} 👀", "{name} 💜"],
  nameFallbacks: ["🦀", "👑", "🫡", "😎", "⭐", "🐙"],
  power: ["⚡", "🔥", "💪", "👑", "🦀👑", "⚡⚡⚡", "💎", "🔱", "✨💪", "🌟"],
};

