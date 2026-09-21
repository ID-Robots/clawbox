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

// ── The crab-literal lines in this pack ──
//
// A Hermes pet wears someone else's body, so it must never say "crab", "claw"
// or wear the 🦀. `mascot-pet-voice.ts` subtracts this set from the pack
// before a pet speaks; the crab itself is served the pack untouched.
//
// Tagged HERE, next to the lines themselves, so adding a joke and declaring it
// crab-specific is one edit in one file — and so a locale's tags travel in the
// same code-split chunk as its pack. `mascot-pet-voice.test.ts` re-derives
// this list from a crab lexicon and fails if the two disagree, which is what
// stops it drifting.
export const neutralCrab: readonly string[] = [
  "🦀",
  "🦀💢",
  "🦀💤",
  "💤🦀",
  "🦀⬆️",
  "🦀🎶",
  "{name} 🦀",
  "🦀👑",
];
