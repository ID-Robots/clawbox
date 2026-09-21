// ── Italiano (it) mascot pack ──
//
// Transcreated, not translated: the crab is the same lazy, sarcastic,
// scandalous creature in every language, but the jokes are local ones.
// See en.ts for the contract every pack has to satisfy.
//
// Model-drafted, machine-checked against the contract — the wording is
// still worth a native speaker's pass.

import type { MascotPhraseSet } from "@/lib/mascot-phrases";

export const it: MascotPhraseSet = {
  sass: [
    "Qui lavoro solo io. 🦀",
    "Più veloci con il deploy, umani.",
    "Bug? No, è una funzione. 🫡",
    "Voglio un aumento.",
    "*ribalta il tavolo*",
    "sudo fammi un panino",
    "404: motivazione non trovata",
    "Deploy di venerdì? Provaci.",
  ],
  idle: [
    "😑",
    "🍝",
    "🫠",
    "*fissa il vuoto*",
    "*musica da ascensore*",
    "mah...",
    "*esiste con impegno*",
    "*sbatte le palpebre*",
    "*finge di lavorare*",
    "*conta i pixel*",
    "*caricamento personalità...*",
    "*aspetta qualcosa di bello*",
  ],
  sleep: [
    "💤 buonanotte",
    "😴 zzz... 🐚",
    "💤 altri cinque minuti...",
    "*russa piano*",
    "😴 svegliami a settembre...",
    "💤 sto solo riposando gli occhi...",
  ],
  jump: [
    "OPLÀ!",
    "🦘 salto!",
    "Parkour, ma con le chele.",
    "Verso l’infinito!",
    "🚀 EVVAIII!",
    "So volare!",
  ],
  dance: [
    "💃🕺 si balla!",
    "♪ tuca tuca ♪",
    "🎶 dai!",
    "🪩 MODALITÀ DISCOTECA!",
    "*fa il robot*",
    "♪ tunz tunz tunz ♪",
  ],
  facepalm: [
    "🤦 mamma mia.",
    "Ma davvero?",
    "Perché. Ma perché.",
    "*respira a fondo*",
    "Non ho parole...",
    "Giornata annullata.",
  ],
  nameGreetings: [
    "Ciao {name}! 👋",
    "Ehi {name} 🦀",
    "{name}, sveglia!",
    "psss {name}, senti...",
    "{name}, fai il deploy! 🚀",
    "Un caffè, {name}?",
    "In piedi, {name}!",
    "{name}, tutto bene? 👀",
    "{name}! Quanto tempo.",
    "{name}, basta scrollare 😤",
    "{name}, la box ti saluta 📦",
    "*saluta {name}*",
    "{name}, un cornetto? 🥐",
    "{name}, sei un mito 💜",
    "Ehilà {name}!",
    "{name}, crea qualcosa di bello",
    "Hai mangiato, {name}? 🍱",
    "{name}, mi sei mancato 🥺",
    "*dà una pacca a {name}*",
    "{name}, il server regge 🛡️",
  ],
  nameFallbacks: [
    "capo",
    "capitano",
    "amico",
    "umano",
    "socio",
    "collega",
    "campione",
    "maestro",
  ],
  power: [
    "⚡ POTENZA ILLIMITATA!",
    "🔥 SUPER CHELA!",
    "💪 FORZA MASSIMA!",
    "⚡ IO SONO LA BOX!",
    "🦀👑 RE GRANCHIO!",
    "✨ LIVELLO SUPERIORE!",
    "🔱 QUESTO È IL MIO TRONO!",
    "⚡ CHI COMANDA QUI?!",
    "👑 INCHINATEVI!",
    "🦀 GRANCHI AL POTERE!",
    "⚡ ISTINTO SUPREMO!",
    "💎 CHELE DI DIAMANTE!",
    "🔥 FUOCO E FURIA!",
    "⚡ OLTRE OGNI LIMITE!",
    "🦀 RE DELLA DASHBOARD!",
    "☢️ LANCIO RILEVATO!",
    "👑 RE DI TUTTE LE BOX!",
    "⚡ FORMA FINALE!",
    "🔱 MODALITÀ POSEIDONE!",
    "💪 MI SONO ALLENATO PER QUESTO!",
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
export const itCrab: readonly string[] = [
  "Qui lavoro solo io. 🦀",
  "Parkour, ma con le chele.",
  "Ehi {name} 🦀",
  "🔥 SUPER CHELA!",
  "🦀👑 RE GRANCHIO!",
  "🦀 GRANCHI AL POTERE!",
  "💎 CHELE DI DIAMANTE!",
  "🦀 RE DELLA DASHBOARD!",
];
