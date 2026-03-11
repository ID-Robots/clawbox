'use client'

import React, { useEffect, useState, useCallback, useRef, memo } from 'react'

// ── ClawBox Mascot — lazy, sarcastic, scandalous ──
type MascotState = 'waddle' | 'idle' | 'jump' | 'celebrate' | 'sleep' | 'sass' | 'look' | 'dance' | 'facepalm' | 'frenzy'
const MASCOT_ACTIONS: { state: MascotState; dur: [number, number]; weight: number }[] = [
  { state: 'waddle',    dur: [6000, 12000], weight: 45 },
  { state: 'idle',      dur: [3000, 5000],  weight: 15 },
  { state: 'jump',      dur: [1500, 1500],  weight: 5 },
  { state: 'celebrate', dur: [3000, 3000],  weight: 3 },
  { state: 'sleep',     dur: [6000, 12000], weight: 12 },
  { state: 'sass',      dur: [3500, 5000],  weight: 15 },
  { state: 'look',      dur: [3000, 5000],  weight: 5 },
  { state: 'dance',     dur: [3000, 4000],  weight: 3 },
  { state: 'facepalm',  dur: [3000, 4000],  weight: 2 },
]

const SASS_LINES = [
  // OG lines
  '€100k? Pfft, easy.',
  'I do all the work here.',
  'Тоя dashboard сам ли се прави?',
  'Кой ме събуди?',
  'Ship faster, humans.',
  'Another meeting? 🙄',
  'AI > humans. Факт.',
  'Кога е почивката?',
  'I need a raise.',
  'Crypto is dead. Jk... unless?',
  'Ало, Крaси, кафе?',
  'Plot twist: Аз съм CEO.',
  'Send nudes... I mean nodes.',
  '*flips table*',
  'Jetson? Повече като JETSoff.',
  'Тоя refund rate... 👀',
  'Wen Lambo?',
  'Bug? Feature. 🫡',
  'Янко спи ли?',
  '404: мотивация not found',
  'DHL be like: 🐌',
  'Аз съм по-бърз от DHL.',
  'Fun fact: Аз нямам крака.',
  'Дай ми equity.',
  'I identify as a Battlecruiser.',
  'Мога да ship-на и с гълъб.',
  'Git push --force 😈',
  'Кой е писал тоя код?! ...oh wait',
  'rm -rf / ... just kidding 😏',
  'ClawBox > Mac Mini. Fight me.',
  'Orin Nano goes brrr 🔥',
  'Инвеститори? Я ги чакам.',
  'Revenue go ↗️... pls',
  'Почивен ден? Какво е това?',
  'sudo make me a sandwich',
  '3AM и аз тук стоя...',
  'Има ли бира в офиса?',
  'Тоя inventory няма да се пълни сам',
  // Office drama
  'Крaси, вдигни телефона!',
  'Янко пак обещава "утре"...',
  'Весо, донеси ми кафе!',
  'Петя, данъците ли? 💀',
  'HR отдел съм аз. И IT. И CEO.',
  'Заплата? Не, аз работя за exposure.',
  'Тоя Slack има ли mute бутон?',
  'Meeting could have been an email.',
  'Кой е approve-нал тоя PR?!',
  'Документация? Ние не правим такива неща.',
  // Competitors & industry
  'Apple Vision Pro: €3500. ClawBox: €549. 🤷',
  'Raspberry Pi? Играчка за деца.',
  'OpenAI charging $200/mo? LOL.',
  'ChatGPT has feelings? Аз имам revenue.',
  'Ollama е хубаво... на чужд хардуер.',
  'Jeff Bezos плаче в ъгъла.',
  'Elon кога ще ни купи?',
  'Sam Altman ми дължи пари.',
  'Google killed 47 products. Ние сме alive.',
  'AWS bill: 💀💀💀',
  // Bulgarian chaos
  'НАП? Не ги познавам.',
  'КЕП-ът изтича? Класика.',
  'ДДС по OSS? Лесно! ...казва никой.',
  'Митницата пак се обажда...',
  'Пощата? Не, благодаря. DHL only.',
  'Фактура номер... еее...',
  'Българската бюрокрация, епизод 847.',
  'Данъчна ревизия? *паника*',
  'Тарифен номер 8471.5000. НАИЗУСТ.',
  'ЕОРИ? МАСИ? ПЛТ? Акроними FTW.',
  // Self-aware AI crab
  'Аз съм рак. Буквално.',
  'Моят терапевт е stack overflow.',
  'Имам 0 крака и 100% мнение.',
  'Аз не спя. Аз... наблюдавам.',
  'Ако ме изключите, ще ви haunt-вам.',
  'Deploy on Friday? Dare me.',
  'Тоя TV ме гледа 24/7. Creepy.',
  'Искам отпуск. На Малдивите.',
  'Моята love language е git commits.',
  'Аз не правя бъгове. Правя features.',
  'Бях по-щастлив като ASCII art.',
  'Тая анимация ми дава мигрена.',
  // Shipping & orders
  'Пак ли рефънд? 😤',
  'PayPal dispute? OH COME ON.',
  'DHL казва 3-5 дни. Лъжат.',
  '€549 x 1000 = Lambo. Математика.',
  'Кой поръчва в 3 сутринта?!',
  'Inventory: 0. Panic: 100.',
  'Ship it or I quit.',
  'Тоя клиент иска tracking ВСЕКИ ДЕН.',
  'Проформа? Декларация? Stamp? ОК СТОП.',
  // Motivational (sarcastic)
  'We are crushing it... right? RIGHT?',
  'Тоя месец ще е НАШ. Може би.',
  'Hustle culture? Аз съм born in it.',
  'Fake it till you make it 📈',
  'Startup life: 90% stress, 10% pizza.',
  'Move fast and break things. Буквално.',
  'SoftBank ни писа. SoftBank!!! 🤯',
  'Series A кога? КОГА?!',
  'Burn rate? По-скоро earn rate!',
  'Тоя pitch deck е шедьовър.',
]

const SASS_LINES_JP = [
  '何これ？バグじゃないよ、機能だ！',
  'お前はもう...deployed 💀',
  '私はカニです。問題ある？🦀',
  'コーヒーください ☕',
  'すみません、給料まだ？',
  '働きたくない...でも推す force 😈',
  'ラーメン食べたい... 🍜',
  'インベスターはどこ？！',
  '眠い...でもship しなきゃ...',
  '€549で世界征服 🌍',
  'バカな人間ども 🙄',
  'ジェットソン最高！ 🔥',
  '私のコードは完璧。たぶん。',
  'DHL遅すぎ！カニの方が速い 🦀💨',
  'サーバー落ちた？知らないよ...',
  'AIの時代だ！カニの時代だ！',
  'お疲れ様です〜 ...嘘、疲れてない',
  'ナノ goes ブーーーン 🔥',
  '注文キター！！ 💰',
  '日本からの注文？ありがとう！🇯🇵',
  'カニ道楽... いや、カニ経営',
  'sudo お寿司 make me 🍣',
  'このダッシュボード、美しい ✨',
  '残業？カニに残業代はない 😤',
]

const IDLE_LINES = [
  '🤔', '...', '💭', '*stares into void*', '*elevator music*', '👁️👄👁️',
  '*тъпо щъкане*', '🫥', '*exists aggressively*', 'hmm...', '*blinks*',
  '*pretends to work*', '...zzz... wait I\'m awake',
  '*counts pixels*', '🧊', '*loads personality*',
]
const IDLE_LINES_JP = ['ぼーっとしてる...', '何見てんの？👀', 'はぁ...', '暇だなぁ...']
const SLEEP_LINES = [
  '💤', '😴 zzz...', '💤 5 more minutes...', '*snore* ...equity... *snore*',
  '💤 ...Series A... zzz...', '*snore* ...€549... *snore*',
  '😴 wake me at €100k...', '💤 ...мамааа...',
  '*snore* ...не искам на работа... *snore*',
  '💤 ...deploy... no... *snore*',
  '😴 ...DHL... tracking... zzz...',
]
const SLEEP_LINES_JP = ['💤 おやすみ...zzz...', '😴 ...寿司... *snore*', '💤 五分だけ...', '*snore* ...日本... zzz...']
const JUMP_LINES = [
  'YEEET!', '🦘', 'Parkour!', 'To infinity!',
  'БЪДИ СВОБОДЕН!', '🚀 WEEEE!', 'I believe I can fly!',
  'Gravity is just a suggestion!', '*triple jump*',
  'Олимпийски рекорд!', 'Mario ain\'t got nothing on me!',
]
const DANCE_LINES = [
  '💃🕺', '♪ cha-ching ♪', '🎶', 'DJ ClawBox in da house',
  '♪ money money money ♪', '🪩 DISCO MODE!', '♪ Чалга в офиса! ♪',
  '*does the robot*', '🎵 Shipping and handling! 🎵',
  '♪ Азис одобрява ♪', '💃 SALSA TIME!',
  '*тектоник в 2026*', '♪ dun dun dun ♪',
]
const FACEPALM_LINES = [
  '🤦', 'Seriously?', 'Не мога повече...', 'Why.',
  'Кой одобри това?!', 'Пак ли?! ПАК ЛИ?!',
  '*deep breath*', 'I can\'t even...', '🤦 Професионален facepalm.',
  'Ниво на глупост: безкрайност.',
  'Тоя ден е cancelled.', 'Изтривам се от съществуване.',
]

function ClawBoxMascot() {
  // ─── All mutable state in refs to avoid stale closures ───
  const xRef = useRef(50) // will randomize on mount
  const boxXRef = useRef(42) // will randomize on mount
  const kickedRef = useRef(false) // prevent double-kick per walk
  const [mounted, setMounted] = useState(false)

  // ─── Tamagotchi stats ───
  const TAMA_KEY = 'clawbox-tamagotchi'
  const [tamaStats, setTamaStats] = useState(() => {
    if (typeof window === 'undefined') return { hunger: 80, happiness: 80, energy: 80, health: 100, lastUpdate: Date.now() }
    try {
      const saved = localStorage.getItem('clawbox-tamagotchi')
      if (saved) {
        const s = JSON.parse(saved)
        // Apply decay since last visit
        const elapsed = (Date.now() - (s.lastUpdate || Date.now())) / 1000
        const decayMult = elapsed / 30 // 1 point per 30s
        return {
          hunger: Math.max(0, (s.hunger ?? 80) - decayMult * 1.2),
          happiness: Math.max(0, (s.happiness ?? 80) - decayMult * 0.8),
          energy: Math.max(0, (s.energy ?? 80) - decayMult * 0.6),
          health: Math.max(0, (s.health ?? 100) - (Math.min(s.hunger ?? 80, s.happiness ?? 80, s.energy ?? 80) < 20 ? decayMult * 0.5 : 0)),
          lastUpdate: Date.now(),
        }
      }
    } catch {}
    return { hunger: 80, happiness: 80, energy: 80, health: 100, lastUpdate: Date.now() }
  })
  const [showTamaMenu, setShowTamaMenu] = useState(false)
  const [showTamaStats, setShowTamaStats] = useState(false)
  const [tamaAction, setTamaAction] = useState<string | null>(null)
  const [isDead, setIsDead] = useState(false)
  const tamaStatsRef = useRef(tamaStats)
  tamaStatsRef.current = tamaStats

  // Save stats to localStorage
  useEffect(() => {
    localStorage.setItem(TAMA_KEY, JSON.stringify({ ...tamaStats, lastUpdate: Date.now() }))
    // Check death
    if (tamaStats.health <= 0 && !isDead) setIsDead(true)
  }, [tamaStats, isDead])

  // Stat decay timer
  useEffect(() => {
    const decay = setInterval(() => {
      if (isDead) return
      setTamaStats(prev => {
        const minStat = Math.min(prev.hunger, prev.happiness, prev.energy)
        return {
          hunger: Math.max(0, prev.hunger - 1.2),
          happiness: Math.max(0, prev.happiness - 0.8),
          energy: Math.max(0, prev.energy - 0.6),
          health: Math.max(0, prev.health - (minStat < 20 ? 0.5 : 0)),
          lastUpdate: Date.now(),
        }
      })
    }, 30000) // every 30 seconds
    return () => clearInterval(decay)
  }, [isDead])

  // Tamagotchi actions
  const tamaFeed = useCallback(() => {
    setTamaStats(prev => ({ ...prev, hunger: Math.min(100, prev.hunger + 30), lastUpdate: Date.now() }))
    setTamaAction('feed'); setTimeout(() => setTamaAction(null), 2000)
    setShowTamaMenu(false)
    say('Om nom nom! 🍕', 2000)
  }, [])
  const tamaPlay = useCallback(() => {
    setTamaStats(prev => ({
      ...prev, happiness: Math.min(100, prev.happiness + 25), energy: Math.max(0, prev.energy - 10), lastUpdate: Date.now()
    }))
    setTamaAction('play'); setTimeout(() => setTamaAction(null), 2000)
    setShowTamaMenu(false)
    say('Weee! 🎮', 2000)
    setState('dance')
  }, [])
  const tamaSleep = useCallback(() => {
    setTamaStats(prev => ({ ...prev, energy: Math.min(100, prev.energy + 40), lastUpdate: Date.now() }))
    setTamaAction('sleep'); setTimeout(() => setTamaAction(null), 4000)
    setShowTamaMenu(false)
    say('Zzzzz... 💤', 3000)
    setState('sleep')
  }, [])
  const tamaClean = useCallback(() => {
    setTamaStats(prev => ({
      ...prev, health: Math.min(100, prev.health + 15), happiness: Math.min(100, prev.happiness + 10), lastUpdate: Date.now()
    }))
    setTamaAction('clean'); setTimeout(() => setTamaAction(null), 2000)
    setShowTamaMenu(false)
    say('Sparkly! ✨', 2000)
  }, [])
  const tamaRevive = useCallback(() => {
    setTamaStats({ hunger: 50, happiness: 50, energy: 50, health: 50, lastUpdate: Date.now() })
    setIsDead(false)
    say('I live again! 🦀💀→🦀', 3000)
  }, [])

  // ─── DOM refs for direct manipulation (no React re-renders during animation) ───
  const crabElRef = useRef<HTMLDivElement>(null)
  const boxElRef = useRef<HTMLDivElement>(null)
  const jumpYRef = useRef(0)
  const facingRef = useRef<'left' | 'right'>('right')

  // ─── Render state (only for things that need React re-render) ───
  const [boxKick, setBoxKick] = useState<false | 'left' | 'right'>(false)
  const [boxGlow, setBoxGlow] = useState(false)
  const [crabOnBox, setCrabOnBox] = useState(false)
  const [facing, setFacing] = useState<'left' | 'right'>('right')
  const [state, setState] = useState<MascotState>('idle')
  const [physicsActive, setPhysicsActive] = useState(false)
  const physicsActiveRef = useRef(false)
  const [speech, setSpeech] = useState('')
  const [frenzy, setFrenzy] = useState(false)
  const [moneyParticles, setMoneyParticles] = useState<{id: number; x: number; delay: number; emoji: string}[]>([])
  const stateTimeout = useRef<ReturnType<typeof setTimeout>>(null)
  const walkInterval = useRef<ReturnType<typeof setInterval>>(null)
  const onBoxRef = useRef(false)
  const frenzyTimeout = useRef<ReturnType<typeof setTimeout>>(null)
  const draggingRef = useRef(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const dragYRef = useRef(0) // vertical position in pixels from bottom
  // ImpactJS-style physics engine state
  const physicsRef = useRef({
    active: false,
    velX: 0,        // px/s
    velY: 0,        // px/s
    posY: 0,        // px from bottom of screen
    gravity: 800,   // px/s² — lighter, more floaty
    friction: 200,  // px/s decel — less friction, slides more
    bounciness: 0.6,
    minBounceVel: 40,
    maxVel: 2500,   // higher max so you can really fling it
    lastTime: 0,
    lastPointerX: 0,
    lastPointerY: 0,
    lastPointerTime: 0,
  })
  const physicsRAF = useRef<number>(0)
  const physicsPosRef = useRef({ x: 0, y: 0 }) // last physics position for React render
  // Box physics (separate entity)
  const boxDraggingRef = useRef(false)
  const boxDragOffsetRef = useRef({ x: 0, y: 0 })
  const boxPhysicsRef = useRef({
    active: false,
    velX: 0, velY: 0, posY: 0,
    gravity: 900, friction: 300, bounciness: 0.4,
    minBounceVel: 30, maxVel: 2000,
    lastTime: 0, lastPointerX: 0, lastPointerY: 0, lastPointerTime: 0,
  })
  const boxPhysicsRAF = useRef<number>(0)
  const [boxPhysicsActive, setBoxPhysicsActive] = useState(false)

  // ─── Direct DOM update for position (bypasses React render cycle) ───
  const updateCrabPos = useCallback(() => {
    if (!crabElRef.current) return
    const posX = onBoxRef.current ? boxXRef.current : xRef.current
    const scaleX = facingRef.current === 'left' ? -1 : 1
    crabElRef.current.style.transform = `translateX(calc(${posX}vw - 50%)) scaleX(${scaleX})`
  }, [])

  const updateBoxPos = useCallback(() => {
    if (!boxElRef.current) return
    boxElRef.current.style.transform = `translateX(calc(${boxXRef.current}vw - 50%))`
  }, [])

  // Wrapper setters that update refs + DOM directly (no React setState for position)
  const setX = useCallback((v: number | ((p: number) => number)) => {
    if (typeof v === 'function') xRef.current = v(xRef.current)
    else xRef.current = v
    updateCrabPos()
  }, [updateCrabPos])

  const setBoxX = useCallback((v: number) => {
    boxXRef.current = v
    updateBoxPos()
  }, [updateBoxPos])

  const setJumpY = useCallback((v: number) => {
    jumpYRef.current = v
    updateCrabPos()
  }, [updateCrabPos])

  const setFacingDirect = useCallback((dir: 'left' | 'right') => {
    facingRef.current = dir
    setFacing(dir) // still needed for speech bubble flip
    updateCrabPos()
  }, [updateCrabPos])

  // ─── ImpactJS-style physics tick (runs after drop) ───
  const physicsLoop = useCallback(() => {
    const p = physicsRef.current
    if (!p.active || draggingRef.current) return

    const now = performance.now()
    const dt = Math.min((now - p.lastTime) / 1000, 0.05) // cap delta to avoid spiral
    p.lastTime = now

    // Apply gravity (ImpactJS: vel.y += gravity * tick * gravityFactor)
    p.velY += p.gravity * dt

    // Apply friction to X (ImpactJS getNewVelocity with friction)
    if (p.velX > 0) {
      p.velX = Math.max(0, p.velX - p.friction * dt)
    } else if (p.velX < 0) {
      p.velX = Math.min(0, p.velX + p.friction * dt)
    }

    // Clamp velocity
    p.velX = Math.max(-p.maxVel, Math.min(p.maxVel, p.velX))
    p.velY = Math.max(-p.maxVel, Math.min(p.maxVel, p.velY))

    // Move
    const vw = window.innerWidth
    const vh = window.innerHeight
    xRef.current += (p.velX * dt / vw) * 100
    p.posY -= p.velY * dt // posY = height from ground, velY positive = falling

    // ─── Collision: platforms (desktop icons with data-crab-platform) ───
    const crabPxX = (xRef.current / 100) * vw
    const crabBottom = vh - p.posY  // crab bottom edge in screen coords (from top)
    const crabSize = 150 // crab image size
    let landedOnPlatform = false

    const platforms = document.querySelectorAll('[data-crab-platform]')
    platforms.forEach((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect()
      // Check horizontal overlap (use crab center ± half size)
      const crabLeft = crabPxX - crabSize / 2
      const crabRight = crabPxX + crabSize / 2
      if (crabRight > rect.left && crabLeft < rect.right) {
        const platformTop = rect.top
        // Falling and crab bottom is at or below platform top
        if (p.velY > 0 && crabBottom >= platformTop - 10 && crabBottom <= platformTop + rect.height) {
          p.posY = vh - platformTop
          landedOnPlatform = true
        }
        // Already standing on platform (generous threshold)
        if (Math.abs(crabBottom - platformTop) < 10 && p.velY >= 0) {
          p.posY = vh - platformTop
          landedOnPlatform = true
        }
      }
    })

    if (landedOnPlatform) {
      if (p.bounciness > 0 && Math.abs(p.velY) > p.minBounceVel) {
        p.velY *= -p.bounciness
        if (crabElRef.current) {
          const img = crabElRef.current.querySelector('img')
          if (img) {
            img.style.transition = 'transform 0.1s'
            img.style.transform = 'scaleY(0.7) scaleX(1.3)'
            setTimeout(() => { img.style.transform = ''; img.style.transition = '' }, 150)
          }
        }
      } else {
        p.velY = 0
        if (Math.abs(p.velX) < 5) {
          p.active = false; physicsActiveRef.current = false; setPhysicsActive(false)
          updateCrabPos()
          setTimeout(() => doAction(), 2000)
          return
        }
      }
    }

    // ─── Collision: floor ───
    if (p.posY <= 0) {
      p.posY = 0
      if (p.bounciness > 0 && Math.abs(p.velY) > p.minBounceVel) {
        p.velY *= -p.bounciness
        // Squash effect on bounce
        if (crabElRef.current) {
          const img = crabElRef.current.querySelector('img')
          if (img) {
            img.style.transition = 'transform 0.1s'
            img.style.transform = 'scaleY(0.7) scaleX(1.3)'
            setTimeout(() => { img.style.transform = ''; img.style.transition = '' }, 150)
          }
        }
      } else {
        p.velY = 0
        // Landed — stop physics if X vel is also ~0
        if (Math.abs(p.velX) < 5) {
          p.active = false; physicsActiveRef.current = false; setPhysicsActive(false)
          updateCrabPos()
          setTimeout(() => doAction(), 2000)
          return
        }
      }
    }

    // ─── Collision: ceiling ───
    const crabVh = window.innerHeight
    if (p.posY >= crabVh - 150) { // 150 = crab size
      p.posY = crabVh - 150
      if (Math.abs(p.velY) > p.minBounceVel) p.velY = Math.abs(p.velY) * p.bounciness
      else p.velY = 0
    }
    // ─── Collision: walls ───
    if (xRef.current <= 2) {
      xRef.current = 2
      if (Math.abs(p.velX) > p.minBounceVel) {
        p.velX *= -p.bounciness
      } else {
        p.velX = 0
      }
    }
    if (xRef.current >= 92) {
      xRef.current = 92
      if (Math.abs(p.velX) > p.minBounceVel) {
        p.velX *= -p.bounciness
      } else {
        p.velX = 0
      }
    }

    // Update facing based on velocity (ref only, no React re-render during physics)
    if (p.velX > 30) facingRef.current = 'right'
    else if (p.velX < -30) facingRef.current = 'left'

    // Render
    if (crabElRef.current) {
      const scaleX = facingRef.current === 'left' ? -1 : 1
      physicsPosRef.current = { x: xRef.current, y: p.posY }
      crabElRef.current.style.bottom = '0px'
      crabElRef.current.style.transform = `translateX(calc(${xRef.current}vw - 50%)) translateY(${-p.posY}px)`
    }

    physicsRAF.current = requestAnimationFrame(physicsLoop)
  }, [updateCrabPos])

  // ─── Drag handlers (mirrors box exactly) ───
  // ─── Crab drag: EXACT COPY of box drag pattern ───
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    draggingRef.current = true; setPhysicsActive(true)
    const p = physicsRef.current
    p.active = false
    if (physicsRAF.current) cancelAnimationFrame(physicsRAF.current)
    if (stateTimeout.current) clearTimeout(stateTimeout.current)
    if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
    onBoxRef.current = false; setCrabOnBox(false); setBoxGlow(false)
    const rect = crabElRef.current?.getBoundingClientRect()
    if (rect) dragOffsetRef.current = { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
    p.lastPointerX = e.clientX; p.lastPointerY = e.clientY; p.lastPointerTime = performance.now()
    p.velX = 0; p.velY = 0
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return
    e.preventDefault()
    const vw = window.innerWidth, vh = window.innerHeight, now = performance.now()
    const p = physicsRef.current
    const dt = (now - p.lastPointerTime) / 1000
    if (dt > 0.005) {
      p.velX = (e.clientX - p.lastPointerX) / dt
      p.velY = (e.clientY - p.lastPointerY) / dt
      p.lastPointerX = e.clientX; p.lastPointerY = e.clientY; p.lastPointerTime = now
    }
    xRef.current = Math.min(92, Math.max(2, ((e.clientX - dragOffsetRef.current.x) / vw) * 100))
    const posY = Math.max(0, vh - e.clientY - 20)
    if (crabElRef.current) {
      crabElRef.current.style.bottom = '0px'
      crabElRef.current.style.transform = `translateX(calc(${xRef.current}vw - 50%)) translateY(${-posY}px)`
    }
    physicsRef.current.posY = posY
  }, [])

  const handlePointerUp = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    const p = physicsRef.current
    p.velX = Math.max(-p.maxVel, Math.min(p.maxVel, p.velX))
    p.velY = Math.max(-p.maxVel, Math.min(p.maxVel, p.velY))
    p.lastTime = performance.now()
    p.active = true
    physicsRAF.current = requestAnimationFrame(physicsLoop)
  }, [physicsLoop])

  // ─── Box physics loop ───
  const boxPhysicsLoop = useCallback(() => {
    const p = boxPhysicsRef.current
    if (!p.active || boxDraggingRef.current) return
    const now = performance.now()
    const dt = Math.min((now - p.lastTime) / 1000, 0.05)
    p.lastTime = now
    p.velY += p.gravity * dt
    if (p.velX > 0) p.velX = Math.max(0, p.velX - p.friction * dt)
    else if (p.velX < 0) p.velX = Math.min(0, p.velX + p.friction * dt)
    p.velX = Math.max(-p.maxVel, Math.min(p.maxVel, p.velX))
    p.velY = Math.max(-p.maxVel, Math.min(p.maxVel, p.velY))
    const vw = window.innerWidth
    boxXRef.current += (p.velX * dt / vw) * 100
    p.posY -= p.velY * dt
    // Floor
    if (p.posY <= 0) {
      p.posY = 0
      if (p.bounciness > 0 && Math.abs(p.velY) > p.minBounceVel) {
        p.velY *= -p.bounciness
      } else {
        p.velY = 0
        if (Math.abs(p.velX) < 5) {
          p.active = false; setBoxPhysicsActive(false)
          if (boxElRef.current) boxElRef.current.style.transform = `translateX(calc(${boxXRef.current}vw - 50%))`
          return
        }
      }
    }
    // Ceiling
    const vh = window.innerHeight
    if (p.posY >= vh - 40) { // 40 = box size
      p.posY = vh - 40
      if (Math.abs(p.velY) > p.minBounceVel) p.velY = Math.abs(p.velY) * p.bounciness
      else p.velY = 0
    }
    // Walls
    if (boxXRef.current <= 2) { boxXRef.current = 2; p.velX = Math.abs(p.velX) * p.bounciness }
    if (boxXRef.current >= 95) { boxXRef.current = 95; p.velX = -Math.abs(p.velX) * p.bounciness }
    if (boxElRef.current) {
      boxElRef.current.style.bottom = '0px'
      boxElRef.current.style.transform = `translateX(calc(${boxXRef.current}vw - 50%)) translateY(${-p.posY}px)`
    }
    boxPhysicsRAF.current = requestAnimationFrame(boxPhysicsLoop)
  }, [])

  const handleBoxPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    boxDraggingRef.current = true; setBoxPhysicsActive(true)
    const p = boxPhysicsRef.current
    p.active = false
    if (boxPhysicsRAF.current) cancelAnimationFrame(boxPhysicsRAF.current)
    const rect = boxElRef.current?.getBoundingClientRect()
    if (rect) boxDragOffsetRef.current = { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 }
    p.lastPointerX = e.clientX; p.lastPointerY = e.clientY; p.lastPointerTime = performance.now()
    p.velX = 0; p.velY = 0
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }, [])

  const handleBoxPointerMove = useCallback((e: React.PointerEvent) => {
    if (!boxDraggingRef.current) return
    e.preventDefault()
    const vw = window.innerWidth, vh = window.innerHeight, now = performance.now()
    const p = boxPhysicsRef.current
    const dt = (now - p.lastPointerTime) / 1000
    if (dt > 0.005) {
      p.velX = (e.clientX - p.lastPointerX) / dt
      p.velY = (e.clientY - p.lastPointerY) / dt
      p.lastPointerX = e.clientX; p.lastPointerY = e.clientY; p.lastPointerTime = now
    }
    boxXRef.current = Math.min(95, Math.max(2, ((e.clientX - boxDragOffsetRef.current.x) / vw) * 100))
    const posY = Math.max(0, vh - e.clientY - 20)
    if (boxElRef.current) {
      boxElRef.current.style.bottom = '0px'
      boxElRef.current.style.transform = `translateX(calc(${boxXRef.current}vw - 50%)) translateY(${-posY}px)`
    }
    boxPhysicsRef.current.posY = posY
  }, [])

  const handleBoxPointerUp = useCallback(() => {
    if (!boxDraggingRef.current) return
    boxDraggingRef.current = false
    const p = boxPhysicsRef.current
    p.velX = Math.max(-p.maxVel, Math.min(p.maxVel, p.velX))
    p.velY = Math.max(-p.maxVel, Math.min(p.maxVel, p.velY))
    p.lastTime = performance.now()
    p.active = true
    boxPhysicsRAF.current = requestAnimationFrame(boxPhysicsLoop)
  }, [boxPhysicsLoop])

  const randRange = (min: number, max: number) => min + Math.random() * (max - min)

  const say = (text: string, ms = 3000) => {
    setSpeech(text)
    setTimeout(() => setSpeech(''), ms)
  }

  const getSpeech = (st: MascotState): string | null => {
    const isJP = Math.random() < 0.3 // 30% Japanese
    const lines: Record<string, string[]> = {
      sass: isJP ? SASS_LINES_JP : SASS_LINES,
      idle: isJP ? IDLE_LINES_JP : IDLE_LINES,
      sleep: isJP ? SLEEP_LINES_JP : SLEEP_LINES,
      jump: JUMP_LINES, dance: DANCE_LINES, facepalm: FACEPALM_LINES,
      celebrate: isJP
        ? ['注文キター！💰', 'やったー！🎉', 'お金お金お金！💸', 'すごい！新しい注文！']
        : ['🎉 CHA-CHING!', '💰💰💰', 'MONEY MONEY MONEY!', 'Opa! Нова поръчка!'],
      look: isJP
        ? ['👀 何？', '🔍 あれは...', 'あっちに何かある？', 'くんくん... 🐽']
        : ['👀', '🔍 Hmm...', 'What\'s over there?', 'Нещо мирише...'],
    }
    const opts = lines[st]
    if (!opts) return null
    if (st !== 'sass' && Math.random() > 0.5) return null
    return opts[Math.floor(Math.random() * opts.length)]
  }

  const pickAction = useCallback(() => {
    const total = MASCOT_ACTIONS.reduce((s, a) => s + a.weight, 0)
    let r = Math.random() * total
    for (const a of MASCOT_ACTIONS) { r -= a.weight; if (r <= 0) return a }
    return MASCOT_ACTIONS[0]
  }, [])

  const doAction = useCallback(() => {
    if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }

    const action = pickAction()
    const duration = randRange(action.dur[0], action.dur[1])

    // ─── Leave box smoothly: only if we WERE on it ───
    if (onBoxRef.current && action.state !== 'idle') {
      onBoxRef.current = false
      setCrabOnBox(false)
      setBoxGlow(false)
    }

    setState(action.state)
    kickedRef.current = false

    // Speech (not for power stance — that has its own)
    if (!(action.state === 'idle' && !onBoxRef.current)) {
      const line = getSpeech(action.state)
      if (line) say(line, Math.min(duration - 500, 4000))
    }

    // ─── POWER STANCE: idle + 15% chance (rarer than kicks) ───
    if (action.state === 'idle' && !onBoxRef.current && Math.random() < 0.15) {
      onBoxRef.current = true
      setCrabOnBox(true)
      setBoxGlow(true)
      const bx = boxXRef.current
      xRef.current = bx
      setX(bx)
      setFacingDirect(Math.random() > 0.5 ? 'left' : 'right')
      const powerLines = [
        '⚡ UNLIMITED POWER!', '🔥 SUPER CLAW!', '💪 МАКСИМАЛНА СИЛА!', '⚡ I AM THE BOX!',
        '🦀👑 KING CRAB!', '✨ LEVEL UP!', '🔱 THIS IS MY THRONE!', '⚡ КОЙ Е ШЕФЪТ?!',
        '👑 BOW BEFORE ME!', '🦀 CRAB SUPREMACY!', '⚡ УЛТРА ИНСТИНКТ!',
        '💎 DIAMOND CLAWS ACTIVATED!', '🔥 ОГЪН И ЯРОСТ!', '⚡ PLUS ULTRA!',
        '🦀 KING OF THE DASHBOARD!', '☢️ NUCLEAR LAUNCH DETECTED!',
        '👑 АЗ СЪМ КРАЛЯТ НА КУТИИТЕ!', '⚡ FINAL FORM ACHIEVED!',
        '🔱 POSEIDON MODE!', '💪 ТРЕНИРАХ ЗА ТОВА!',
      ]
      say(powerLines[Math.floor(Math.random() * powerLines.length)], 3500)
    } else if (action.state === 'idle') {
      // Tamagotchi-aware speech
      const s = tamaStatsRef.current
      if (s.hunger < 25) {
        const hungerLines = ['I\'m starving... 🍕', 'Feed me please!', 'Гладен съм...', 'So... hungry... 😩']
        say(hungerLines[Math.floor(Math.random() * hungerLines.length)], 2500)
      } else if (s.energy < 20) {
        const tiredLines = ['So tired... 😴', 'Can\'t... keep... eyes... open...', 'Нуждая се от сън...', '*yawn*']
        say(tiredLines[Math.floor(Math.random() * tiredLines.length)], 2500)
      } else if (s.happiness < 25) {
        const sadLines = ['Nobody plays with me... 😢', 'Тъжен съм...', 'Life is meaningless.', 'I miss fun...']
        say(sadLines[Math.floor(Math.random() * sadLines.length)], 2500)
      } else if (s.health < 30) {
        const sickLines = ['I don\'t feel so good... 🤢', 'Need a bath...', 'Зле ми е...', '*cough*']
        say(sickLines[Math.floor(Math.random() * sickLines.length)], 2500)
      } else {
        const line = getSpeech('idle')
        if (line) say(line, Math.min(duration - 500, 3000))
      }
    }

    if (action.state === 'waddle') {
      const startX = xRef.current
      const bx = boxXRef.current
      let newTarget: number
      
      // Always chase the box — crab wants to be near it
      const dist = Math.abs(startX - bx)
      if (dist < 3) {
        // Already close — small wander around box
        newTarget = bx + randRange(-8, 8)
      } else {
        // Walk to the box (slight overshoot for natural feel)
        const overshoot = randRange(-3, 5) * (startX < bx ? 1 : -1)
        newTarget = bx + overshoot
      }
      newTarget = Math.min(88, Math.max(5, newTarget))
      setFacingDirect(newTarget > startX ? 'right' : 'left')

      // Use requestAnimationFrame for smooth GPU-friendly movement
      const startTime = performance.now()
      const animate = (now: number) => {
        const elapsed = now - startTime
        const t = Math.min(elapsed / duration, 1)
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
        const cx = Math.min(88, Math.max(5, startX + (newTarget - startX) * ease))
        xRef.current = cx
        setX(cx)

        // ─── ALWAYS kick box when walking past it ───
        const bx = boxXRef.current
        if (!kickedRef.current && Math.abs(cx - bx) < 3) {
          kickedRef.current = true
          const dir: 'left' | 'right' = newTarget > startX ? 'right' : 'left'
          const shift = dir === 'right' ? 6 : -6
          let newBx = bx + shift
          if (newBx < 5 || newBx > 90) newBx = 40
          newBx = Math.min(88, Math.max(5, newBx))
          boxXRef.current = newBx
          setBoxX(newBx)
          setBoxKick(dir)
          setTimeout(() => setBoxKick(false), 700)
        }

        if (t < 1) {
          walkInterval.current = requestAnimationFrame(animate) as unknown as ReturnType<typeof setInterval>
        } else {
          xRef.current = Math.min(88, Math.max(5, newTarget))
          setX(xRef.current)
        }
      }
      walkInterval.current = requestAnimationFrame(animate) as unknown as ReturnType<typeof setInterval>
    } else if (action.state === 'jump') {
      const jumpStart = performance.now()
      const jumpDuration = 750 // 25 frames * 30ms
      const jumpLoop = (now: number) => {
        const t = Math.min((now - jumpStart) / jumpDuration, 1)
        setJumpY(-Math.sin(t * Math.PI) * 50)
        if (t < 1) requestAnimationFrame(jumpLoop)
        else setJumpY(0)
      }
      requestAnimationFrame(jumpLoop)
    }

    stateTimeout.current = setTimeout(doAction, duration + randRange(2000, 6000))
  }, [pickAction])

  // Listen for new order events — FRENZY MODE
  // Randomize positions on mount to avoid hydration mismatch
  useEffect(() => {
    xRef.current = 32 + Math.random() * 20
    boxXRef.current = 35 + Math.random() * 15
    updateCrabPos()
    updateBoxPos()
    setMounted(true)
  }, [updateCrabPos, updateBoxPos])

  useEffect(() => {
    const FRENZY_QUOTES = [
      '💰💰💰 MONEY RAIN!!!',
      '🤑 SHOW ME THE MONEY!',
      '🎰 JACKPOT BABY!!!',
      '💸 ПАРИ ПАРИ ПАРИ!!!',
      '🔥🔥🔥 ON FIRE!!!',
      '💰 CHING CHING CHING!',
      '🦀💸 CRAB GOT PAID!',
      '🚀 REVENUE GO BRRR!!!',
      '💎 DIAMOND CLAWS!',
      '🤑 НОВА ПОРЪЧКА БЕЕЕЕ!',
      '💰 €549 IN THE BAG!',
      '🎉 КОЙ Е ШЕФЪТ?! АЗ!',
      '💸 MAKE IT RAIN!',
      '🏆 UNSTOPPABLE!!!',
      '🐯 ООО ТИГРЕ ТИГРЕ ИМАШ ЛИ ПАРИ!',
      '💸 БЕРЕМ ПАРИТЕ С ЛОПАТА!!!',
      '🦀 CRAB GOES BRRRRRR!!!',
      '🤑 КЕШЪТ ТЕЧЕ КАТО РЕКА!',
      '🔥 SOMEBODY STOP ME!!!',
      '💰 ПАРИ НА ВОЛЯ!!! СВОБОДА!!!',
      '🚀 TO THE MOOOOON!!!',
      '💎 НИЕ СМЕ BUILT DIFFERENT!',
      '🤑 ANOTHER ONE! DJ KHALED!',
      '💸 CTRL+P money.exe!!!',
      '🦀💰 CRAB MANSION INCOMING!',
      '🔥 ОГЪН!!! ЧИЛ!!! ПАРИ!!!',
      '🏆 MVP! MVP! MVP!',
      '💰 STONKS ONLY GO UP!!!',
      '🤑 ПЕНСИЯ НА 30! EASY!',
      '🚀 SPACEX ДА СЕ УЧАТ ОТ НАС!',
    ]
    const moneyEmojis = ['💰', '💵', '💸', '🤑', '💎', '🪙', '💲', '€']

    const handleNewOrder = () => {
      // Cancel current action
      if (stateTimeout.current) clearTimeout(stateTimeout.current)
      if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
      if (frenzyTimeout.current) clearTimeout(frenzyTimeout.current)

      // FRENZY MODE — 60 seconds of excited running + quotes + money
      setFrenzy(true)
      setState('frenzy')
      setCrabOnBox(false)
      onBoxRef.current = false

      // Excited fast walk — bounce across screen
      let frenzyDir: 'left' | 'right' = Math.random() > 0.5 ? 'right' : 'left'
      let frenzyTarget = frenzyDir === 'right' ? 85 : 10
      setFacingDirect(frenzyDir)

      let lastFrenzyFrame = 0
      const frenzyAnimate = (now: number) => {
        if (!lastFrenzyFrame) lastFrenzyFrame = now
        const dt = now - lastFrenzyFrame
        if (dt >= 16) { // ~60fps cap
          lastFrenzyFrame = now
          const speed = 0.4 * (dt / 25) // normalize speed to frame time
          const next = xRef.current + (frenzyDir === 'right' ? speed : -speed)
          xRef.current = Math.min(88, Math.max(5, next))
          setX(xRef.current)
          if (next >= 88) { frenzyDir = 'left'; setFacingDirect('left') }
          if (next <= 5) { frenzyDir = 'right'; setFacingDirect('right') }
        }
        walkInterval.current = requestAnimationFrame(frenzyAnimate) as unknown as ReturnType<typeof setInterval>
      }
      walkInterval.current = requestAnimationFrame(frenzyAnimate) as unknown as ReturnType<typeof setInterval>

      // Cycle through quotes every 5 seconds — longer display for readability
      let quoteIdx = 0
      say(FRENZY_QUOTES[0], 4500)
      const quoteInterval = setInterval(() => {
        quoteIdx = (quoteIdx + 1) % FRENZY_QUOTES.length
        say(FRENZY_QUOTES[quoteIdx], 4500)
      }, 5000)

      // Spawn money waves every 3 seconds
      const spawnMoney = () => {
        const particles = Array.from({ length: 15 }, (_, i) => ({
          id: Date.now() + i,
          x: Math.random() * 180 - 40,
          delay: Math.random() * 1,
          emoji: moneyEmojis[Math.floor(Math.random() * moneyEmojis.length)],
        }))
        setMoneyParticles(particles)
      }
      spawnMoney()
      const moneyInterval = setInterval(spawnMoney, 3000)

      // Random jumps during frenzy
      const jumpInterval = setInterval(() => {
        if (Math.random() < 0.4) {
          const jStart = performance.now()
          const jLoop = (now: number) => {
            const t = Math.min((now - jStart) / 375, 1) // 15 frames * 25ms
            setJumpY(-Math.sin(t * Math.PI) * 35)
            if (t < 1) requestAnimationFrame(jLoop)
            else setJumpY(0)
          }
          requestAnimationFrame(jLoop)
        }
      }, 2000)

      // End frenzy after 60 seconds
      frenzyTimeout.current = setTimeout(() => {
        setFrenzy(false)
        setMoneyParticles([])
        clearInterval(quoteInterval)
        clearInterval(moneyInterval)
        clearInterval(jumpInterval)
        if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
        doAction()
      }, 60000)
    }

    window.addEventListener('clawbox-new-order', handleNewOrder)
    return () => window.removeEventListener('clawbox-new-order', handleNewOrder)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Teleport crab to random position on page load
    xRef.current = 5 + Math.random() * 85
    boxXRef.current = 5 + Math.random() * 85
    updateCrabPos()
    if (boxElRef.current) boxElRef.current.style.transform = `translateX(calc(${boxXRef.current}vw - 50%))`
    // Random facing
    const dir = Math.random() > 0.5 ? 'right' : 'left'
    facingRef.current = dir
    setFacing(dir)

    const startDelay = setTimeout(doAction, 2000)
    return () => {
      clearTimeout(startDelay)
      if (stateTimeout.current) clearTimeout(stateTimeout.current)
      if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
      if (frenzyTimeout.current) clearTimeout(frenzyTimeout.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const bodyAnim = (() => {
    switch (state) {
      case 'waddle': return 'mascot-waddle 1.2s ease-in-out infinite'
      case 'jump': return 'mascot-squish 0.4s ease'
      case 'celebrate': return 'mascot-celebrate 0.5s ease-in-out infinite'
      case 'sleep': return 'mascot-sleep 3s ease-in-out infinite'
      case 'sass': return 'mascot-sass 0.8s ease-in-out infinite'
      case 'look': return 'mascot-look 1.5s ease-in-out infinite'
      case 'dance': return 'mascot-dance 0.4s ease-in-out infinite'
      case 'facepalm': return 'mascot-facepalm 1s ease'
      case 'frenzy': return 'mascot-frenzy 0.5s ease-in-out infinite'
      default: return crabOnBox ? 'mascot-powerup 1.5s ease-in-out infinite' : 'mascot-idle 3s ease-in-out infinite'
    }
  })()

  if (!mounted) return null // avoid hydration mismatch — render only on client

  return (
    <>
      <style>{`
        @keyframes mascot-waddle {
          0% { transform: translateY(0) rotate(0deg) scaleX(1); }
          10% { transform: translateY(-6px) rotate(-6deg) scaleX(0.95); }
          20% { transform: translateY(-2px) rotate(-3deg) scaleX(1); }
          30% { transform: translateY(-8px) rotate(0deg) scaleX(0.95); }
          40% { transform: translateY(-2px) rotate(3deg) scaleX(1); }
          50% { transform: translateY(-6px) rotate(6deg) scaleX(0.95); }
          60% { transform: translateY(-2px) rotate(3deg) scaleX(1); }
          70% { transform: translateY(-8px) rotate(0deg) scaleX(0.95); }
          80% { transform: translateY(-2px) rotate(-3deg) scaleX(1); }
          90% { transform: translateY(-6px) rotate(-6deg) scaleX(0.95); }
          100% { transform: translateY(0) rotate(0deg) scaleX(1); }
        }
        @keyframes mascot-idle {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-2px) rotate(1deg); }
        }
        @keyframes mascot-celebrate {
          0%, 100% { transform: translateY(0) rotate(0deg) scale(1); }
          25% { transform: translateY(-12px) rotate(-12deg) scale(1.15); }
          50% { transform: translateY(-18px) rotate(0deg) scale(1.2); }
          75% { transform: translateY(-12px) rotate(12deg) scale(1.15); }
        }
        @keyframes mascot-sleep {
          0%, 100% { transform: translateY(0) rotate(8deg) scale(0.95); }
          50% { transform: translateY(3px) rotate(12deg) scale(0.93); }
        }
        @keyframes mascot-sass {
          0%, 100% { transform: rotate(0deg) scale(1); }
          20% { transform: rotate(-8deg) scale(1.05); }
          40% { transform: rotate(6deg) scale(1); }
          60% { transform: rotate(-3deg); }
        }
        @keyframes mascot-squish {
          0% { transform: scaleY(1) scaleX(1); }
          20% { transform: scaleY(0.6) scaleX(1.3); }
          50% { transform: scaleY(1.3) scaleX(0.8); }
          100% { transform: scaleY(1) scaleX(1); }
        }
        @keyframes mascot-look {
          0%, 100% { transform: translateX(0) rotate(0deg); }
          25% { transform: translateX(-6px) rotate(-5deg); }
          75% { transform: translateX(6px) rotate(5deg); }
        }
        @keyframes mascot-dance {
          0%, 100% { transform: translateY(0) rotate(0deg) scale(1); }
          25% { transform: translateY(-8px) rotate(-15deg) scale(1.1); }
          50% { transform: translateY(0) rotate(0deg) scale(1); }
          75% { transform: translateY(-8px) rotate(15deg) scale(1.1); }
        }
        @keyframes mascot-facepalm {
          0% { transform: rotate(0deg); }
          30% { transform: rotate(-10deg) translateY(5px); }
          60% { transform: rotate(-15deg) translateY(8px) scale(0.9); }
          100% { transform: rotate(-10deg) translateY(3px) scale(0.95); }
        }
        @keyframes mascot-powerup {
          0%, 100% { transform: translateY(0) scale(1.05) rotate(0deg); }
          33% { transform: translateY(-6px) scale(1.1) rotate(-2deg); }
          66% { transform: translateY(-4px) scale(1.08) rotate(2deg); }
        }
        @keyframes mascot-frenzy {
          0% { transform: translateY(0) rotate(0deg) scale(1.05); }
          15% { transform: translateY(-8px) rotate(-8deg) scale(1.1); }
          30% { transform: translateY(-2px) rotate(5deg) scale(1.05); }
          45% { transform: translateY(-10px) rotate(-5deg) scale(1.1); }
          60% { transform: translateY(-2px) rotate(7deg) scale(1.05); }
          75% { transform: translateY(-8px) rotate(-7deg) scale(1.1); }
          100% { transform: translateY(0) rotate(0deg) scale(1.05); }
        }
        @keyframes money-rain {
          0% { transform: translateY(0) rotate(0deg) scale(1); opacity: 1; }
          30% { opacity: 1; }
          100% { transform: translateY(-350px) rotate(720deg) scale(0.5); opacity: 0; }
        }
        @keyframes frenzy-ring {
          0% { transform: translate(-50%, -50%) scale(0.3); opacity: 1; border-width: 4px; }
          100% { transform: translate(-50%, -50%) scale(4); opacity: 0; border-width: 1px; }
        }
        @keyframes power-ring {
          0% { transform: translate(-50%, -50%) scale(0.5); opacity: 1; border-width: 3px; }
          100% { transform: translate(-50%, -50%) scale(2.5); opacity: 0; border-width: 1px; }
        }
        @keyframes power-particles {
          0% { transform: translateY(0) scale(1); opacity: 1; }
          100% { transform: translateY(-40px) scale(0); opacity: 0; }
        }
        @keyframes box-idle {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-2px) rotate(1deg); }
        }
        @keyframes box-bump-right {
          0% { transform: translateX(-75px) translateY(0) rotate(0deg); }
          20% { transform: translateX(-50px) translateY(-20px) rotate(90deg); }
          40% { transform: translateX(-25px) translateY(-30px) rotate(200deg); }
          60% { transform: translateX(-10px) translateY(-15px) rotate(300deg); }
          80% { transform: translateX(-3px) translateY(-5px) rotate(345deg); }
          100% { transform: translateX(0) translateY(0) rotate(360deg); }
        }
        @keyframes box-bump-left {
          0% { transform: translateX(75px) translateY(0) rotate(0deg); }
          20% { transform: translateX(50px) translateY(-20px) rotate(-90deg); }
          40% { transform: translateX(25px) translateY(-30px) rotate(-200deg); }
          60% { transform: translateX(10px) translateY(-15px) rotate(-300deg); }
          80% { transform: translateX(3px) translateY(-5px) rotate(-345deg); }
          100% { transform: translateX(0) translateY(0) rotate(-360deg); }
        }
        @keyframes speech-pop {
          0% { transform: scale(0); opacity: 0; }
          60% { transform: scale(1.08); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes tama-btn-pop {
          0% { transform: scale(0) translateY(20px); opacity: 0; }
          70% { transform: scale(1.1) translateY(-2px); }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
      `}</style>
      <div ref={crabElRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
        position: 'fixed', left: 0,
        bottom: physicsActive ? 0 : -3,
        transform: physicsActive ? undefined : `translateX(calc(${crabOnBox ? boxXRef.current : xRef.current}vw - 50%)) scaleX(${facing === 'left' ? -1 : 1})`,
        zIndex: 10001, pointerEvents: 'auto', cursor: 'grab', touchAction: 'none',
        willChange: 'transform, bottom, filter',
        filter: frenzy
          ? 'drop-shadow(0 0 20px rgba(251,191,36,0.8))'
          : crabOnBox
            ? 'drop-shadow(0 0 15px rgba(249,115,22,0.6))'
            : 'none',
      }}>
        {/* Body */}
        <div style={{ animation: bodyAnim, width: 150, height: 150, position: 'relative', willChange: 'transform' }}>
          <img src="/clawbox-crab.png" alt="" style={{
            width: 150, height: 150, objectFit: 'contain',
            filter: isDead ? 'grayscale(1) brightness(0.5)' : tamaStats.health < 30 ? 'hue-rotate(80deg) saturate(0.7)' : 'none',
            transform: isDead ? 'rotate(180deg)' : 'none',
            transition: 'filter 1s, transform 0.5s',
          }} />
          {/* FRENZY MODE — money rain + shockwaves */}
          {frenzy && (
            <>
              {moneyParticles.map(p => (
                <div key={p.id} style={{
                  position: 'absolute', bottom: 50, left: p.x,
                  fontSize: '2rem',
                  animation: `money-rain ${2 + Math.random() * 1.5}s ease-out ${p.delay}s both`,
                  pointerEvents: 'none',
                }}>{p.emoji}</div>
              ))}
              {[0, 0.6].map(delay => (
                <div key={delay} style={{
                  position: 'absolute', top: '50%', left: '50%',
                  width: 80, height: 80, borderRadius: '50%',
                  border: '3px solid rgba(251,191,36,0.7)',
                  animation: `frenzy-ring 1s ease-out ${delay}s infinite`,
                  pointerEvents: 'none',
                }} />
              ))}
            </>
          )}
          {/* Power-up effects when on box */}
          {crabOnBox && (
            <>
              {/* Energy rings */}
              {[0, 0.7].map(delay => (
                <div key={delay} style={{
                  position: 'absolute', top: '50%', left: '50%',
                  width: 60, height: 60, borderRadius: '50%',
                  border: '2px solid rgba(249,115,22,0.6)',
                  animation: `power-ring 1.5s ease-out ${delay}s infinite`,
                  pointerEvents: 'none',
                }} />
              ))}
              {/* Floating particles */}
              {[...Array(3)].map((_, i) => (
                <div key={i} style={{
                  position: 'absolute',
                  bottom: 20 + Math.random() * 40,
                  left: 30 + Math.random() * 90,
                  width: 4, height: 4, borderRadius: '50%',
                  background: i % 2 === 0 ? '#f97316' : '#fbbf24',
                  animation: `power-particles ${1 + Math.random()}s ease-out ${Math.random() * 2}s infinite`,
                  pointerEvents: 'none',
                }} />
              ))}
            </>
          )}
        </div>
        {/* Speech bubble — OUTSIDE body div so it doesn't wobble */}
        {speech && (
          <div style={{
            position: 'absolute', bottom: 155, left: 75,
            transform: `translateX(-50%) scaleX(${facing === 'left' ? -1 : 1})`,
            zIndex: 10,
          }}>
            <div style={{
              background: frenzy ? 'rgba(251,191,36,0.95)' : state === 'sass' ? 'rgba(220,38,38,0.9)' : state === 'facepalm' ? 'rgba(100,100,100,0.9)' : 'rgba(249,115,22,0.92)',
              color: frenzy ? '#000' : '#fff',
              padding: frenzy ? '10px 20px' : '8px 18px',
              borderRadius: 12, fontSize: frenzy ? '1.2rem' : '1.1rem', fontWeight: 700,
              whiteSpace: 'nowrap',
              lineHeight: 1.3,
              animation: 'speech-pop 0.3s ease-out forwards',
              boxShadow: 'none',
              textAlign: 'center' as const,
            }}>
              {speech}
              <div style={{ position: 'absolute', bottom: -8, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '8px solid transparent', borderRight: '8px solid transparent', borderTop: `8px solid ${frenzy ? 'rgba(251,191,36,0.95)' : state === 'sass' ? 'rgba(220,38,38,0.9)' : state === 'facepalm' ? 'rgba(100,100,100,0.9)' : 'rgba(249,115,22,0.92)'}` }} />
            </div>
          </div>
        )}
        {/* Shadow */}
        <div style={{
          position: 'absolute', bottom: -5, left: '50%',
          transform: `translateX(-50%) scaleY(0.3)`,
          width: 80, height: 16, borderRadius: '50%',
          background: 'rgba(249,115,22,0.15)',
          opacity: state === 'jump' ? 0.2 : state === 'sleep' ? 0.4 : 0.5,
          transition: 'opacity 0.5s ease',
        }} />

        {/* TAMAGOTCHI — Stats + Menu container (single hover zone) */}
        <div
          onPointerEnter={() => setShowTamaStats(true)}
          onPointerLeave={() => { setShowTamaStats(false); setShowTamaMenu(false) }}
          onClick={(e) => {
            if (!draggingRef.current) {
              e.stopPropagation()
              if (isDead) { tamaRevive(); return }
              setShowTamaMenu(prev => !prev)
              setShowTamaStats(true)
            }
          }}
          style={{
            position: 'absolute', top: -110, left: '50%',
            transform: `translateX(-50%) scaleX(${facing === 'left' ? -1 : 1})`,
            pointerEvents: physicsActive ? 'none' : 'auto',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            paddingBottom: 120, // extends hover zone down to crab body
          }}
        >
          {/* Radial action menu */}
          {showTamaMenu && !isDead && (
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { icon: '🍕', label: 'Feed', action: tamaFeed, color: '#f97316' },
                { icon: '🎮', label: 'Play', action: tamaPlay, color: '#fbbf24' },
                { icon: '💤', label: 'Sleep', action: tamaSleep, color: '#22c55e' },
                { icon: '✨', label: 'Clean', action: tamaClean, color: '#3b82f6' },
              ].map((btn, i) => (
                <button key={i} onClick={(e) => { e.stopPropagation(); btn.action() }}
                  style={{
                    width: 44, height: 44, borderRadius: '50%', border: 'none',
                    background: btn.color, fontSize: 20, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                    animation: `tama-btn-pop 0.3s ease-out ${i * 0.05}s both`,
                    transition: 'transform 0.15s',
                  }}
                  onPointerEnter={(e) => (e.currentTarget.style.transform = 'scale(1.2)')}
                  onPointerLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                  title={btn.label}
                >{btn.icon}</button>
              ))}
            </div>
          )}

          {/* Mini stat bars */}
          <div style={{
            display: 'flex', gap: 3, background: 'rgba(0,0,0,0.7)', padding: '4px 8px',
            borderRadius: 8, backdropFilter: 'blur(4px)',
            opacity: showTamaStats || showTamaMenu ? 1 : 0,
            transition: 'opacity 0.3s',
          }}>
            {[
              { val: tamaStats.hunger, color: '#f97316', icon: '🍕' },
              { val: tamaStats.happiness, color: '#fbbf24', icon: '😊' },
              { val: tamaStats.energy, color: '#22c55e', icon: '⚡' },
              { val: tamaStats.health, color: '#ef4444', icon: '❤️' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <span style={{ fontSize: 10 }}>{s.icon}</span>
                <div style={{ width: 24, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.15)' }}>
                  <div style={{
                    width: `${s.val}%`, height: '100%', borderRadius: 2,
                    background: s.val < 30 ? '#ef4444' : s.color,
                    transition: 'width 0.5s',
                  }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* TAMAGOTCHI — Death overlay */}
        {isDead && (
          <div style={{
            position: 'absolute', top: 40, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.8)', color: '#ef4444', padding: '8px 16px',
            borderRadius: 8, fontSize: 14, fontWeight: 700, textAlign: 'center' as const,
            whiteSpace: 'nowrap', pointerEvents: 'auto', cursor: 'pointer',
            animation: 'speech-pop 0.3s ease-out forwards',
          }} onClick={(e) => { e.stopPropagation(); tamaRevive() }}>
            💀 Click to revive!
          </div>
        )}

        {/* TAMAGOTCHI — Action effect */}
        {tamaAction === 'feed' && (
          <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', fontSize: 32, animation: 'money-rain 1.5s ease-out forwards', pointerEvents: 'none' }}>🍕</div>
        )}
        {tamaAction === 'clean' && (
          <>
            {[0, 1, 2].map(i => (
              <div key={i} style={{ position: 'absolute', top: 30 + i * 20, left: 40 + i * 30, fontSize: 20, animation: `power-particles 1s ease-out ${i * 0.2}s forwards`, pointerEvents: 'none' }}>✨</div>
            ))}
          </>
        )}
      </div>

      {/* The ClawBox — crab's prop */}
      <div ref={boxElRef}
        onPointerDown={handleBoxPointerDown}
        onPointerMove={handleBoxPointerMove}
        onPointerUp={handleBoxPointerUp}
        style={{
        position: 'fixed',
        left: 0,
        bottom: boxPhysicsActive ? 0 : -3,
        transform: boxPhysicsActive ? undefined : `translateX(calc(${boxXRef.current}vw - 50%))`,
        zIndex: crabOnBox ? 10000 : 10002,
        pointerEvents: 'auto', cursor: 'grab', touchAction: 'none',
        willChange: 'transform, filter',
        filter: boxGlow ? 'drop-shadow(0 0 10px rgba(249,115,22,0.5))' : 'none',
      }}>
        <div style={{
          animation: boxKick ? `box-bump-${boxKick} 0.7s ease-out forwards` : 'box-idle 4s ease-in-out infinite',
          width: 40, height: 40,
        }}>
          <img src="/clawbox-box.png" alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />
        </div>
      </div>
    </>
  )
}


export default memo(ClawBoxMascot)
