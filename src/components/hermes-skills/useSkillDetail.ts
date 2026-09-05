'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type CliFailureCode,
  type HermesSkill,
  type HermesSkillDetail,
  isCliFailureCode,
} from '@/lib/hermes-skills';

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

/**
 * What a cached answer — and a failure — belong to. Both scopes are kept apart
 * because the same string can be a lock name in the Installed tab and a
 * registry identifier in Browse, and those are two DIFFERENT skills.
 */
const detailKey = (id: string, fromInstalled: boolean) => `${fromInstalled ? 'i' : 'b'}:${id}`;

export type DetailPhase = 'idle' | 'meta' | 'docs' | 'done';

/**
 * Why the panel has a note on it, in the two parts the panel says differently:
 * `docs` cost only the documentation body — the metadata is already on screen —
 * while `meta` is the whole detail. The CODE, never the route's sentence: that
 * sentence is English composed on the device, and it used to be painted
 * verbatim under a localised header (HERMES-04). A failure that carried no code
 * — an older device build, a transport error — is `null` and gets the generic
 * line, the same rule the Browse tab applies.
 */
export interface DetailFailure {
  part: 'meta' | 'docs';
  /**
   * `not_found` is the one refusal that is not a CLI failure: Hermes answered,
   * and what it said is that the skill does not exist.
   */
  code: CliFailureCode | 'not_found' | null;
}

interface DetailDelta extends Partial<HermesSkillDetail> {
  provenance?: HermesSkillDetail['provenance'];
}

export interface DetailController {
  detail: HermesSkillDetail | null;
  phase: DetailPhase;
  error: DetailFailure | null;
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
  // Every answer carries the request it belongs to, and the bottom of this hook
  // hands back only the ones that still describe what is on screen — dropping a
  // stale answer by DERIVATION rather than by an extra state write.
  //
  // The tag is the CACHE KEY, not the bare id: the same string is a lock name
  // in the Installed tab and a registry identifier in Browse, and those are two
  // DIFFERENT skills (40 ClawHub ids collide with a bundled skill on this
  // device — it is why the route takes a `scope` at all). An id-only tag let
  // one tab's answer be painted for the other's skill.
  //
  // The two that describe an ATTEMPT rather than a skill carry the RUN of the
  // effect they came from, so a re-ask hides them without clearing anything: a
  // note from the attempt before has no business sitting under a panel that is
  // being asked again. `reloadKey` cannot do that job — it moves only in
  // `refresh()`, so Installed(id) -> Browse(id) -> Installed(id) came back with
  // the same tag as the failure before it and showed that failure while the new
  // request was still in flight. `epoch` moves for every run of the effect.
  //
  // A ref, not state, and read during render on purpose: it only ever changes
  // inside the effect, and every run of the effect also writes `held` with a
  // fresh object, so the render that sees the new value always happens.
  const [held, setHeld] = useState<{ key: string; skill: HermesSkillDetail } | null>(null);
  const [phase, setPhase] = useState<DetailPhase>('idle');
  const [errorState, setErrorState] = useState<({ key: string; run: number } & DetailFailure) | null>(null);
  const [ambiguous, setAmbiguous] = useState<
    { key: string; run: number; query: string; candidates: HermesSkill[] } | null
  >(null);
  const [reloadKey, setReloadKey] = useState(0);
  const epoch = useRef(0);
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
    const cacheKey = detailKey(inspectId, fromInstalled);
    const run = ++epoch.current;
    const controller = new AbortController();
    let cancelled = false;

    const cached = cache.current.get(cacheKey);
    if (cached) {
      setHeld({ key: cacheKey, skill: cached });
      setPhase(cached.needsRemoteDocs ? 'docs' : 'done');
      if (!cached.needsRemoteDocs) return;
    } else {
      setHeld(null);
      setPhase('meta');
    }

    (async () => {
      let base = cached ?? null;
      // Set from the answer's own code before the throw below, so the catch —
      // which also covers a transport failure that has no code at all — knows
      // which of the two it is holding.
      let metaCode: CliFailureCode | null = null;
      try {
        if (!base) {
          const res = await fetch(`${INSPECT_URL}?id=${encodeURIComponent(inspectId)}${scope}`, {
            signal: controller.signal,
            cache: 'no-store',
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            if (isCliFailureCode(data?.code)) metaCode = data.code;
            throw new Error(data?.error || `HTTP ${res.status}`);
          }
          base = data.skill as HermesSkillDetail;
          if (cancelled) return;
          setHeld({ key: cacheKey, skill: base });
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
          setAmbiguous({
            key: cacheKey,
            run,
            query: String(data.query || inspectId),
            candidates: data.candidates as HermesSkill[],
          });
          setPhase('done');
          return;
        }
        if (!res.ok) {
          // A 404 `not_found` is HERMES refusing the id — it is the authority on
          // what exists, and phase 1's catalogue is a snapshot that can be stale
          // or keyed differently (a related-skill chip carries a bare NAME). Over
          // a phase-1 record nothing backed, that refusal settles the question:
          // what is on screen behind this note is the id echoed back as a name,
          // not a skill, so the record goes with the note.
          if (res.status === 404 && data?.code === 'not_found' && base.catalogMiss) {
            console.error('[skills detail] no such skill', inspectId);
            cache.current.delete(cacheKey);
            setHeld(null);
            setPhase('done');
            setErrorState({ key: cacheKey, run, part: 'meta', code: 'not_found' });
            return;
          }
          // The metadata is already on screen; a failed docs fetch only costs
          // the body, so it degrades to a note rather than an error page.
          console.error('[skills detail] documentation', data?.code ?? 'no code', data?.error ?? res.status);
          setPhase('done');
          setErrorState({
            key: cacheKey,
            run,
            part: 'docs',
            code: isCliFailureCode(data?.code) ? data.code : null,
          });
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
        setHeld({ key: cacheKey, skill: merged });
        remember(cacheKey, merged);
        setPhase('done');
      } catch (err) {
        if ((err as Error).name === 'AbortError' || cancelled) return;
        console.error('[skills detail]', err);
        setPhase('done');
        setErrorState({ key: cacheKey, run, part: 'meta', code: metaCode });
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
  // frame the state still describes the previous request. Everything below is
  // therefore checked against what is on screen NOW, and a mismatch reads as
  // "still loading" rather than painting another skill's version, another
  // tab's failure, or the ambiguity of a query this one already resolved.
  const heldFor = detailKey(inspectId, fromInstalled);
  const stale = !held || held.key !== heldFor || held.skill.id !== inspectId;
  const fromThisRun = (a: { key: string; run: number }) => a.key === heldFor && a.run === epoch.current;
  return {
    detail: stale ? null : held.skill,
    phase: stale ? 'meta' : phase,
    error: errorState && fromThisRun(errorState) ? errorState : null,
    ambiguous: ambiguous && fromThisRun(ambiguous) && ambiguous.query === inspectId ? ambiguous : null,
    refresh,
  };
}
