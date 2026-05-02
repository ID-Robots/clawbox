// ── Mascot phrase categories ──
// The hardcoded arrays below are kept on purpose: they're the *inspiration
// seed* that gets fed into the OpenClaw-driven phrase generator (so the
// generator stays on-tone — "lazy, sarcastic, scandalous"), AND they're the
// final fallback the Mascot component falls back to when generation hasn't
// produced anything yet (fresh device, Ollama not running, no models pulled).
//
// At runtime the Mascot fetches `/setup-api/mascot-lines`, which returns
// generated arrays in the user's selected language. The generator uses these
// inspiration arrays as tonal reference, but should not copy them verbatim.

export interface MascotPhraseSet {
  sass: string[]
  idle: string[]
  sleep: string[]
  jump: string[]
  dance: string[]
  facepalm: string[]
  /** Each entry must contain the literal `{name}` token. */
  nameGreetings: string[]
  /** Single-word friendly placeholders used when `ui_user_name` is unset. */
  nameFallbacks: string[]
  /** Shouted while the crab perches on top of the box in power stance. */
  power: string[]
}

export const INSPIRATION_PHRASES: MascotPhraseSet = {
  sass: [
    'I do all the work here.',
    'Ship faster, humans.',
    'Bug? Feature. 🫡',
    'I need a raise.',
    '*flips table*',
    'sudo make me a sandwich',
    '404: motivation not found',
    'Deploy on Friday? Dare me.',
  ],
  idle: [
    '🤔', '...', '💭', '*stares into void*', '*elevator music*',
    '🫥', '*exists aggressively*', 'hmm...', '*blinks*',
    '*pretends to work*', '*counts pixels*', '*loads personality*',
  ],
  sleep: [
    '💤', '😴 zzz...', '💤 5 more minutes...', '*snore*',
    '😴 wake me up later...', '💤 ...just resting my eyes...',
  ],
  jump: [
    'YEEET!', '🦘', 'Parkour!', 'To infinity!',
    '🚀 WEEEE!', 'I believe I can fly!',
  ],
  dance: [
    '💃🕺', '♪ cha-ching ♪', '🎶', '🪩 DISCO MODE!',
    '*does the robot*', '♪ dun dun dun ♪',
  ],
  facepalm: [
    '🤦', 'Seriously?', 'Why.', '*deep breath*',
    "I can't even...", 'This day is cancelled.',
  ],
  nameGreetings: [
    'Hey {name}! 👋',
    'yo {name} 🦀',
    '{name}, look alive!',
    'psst {name}...',
    '{name}, ship it! 🚀',
    'Coffee, {name}?',
    'Wake up, {name}!',
    '{name}, you good? 👀',
    '{name}! Long time no scuttle.',
    'Здрасти, {name}! 🇧🇬',
    '{name}, stop scrolling 😤',
    '{name}, the box says hi 📦',
    '*waves at {name}*',
    '{name}, treat? 🍣',
    "{name}, you're the best 💜",
    'oi oi {name}!',
    '{name}, deploy something cool',
    'Did you eat, {name}? 🍱',
    '{name}, I missed you 🥺',
    '*nudges {name}*',
  ],
  nameFallbacks: ['boss', 'captain', 'friend', 'human', 'partner', 'buddy', 'шефе', 'capitão'],
  power: [
    '⚡ UNLIMITED POWER!',
    '🔥 SUPER CLAW!',
    '💪 MAXIMUM POWER!',
    '⚡ I AM THE BOX!',
    '🦀👑 KING CRAB!',
    '✨ LEVEL UP!',
    '🔱 THIS IS MY THRONE!',
    "⚡ WHO'S THE BOSS?!",
    '👑 BOW BEFORE ME!',
    '🦀 CRAB SUPREMACY!',
    '⚡ ULTRA INSTINCT!',
    '💎 DIAMOND CLAWS ACTIVATED!',
    '🔥 FIRE AND FURY!',
    '⚡ PLUS ULTRA!',
    '🦀 KING OF THE DASHBOARD!',
    '☢️ NUCLEAR LAUNCH DETECTED!',
    '👑 KING OF ALL BOXES!',
    '⚡ FINAL FORM ACHIEVED!',
    '🔱 POSEIDON MODE!',
    '💪 TRAINED FOR THIS!',
  ],
}

export const PHRASE_CATEGORIES = Object.keys(INSPIRATION_PHRASES) as (keyof MascotPhraseSet)[]

export const LANG_NAMES: Record<string, string> = {
  en: 'English',
  bg: 'Български',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  nl: 'Nederlands',
  sv: 'Svenska',
  zh: '中文',
}

/**
 * Ensure every category in `set` is non-empty by topping up from the
 * inspiration arrays. Used as a safety net so the Mascot never receives
 * an empty array (which would silently break random pick).
 */
export function ensureFullPhraseSet(set: Partial<MascotPhraseSet> | null | undefined): MascotPhraseSet {
  // Clone every array off INSPIRATION_PHRASES so a returned set never aliases
  // the module-level defaults — callers that mutate (e.g. shuffling, push) on
  // category arrays must not corrupt the shared seed.
  const merged: MascotPhraseSet = {
    sass: [...INSPIRATION_PHRASES.sass],
    idle: [...INSPIRATION_PHRASES.idle],
    sleep: [...INSPIRATION_PHRASES.sleep],
    jump: [...INSPIRATION_PHRASES.jump],
    dance: [...INSPIRATION_PHRASES.dance],
    facepalm: [...INSPIRATION_PHRASES.facepalm],
    nameGreetings: [...INSPIRATION_PHRASES.nameGreetings],
    nameFallbacks: [...INSPIRATION_PHRASES.nameFallbacks],
    power: [...INSPIRATION_PHRASES.power],
  }
  if (!set) return merged
  for (const key of PHRASE_CATEGORIES) {
    const incoming = set[key]
    if (Array.isArray(incoming) && incoming.length > 0) {
      // Trim before validating so " spaces only " or "\n" entries are
      // dropped instead of slipping through as "valid" but invisible.
      // For nameGreetings, only keep entries that contain the {name} token.
      if (key === 'nameGreetings') {
        const valid = incoming.filter((s) => {
          if (typeof s !== 'string') return false
          const trimmed = s.trim()
          return trimmed.length > 0 && trimmed.length < 120 && trimmed.includes('{name}')
        })
        merged.nameGreetings = valid.length > 0 ? valid : [...INSPIRATION_PHRASES.nameGreetings]
        continue
      }
      const cleaned = incoming.filter((s) => {
        if (typeof s !== 'string') return false
        const trimmed = s.trim()
        return trimmed.length > 0 && trimmed.length < 120
      })
      if (cleaned.length > 0) merged[key] = cleaned
    }
  }
  return merged
}
