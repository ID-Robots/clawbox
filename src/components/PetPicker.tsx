'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '@/lib/i18n'
import { VIBRANT_CLAWD_SLUG } from '@/lib/pet-builtin'
import { announcePetChanged } from '@/lib/pet-client'

// ── Settings → Appearance → Mascot pet ──
//
// On every edition since 2026-09-07 (the owner's ask: "add the mascots when we
// are on openclaw"). It still gates itself on the route: a server that
// predates pets, or one that cannot be reached, answers no `supported: true`
// and this whole card renders nothing.
//
// On Hermes a pick writes through `hermes pets install` + `hermes pets
// select`, which means config.yaml — the same store the Hermes CLI, TUI and
// desktop app read, so `hermes pets select boba` in the in-UI terminal moves
// this picker too. On OpenClaw the same route downloads the curated sheet
// into ClawBox's own store and keeps the pick in the config store.
//
// THE FIRST TILE is what the desktop wears with no pet picked. Where ClawBox's
// own harness runs (`placeholder: "crab"`) that body is the ClawBox crab, and
// since 2026-09-17 the crab is itself a pet — the bundled `vibrant-clawd` pack
// — so the tile is drawn from that pack's own sheet, through the same
// thumbnail route every other tile uses, under the crab's own localised name.
// It is the ONLY tile that pack gets there: a second "Vibrant Clawd" beside it
// (owner, 2026-09-18) offered one body twice. On a Hermes-only box the first
// tile is still "None" — the egg — and the bundled pack stays an ordinary
// gallery tile, because the crab is ClawBox's brand and not a stand-in on
// someone else's harness.
//
// The tiles show `by <author>`: Petdex art stays credited to whoever submitted
// it, and the footer says plainly where the sprites come from and that they
// download to this device rather than shipping with ClawBox. The one exception
// is ClawBox's own `vibrant-clawd`, which is bundled and wears a "Built in"
// badge instead.

interface GalleryPet {
  slug: string
  displayName: string
  kind: string
  submittedBy: string
  curated: boolean
  /** Ships with ClawBox: no download, works offline, cannot be removed.
   *  Absent from a server that predates the bundled pack. */
  builtin?: boolean
  installed: boolean
}

interface Gallery {
  supported: boolean
  /** What the desktop wears with no pet picked; absent from an older server. */
  placeholder?: 'crab' | 'egg'
  /**
   * Which harnesses this box runs. It decides what the crab tile POSTS, not
   * what it draws: `dual` is the one edition where the crab is the placeholder
   * AND the pick lands in a store other surfaces read. Absent from an older
   * server, which is read as "not dual" — the behaviour that box already had.
   */
  edition?: 'openclaw' | 'hermes' | 'dual'
  enabled: boolean
  activeSlug: string
  defaultSlug?: string
  galleryUrl?: string
  pets: GalleryPet[]
}

interface PetTileProps {
  /** Which sheet the preview is cut from — not necessarily what a click picks. */
  slug: string
  label: string
  /** Already interpolated ("by railly"), or empty for a pet with no author. */
  byline: string
  /** "Built in" / "Curated", or nothing. Hidden while the tile is selected. */
  badge: string | null
  selected: boolean
  busy: boolean
  busyLabel: string
  disabled: boolean
  onClick: () => void
  testId?: string
}

/** One gallery tile. Shared by the brand crab and by every pet, so the crab
 *  cannot drift into a second look for the same grid. */
function PetTile({
  slug, label, byline, badge, selected, busy, busyLabel, disabled, onClick, testId,
}: PetTileProps) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      title={byline ? `${label} — ${byline}` : label}
      className={`relative rounded-xl overflow-hidden aspect-square transition-all cursor-pointer border-none p-0 bg-white/[0.03] disabled:opacity-50 group ${
        selected ? 'ring-2 ring-orange-400 ring-offset-2 ring-offset-[#0d1117]' : 'hover:ring-1 hover:ring-white/20'
      }`}
    >
      {/* The preview is a server-cropped idle frame, not the 2.2 MB sheet and
          not a CDN hotlink. A 404 (offline, or a pet taken down since) leaves
          the name-only tile, which is why the label is drawn underneath rather
          than over the image. */}
      <img
        src={`/setup-api/pets/thumb?slug=${encodeURIComponent(slug)}`}
        alt=""
        loading="lazy"
        className="absolute inset-0 w-full h-full object-contain p-1.5"
        style={{ imageRendering: 'pixelated' }}
        onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
      />
      {busy && (
        <span role="status" className="absolute inset-0 flex items-center justify-center bg-black/60 text-[10px] text-white/80">
          {busyLabel}
        </span>
      )}
      <span className="absolute bottom-0 inset-x-0 text-[9px] leading-tight py-1 text-center font-medium backdrop-blur-md bg-black/55 text-white/80">
        {label}
        {byline && <span className="block text-[8px] text-white/45">{byline}</span>}
      </span>
      {/* "Built in" outranks "Curated": both are true of a pet we ship, and
          which one the owner needs to know is that this one is already on the
          device and needs no internet. */}
      {badge && !selected && (
        <span className="absolute top-1 left-1 text-[8px] px-1 py-[1px] rounded bg-white/10 text-white/60">
          {badge}
        </span>
      )}
      {selected && (
        <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center shadow-lg">
          <span className="material-symbols-rounded text-white" style={{ fontSize: 14 }} aria-hidden="true">check</span>
        </span>
      )}
    </button>
  )
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
  const byline = (author: string) =>
    author ? t('settings.mascot.petBy').replace('{author}', author) : ''

  // Where the "no pet" body is the crab, the crab IS the bundled pet: it leads
  // the grid once, wearing the crab's name, and is filtered out of the gallery
  // list so the same body cannot be offered twice.
  const brandSlug = gallery.placeholder === 'crab' ? VIBRANT_CLAWD_SLUG : null
  const brandRow = brandSlug ? gallery.pets.find(p => p.slug === brandSlug) : undefined
  const pets = brandSlug ? gallery.pets.filter(p => p.slug !== brandSlug) : gallery.pets
  // Worn whether the box landed on the brand body by itself (nothing picked, or
  // the pet switched off) or the slug is the owner's explicit pick — the route
  // resolves both to the same descriptor, so both must light the same tile.
  const brandSelected = activeSlug === '' || activeSlug === brandSlug
  // WHAT the crab tile posts, which is not the same answer on both crab
  // editions. On `dual` the picker's writes go through the `hermes pets` CLI
  // into config.yaml — the store the Hermes TUI and the upstream desktop app
  // read — where "no pet" is `pets off` and those surfaces then wear nothing
  // while ClawBox's own desktop falls back to the crab. So there the tile
  // SELECTS the pack, which is the only thing that puts the crab on all three,
  // and the copy into the harness store that costs (`materialiseBuiltinPet`)
  // is the reason it can show a busy state. On an openclaw-only box nothing
  // else reads that store, `{ slug: null }` already IS the crab, and selecting
  // the slug would reach the same body through a Petdex install that has never
  // heard of it — a route that can fail, for no visible difference.
  // With no pack on the device there is nothing to select on either edition.
  const brandChoice = brandSlug && brandRow?.installed && gallery.edition === 'dual' ? brandSlug : null

  return (
    <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5">
      <div className="flex items-center gap-2 mb-1">
        <span className="material-symbols-rounded text-[var(--coral-bright)]" style={{ fontSize: 18 }}>pets</span>
        <h3 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">{t('settings.mascot.pets')}</h3>
        {/* Where the rest of the pets are.

            It OPENS Petdex rather than installing from it, and the label says
            so, because "install any of the 4,600" is not a thing this box may
            do: `pet-curated.ts` is the standing decision — Petdex art carries
            no blanket licence, ~2,297 of the entries are recognisable fan art
            of other people's characters, and ClawBox therefore offers the
            `/curated/` namespace and links out for the rest instead of
            mirroring the gallery in-product. A button that quietly widened
            `installPetDirect` past `curatedPet()` would reverse that ruling,
            not implement a button.

            So this is the same destination the attribution line below already
            credits, promoted to an affordance an owner can actually find: a
            real control beside the grid rather than a word inside a paragraph.
            It adds no outbound service of its own — the browser makes the
            request, not the box. */}
        <a
          href={gallery.galleryUrl || 'https://petdex.dev'}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="pet-more-on-petdex"
          className="ml-auto flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-white/10 text-[var(--text-secondary)] hover:bg-white/5 transition-colors shrink-0 no-underline"
        >
          <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>open_in_new</span>
          {t('settings.mascot.petMoreOnPetdex')}
        </a>
      </div>
      <p className="text-[11px] text-[var(--text-muted)] mb-4">{t('settings.mascot.petHint')}</p>

      <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
        {/* The first tile draws what the box wears with nothing picked, and posts
            `brandChoice` (see above): `{ slug: null }` on Hermes — `hermes pets
            off`, the desktop stays bare with the egg rather than falling back to
            the crab, which is ClawBox's own brand — and on an openclaw-only box,
            where "no pet" already IS the crab; the bundled slug on a `dual` box,
            whose Hermes-owned surfaces read the same store and would otherwise
            be left with no pet at all. */}
        {brandRow?.installed ? (
          <PetTile
            testId="pet-tile-none"
            slug={brandRow.slug}
            label={t('settings.mascot.petCrab')}
            byline={byline(brandRow.submittedBy)}
            badge={t('settings.mascot.petBuiltin')}
            selected={brandSelected}
            /* Only the dual pick copies anything (the pack into the harness
               store); where the tile posts "no pet" nothing is fetched, so
               there is no "Downloading…" state to show. */
            busy={brandChoice !== null && busySlug === brandChoice}
            busyLabel={t('settings.mascot.petInstalling')}
            disabled={busySlug !== null}
            onClick={() => choose(brandChoice)}
          />
        ) : (
          <button
            data-testid="pet-tile-none"
            onClick={() => choose(null)}
            disabled={busySlug !== null}
            aria-pressed={brandSlug ? brandSelected : activeSlug === ''}
            className={`relative rounded-xl overflow-hidden aspect-square transition-all cursor-pointer border-none p-0 flex flex-col items-center justify-center gap-1 bg-white/[0.03] disabled:opacity-50 ${
              (brandSlug ? brandSelected : activeSlug === '') ? 'ring-2 ring-orange-400 ring-offset-2 ring-offset-[#0d1117]' : 'hover:ring-1 hover:ring-white/20'
            }`}
          >
            {brandSlug ? (
              // The crab with no bundled pack to draw it from — a build whose
              // sheet did not survive the copy, or a server that predates it.
              // The still PNG is the desktop's own fail-open body, so the tile
              // shows what the owner would actually get.
              <>
                <img src="/clawbox-crab.png" alt="" className="w-12 h-12 object-contain" />
                <span className="text-[10px] text-white/70 font-medium">{t('settings.mascot.petCrab')}</span>
              </>
            ) : (
              <>
                <span className="material-symbols-rounded text-white/40" style={{ fontSize: 22 }} aria-hidden="true">block</span>
                <span className="text-[10px] text-white/50 font-medium">{t('settings.mascot.petNone')}</span>
              </>
            )}
          </button>
        )}

        {pets.map(p => (
          <PetTile
            key={p.slug}
            slug={p.slug}
            label={p.displayName}
            byline={byline(p.submittedBy)}
            badge={p.builtin ? t('settings.mascot.petBuiltin') : p.curated ? t('settings.mascot.petCurated') : null}
            selected={activeSlug === p.slug}
            busy={busySlug === p.slug}
            busyLabel={t('settings.mascot.petInstalling')}
            disabled={busySlug !== null}
            onClick={() => choose(p.slug)}
          />
        ))}
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
