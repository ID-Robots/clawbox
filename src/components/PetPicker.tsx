'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'
import { announcePetChanged } from '@/lib/pet-client'

// ── Settings → Appearance → Mascot pet ──
//
// Hermes-only, and it gates itself: `/setup-api/pets` answers `supported:
// false` on an OpenClaw box (there is no `hermes` binary there), so this whole
// card renders nothing and the crab section above it is untouched.
//
// Picking a pet writes through `hermes pets install` + `hermes pets select`,
// which means config.yaml — the same store the Hermes CLI, TUI and desktop app
// read. ClawBox keeps no selection of its own, so `hermes pets select boba` in
// the in-UI terminal moves this picker too.
//
// The tiles show `by <author>`: Petdex art stays credited to whoever submitted
// it, and the footer says plainly where the sprites come from and that they
// download to this device rather than shipping with ClawBox.

interface GalleryPet {
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  curated: boolean
  installed: boolean
}

interface Gallery {
  supported: boolean
  enabled: boolean
  activeSlug: string
  defaultSlug?: string
  galleryUrl?: string
  pets: GalleryPet[]
}

export default function PetPicker() {
  const { t } = useT()
  const [gallery, setGallery] = useState<Gallery | null>(null)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/setup-api/pets?gallery=1', { cache: 'no-store', signal })
      if (!res.ok) return
      const data = (await res.json()) as Gallery
      if (data && data.supported) setGallery(data)
      else setGallery({ supported: false, enabled: false, activeSlug: '', pets: [] })
    } catch {
      // Never surface a load failure as a broken panel: an unreachable route
      // just means no pet card, exactly as on OpenClaw.
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    load(ac.signal)
    return () => ac.abort()
  }, [load])

  const choose = useCallback(async (slug: string | null) => {
    setBusySlug(slug ?? '__off__')
    setError(false)
    try {
      const res = await fetch('/setup-api/pets/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      })
      if (!res.ok) { setError(true); return }
      announcePetChanged()
      await load()
    } catch {
      setError(true)
    } finally {
      setBusySlug(null)
    }
  }, [load])

  if (!gallery || !gallery.supported) return null

  const activeSlug = gallery.enabled ? gallery.activeSlug : ''

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>pets</span>
        <label className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t('settings.mascot.pets')}</label>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-4">{t('settings.mascot.petHint')}</p>

      <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
        {/* "No pet" — `hermes pets off`. Keeps the desktop bare rather than
            falling back to the crab, which is the OpenClaw mascot. */}
        <button
          onClick={() => choose(null)}
          disabled={busySlug !== null}
          className={`relative rounded-xl overflow-hidden aspect-square transition-all cursor-pointer border-none p-0 flex flex-col items-center justify-center gap-1 bg-white/[0.03] disabled:opacity-50 ${
            activeSlug === '' ? 'ring-2 ring-orange-400 ring-offset-2 ring-offset-[#0d1117]' : 'hover:ring-1 hover:ring-white/20'
          }`}
        >
          <span className="material-symbols-rounded text-white/40" style={{ fontSize: 22 }}>block</span>
          <span className="text-[10px] text-white/50 font-medium">{t('settings.mascot.petNone')}</span>
        </button>

        {gallery.pets.map(p => {
          const selected = activeSlug === p.slug
          const busy = busySlug === p.slug
          return (
            <button
              key={p.slug}
              onClick={() => choose(p.slug)}
              disabled={busySlug !== null}
              title={`${p.displayName}${p.submittedBy ? ` — ${t('settings.mascot.petBy').replace('{author}', p.submittedBy)}` : ''}`}
              className={`relative rounded-xl overflow-hidden aspect-square transition-all cursor-pointer border-none p-0 bg-white/[0.03] disabled:opacity-50 group ${
                selected ? 'ring-2 ring-orange-400 ring-offset-2 ring-offset-[#0d1117]' : 'hover:ring-1 hover:ring-white/20'
              }`}
            >
              {/* The preview is a server-cropped idle frame, not the 2.2 MB
                  sheet and not a CDN hotlink. A 404 (offline, or a pet taken
                  down since) leaves the name-only tile, which is why the label
                  is drawn underneath rather than over the image. */}
              <img
                src={`/setup-api/pets/thumb?slug=${encodeURIComponent(p.slug)}`}
                alt=""
                loading="lazy"
                className="absolute inset-0 w-full h-full object-contain p-1.5"
                style={{ imageRendering: 'pixelated' }}
                onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
              />
              {busy && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-[10px] text-white/80">
                  {t('settings.mascot.petInstalling')}
                </span>
              )}
              <span className="absolute bottom-0 inset-x-0 text-[9px] leading-tight py-1 text-center font-medium backdrop-blur-md bg-black/55 text-white/80">
                {p.displayName}
                {p.submittedBy && (
                  <span className="block text-[8px] text-white/45">
                    {t('settings.mascot.petBy').replace('{author}', p.submittedBy)}
                  </span>
                )}
              </span>
              {p.curated && !selected && (
                <span className="absolute top-1 left-1 text-[8px] px-1 py-[1px] rounded bg-white/10 text-white/60">
                  {t('settings.mascot.petCurated')}
                </span>
              )}
              {selected && (
                <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center shadow-lg">
                  <span className="material-symbols-rounded text-white" style={{ fontSize: 14 }}>check</span>
                </span>
              )}
            </button>
          )
        })}
      </div>

      {error && (
        <p className="mt-3 text-[11px] text-red-400/90">{t('settings.mascot.petInstallFailed')}</p>
      )}

      <p className="mt-4 text-[10px] leading-relaxed text-[var(--text-muted)]">
        {t('settings.mascot.petAttribution')}{' '}
        <a
          href={gallery.galleryUrl || 'https://petdex.dev'}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--coral-bright)]/80 hover:underline"
        >
          {t('settings.mascot.petBrowseAll')}
        </a>
      </p>
    </div>
  )
}
