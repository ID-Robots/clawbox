// ── Tamagotchi Engine ──
// Pure state machine implementing the P1/P2 mechanics adapted for desktop.
// No React dependencies — consumed by the Mascot component.

// ─── Types ───

export type LifeStage = 'egg' | 'baby' | 'child' | 'teen' | 'adult' | 'dead'

export type AdultCharacter =
  | 'star'      // Best (Mametchi equivalent)
  | 'scholar'   // 2nd  (Ginjirotchi)
  | 'rebel'     // 3rd  (Maskutchi)
  | 'foodie'    // Bad-1st (Kuchipatchi)
  | 'blob'      // Bad-2nd (Nyorotchi)
  | 'gremlin'   // Worst (Tarakotchi)

export type TeenType = 'good' | 'bad'
export type HiddenType = 1 | 2 // discipline-based hidden flag

export interface TamaStats {
  hunger: number          // 0-4 hearts
  happiness: number       // 0-4 hearts
  discipline: number      // 0-4 (maps to 0/25/50/75/100%)
  weight: number          // 5-99 oz
  age: number             // days (increments at midnight/wake)
}

export interface TamaTimers {
  lastHungerDecay: number
  lastHappinessDecay: number
  lastPoopTime: number
  lastUpdate: number
  hungerZeroSince: number | null     // timestamp when hunger hit 0 (starvation timer)
  happinessZeroSince: number | null  // timestamp when happiness hit 0
  careAlertStart: number | null      // when current care alert began (15-min window)
  disciplineCallStart: number | null // when current discipline call began
  sicknessStart: number | null       // when sickness began (4h death timer)
  sleepStart: number | null          // when sleep began
  lastAgeIncrement: string            // date string YYYY-MM-DD of last age increment
}

export interface TamaState {
  stage: LifeStage
  stats: TamaStats
  timers: TamaTimers

  // Hidden evolution variables
  careMistakes: number
  disciplineMisses: number
  disciplineCallsThisStage: number  // how many calls issued so far (max 4)
  teenType: TeenType | null
  hiddenType: HiddenType | null
  adultCharacter: AdultCharacter | null

  // Status flags
  poopCount: number               // 0-4 poops on screen
  isSick: boolean
  sicknessCountThisStage: number  // 3 = death
  isSleeping: boolean
  lightsOff: boolean
  isDisciplineCall: boolean       // mascot is misbehaving, needs scolding
  isDead: boolean
  deathCause: string | null

  // Birth tracking
  bornAt: number                  // timestamp
  stageStartedAt: number          // when current stage began

  // Hall of fame
  hallOfFame: HallOfFameEntry[]
}

export interface HallOfFameEntry {
  character: AdultCharacter | null
  stage: LifeStage
  age: number
  diedAt: number
  cause: string
}

// ─── Constants ───

const HEARTS_MAX = 4
const WEIGHT_MIN = 5
const WEIGHT_MAX = 99
const POOPS_MAX = 4
const DISCIPLINE_MAX = 4
const DISCIPLINE_CALLS_PER_STAGE = 4

// Durations in ms
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const EGG_DURATION = 30_000          // 30 seconds
const BABY_DURATION = 30 * MINUTE    // 30 minutes

// Care-mistake window: 15 minutes
const CARE_WINDOW = 15 * MINUTE
// Poop sickness trigger: 3+ poops for 30 minutes
const POOP_SICKNESS_DELAY = 30 * MINUTE
// Sickness death: 4 hours untreated
const SICKNESS_DEATH_TIME = 4 * HOUR
// Starvation death: 4 hours at 0 hunger
const STARVATION_TIME = 4 * HOUR
// Poop interval: 2 hours
const POOP_INTERVAL = 2 * HOUR

// Decay rates (ms per heart loss) by stage
const DECAY_RATES: Record<string, { hunger: number; happiness: number }> = {
  baby:  { hunger: 2 * MINUTE,  happiness: 3 * MINUTE },
  child: { hunger: 40 * MINUTE, happiness: 50 * MINUTE },
  teen:  { hunger: 60 * MINUTE, happiness: 70 * MINUTE },
}

// Adult decay rates by character tier
const ADULT_DECAY: Record<AdultCharacter, { hunger: number; happiness: number; lifespan: number }> = {
  star:    { hunger: 100 * MINUTE, happiness: 110 * MINUTE, lifespan: 30 },
  scholar: { hunger: 90 * MINUTE,  happiness: 100 * MINUTE, lifespan: 20 },
  rebel:   { hunger: 80 * MINUTE,  happiness: 90 * MINUTE,  lifespan: 25 },
  foodie:  { hunger: 70 * MINUTE,  happiness: 80 * MINUTE,  lifespan: 12 },
  blob:    { hunger: 50 * MINUTE,  happiness: 60 * MINUTE,  lifespan: 7 },
  gremlin: { hunger: 40 * MINUTE,  happiness: 50 * MINUTE,  lifespan: 5 },
}

// ─── Factory ───

export function createInitialState(): TamaState {
  const now = Date.now()
  return {
    stage: 'egg',
    stats: { hunger: 4, happiness: 4, discipline: 0, weight: 5, age: 0 },
    timers: {
      lastHungerDecay: now,
      lastHappinessDecay: now,
      lastPoopTime: now,
      lastUpdate: now,
      hungerZeroSince: null,
      happinessZeroSince: null,
      careAlertStart: null,
      disciplineCallStart: null,
      sicknessStart: null,
      sleepStart: null,
      lastAgeIncrement: new Date(now).toISOString().slice(0, 10),
    },
    careMistakes: 0,
    disciplineMisses: 0,
    disciplineCallsThisStage: 0,
    teenType: null,
    hiddenType: null,
    adultCharacter: null,
    poopCount: 0,
    isSick: false,
    sicknessCountThisStage: 0,
    isSleeping: false,
    lightsOff: false,
    isDisciplineCall: false,
    isDead: false,
    deathCause: null,
    bornAt: now,
    stageStartedAt: now,
    hallOfFame: [],
  }
}

// ─── Persistence ───

const STORAGE_KEY = 'clawbox-tamagotchi-v2'

export function saveState(state: TamaState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* quota exceeded, etc. */ }
}

export function loadState(): TamaState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as TamaState
  } catch {
    return null
  }
}

// ─── Decay helpers ───

function getDecayRate(state: TamaState): { hunger: number; happiness: number } {
  if (state.stage === 'adult' && state.adultCharacter) {
    const base = ADULT_DECAY[state.adultCharacter]
    const lifespan = base.lifespan
    const daysLeft = lifespan - state.stats.age
    // Old-age acceleration: x2 last 2 days, x4 final day
    let mult = 1
    if (daysLeft <= 1) mult = 4
    else if (daysLeft <= 2) mult = 2
    return { hunger: base.hunger / mult, happiness: base.happiness / mult }
  }
  return DECAY_RATES[state.stage] || DECAY_RATES.child
}

// ─── Evolution ───

function evolveToTeen(state: TamaState): void {
  state.stage = 'teen'
  state.stageStartedAt = Date.now()
  state.teenType = state.careMistakes <= 2 ? 'good' : 'bad'
  state.hiddenType = state.disciplineMisses <= 2 ? 1 : 2
  state.stats.weight = Math.max(20, state.stats.weight)
  state.disciplineCallsThisStage = 0
  state.sicknessCountThisStage = 0
}

function evolveToAdult(state: TamaState): void {
  state.stage = 'adult'
  state.stageStartedAt = Date.now()
  state.adultCharacter = pickAdultCharacter(state)
  state.stats.weight = Math.max(10, state.stats.weight)
  state.disciplineCallsThisStage = 0
  state.sicknessCountThisStage = 0
}

function pickAdultCharacter(state: TamaState): AdultCharacter {
  const cm = state.careMistakes
  const dm = state.disciplineMisses
  const teen = state.teenType
  const ht = state.hiddenType

  if (teen === 'good') {
    if (ht === 1) {
      // Type 1 Good Teen — full tree
      if (cm <= 2 && dm === 0) return 'star'
      if (cm <= 2 && dm === 1) return 'scholar'
      if (cm <= 2 && dm >= 2) return 'rebel'
      if (cm > 2 && dm <= 1) return 'foodie'
      if (cm > 2 && dm <= 3) return 'blob'
      return 'gremlin'
    }
    // Type 2 Good Teen — star locked out
    if (cm <= 2 && dm <= 1) return 'scholar'
    if (cm <= 2) return 'rebel'
    if (cm > 2 && dm <= 2) return 'blob'
    return 'gremlin'
  }

  // Bad Teen
  if (ht === 1) {
    if (dm <= 1) return 'foodie'
    if (dm <= 2) return 'blob'
    return 'gremlin'
  }
  // Type 2 Bad Teen
  if (dm <= 2) return 'blob'
  return 'gremlin'
}

// ─── Death ───

function triggerDeath(state: TamaState, cause: string): void {
  state.isDead = true
  state.deathCause = cause
  state.stage = 'dead'
  state.hallOfFame.push({
    character: state.adultCharacter,
    stage: state.stage,
    age: state.stats.age,
    diedAt: Date.now(),
    cause,
  })
}

// ─── Actions (user interactions) ───

export function feedMeal(state: TamaState): string | null {
  if (state.isDead || state.isSleeping || state.isSick) return null
  if (state.stats.hunger >= HEARTS_MAX) {
    // Refuses meal at full — could be discipline call
    if (state.isDisciplineCall) return 'misbehaving'
    return 'full'
  }
  state.stats.hunger = Math.min(HEARTS_MAX, state.stats.hunger + 1)
  state.stats.weight = Math.min(WEIGHT_MAX, state.stats.weight + 1)
  // Clear starvation timer if fed
  if (state.stats.hunger > 0) {
    state.timers.hungerZeroSince = null
    state.timers.careAlertStart = null
  }
  return 'fed'
}

export function feedSnack(state: TamaState): string | null {
  if (state.isDead || state.isSleeping || state.isSick) return null
  state.stats.happiness = Math.min(HEARTS_MAX, state.stats.happiness + 1)
  state.stats.weight = Math.min(WEIGHT_MAX, state.stats.weight + 2)
  if (state.stats.happiness > 0) {
    state.timers.happinessZeroSince = null
  }
  return 'snack'
}

/** Play game: 50% chance to win. Win: +1 happiness. Always: -1 weight. */
export function playGame(state: TamaState): 'win' | 'lose' | null {
  if (state.isDead || state.isSleeping || state.isSick) return null
  state.stats.weight = Math.max(WEIGHT_MIN, state.stats.weight - 1)
  const won = Math.random() >= 0.5
  if (won) {
    state.stats.happiness = Math.min(HEARTS_MAX, state.stats.happiness + 1)
    if (state.stats.happiness > 0) state.timers.happinessZeroSince = null
  }
  return won ? 'win' : 'lose'
}

export function cleanPoop(state: TamaState): boolean {
  if (state.poopCount === 0) return false
  state.poopCount = 0
  return true
}

export function giveMedicine(state: TamaState): boolean {
  if (!state.isSick) return false
  // Original requires 2 doses — we simplify to 1 click for desktop UX
  state.isSick = false
  state.timers.sicknessStart = null
  return true
}

export function scoldDiscipline(state: TamaState): boolean {
  if (!state.isDisciplineCall) return false
  state.isDisciplineCall = false
  state.timers.disciplineCallStart = null
  state.stats.discipline = Math.min(DISCIPLINE_MAX, state.stats.discipline + 1)
  return true
}

export function turnLightsOff(state: TamaState): boolean {
  if (!state.isSleeping || state.lightsOff) return false
  state.lightsOff = true
  state.timers.careAlertStart = null
  return true
}

export function resetToEgg(state: TamaState): void {
  const hof = state.hallOfFame
  const fresh = createInitialState()
  fresh.hallOfFame = hof
  Object.assign(state, fresh)
}

// ─── Tick — called every ~1-2 seconds ───

export interface TickEvents {
  evolved?: LifeStage
  died?: string
  pooped?: boolean
  gotSick?: boolean
  disciplineCall?: boolean
  careMistake?: boolean
  disciplineMiss?: boolean
  ageUp?: number
}

export function tick(state: TamaState): TickEvents {
  const events: TickEvents = {}
  const now = Date.now()

  if (state.isDead) return events

  // ── Egg stage: hatch after 30s ──
  if (state.stage === 'egg') {
    if (now - state.stageStartedAt >= EGG_DURATION) {
      state.stage = 'baby'
      state.stageStartedAt = now
      state.timers.lastHungerDecay = now
      state.timers.lastHappinessDecay = now
      state.timers.lastPoopTime = now
      state.stats.weight = 5
      events.evolved = 'baby'
    }
    state.timers.lastUpdate = now
    return events
  }

  // ── Sleeping — no decay, only check lights-off care mistake ──
  if (state.isSleeping) {
    if (!state.lightsOff && state.timers.careAlertStart) {
      if (now - state.timers.careAlertStart >= CARE_WINDOW) {
        state.careMistakes++
        state.timers.careAlertStart = null
        state.lightsOff = true // auto lights-off after penalty
        events.careMistake = true
      }
    }
    // Baby auto-wakes after ~5 min nap, otherwise handled by external sleep cycle
    if (state.stage === 'baby' && state.timers.sleepStart) {
      if (now - state.timers.sleepStart >= 5 * MINUTE) {
        state.isSleeping = false
        state.lightsOff = false
        state.timers.sleepStart = null
      }
    }
    state.timers.lastUpdate = now
    return events
  }

  // ── Age increment (once per calendar day) ──
  const today = new Date(now).toISOString().slice(0, 10)
  if (today !== state.timers.lastAgeIncrement && state.stage !== 'baby') {
    state.stats.age++
    state.timers.lastAgeIncrement = today
    events.ageUp = state.stats.age
  }

  // ── Stage evolution checks ──
  if (state.stage === 'baby' && now - state.stageStartedAt >= BABY_DURATION) {
    state.stage = 'child'
    state.stageStartedAt = now
    state.stats.hunger = HEARTS_MAX
    state.stats.happiness = HEARTS_MAX
    state.stats.weight = 10
    state.stats.age = 1
    state.timers.lastHungerDecay = now
    state.timers.lastHappinessDecay = now
    events.evolved = 'child'
  }

  // Child → Teen: at age 2
  if (state.stage === 'child' && state.stats.age >= 2) {
    evolveToTeen(state)
    events.evolved = 'teen'
  }

  // Teen → Adult: at age 4
  if (state.stage === 'teen' && state.stats.age >= 4) {
    evolveToAdult(state)
    events.evolved = 'adult'
  }

  // Adult lifespan check
  if (state.stage === 'adult' && state.adultCharacter) {
    const lifespan = ADULT_DECAY[state.adultCharacter].lifespan
    if (state.stats.age >= lifespan + 4) { // +4 because adult starts at age 4
      triggerDeath(state, 'old age')
      events.died = 'old age'
      state.timers.lastUpdate = now
      return events
    }
  }

  // ── Hunger decay ──
  const rates = getDecayRate(state)
  if (now - state.timers.lastHungerDecay >= rates.hunger) {
    const ticks = Math.floor((now - state.timers.lastHungerDecay) / rates.hunger)
    state.stats.hunger = Math.max(0, state.stats.hunger - ticks)
    state.timers.lastHungerDecay = now

    if (state.stats.hunger === 0 && !state.timers.hungerZeroSince) {
      state.timers.hungerZeroSince = now
      state.timers.careAlertStart = now
    }
  }

  // ── Happiness decay ──
  if (now - state.timers.lastHappinessDecay >= rates.happiness) {
    const ticks = Math.floor((now - state.timers.lastHappinessDecay) / rates.happiness)
    state.stats.happiness = Math.max(0, state.stats.happiness - ticks)
    state.timers.lastHappinessDecay = now

    if (state.stats.happiness === 0 && !state.timers.happinessZeroSince) {
      state.timers.happinessZeroSince = now
      if (!state.timers.careAlertStart) state.timers.careAlertStart = now
    }
  }

  // ── Care mistake check (15-min window) ──
  if (state.timers.careAlertStart && !state.isDisciplineCall) {
    if (now - state.timers.careAlertStart >= CARE_WINDOW) {
      state.careMistakes++
      state.timers.careAlertStart = null
      events.careMistake = true
      // Reset the alert — will re-trigger if still at 0
      if (state.stats.hunger === 0) state.timers.careAlertStart = now
      if (state.stats.happiness === 0 && !state.timers.careAlertStart) {
        state.timers.careAlertStart = now
      }
    }
  }

  // ── Starvation death (4 hours at 0 hunger) ──
  if (state.timers.hungerZeroSince && now - state.timers.hungerZeroSince >= STARVATION_TIME) {
    triggerDeath(state, 'starvation')
    events.died = 'starvation'
    state.timers.lastUpdate = now
    return events
  }

  // ── Poop ──
  if (state.stage !== 'baby' && now - state.timers.lastPoopTime >= POOP_INTERVAL) {
    if (state.poopCount < POOPS_MAX) {
      state.poopCount++
      events.pooped = true
    }
    state.timers.lastPoopTime = now
  }

  // ── Poop → Sickness (3+ poops for 30 min) ──
  if (state.poopCount >= 3 && !state.isSick) {
    // Use lastPoopTime as approximation for when 3rd poop appeared
    const poopAge = now - state.timers.lastPoopTime
    if (poopAge >= POOP_SICKNESS_DELAY || state.poopCount >= 4) {
      state.isSick = true
      state.sicknessCountThisStage++
      state.timers.sicknessStart = now
      events.gotSick = true
    }
  }

  // ── Sickness death ──
  if (state.isSick) {
    if (state.timers.sicknessStart && now - state.timers.sicknessStart >= SICKNESS_DEATH_TIME) {
      triggerDeath(state, 'untreated sickness')
      events.died = 'untreated sickness'
      state.timers.lastUpdate = now
      return events
    }
    if (state.sicknessCountThisStage >= 3) {
      triggerDeath(state, 'chronic sickness')
      events.died = 'chronic sickness'
      state.timers.lastUpdate = now
      return events
    }
  }

  // ── Discipline calls (4 per stage, evenly spaced) ──
  if ((state.stage === 'child' || state.stage === 'teen' || state.stage === 'adult') &&
      state.disciplineCallsThisStage < DISCIPLINE_CALLS_PER_STAGE &&
      !state.isDisciplineCall && !state.isSick) {
    const stageDuration = getStageDuration(state)
    const callInterval = stageDuration / (DISCIPLINE_CALLS_PER_STAGE + 1)
    const elapsed = now - state.stageStartedAt
    const expectedCalls = Math.floor(elapsed / callInterval)
    if (expectedCalls > state.disciplineCallsThisStage) {
      state.isDisciplineCall = true
      state.disciplineCallsThisStage++
      state.timers.disciplineCallStart = now
      events.disciplineCall = true
    }
  }

  // ── Discipline call timeout (15 min) ──
  if (state.isDisciplineCall && state.timers.disciplineCallStart) {
    if (now - state.timers.disciplineCallStart >= CARE_WINDOW) {
      state.isDisciplineCall = false
      state.timers.disciplineCallStart = null
      state.disciplineMisses++
      events.disciplineMiss = true
    }
  }

  state.timers.lastUpdate = now
  return events
}

function getStageDuration(state: TamaState): number {
  switch (state.stage) {
    case 'baby': return BABY_DURATION
    case 'child': return 24 * HOUR   // 1 day
    case 'teen': return 48 * HOUR    // 2 days
    case 'adult': {
      const lifespan = state.adultCharacter ? ADULT_DECAY[state.adultCharacter].lifespan : 15
      return lifespan * 24 * HOUR
    }
    default: return 24 * HOUR
  }
}

// ─── Notification tier ───

export type AlertTier = 0 | 1 | 2 | 3

/** Returns the current alert urgency level for UI display */
export function getAlertTier(state: TamaState): AlertTier {
  if (state.isDead) return 0
  if (state.isSleeping) return 0
  // Tier 3: any stat at 0 (care-mistake countdown)
  if (state.stats.hunger === 0 || state.stats.happiness === 0) return 3
  if (state.isDisciplineCall) return 3
  if (state.isSick) return 3
  // Tier 2: any stat at 1
  if (state.stats.hunger === 1 || state.stats.happiness === 1) return 2
  // Tier 1: any stat at 2
  if (state.stats.hunger === 2 || state.stats.happiness === 2) return 1
  return 0
}

/** Get a human-readable status description */
export function getStatusText(state: TamaState): string {
  if (state.isDead) return state.deathCause ? `Died: ${state.deathCause}` : 'Dead'
  if (state.stage === 'egg') return 'Hatching...'
  if (state.isSleeping) return state.lightsOff ? 'Sleeping 💤' : 'Sleepy — turn off lights!'
  if (state.isSick) return 'Sick! Needs medicine 💊'
  if (state.isDisciplineCall) return 'Misbehaving! Scold me! 😤'
  if (state.stats.hunger === 0) return 'Starving! 🍕'
  if (state.stats.happiness === 0) return 'Miserable! 😢'
  if (state.stats.hunger === 1) return 'Hungry...'
  if (state.stats.happiness === 1) return 'Sad...'
  if (state.poopCount >= 2) return 'Messy! Clean up! 💩'
  return ''
}

/** Character display name */
export function getCharacterName(state: TamaState): string {
  if (state.stage === 'egg') return 'Egg'
  if (state.stage === 'baby') return 'Baby Claw'
  if (state.stage === 'child') return 'Little Claw'
  if (state.stage === 'teen') return state.teenType === 'good' ? 'Cool Claw' : 'Grumpy Claw'
  if (state.stage === 'adult' && state.adultCharacter) {
    const names: Record<AdultCharacter, string> = {
      star: '⭐ Star Claw',
      scholar: '📚 Scholar Claw',
      rebel: '🔥 Rebel Claw',
      foodie: '🍕 Foodie Claw',
      blob: '🫠 Blob Claw',
      gremlin: '👹 Gremlin Claw',
    }
    return names[state.adultCharacter]
  }
  if (state.stage === 'dead') return 'R.I.P.'
  return 'Claw'
}

/** Hearts display helper */
export function heartsString(value: number, max = 4): string {
  return '❤️'.repeat(value) + '🖤'.repeat(max - value)
}

/** Discipline bar display */
export function disciplineString(value: number): string {
  const filled = value
  const empty = DISCIPLINE_MAX - value
  return '▰'.repeat(filled) + '▱'.repeat(empty)
}
