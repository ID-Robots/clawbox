// ── Svenska (sv) mascot pack ──
//
// Transcreated, not translated: the crab is the same lazy, sarcastic,
// scandalous creature in every language, but the jokes are local ones.
// See en.ts for the contract every pack has to satisfy.
//
// Model-drafted, machine-checked against the contract — the wording is
// still worth a native speaker's pass.

import type { MascotPhraseSet } from "@/lib/mascot-phrases";

export const sv: MascotPhraseSet = {
  sass: [
    "Jag gör allt jobb här. 🦀",
    "Snabbare deploy, människor.",
    "Bug? Nej, en funktion. 🫡",
    "Jag vill ha löneförhöjning.",
    "*välter bordet*",
    "sudo gör en macka åt mig",
    "404: motivation hittades inte",
    "Deploy på en fredag? Vågar du?",
  ],
  idle: [
    "😌",
    "❄️",
    "☕",
    "*stirrar ut i tomma intet*",
    "*hissmusik*",
    "nja...",
    "*existerar med eftertryck*",
    "*blinkar långsamt*",
    "*låtsas jobba*",
    "*räknar pixlar*",
    "*laddar personlighet...*",
    "*väntar på något spännande*",
  ],
  sleep: [
    "💤 god natt",
    "😴 zzz... ⚓",
    "💤 fem minuter till...",
    "*snarkar tyst*",
    "😴 väck mig till våren...",
    "💤 jag vilar bara ögonen...",
  ],
  jump: [
    "HOPPSAN!",
    "🦘 hopp!",
    "Parkour, fast i sidled.",
    "Mot oändligheten!",
    "🚀 JIHAAA!",
    "Jag kan flyga!",
  ],
  dance: [
    "💃🕺 dags att dansa!",
    "♪ tjoho ♪",
    "🎶 kör hårt!",
    "🪩 DISKOLÄGE PÅ!",
    "*gör roboten*",
    "♪ dunk dunk dunk ♪",
  ],
  facepalm: [
    "🤦 oj då.",
    "Allvarligt?",
    "Varför då.",
    "*andas djupt*",
    "Jag har inga ord...",
    "Dagen är inställd.",
  ],
  nameGreetings: [
    "Hej {name}! 👋",
    "Tjena {name} 🦀",
    "{name}, vakna!",
    "psst {name}, kolla här...",
    "{name}, kör en deploy! 🚀",
    "Kaffe, {name}?",
    "Upp med dig, {name}!",
    "{name}, allt bra? 👀",
    "{name}! Länge sedan sist.",
    "{name}, sluta scrolla 😤",
    "{name}, lådan hälsar 📦",
    "*vinkar till {name}*",
    "{name}, en kanelbulle? 🧁",
    "{name}, du är bäst 💜",
    "Tjabba {name}!",
    "{name}, bygg något fint",
    "Har du ätit, {name}? 🍱",
    "{name}, jag har saknat dig 🥺",
    "*puttar lite på {name}*",
    "{name}, servern snurrar på 🛡️",
  ],
  nameFallbacks: [
    "chefen",
    "kapten",
    "vän",
    "människa",
    "kompis",
    "polare",
    "mästare",
    "stjärna",
  ],
  power: [
    "⚡ OBEGRÄNSAD KRAFT!",
    "🔥 SUPERKLO!",
    "💪 MAXIMAL STYRKA!",
    "⚡ JAG ÄR LÅDAN!",
    "🦀👑 KUNGSKRABBA!",
    "✨ NY NIVÅ!",
    "🔱 DETTA ÄR MIN TRON!",
    "⚡ VEM BESTÄMMER HÄR?!",
    "👑 BUGA FÖR MIG!",
    "🦀 KRABBOR TILL MAKTEN!",
    "⚡ ULTRA INSTINKT!",
    "💎 DIAMANTKLOR AKTIVERADE!",
    "🔥 ELD OCH LÅGOR!",
    "⚡ BORTOM ALLA GRÄNSER!",
    "🦀 KUNG ÖVER INSTRUMENTPANELEN!",
    "☢️ UPPSKJUTNING UPPTÄCKT!",
    "👑 HÄRSKARE ÖVER ALLA LÅDOR!",
    "⚡ SLUTFORM UPPNÅDD!",
    "🔱 POSEIDONLÄGE!",
    "💪 JAG HAR TRÄNAT FÖR DETTA!",
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
export const svCrab: readonly string[] = [
  "Jag gör allt jobb här. 🦀",
  "Tjena {name} 🦀",
  "🔥 SUPERKLO!",
  "🦀👑 KUNGSKRABBA!",
  "🦀 KRABBOR TILL MAKTEN!",
  "💎 DIAMANTKLOR AKTIVERADE!",
  "🦀 KUNG ÖVER INSTRUMENTPANELEN!",
];
