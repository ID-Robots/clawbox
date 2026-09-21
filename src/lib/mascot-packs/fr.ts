// ── Français (fr) mascot pack ──
//
// Transcreated, not translated: the crab is the same lazy, sarcastic,
// scandalous creature in every language, but the jokes are local ones.
// See en.ts for the contract every pack has to satisfy.
//
// Model-drafted, machine-checked against the contract — the wording is
// still worth a native speaker's pass.

import type { MascotPhraseSet } from "@/lib/mascot-phrases";

export const fr: MascotPhraseSet = {
  sass: [
    "C’est moi qui fais tout ici.",
    "Plus vite le deploy, humains.",
    "Bug ? Non, une fonctionnalité. 🫡",
    "Je réclame une augmentation.",
    "*renverse la table*",
    "sudo fais-moi un sandwich",
    "404 : motivation introuvable",
    "Deploy un vendredi ? Ose.",
  ],
  idle: [
    "🙃",
    "☁️",
    "🥐",
    "*fixe le vide*",
    "*musique d’ascenseur*",
    "hmm, bon...",
    "*existe avec conviction*",
    "*cligne lentement*",
    "*fait semblant de bosser*",
    "*compte les pixels*",
    "*chargement de la personnalité...*",
    "*attend un truc palpitant*",
  ],
  sleep: [
    "💤 bonne nuit",
    "😴 zzz... 🌙",
    "💤 encore cinq minutes...",
    "*ronfle doucement*",
    "😴 réveille-moi en septembre...",
    "💤 je repose juste les yeux...",
  ],
  jump: [
    "HOP LÀ !",
    "🦘 saut !",
    "Parkour, version crabe.",
    "Vers l’infini !",
    "🚀 YOUPIII !",
    "Je sais voler !",
  ],
  dance: [
    "💃🕺 on danse !",
    "♪ tsoin tsoin ♪",
    "🎶 allez !",
    "🪩 MODE DISCO !",
    "*fait le robot*",
    "♪ boum boum boum ♪",
  ],
  facepalm: [
    "🤦 oh là là.",
    "Sérieusement ?",
    "Pourquoi. Mais pourquoi.",
    "*inspire profondément*",
    "Je n’ai plus de mots...",
    "Journée annulée.",
  ],
  nameGreetings: [
    "Salut {name} ! 👋",
    "Hé {name} 🦀",
    "{name}, réveille-toi !",
    "psst {name}, viens voir...",
    "{name}, fais un deploy ! 🚀",
    "Un café, {name} ?",
    "Debout, {name} !",
    "{name}, ça va ? 👀",
    "{name} ! Ça faisait longtemps.",
    "{name}, arrête de scroller 😤",
    "{name}, la box te salue 📦",
    "*fait coucou à {name}*",
    "{name}, un croissant ? 🥐",
    "{name}, tu gères 💜",
    "Coucou {name} !",
    "{name}, code un truc sympa",
    "Tu as mangé, {name} ? 🍱",
    "{name}, tu m’as manqué 🥺",
    "*pousse gentiment {name}*",
    "{name}, le server tient bon 🛡️",
  ],
  nameFallbacks: [
    "chef",
    "capitaine",
    "ami",
    "humain",
    "collègue",
    "copain",
    "patron",
    "champion",
  ],
  power: [
    "⚡ PUISSANCE ILLIMITÉE !",
    "🔥 SUPER PINCE !",
    "💪 FORCE MAXIMALE !",
    "⚡ JE SUIS LA BOX !",
    "🦀👑 ROI CRABE !",
    "✨ NIVEAU SUPÉRIEUR !",
    "🔱 VOICI MON TRÔNE !",
    "⚡ QUI COMMANDE ICI ?!",
    "👑 INCLINEZ-VOUS !",
    "🦀 LES CRABES AU POUVOIR !",
    "⚡ INSTINCT ULTIME !",
    "💎 PINCES EN DIAMANT !",
    "🔥 FEU ET FUREUR !",
    "⚡ AU-DELÀ DES LIMITES !",
    "🦀 ROI DU TABLEAU DE BORD !",
    "☢️ LANCEMENT DÉTECTÉ !",
    "👑 ROI DE TOUTES LES BOX !",
    "⚡ FORME FINALE ATTEINTE !",
    "🔱 MODE POSÉIDON !",
    "💪 J’AI TOUT DONNÉ À L’ENTRAÎNEMENT !",
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
export const frCrab: readonly string[] = [
  "Parkour, version crabe.",
  "Hé {name} 🦀",
  "🔥 SUPER PINCE !",
  "🦀👑 ROI CRABE !",
  "🦀 LES CRABES AU POUVOIR !",
  "💎 PINCES EN DIAMANT !",
  "🦀 ROI DU TABLEAU DE BORD !",
];
