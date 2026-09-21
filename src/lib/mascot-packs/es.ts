// ── Español (es) mascot pack ──
//
// Transcreated, not translated: the crab is the same lazy, sarcastic,
// scandalous creature in every language, but the jokes are local ones.
// See en.ts for the contract every pack has to satisfy.
//
// Model-drafted, machine-checked against the contract — the wording is
// still worth a native speaker's pass.

import type { MascotPhraseSet } from "@/lib/mascot-phrases";

export const es: MascotPhraseSet = {
  sass: [
    "Aquí trabajo yo solito. 🦀",
    "Más rápido con el deploy, humanos.",
    "¿Bug? No, es una función. 🫡",
    "Pido un aumento.",
    "*tira la mesa*",
    "sudo hazme un bocadillo",
    "404: motivación no encontrada",
    "¿Deploy un viernes? Atrévete.",
  ],
  idle: [
    "😐",
    "🌀",
    "🫧",
    "*mira al vacío*",
    "*música de ascensor*",
    "mmm...",
    "*existe intensamente*",
    "*parpadea despacio*",
    "*finge que trabaja*",
    "*cuenta píxeles*",
    "*cargando personalidad...*",
    "*espera algo emocionante*",
  ],
  sleep: [
    "💤 buenas noches",
    "😴 zzz... 🦀",
    "💤 cinco minutitos más...",
    "*ronca bajito*",
    "😴 despiértame en otoño...",
    "💤 solo descanso los ojos...",
  ],
  jump: [
    "¡ARRIBA!",
    "🦘 ¡salto!",
    "¡Parkour, pero de lado!",
    "¡Al infinito!",
    "🚀 ¡YUJUUU!",
    "¡Puedo volar!",
  ],
  dance: [
    "💃🕺 ¡a bailar!",
    "♪ chas chas ♪",
    "🎶 ¡venga!",
    "🪩 ¡MODO DISCOTECA!",
    "*hace el robot*",
    "♪ tucu tucu tucu ♪",
  ],
  facepalm: [
    "🤦 madre mía.",
    "¿En serio?",
    "Por qué. Solo por qué.",
    "*respira hondo*",
    "No tengo palabras...",
    "Este día queda cancelado.",
  ],
  nameGreetings: [
    "¡Hola {name}! 👋",
    "¡Ey {name}! 🦀",
    "¡{name}, despierta!",
    "psss {name}...",
    "¡{name}, haz deploy! 🚀",
    "¿Un café, {name}?",
    "¡Levanta, {name}!",
    "{name}, ¿todo bien? 👀",
    "¡{name}! Cuánto tiempo.",
    "{name}, deja de hacer scroll 😤",
    "{name}, la caja te saluda 📦",
    "*saluda a {name}*",
    "{name}, ¿un pincho? 🍢",
    "{name}, eres lo más 💜",
    "¡Buenas, {name}!",
    "{name}, crea algo chulo",
    "¿Ya comiste, {name}? 🍱",
    "{name}, te he echado de menos 🥺",
    "*da un toquecito a {name}*",
    "{name}, el server sigue en pie 🛡️",
  ],
  nameFallbacks: [
    "jefe",
    "capitán",
    "amigo",
    "humano",
    "compañero",
    "colega",
    "crack",
    "campeón",
  ],
  power: [
    "⚡ ¡PODER ILIMITADO!",
    "🔥 ¡SÚPER PINZA!",
    "💪 ¡FUERZA MÁXIMA!",
    "⚡ ¡YO SOY LA CAJA!",
    "🦀👑 ¡REY CANGREJO!",
    "✨ ¡SUBIDA DE NIVEL!",
    "🔱 ¡ESTE ES MI TRONO!",
    "⚡ ¡¿QUIÉN MANDA AQUÍ?!",
    "👑 ¡INCLINAOS ANTE MÍ!",
    "🦀 ¡CANGREJOS AL PODER!",
    "⚡ ¡INSTINTO SUPERIOR!",
    "💎 ¡PINZAS DE DIAMANTE!",
    "🔥 ¡FUEGO Y FURIA!",
    "⚡ ¡MÁS ALLÁ DEL LÍMITE!",
    "🦀 ¡REY DEL PANEL!",
    "☢️ ¡LANZAMIENTO DETECTADO!",
    "👑 ¡REY DE TODAS LAS CAJAS!",
    "⚡ ¡FORMA FINAL!",
    "🔱 ¡MODO POSEIDÓN!",
    "💪 ¡PARA ESTO ENTRENÉ!",
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
export const esCrab: readonly string[] = [
  "Aquí trabajo yo solito. 🦀",
  "😴 zzz... 🦀",
  "¡Ey {name}! 🦀",
  "🔥 ¡SÚPER PINZA!",
  "🦀👑 ¡REY CANGREJO!",
  "🦀 ¡CANGREJOS AL PODER!",
  "💎 ¡PINZAS DE DIAMANTE!",
  "🦀 ¡REY DEL PANEL!",
];
