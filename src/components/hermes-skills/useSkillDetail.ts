'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HermesSkill, HermesSkillDetail } from '@/lib/hermes-skills';

// Two-phase detail fetch.
//
//   phase 1 (?id=)        instant: on-disk SKILL.md / catalog metadata, no CLI.
//   phase 2 (?id=&docs=1) only when phase 1 says the documentation lives
//                         remotely. This one shells out to `hermes skills
//                         inspect` and can take seconds, so it is fired ONLY
//                         while the detail view is open and is aborted the
//                         moment the user navigates away.

const INSPECT_URL = '/setup-api/hermes/skills/inspect';
const CACHE_LIMIT = 50;

export type DetailPhase = 'idle' | 'meta' | 'docs' | 'done';

interface DetailDelta extends Partial<HermesSkillDetail> {
  provenance?: HermesSkillDetail['provenance'];
}

export interface DetailController {
  detail: HermesSkillDetail | null;
  phase: DetailPhase;
  error: string | null;
  ambiguous: { query: string; candidates: HermesSkill[] } | null;
  /**
   * Drop the cached entries for these ids AND re-run the fetch for whatever is
   * on screen — the answer changes completely once a skill is (un)installed.
   * Dropping the cache alone was not enough: the effect keys on the id, and the
   * id does not change when you install, so the open detail view kept showing
   * the pre-install state (no requirements, no scan report, "after install").
   */
  refresh: (...ids: (string | undefined)[]) => void;
}

/** True when the id came from the Installed tab (see the inspect route). */
export function useSkillDetail(inspectId: string | null, fromInstalled = false): DetailController {
  const [detail, setDetail] = useState<HermesSkillDetail | null>(null);
  const [phase, setPhase] = useState<DetailPhase>('idle');
  // Errors and ambiguity are tagged with the id they belong to, so switching
  // skills drops them by DERIVATION rather than by an extra state write.
  const [errorState, setErrorState] = useState<{ id: string; message: string } | null>(null);
  const [ambiguous, setAmbiguous] = useState<{ query: string; candidates: HermesSkill[] } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const cache = useRef<Map<string, HermesSkillDetail>>(new Map());

  // Both scopes are dropped for an id: the same string can be a lock name in
  // the Installed tab and a registry identifier in Browse, and those are two
  // DIFFERENT skills with two different cached answers.
  const dropCached = useCallback((id: string) => {
    cache.current.delete(`i:${id}`);
    cache.current.delete(`b:${id}`);
  }, []);

  const refresh = useCallback(
    (...ids: (string | undefined)[]) => {
      for (const id of ids) {
        if (id) dropCached(id);
      }
      setReloadKey((k) => k + 1);
    },
    [dropCached],
  );

  const remember = useCallback((key: string, value: HermesSkillDetail) => {
    const map = cache.current;
    map.delete(key);
    map.set(key, value);
    // FIFO trim — the detail objects carry whole SKILL.md bodies.
    while (map.size > CACHE_LIMIT) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }, []);

  useEffect(() => {
    // No selection: nothing to fetch. The closed-view state is DERIVED at the
    // bottom of this hook instead of being written back here, so closing the
    // detail costs no extra render.
    if (!inspectId) return;

    const scope = fromInstalled ? '&scope=installed' : '';
    const cacheKey = `${fromInstalled ? 'i' : 'b'}:${inspectId}`;
    const controller = new AbortController();
    let cancelled = false;

    const cached = cache.current.get(cacheKey);
    if (cached) {
      setDetail(cached);
      setPhase(cached.needsRemoteDocs ? 'docs' : 'done');
      if (!cached.needsRemoteDocs) return;
    } else {
      setDetail(null);
      setPhase('meta');
    }

    (async () => {
      let base = cached ?? null;
      try {
        if (!base) {
          const res = await fetch(`${INSPECT_URL}?id=${encodeURIComponent(inspectId)}${scope}`, {
            signal: controller.signal,
            cache: 'no-store',
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          base = data.skill as HermesSkillDetail;
          if (cancelled) return;
          setDetail(base);
          remember(cacheKey, base);
          setPhase(base.needsRemoteDocs ? 'docs' : 'done');
        }

        if (!base.needsRemoteDocs) return;

        const res = await fetch(`${INSPECT_URL}?id=${encodeURIComponent(inspectId)}${scope}&docs=1`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && data?.ambiguous && Array.isArray(data.candidates)) {
          setAmbiguous({ query: String(data.query || inspectId), candidates: data.candidates as HermesSkill[] });
          setPhase('done');
          return;
        }
        if (!res.ok) {
          // The metadata is already on screen; a failed docs fetch only costs
          // the body, so it degrades to a note rather than an error page.
          setPhase('done');
          setErrorState({ id: inspectId, message: data?.error || 'Could not load the full documentation' });
          return;
        }
        const delta = (data.delta || {}) as DetailDelta;
        const merged: HermesSkillDetail = {
          ...base,
          // The delta only fills GAPS — anything we proved from disk or the
          // catalog outranks a lossy CLI preview.
          description: base.description ?? delta.description,
          version: base.version ?? delta.version,
          author: base.author ?? delta.author,
          license: base.license ?? delta.license,
          body: base.body ?? delta.body,
          bodySource: base.body ? base.bodySource : (delta.bodySource ?? 'none'),
          bodyTruncated: base.body ? base.bodyTruncated : !!delta.bodyTruncated,
          headings: base.headings ?? delta.headings,
          needsRemoteDocs: false,
          provenance: {
            sourceUrlVerified: false,
            ...delta.provenance,
            ...base.provenance,
            // A published repo link from the CLI beats a derived guess.
            ...(base.provenance?.sourceUrlVerified
              ? {}
              : delta.provenance?.sourceUrl
                ? { sourceUrl: delta.provenance.sourceUrl, sourceUrlVerified: true }
                : {}),
          },
        };
        setDetail(merged);
        remember(cacheKey, merged);
        setPhase('done');
      } catch (err) {
        if ((err as Error).name === 'AbortError' || cancelled) return;
        setPhase('done');
        setErrorState({ id: inspectId, message: err instanceof Error ? err.message : 'Couldn’t load details' });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [inspectId, remember, fromInstalled, reloadKey]);

  if (!inspectId) {
    return { detail: null, phase: 'idle', error: null, ambiguous: null, refresh };
  }
  // The effect runs AFTER the render that changed the selection, so for one
  // frame the state still describes the previous skill. Every payload carries
  // the id it was fetched for, so a mismatch is reported as "still loading"
  // rather than painting another skill's version/author into this header.
  const stale = !detail || detail.id !== inspectId;
  return {
    detail: stale ? null : detail,
    phase: stale ? 'meta' : phase,
    error: errorState && errorState.id === inspectId ? errorState.message : null,
    ambiguous: ambiguous && ambiguous.query === inspectId ? ambiguous : null,
    refresh,
  };
}
