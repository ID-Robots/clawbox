'use client';

import { useCallback, useEffect, useState } from 'react';
import type { InstalledHermesSkill } from '@/lib/hermes-skills';

// Installed-tab data. Kept apart from the browse catalog because it has a
// different lifecycle: it is re-read after every install/uninstall and it is the
// source of truth for marking a browse result as already installed.

const INSTALLED_URL = '/setup-api/hermes/skills/installed';

export interface InstalledCounts {
  total: number;
  builtin: number;
  hub: number;
  local: number;
  incompatible: number;
}

export interface InstalledController {
  skills: InstalledHermesSkill[];
  counts: InstalledCounts;
  categories: { id: string; count: number }[];
  loading: boolean;
  /**
   * Set when the read FAILED. Distinct from an empty list on purpose: "you have
   * no skills" and "we couldn't look" are different answers and the old store
   * showed the first for both.
   */
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_COUNTS: InstalledCounts = { total: 0, builtin: 0, hub: 0, local: 0, incompatible: 0 };

export function useInstalledSkills(): InstalledController {
  const [skills, setSkills] = useState<InstalledHermesSkill[]>([]);
  const [counts, setCounts] = useState<InstalledCounts>(EMPTY_COUNTS);
  const [categories, setCategories] = useState<{ id: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(INSTALLED_URL, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setSkills(Array.isArray(data.skills) ? (data.skills as InstalledHermesSkill[]) : []);
      setCounts({ ...EMPTY_COUNTS, ...(data.counts || {}) });
      setCategories(Array.isArray(data.categories) ? data.categories : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read installed skills');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { skills, counts, categories, loading, error, refresh };
}
