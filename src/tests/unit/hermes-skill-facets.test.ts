import { describe, expect, it } from 'vitest';
import {
  EMPTY_INSTALLED_SELECTION,
  SAFETY_BUCKETS,
  TRUST_BUCKETS,
  categoryLabelFromKey,
  facetInstalled,
  fixedFacets,
  isValidCategoryKey,
  normalizeCategory,
  rankFacets,
  safetyBucket,
  trustBucket,
} from '@/lib/hermes-skill-facets';

/**
 * The facet rail's vocabulary.
 *
 * The two constraints this file exists to pin come from the device, not from
 * taste:
 *
 *  1. TASK-452 called ClawHub's categories junk, and the box is worse than
 *     that — 89 866 of its 90 605 catalogue rows declare no category at all,
 *     and the 739 that do are spelled three ways by three registries. So the
 *     normaliser has to collapse the spellings, reject the words that carry no
 *     information, and let the rail stand on Trust and Safety instead.
 *  2. A facet count is a promise about what a filter will reach. Every count
 *     here is measured with the OTHER groups applied and this group's own
 *     selection ignored, which is what keeps that promise true while more than
 *     one group is ticked.
 */

describe('trustBucket', () => {
  it('collapses builtin and official, which read as one thing to a customer', () => {
    expect(trustBucket('builtin')).toBe('official');
    expect(trustBucket('official')).toBe('official');
  });

  it('keeps the tiers a customer has to tell apart', () => {
    expect(trustBucket('trusted')).toBe('trusted');
    expect(trustBucket('community')).toBe('community');
  });

  it('treats anything it does not recognise as unknown, not as trusted', () => {
    expect(trustBucket(undefined)).toBe('unknown');
    expect(trustBucket('')).toBe('unknown');
    expect(trustBucket('gold-star')).toBe('unknown');
  });
});

describe('safetyBucket', () => {
  it('reads every clean verdict the scanner can write as safe', () => {
    for (const v of ['safe', 'clean', 'ok', 'pass', 'passed', 'none', ' SAFE ']) {
      expect(safetyBucket(v)).toBe('safe');
    }
  });

  it('separates a refusal from a warning', () => {
    expect(safetyBucket('dangerous')).toBe('dangerous');
    expect(safetyBucket('blocked')).toBe('dangerous');
    expect(safetyBucket('caution')).toBe('caution');
  });

  it('fails closed: a verdict a newer scanner invents is a warning, not clean', () => {
    expect(safetyBucket('suspicious')).toBe('caution');
    expect(safetyBucket('needs-review')).toBe('caution');
  });

  it('never scanned is its own answer, not "safe"', () => {
    expect(safetyBucket(undefined)).toBe('unscanned');
    expect(safetyBucket('')).toBe('unscanned');
  });
});

describe('normalizeCategory', () => {
  it('collapses the spellings three registries use for one thing', () => {
    const keys = ['Data Science', 'data-science', 'data_science', 'DATA  SCIENCE'].map(
      (v) => normalizeCategory(v)?.key,
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('labels a key back into something readable, acronyms intact', () => {
    expect(categoryLabelFromKey('developer-tools')).toBe('Developer Tools');
    expect(categoryLabelFromKey('ai')).toBe('AI');
    expect(categoryLabelFromKey('smart-home')).toBe('Smart Home');
    expect(categoryLabelFromKey('devops')).toBe('DevOps');
    // Seen on the box's Installed tab, where it read "Github".
    expect(categoryLabelFromKey('github')).toBe('GitHub');
  });

  it('merges the registry synonyms actually seen on the box', () => {
    expect(normalizeCategory('Vision AI')?.key).toBe('ai');
    expect(normalizeCategory('Training AI')?.key).toBe('ai');
    expect(normalizeCategory('e-commerce')?.key).toBe('ecommerce');
    expect(normalizeCategory('dev-tools')?.key).toBe('developer-tools');
  });

  it('rejects the words that would make a bucket say nothing', () => {
    for (const junk of ['other', 'misc', 'General', 'uncategorized', 'unknown', 'n/a', 'TBD']) {
      expect(normalizeCategory(junk), junk).toBeNull();
    }
  });

  it('rejects the registry mangling that is not a category at all', () => {
    expect(normalizeCategory('metadata:')).toBeNull();
    expect(normalizeCategory('name: thing, description: other')).toBeNull();
    expect(normalizeCategory('A skill that helps you write great blog posts.')).toBeNull();
    expect(normalizeCategory('"quoted"')).toBeNull();
    expect(normalizeCategory('   ')).toBeNull();
    expect(normalizeCategory(undefined)).toBeNull();
    expect(normalizeCategory('a'.repeat(41))).toBeNull();
  });

  it('keeps a real multi-word category', () => {
    expect(normalizeCategory('real-estate')).toEqual({ key: 'real-estate', label: 'Real Estate' });
  });

  it('only accepts a filter value that is its own normal form', () => {
    expect(isValidCategoryKey('real-estate')).toBe(true);
    expect(isValidCategoryKey('Real Estate')).toBe(false); // the label, not the key
    expect(isValidCategoryKey('--flag')).toBe(false);
    expect(isValidCategoryKey('other')).toBe(false);
    expect(isValidCategoryKey('../etc')).toBe(false);
  });
});

describe('rankFacets', () => {
  const counts = new Map([
    ['a', 10],
    ['b', 5],
    ['c', 1],
  ]);

  it('orders by count and caps the list', () => {
    expect(rankFacets(counts, [], (id) => id, 2).map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('keeps a ticked value that fell out of the top N', () => {
    // Without this a filter that is still applied has no checkbox to clear it.
    const out = rankFacets(counts, ['c'], (id) => id, 2);
    expect(out.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(out.find((f) => f.id === 'c')?.count).toBe(1);
  });

  it('shows a ticked value the current query cannot reach at all, as zero', () => {
    const out = rankFacets(counts, ['zzz'], (id) => id, 12);
    expect(out.find((f) => f.id === 'zzz')).toEqual({ id: 'zzz', label: 'zzz', count: 0 });
  });
});

describe('fixedFacets', () => {
  it('lists a fixed vocabulary in its own order, not by count', () => {
    const counts = new Map([
      ['community', 900],
      ['official', 2],
    ]);
    expect(fixedFacets(TRUST_BUCKETS, counts, [], (id) => id).map((f) => f.id)).toEqual([
      'official',
      'community',
    ]);
  });

  it('hides an empty bucket, unless it is ticked', () => {
    const counts = new Map([['safe', 3]]);
    expect(fixedFacets(SAFETY_BUCKETS, counts, [], (id) => id).map((f) => f.id)).toEqual(['safe']);
    expect(
      fixedFacets(SAFETY_BUCKETS, counts, ['dangerous'], (id) => id).map((f) => f.id),
    ).toEqual(['safe', 'dangerous']);
  });
});

describe('facetInstalled', () => {
  const rows = [
    { category: 'devops', trust: 'builtin', source: 'builtin' },
    { category: 'devops', trust: 'community', source: 'clawhub', scanVerdict: 'safe' },
    { category: 'email', trust: 'community', source: 'clawhub', scanVerdict: 'dangerous' },
    { category: 'email', trust: 'trusted', source: 'skills.sh', scanVerdict: 'caution' },
    { category: 'other', trust: undefined, source: 'local' },
  ];

  it('returns everything when nothing is ticked', () => {
    const out = facetInstalled(rows, EMPTY_INSTALLED_SELECTION);
    expect(out.rows).toHaveLength(5);
    expect(out.counts.trust.get('official')).toBe(1);
    expect(out.counts.trust.get('community')).toBe(2);
    expect(out.counts.safety.get('unscanned')).toBe(2);
  });

  it('drops a junk category from the buckets but not the row from the list', () => {
    const out = facetInstalled(rows, EMPTY_INSTALLED_SELECTION);
    expect(out.counts.category.has('other')).toBe(false);
    expect(out.categoryCoverage).toBe(4);
    expect(out.rows).toHaveLength(5);
  });

  it('filters on one group', () => {
    const out = facetInstalled(rows, { ...EMPTY_INSTALLED_SELECTION, trust: ['community'] });
    expect(out.rows).toHaveLength(2);
  });

  it('multi-select inside a group is OR', () => {
    const out = facetInstalled(rows, {
      ...EMPTY_INSTALLED_SELECTION,
      trust: ['community', 'trusted'],
    });
    expect(out.rows).toHaveLength(3);
  });

  it('across groups is AND', () => {
    const out = facetInstalled(rows, {
      ...EMPTY_INSTALLED_SELECTION,
      trust: ['community'],
      category: ['email'],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].scanVerdict).toBe('dangerous');
  });

  it('counts a group WITHOUT its own filter, so its siblings never read zero', () => {
    const out = facetInstalled(rows, { ...EMPTY_INSTALLED_SELECTION, trust: ['community'] });
    // Ticking Community must not make the other trust buckets look empty …
    expect(out.counts.trust.get('official')).toBe(1);
    expect(out.counts.trust.get('trusted')).toBe(1);
    // … while the OTHER groups do narrow to what Community can reach.
    expect(out.counts.category.get('devops')).toBe(1);
    expect(out.counts.source.get('builtin')).toBeUndefined();
  });
});
