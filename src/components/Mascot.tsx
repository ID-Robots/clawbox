'use client'

import React, { useEffect, useState, useCallback, useRef, memo } from 'react'
import * as kv from '@/lib/client-kv'
import { useT } from '@/lib/i18n'
import { INSPIRATION_PHRASES, type MascotPhraseSet } from '@/lib/mascot-phrases'
import { fetchUserName, fetchPhraseSet, pickNameGreeting } from '@/lib/mascot-client'
import { MASCOT_KEYFRAMES } from '@/lib/mascot-styles'

// ── ClawBox Mascot — lazy, sarcastic, scandalous ──
//
// All speech-bubble phrases used to live as hardcoded arrays here. They've
// moved to `@/lib/mascot-phrases` (shared with the server-side generator)
// and are now treated as INSPIRATION SEEDS only. At runtime we fetch a
// LLM-generated set in the user's selected language from
// `/setup-api/mascot-lines`, refreshed weekly with daily top-ups based on
// what the user actually works on. Inspiration is the cold-start fallback.

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

const POWER_PARTICLES = [
  { bottom: 24, left: 38, duration: 1.2, delay: 0.15 },
  { bottom: 42, left: 76, duration: 1.5, delay: 0.55 },
  { bottom: 30, left: 108, duration: 1.35, delay: 0.95 },
]

function ClawBoxMascot({ onTap, frozen, thinking, onPositionChange }: { onTap?: (x?: number) => void; frozen?: boolean; thinking?: boolean; onPositionChange?: (x: number) => void } = {}) {
  const { locale } = useT()
  const frozenRef = useRef(false)
  const onPositionChangeRef = useRef(onPositionChange)
  onPositionChangeRef.current = onPositionChange
  // ─── All mutable state in refs to avoid stale closures ───
  const DEFAULT_POS = { x: 85, bx: 85 }
  const savedPos = useRef<{ x: number; bx: number } | null>(null)
  if (savedPos.current === null) {
    savedPos.current = kv.getJSON<{ x: number; bx: number }>('clawbox-crab-pos') ?? DEFAULT_POS
  }
  const xRef = useRef(savedPos.current?.x ?? DEFAULT_POS.x)
  const boxXRef = useRef(savedPos.current?.bx ?? DEFAULT_POS.bx)
  const kickedRef = useRef(false) // prevent double-kick per walk
  const [mounted, setMounted] = useState(false)

  // Speech
  const [speech, setSpeech] = useState('')
  const say = useCallback((text: string, ms = 3000) => {
    setSpeech(text)
    setTimeout(() => setSpeech(''), ms)
  }, [])
  const sayRef = useRef<((text: string, ms?: number) => void) | null>(null)
  sayRef.current = say

  // Simple sleeping state (no tamagotchi engine)
  const [isSleeping, setIsSleeping] = useState(false)
  const isSleepingRef = useRef(false)
  isSleepingRef.current = isSleeping

  // Hidden state (persisted) + context menu
  const [hidden, setHidden] = useState(() => {
    if (typeof window === 'undefined') return false
    return kv.get('clawbox-mascot-hidden') === '1'
  })
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxOpenedAt = useRef(0)

  // Categorized phrase set + extra sass snippets harvested from chat.
  // Initialized to inspiration so the crab can talk before the API responds.
  // Re-fetches when locale changes so a language switch flips the phrase
  // bag immediately instead of after the next midnight cache expiry.
  const phrasesRef = useRef<MascotPhraseSet>(INSPIRATION_PHRASES)
  const sassLinesRef = useRef<string[]>(INSPIRATION_PHRASES.sass)
  // Per-effect token so a slow fetch from a stale locale (e.g. en→bg→en in
  // quick succession) can't overwrite the phrase set with the wrong language.
  const phraseFetchTokenRef = useRef(0)
  useEffect(() => {
    const myToken = ++phraseFetchTokenRef.current
    fetchPhraseSet(locale).then(({ phrases, snippets }) => {
      if (myToken !== phraseFetchTokenRef.current) return
      phrasesRef.current = phrases
      sassLinesRef.current = snippets.length > 0 ? [...phrases.sass, ...snippets] : phrases.sass
    })
  }, [locale])

  // User name (from `ui_user_name` preference) — used in occasional name
  // greetings. Falls back to a randomly-picked friendly placeholder so
  // popups still feel personal even before the user sets a name.
  const userNameRef = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchUserName().then(name => { if (!cancelled) userNameRef.current = name })
    const onChanged = () => { fetchUserName().then(name => { if (!cancelled) userNameRef.current = name }) }
    window.addEventListener('clawbox-user-name-changed', onChanged)
    return () => { cancelled = true; window.removeEventListener('clawbox-user-name-changed', onChanged) }
  }, [])

  // Resolve a name to use right now: the configured one, or a random
  // fallback from the current phrase set so the same placeholder doesn't
  // get stuck on screen.
  const resolveName = useCallback((): string => {
    if (userNameRef.current) return userNameRef.current
    const fallbacks = phrasesRef.current.nameFallbacks.length > 0
      ? phrasesRef.current.nameFallbacks
      : INSPIRATION_PHRASES.nameFallbacks
    return fallbacks[Math.floor(Math.random() * fallbacks.length)]
  }, [])

  // Close context menu on click/right-click elsewhere
  useEffect(() => {
    if (!ctxMenu) return
    const close = (e: Event) => {
      if (Date.now() - ctxOpenedAt.current < 100) return
      e.preventDefault()
      setCtxMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
  }, [ctxMenu])

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
  const [frenzy, setFrenzy] = useState(false)
  const [moneyParticles, setMoneyParticles] = useState<{id: number; x: number; delay: number; duration: number; emoji: string}[]>([])
  const [damageFloaters, setDamageFloaters] = useState<{id: number; dmg: number; x: number}[]>([])
  const stateTimeout = useRef<ReturnType<typeof setTimeout>>(null)
  const sleepZzzRef = useRef<ReturnType<typeof setInterval>>(null)
  const walkInterval = useRef<ReturnType<typeof setInterval>>(null)
  const onBoxRef = useRef(false)
  const frenzyTimeout = useRef<ReturnType<typeof setTimeout>>(null)
  const frenzyIntervalsRef = useRef<ReturnType<typeof setInterval>[]>([])
  const doActionRef = useRef<() => void>(() => {})
  const draggingRef = useRef(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
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
  const saveCrabPos = useCallback(() => {
    kv.setJSON('clawbox-crab-pos', { x: xRef.current, bx: boxXRef.current })
  }, [])

  const updateCrabPos = useCallback(() => {
    if (!crabElRef.current) return
    const posX = onBoxRef.current ? boxXRef.current : xRef.current
    const scaleX = facingRef.current === 'left' ? -1 : 1
    crabElRef.current.style.transform = `translateX(calc(${posX}vw - 50%)) scaleX(${scaleX})`
    saveCrabPos()
  }, [saveCrabPos])

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
    saveCrabPos()
  }, [updateBoxPos, saveCrabPos])

  const setJumpY = useCallback((v: number) => {
    jumpYRef.current = v
    updateCrabPos()
  }, [updateCrabPos])

  const setFacingDirect = useCallback((dir: 'left' | 'right') => {
    facingRef.current = dir
    setFacing(dir) // still needed for speech bubble flip
    updateCrabPos()
  }, [updateCrabPos])

  // ─── Impact damage: take health damage when hitting surfaces at high speed ───
  const IMPACT_THRESHOLD = 600  // px/s — below this, no damage
  const IMPACT_DAMAGE_SCALE = 0.025 // damage per px/s above threshold
  const applyImpactDamage = useCallback((impactVel: number) => {
    const speed = Math.abs(impactVel)
    if (speed < IMPACT_THRESHOLD) return
    const dmg = (speed - IMPACT_THRESHOLD) * IMPACT_DAMAGE_SCALE
    // Spawn floating damage number
    const id = Date.now() + Math.random()
    const x = -20 + Math.random() * 40
    setDamageFloaters(prev => [...prev, { id, dmg: Math.round(dmg), x }])
    setTimeout(() => setDamageFloaters(prev => prev.filter(f => f.id !== id)), 1200)
    if (speed > 1200) say('OUCH! 💀', 1500)
    else if (speed > 800) say('Ow! 🤕', 1200)
  }, [say])

  // ─── ImpactJS-style physics tick (runs after drop) ───
  const physicsLoop = useCallback(function runPhysicsLoop() {
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
    const crabBottom = vh - p.posY  // crab's feet in screen coords (from top)
    // Crab hitbox: narrower than the full 150px image — just the body (~60px wide, centered)
    const crabHitW = 60
    const crabLeft = crabPxX - crabHitW / 2
    const crabRight = crabPxX + crabHitW / 2
    let landedOnPlatform = false

    const platforms = document.querySelectorAll('[data-crab-platform]')
    platforms.forEach((el) => {
      const rect = (el as HTMLElement).getBoundingClientRect()
      // Horizontal overlap check with tight hitbox
      if (crabRight > rect.left && crabLeft < rect.right) {
        const platformTop = rect.top
        // Falling onto platform: crab feet crossing platform top
        if (p.velY > 0 && crabBottom >= platformTop && crabBottom <= platformTop + rect.height * 0.5) {
          p.posY = vh - platformTop
          landedOnPlatform = true
        }
        // Already standing on platform
        if (Math.abs(crabBottom - platformTop) < 5 && p.velY >= 0) {
          p.posY = vh - platformTop
          landedOnPlatform = true
        }
      }
    })

    if (landedOnPlatform) {
      applyImpactDamage(p.velY)
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
          p.active = false; setPhysicsActive(false)
          updateCrabPos()
          setTimeout(() => doActionRef.current(), 2000)
          return
        }
      }
    }

    // ─── Collision: floor ───
    // Floor (crab feet on shelf — crab image hangs below anchor point)
    const crabFloor = 8
    if (p.posY <= crabFloor) {
      p.posY = crabFloor
      applyImpactDamage(p.velY)
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
          p.active = false; setPhysicsActive(false)
          updateCrabPos()
          setTimeout(() => doActionRef.current(), 2000)
          return
        }
      }
    }

    // ─── Collision: ceiling ───
    const crabVh = window.innerHeight
    if (p.posY >= crabVh - 150) { // 150 = crab size
      p.posY = crabVh - 150
      applyImpactDamage(p.velY)
      if (Math.abs(p.velY) > p.minBounceVel) p.velY = Math.abs(p.velY) * p.bounciness
      else p.velY = 0
    }
    // ─── Collision: walls ───
    if (xRef.current <= 2) {
      xRef.current = 2
      applyImpactDamage(p.velX)
      if (Math.abs(p.velX) > p.minBounceVel) {
        p.velX *= -p.bounciness
      } else {
        p.velX = 0
      }
    }
    if (xRef.current >= 92) {
      xRef.current = 92
      applyImpactDamage(p.velX)
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
      crabElRef.current.style.bottom = '0px'
      crabElRef.current.style.transform = `translateX(calc(${xRef.current}vw - 50%)) translateY(${-p.posY}px)`
    }

    physicsRAF.current = requestAnimationFrame(runPhysicsLoop)
  }, [updateCrabPos, applyImpactDamage])

  // ─── Crab drag + tap detection ───
  const dragStartPos = useRef({ x: 0, y: 0 })
  const didDragRef = useRef(false)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Right-click — let onContextMenu handle it, don't start drag/tap
    if (e.button === 2) return
    e.preventDefault(); e.stopPropagation()
    draggingRef.current = true; setPhysicsActive(true)
    didDragRef.current = false
    dragStartPos.current = { x: e.clientX, y: e.clientY }
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
    // Detect actual drag vs tap
    const dx = e.clientX - dragStartPos.current.x, dy = e.clientY - dragStartPos.current.y
    if (dx * dx + dy * dy > 25) didDragRef.current = true
    const vw = window.innerWidth, vh = window.innerHeight, now = performance.now()
    const p = physicsRef.current
    const dt = (now - p.lastPointerTime) / 1000
    if (dt > 0.005) {
      p.velX = (e.clientX - p.lastPointerX) / dt
      p.velY = (e.clientY - p.lastPointerY) / dt
      p.lastPointerX = e.clientX; p.lastPointerY = e.clientY; p.lastPointerTime = now
    }
    xRef.current = Math.min(92, Math.max(2, ((e.clientX - dragOffsetRef.current.x) / vw) * 100))
    onPositionChangeRef.current?.(xRef.current)
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

    // Tap detection — if pointer barely moved, trigger sass/chat
    if (!didDragRef.current) {
      setPhysicsActive(false)
      // Open chat on tap — works even when sleeping
      if (onTap) onTap(xRef.current)
      if (!isSleepingRef.current) {
        const sl = sassLinesRef.current; say(sl[Math.floor(Math.random() * sl.length)], 3000)
        // Restart the action loop so mascot doesn't freeze after tap
        if (stateTimeout.current) clearTimeout(stateTimeout.current)
        stateTimeout.current = setTimeout(() => doActionRef.current(), 3500)
      }
      return
    }

    // Drag-and-drop while sleeping wakes the mascot
    if (isSleepingRef.current) {
      wakeSleepRef.current?.()
      // Let physics play out the drop, then resume normal actions
      const p = physicsRef.current
      p.velX = Math.max(-p.maxVel, Math.min(p.maxVel, p.velX))
      p.velY = Math.max(-p.maxVel, Math.min(p.maxVel, p.velY))
      p.lastTime = performance.now()
      p.active = true
      physicsRAF.current = requestAnimationFrame(physicsLoop)
      return
    }

    const p = physicsRef.current
    p.velX = Math.max(-p.maxVel, Math.min(p.maxVel, p.velX))
    p.velY = Math.max(-p.maxVel, Math.min(p.maxVel, p.velY))
    p.lastTime = performance.now()
    p.active = true
    physicsRAF.current = requestAnimationFrame(physicsLoop)
  }, [physicsLoop])

  // ─── Box physics loop ───
  const boxPhysicsLoop = useCallback(function runBoxPhysicsLoop() {
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
    // Floor (box rests on shelf, 56px from bottom)
    const boxFloor = 56
    if (p.posY <= boxFloor) {
      p.posY = boxFloor
      if (p.bounciness > 0 && Math.abs(p.velY) > p.minBounceVel) {
        p.velY *= -p.bounciness
      } else {
        p.velY = 0
        if (Math.abs(p.velX) < 5) {
          p.active = false; setBoxPhysicsActive(false)
          if (boxElRef.current) boxElRef.current.style.transform = `translateX(calc(${boxXRef.current}vw - 50%))`
          saveCrabPos()
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
    boxPhysicsRAF.current = requestAnimationFrame(runBoxPhysicsLoop)
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

  const getSpeech = (st: MascotState): string | null => {
    const phrases = phrasesRef.current
    const lines: Record<string, string[]> = {
      sass: sassLinesRef.current,
      idle: phrases.idle,
      sleep: phrases.sleep,
      jump: phrases.jump,
      dance: phrases.dance,
      facepalm: phrases.facepalm,
      // celebrate / look kept as inline literals — short, action-specific,
      // and not currently part of the generated set.
      celebrate: ['🎉 CHA-CHING!', '💰💰💰', 'MONEY MONEY MONEY!'],
      look: ['👀', '🔍 Hmm...', 'What\'s over there?'],
    }
    const opts = lines[st]
    if (!opts || opts.length === 0) return null
    if (st !== 'sass' && Math.random() > 0.5) return null
    // Sometimes greet the user by name during sass / idle. Roll *after* the
    // skip-chance above so name greetings stay on the same overall cadence
    // as the regular lines (just rerouted to a personalised variant).
    if ((st === 'sass' || st === 'idle') && Math.random() < 0.25) {
      return pickNameGreeting(resolveName(), phrases)
    }
    return opts[Math.floor(Math.random() * opts.length)]
  }

  const pickAction = useCallback(() => {
    const total = MASCOT_ACTIONS.reduce((s, a) => s + a.weight, 0)
    let r = Math.random() * total
    for (const a of MASCOT_ACTIONS) { r -= a.weight; if (r <= 0) return a }
    return MASCOT_ACTIONS[0]
  }, [])

  const SLEEP_KEY = 'clawbox-mascot-sleep'

  // Start or resume sleep for a given remaining duration (ms)
  const startSleep = useCallback((remainingMs: number) => {
    if (stateTimeout.current) clearTimeout(stateTimeout.current)
    if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
    if (sleepZzzRef.current) clearInterval(sleepZzzRef.current)
    setState('sleep')
    const zzzLines = ['💤 Zzzzz...', '😴 ...zzz...', '💤 *snore*', '😴 ...mumble...', '💤 Zzzzz...']
    let zIdx = 0
    say(zzzLines[0], 4000)
    sleepZzzRef.current = setInterval(() => {
      zIdx = (zIdx + 1) % zzzLines.length
      say(zzzLines[zIdx], 4000)
    }, 30000)
    stateTimeout.current = setTimeout(() => {
      if (sleepZzzRef.current) { clearInterval(sleepZzzRef.current); sleepZzzRef.current = null }
      setSpeech('')
      setState('idle')
      setIsSleeping(false)
      kv.remove(SLEEP_KEY)
      setTimeout(() => doActionRef.current(), 1000)
    }, remainingMs) as ReturnType<typeof setTimeout>
  }, [say])

  // Wake from sleep — clears all sleep state
  const wakeSleep = useCallback(() => {
    if (sleepZzzRef.current) { clearInterval(sleepZzzRef.current); sleepZzzRef.current = null }
    if (stateTimeout.current) clearTimeout(stateTimeout.current)
    setSpeech('')
    setState('idle')
    setIsSleeping(false)
    kv.remove(SLEEP_KEY)
    say('*yawn* I\'m awake! 😤', 2500)
  }, [say])
  const wakeSleepRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    wakeSleepRef.current = wakeSleep
  }, [wakeSleep])

  // mascotSleep — stops movement, sleeps for 10-15 min (or until dragged), shows zzz bubbles
  const mascotSleep = useCallback(() => {
    setIsSleeping(true)
    const sleepDuration = (10 + Math.random() * 5) * 60 * 1000
    const wakeAt = Date.now() + sleepDuration
    kv.setJSON(SLEEP_KEY, wakeAt)
    startSleep(sleepDuration)
  }, [startSleep])

  const doAction = useCallback(() => {
    if (frozenRef.current) return // Don't start new actions while frozen
    if (isSleepingRef.current) return // No random actions while sleeping
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
      const line = getSpeech('idle')
      if (line) say(line, Math.min(duration - 500, 3000))
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

    stateTimeout.current = setTimeout(() => doActionRef.current(), duration + randRange(2000, 6000))
  }, [pickAction])
  useEffect(() => {
    doActionRef.current = doAction
  }, [doAction])

  // Listen for new order events — FRENZY MODE
  // Randomize positions on mount to avoid hydration mismatch
  useEffect(() => {
    // Positions already loaded from localStorage in ref init
    updateCrabPos()
    updateBoxPos()
    setMounted(true)
  }, [updateCrabPos, updateBoxPos])

  useEffect(() => {
    if (!mounted || !onPositionChange) return
    onPositionChange(onBoxRef.current ? boxXRef.current : xRef.current)
  }, [mounted, onPositionChange])

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
      frenzyIntervalsRef.current.forEach(clearInterval)
      frenzyIntervalsRef.current = []
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
          duration: 2 + Math.random() * 1.5,
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

      frenzyIntervalsRef.current = [quoteInterval, moneyInterval, jumpInterval]

      // End frenzy after 60 seconds
      frenzyTimeout.current = setTimeout(() => {
        setFrenzy(false)
        setMoneyParticles([])
        frenzyIntervalsRef.current.forEach(clearInterval)
        frenzyIntervalsRef.current = []
        if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
        doActionRef.current()
      }, 60000)
    }

    window.addEventListener('clawbox-new-order', handleNewOrder)
    return () => window.removeEventListener('clawbox-new-order', handleNewOrder)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Restore saved position (from localStorage via savedPos ref), or randomize on first visit
    updateCrabPos()
    if (boxElRef.current) boxElRef.current.style.transform = `translateX(calc(${boxXRef.current}vw - 50%))`
    // Random facing
    const dir = Math.random() > 0.5 ? 'right' : 'left'
    facingRef.current = dir
    setFacing(dir)

    // Resume sleep if mascot was sleeping before refresh
    let savedSleep = 0
    savedSleep = kv.getJSON<number>('clawbox-mascot-sleep') ?? 0
    const remaining = savedSleep - Date.now()
    const startDelay = remaining > 1000
      ? setTimeout(() => { setIsSleeping(true); startSleep(remaining) }, 500)
      : setTimeout(doAction, 2000)
    // Clean up expired sleep key
    if (savedSleep && remaining <= 1000) kv.remove('clawbox-mascot-sleep')
    return () => {
      clearTimeout(startDelay)
      if (stateTimeout.current) clearTimeout(stateTimeout.current)
      if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
      if (sleepZzzRef.current) clearInterval(sleepZzzRef.current)
      if (frenzyTimeout.current) clearTimeout(frenzyTimeout.current)
      frenzyIntervalsRef.current.forEach(clearInterval)
      if (physicsRAF.current) cancelAnimationFrame(physicsRAF.current)
      if (boxPhysicsRAF.current) cancelAnimationFrame(boxPhysicsRAF.current)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const bodyAnim = (() => {
    // Thinking animation overrides when bot is processing
    if (thinking) return 'mascot-thinking 1.5s ease-in-out infinite'
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

  // Freeze/unfreeze mascot (e.g. when chat popup is open) — enter power stance
  useEffect(() => {
    frozenRef.current = !!frozen
    if (frozen) {
      // Stop all movement — stay in place (don't teleport to box)
      if (stateTimeout.current) clearTimeout(stateTimeout.current)
      if (walkInterval.current) { cancelAnimationFrame(walkInterval.current as unknown as number); clearInterval(walkInterval.current) }
      setBoxGlow(true)
      setState('idle')
      setSpeech('')
    } else {
      // Remove power-up and resume action loop
      setCrabOnBox(false)
      setBoxGlow(false)
      if (stateTimeout.current) clearTimeout(stateTimeout.current)
      stateTimeout.current = setTimeout(() => doActionRef.current(), 1000)
    }
  }, [frozen])

  // Listen for show/hide mascot events from desktop context menu
  useEffect(() => {
    const showHandler = () => { setHidden(prev => { if (!prev) return prev; kv.remove('clawbox-mascot-hidden'); return false }) }
    const hideHandler = () => { setHidden(prev => { if (prev) return prev; kv.set('clawbox-mascot-hidden', '1'); return true }) }
    window.addEventListener('clawbox-show-mascot', showHandler)
    window.addEventListener('clawbox-hide-mascot', hideHandler)
    return () => { window.removeEventListener('clawbox-show-mascot', showHandler); window.removeEventListener('clawbox-hide-mascot', hideHandler) }
  }, [])

  if (!mounted) return null // avoid hydration mismatch — render only on client
  if (hidden) return null

  return (
    <>
      <style>{MASCOT_KEYFRAMES}</style>
      <div ref={crabElRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          ctxOpenedAt.current = Date.now()
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }}
        style={{
        position: 'fixed', left: 0,
        bottom: physicsActive ? 0 : 8,
        transform: physicsActive ? undefined : `translateX(calc(${crabOnBox ? boxXRef.current : xRef.current}vw - 50%)) scaleX(${facing === 'left' ? -1 : 1})`,
        zIndex: 10001, pointerEvents: 'auto',
        cursor: 'grab',
        touchAction: 'none',
        willChange: 'transform, bottom, filter',
        filter: isSleeping
          ? 'drop-shadow(0 0 10px rgba(147,197,253,0.3))'
          : frenzy
            ? 'drop-shadow(0 0 20px rgba(251,191,36,0.8))'
            : thinking
              ? 'drop-shadow(0 0 12px rgba(99,179,237,0.6))'
              : crabOnBox
                ? 'drop-shadow(0 0 15px rgba(249,115,22,0.6))'
                : 'none',
      }}>
        {/* Body */}
        <div style={{ animation: bodyAnim, width: 150, height: 150, position: 'relative', willChange: 'transform' }}>
          <img src="/clawbox-crab.png" alt="" style={{
            width: 150, height: 150, objectFit: 'contain',
          }} />
          {/* FRENZY MODE — money rain + shockwaves */}
          {frenzy && (
            <>
              {moneyParticles.map(p => (
                <div key={p.id} style={{
                  position: 'absolute', bottom: 50, left: p.x,
                  fontSize: '2rem',
                  animation: `money-rain ${p.duration}s ease-out ${p.delay}s both`,
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
              {POWER_PARTICLES.map((particle, i) => (
                <div key={i} style={{
                  position: 'absolute',
                  bottom: particle.bottom,
                  left: particle.left,
                  width: 4, height: 4, borderRadius: '50%',
                  background: i % 2 === 0 ? '#f97316' : '#fbbf24',
                  animation: `power-particles ${particle.duration}s ease-out ${particle.delay}s infinite`,
                  pointerEvents: 'none',
                }} />
              ))}
            </>
          )}
        </div>
        {/* Floating damage numbers */}
        {damageFloaters.map(f => (
          <div key={f.id} style={{
            position: 'absolute', bottom: 120, left: 75 + f.x,
            transform: 'translateX(-50%)',
            pointerEvents: 'none', zIndex: 11,
            animation: 'damage-float 1.2s ease-out forwards',
          }}>
            <span style={{
              color: '#ef4444', fontSize: '1.4rem', fontWeight: 900,
              textShadow: '0 0 8px rgba(239,68,68,0.8), 0 2px 4px rgba(0,0,0,0.5)',
              whiteSpace: 'nowrap',
            }}>-{f.dmg} HP</span>
          </div>
        ))}
        {/* Speech bubble — OUTSIDE body div so it doesn't wobble */}
        {speech && (() => {
          const bubbleBg = frenzy ? 'rgba(251,191,36,0.95)'
            : state === 'sass' ? 'rgba(220,38,38,0.9)'
            : state === 'facepalm' ? 'rgba(100,100,100,0.9)'
            : 'rgba(249,115,22,0.92)'
          return (
            <div style={{
              position: 'absolute', bottom: 155, left: 75,
              transform: `translateX(-50%) scaleX(${facing === 'left' ? -1 : 1})`,
              zIndex: 10,
            }}>
              <div style={{
                background: bubbleBg,
                color: frenzy ? '#000' : '#fff',
                padding: frenzy ? '10px 20px' : '8px 18px',
                borderRadius: 12, fontSize: frenzy ? '1.2rem' : '1.1rem', fontWeight: 700,
                whiteSpace: 'nowrap',
                lineHeight: 1.3,
                animation: 'speech-pop 0.3s ease-out forwards',
                textAlign: 'center' as const,
              }}>
                {speech}
                <div style={{ position: 'absolute', bottom: -8, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '8px solid transparent', borderRight: '8px solid transparent', borderTop: `8px solid ${bubbleBg}` }} />
              </div>
            </div>
          )
        })()}
        {/* ZZZ floating animation when sleeping */}
        {isSleeping && (
          <div style={{
            position: 'absolute', top: 30, right: 15,
            pointerEvents: 'none', zIndex: 11,
          }}>
            {[0, 1.2, 2.4].map((delay, i) => (
              <div key={i} style={{
                position: 'absolute',
                fontSize: [14, 18, 24][i],
                fontWeight: 900,
                color: 'rgba(147,197,253,0.9)',
                textShadow: '0 0 8px rgba(147,197,253,0.5)',
                animation: `zzz-float 3s ${delay}s ease-out infinite`,
                left: i * 6,
                top: -i * 4,
              }}>Z</div>
            ))}
          </div>
        )}
        {/* Thinking indicator — dots above mascot head */}
        {thinking && (
          <div style={{
            position: 'absolute', top: -5, left: '50%', transform: 'translateX(-50%)',
            display: 'flex', gap: 5, alignItems: 'center', zIndex: 11,
            pointerEvents: 'none',
          }}>
            {[0, 0.2, 0.4].map((delay, i) => (
              <div key={i} style={{
                width: 8, height: 8, borderRadius: '50%',
                background: 'rgba(99,179,237,0.9)',
                boxShadow: '0 0 6px rgba(99,179,237,0.5)',
                animation: `think-dot 1.2s ${delay}s ease-in-out infinite`,
              }} />
            ))}
          </div>
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
        bottom: boxPhysicsActive ? 0 : 53,
        transform: boxPhysicsActive ? undefined : `translateX(calc(${boxXRef.current}vw - 50%))`,
        zIndex: 10003,
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

      {/* Mascot right-click context menu */}
      {ctxMenu && (
        <div
          className="fixed z-[99999] min-w-[220px] py-1 bg-[#2d2d2d] rounded-lg shadow-2xl border border-white/10 backdrop-blur-xl text-sm text-white/90"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 240),
            top: ctxMenu.y - 8,
            transform: 'translateY(-100%)',
          }}
          onClick={() => setCtxMenu(null)}
        >
          {!isSleeping && (
            <button
              onClick={() => { mascotSleep(); setCtxMenu(null) }}
              className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3"
            >
              <span className="text-base">💤</span> Sleep
            </button>
          )}
          <button
            onClick={() => { setHidden(true); kv.set('clawbox-mascot-hidden', '1'); setCtxMenu(null); window.dispatchEvent(new Event('clawbox-hide-mascot')) }}
            className="w-full px-4 py-2 text-left hover:bg-white/10 flex items-center gap-3 text-red-400"
          >
            <span className="text-base">👁️‍🗨️</span> Hide mascot
          </button>
        </div>
      )}
    </>
  )
}


export default memo(ClawBoxMascot)
