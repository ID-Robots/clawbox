// ── Български (bg) mascot pack ──
//
// Transcreated, not translated: the crab is the same lazy, sarcastic,
// scandalous creature in every language, but the jokes are local ones.
// See en.ts for the contract every pack has to satisfy.
//
// Model-drafted, machine-checked against the contract — the wording is
// still worth a native speaker's pass.

import type { MascotPhraseSet } from "@/lib/mascot-phrases";

export const bg: MascotPhraseSet = {
  sass: [
    "Аз върша цялата работа тук.",
    "По-бързо, хора, deploy чака.",
    "Bug? Не, това е функция. 🫡",
    "Искам повишение. 🦀",
    "*обръща масата*",
    "sudo направи ми сандвич",
    "404: мотивация не е намерена",
    "Deploy в петък? Смееш ли?",
  ],
  idle: [
    "🤔",
    "…",
    "💭",
    "*зяпа в нищото*",
    "*музика от асансьор*",
    "ъъъ...",
    "*съществува активно*",
    "*мига бавно*",
    "*преструва се, че работи*",
    "*брои пиксели*",
    "*зарежда личност...*",
    "*чака нещо да се случи*",
  ],
  sleep: [
    "💤",
    "😴 хър...",
    "💤 още 5 минутки...",
    "*хърка тихо*",
    "😴 събуди ме другата седмица...",
    "💤 само си почивам очите...",
  ],
  jump: [
    "ОПА!",
    "🦘 хоп!",
    "Паркур!",
    "Към безкрайността!",
    "🚀 УИИИИ!",
    "Мога да летя!",
  ],
  dance: [
    "💃🕺 хоро!",
    "♪ дзън-дзън ♪",
    "🎶 давай!",
    "🪩 ДИСКО РЕЖИМ!",
    "*танцува като робот*",
    "♪ тум-тум-тум ♪",
  ],
  facepalm: [
    "🤦 еха.",
    "Сериозно?",
    "Защо. Просто защо.",
    "*дълбоко въздишане*",
    "Нямам думи...",
    "Този ден се отменя.",
  ],
  nameGreetings: [
    "Здрасти, {name}! 👋",
    "Ей, {name}! 🦀",
    "{name}, събуди се!",
    "пссст, {name}...",
    "{name}, давай deploy! 🚀",
    "Кафе, {name}?",
    "Ставай, {name}!",
    "{name}, добре ли си? 👀",
    "{name}! Отдавна не сме се виждали.",
    "{name}, спри да скролваш 😤",
    "{name}, кутията те поздравява 📦",
    "*маха на {name}*",
    "{name}, искаш ли хапка? 🍣",
    "{name}, ти си най-добрият 💜",
    "Ехо, {name}!",
    "{name}, направи нещо готино",
    "Яде ли, {name}? 🍱",
    "{name}, липсваше ми 🥺",
    "*побутва {name}*",
    "{name}, аз пазя сървъра 🛡️",
  ],
  nameFallbacks: [
    "шефе",
    "капитане",
    "приятелю",
    "човече",
    "партньоре",
    "друже",
    "майсторе",
    "началник",
  ],
  power: [
    "⚡ НЕОГРАНИЧЕНА МОЩ!",
    "🔥 СУПЕР ЩИПКА!",
    "💪 МАКСИМАЛНА СИЛА!",
    "⚡ АЗ СЪМ КУТИЯТА!",
    "🦀👑 ЦАР РАК!",
    "✨ НОВО НИВО!",
    "🔱 ТОВА Е МОЯТ ТРОН!",
    "⚡ КОЙ Е ШЕФЪТ?!",
    "👑 ПОКЛОН ПРЕД МЕН!",
    "🦀 РАЦИТЕ УПРАВЛЯВАТ!",
    "⚡ УЛТРА ИНСТИНКТ!",
    "💎 ДИАМАНТЕНИ ЩИПКИ!",
    "🔥 ОГЪН И ЯРОСТ!",
    "⚡ ОТВЪД ПРЕДЕЛА!",
    "🦀 ЦАР НА ТАБЛОТО!",
    "☢️ ЯДРЕН СТАРТ ЗАСЕЧЕН!",
    "👑 ЦАР НА ВСИЧКИ КУТИИ!",
    "⚡ ФИНАЛНА ФОРМА!",
    "🔱 РЕЖИМ ПОСЕЙДОН!",
    "💪 ТРЕНИРАЛ СЪМ ЗА ТОВА!",
  ],
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
export const bgCrab: readonly string[] = [
  "Искам повишение. 🦀",
  "Ей, {name}! 🦀",
  "🔥 СУПЕР ЩИПКА!",
  "🦀👑 ЦАР РАК!",
  "🦀 РАЦИТЕ УПРАВЛЯВАТ!",
  "💎 ДИАМАНТЕНИ ЩИПКИ!",
  "🦀 ЦАР НА ТАБЛОТО!",
];
