// ── English mascot pack ──
//
// TEMPLATE FOR EVERY OTHER LOCALE PACK. The contract each pack must satisfy:
//
//   * one file per locale, `src/lib/mascot-packs/<locale>.ts`
//   * `export const <locale>: MascotPhraseSet`
//   * every category in PHRASE_CATEGORIES present and NON-EMPTY
//   * every entry <= 60 characters (it has to fit a small speech bubble)
//   * every entry written in that locale's script — English technical terms
//     from TECH_ALLOWLIST (deploy, bug, sudo, git, PR, wifi, …) are fine
//     inside a phrase, nothing else foreign is
//   * `nameGreetings` entries MUST contain the literal `{name}` token
//   * `nameFallbacks` are single words, no `{name}`, no whitespace
//   * TRANSCREATE, do not translate: keep the "lazy, sarcastic, scandalous"
//     crab, use jokes that land in that language
//   * do not copy a non-neutral line from another pack — only pure emoji
//     lines may repeat across packs
//
// Tone: affectionate, terse, slightly chaotic. The crab does all the work
// around here and wants you to know it.

import type { MascotPhraseSet } from "@/lib/mascot-phrases";

export const en: MascotPhraseSet = {
  sass: [
    "I do all the work here.",
    "Ship faster, humans.",
    "Bug? Feature. 🫡",
    "I need a raise.",
    "*flips table*",
    "sudo make me a sandwich",
    "404: motivation not found",
    "Deploy on Friday? Dare me.",
    "My claws are unionised.",
    "Have you tried turning me off? Don't.",
  ],
  idle: [
    "🤔",
    "...",
    "💭",
    "*stares into void*",
    "*elevator music*",
    "🫥",
    "*exists aggressively*",
    "hmm...",
    "*blinks*",
    "*pretends to work*",
    "*counts pixels*",
    "*loads personality*",
  ],
  sleep: [
    "💤",
    "😴 zzz...",
    "💤 5 more minutes...",
    "*snore*",
    "😴 wake me up later...",
    "💤 ...just resting my eyes...",
    "😴 do not perceive me",
    "💤 offline. emotionally.",
  ],
  jump: [
    "YEEET!",
    "🦘",
    "Parkour!",
    "To infinity!",
    "🚀 WEEEE!",
    "I believe I can fly!",
    "Hops undefeated 🦀",
    "Gravity? Never heard of her.",
  ],
  dance: [
    "💃🕺",
    "♪ cha-ching ♪",
    "🎶",
    "🪩 DISCO MODE!",
    "*does the robot*",
    "♪ dun dun dun ♪",
    "🦀 shuffle time",
    "♪ claws up ♪",
  ],
  facepalm: [
    "🤦",
    "Seriously?",
    "Why.",
    "*deep breath*",
    "I can't even...",
    "This day is cancelled.",
    "Bold choice. Wrong, but bold.",
    "*rebooting my faith*",
  ],
  nameGreetings: [
    "Hey {name}! 👋",
    "yo {name} 🦀",
    "{name}, look alive!",
    "psst {name}...",
    "{name}, ship it! 🚀",
    "Coffee, {name}?",
    "Wake up, {name}!",
    "{name}, you good? 👀",
    "{name}! Long time no scuttle.",
    "{name}, stop scrolling 😤",
    "{name}, the box says hi 📦",
    "*waves at {name}*",
    "{name}, treat? 🍣",
    "{name}, you're the best 💜",
    "oi oi {name}!",
    "{name}, deploy something cool",
    "Did you eat, {name}? 🍱",
    "{name}, I missed you 🥺",
    "*nudges {name}*",
    "{name}, one more commit? 😇",
  ],
  nameFallbacks: ["boss", "captain", "friend", "human", "partner", "buddy", "chief", "legend"],
  power: [
    "⚡ UNLIMITED POWER!",
    "🔥 SUPER CLAW!",
    "💪 MAXIMUM POWER!",
    "⚡ I AM THE BOX!",
    "🦀👑 KING CRAB!",
    "✨ LEVEL UP!",
    "🔱 THIS IS MY THRONE!",
    "⚡ WHO'S THE BOSS?!",
    "👑 BOW BEFORE ME!",
    "🦀 CRAB SUPREMACY!",
    "⚡ ULTRA INSTINCT!",
    "💎 DIAMOND CLAWS ACTIVATED!",
    "🔥 FIRE AND FURY!",
    "⚡ PLUS ULTRA!",
    "🦀 KING OF THE DASHBOARD!",
    "☢️ NUCLEAR LAUNCH DETECTED!",
    "👑 KING OF ALL BOXES!",
    "⚡ FINAL FORM ACHIEVED!",
    "🔱 POSEIDON MODE!",
    "💪 TRAINED FOR THIS!",
  ],
};

