import { describe, expect, it } from 'vitest';
import { buildCatalogState, parseBrowseTable, queryCatalog } from '@/lib/hermes-skill-index';

// Rows are shaped exactly like ~/.hermes/skills/.hub/index-cache/hermes-index.json
// on a real device (7 sources, ~90 600 rows).
const INDEX = {
  version: 1,
  generated_at: '2026-07-20T18:55:15Z',
  skills: [
    {
      name: '1password',
      description: 'Set up and use 1Password CLI (op).',
      source: 'official',
      identifier: 'official/security/1password',
      trust_level: 'builtin',
      repo: 'NousResearch/hermes-agent',
      path: 'optional-skills/security/1password',
      tags: ['security', 'secrets'],
      extra: {},
    },
    {
      name: '100m-leads',
      description: 'Indexed by skills.sh from getagentseal/founder-playbook',
      source: 'skills.sh',
      identifier: 'skills-sh/getagentseal/founder-playbook/100m-leads',
      trust_level: 'community',
      repo: 'getagentseal/founder-playbook',
      tags: [],
      extra: {
        detail_url: 'https://skills.sh/getagentseal/founder-playbook/100m-leads',
        repo_url: 'https://github.com/getagentseal/founder-playbook',
      },
    },
    {
      name: 'accelerated-computing-cudf',
      description: 'NVIDIA cuDF GPU DataFrames.',
      source: 'github',
      identifier: 'NVIDIA/skills/skills/accelerated-computing-cudf',
      trust_level: 'trusted',
      tags: [],
      extra: { provider: 'NVIDIA', category: 'Data Science' },
    },
    {
      name: 'account-management',
      description: 'Plug&Pay customer portal.',
      source: 'browse-sh',
      identifier: 'browse-sh/plugandpay.com/account-management-ic4kjh',
      trust_level: 'community',
      tags: ['account-management'],
      extra: { hostname: 'plugandpay.com', install_count: 7, source_url: 'https://example.com/x' },
    },
    // Mangled clawhub row: the "name" is the whole description with a trailing
    // `metadata:` — unusable and un-installable, must never reach the grid.
    {
      name: '"a very long broken name that the registry mangled ".repeat plus metadata:',
      description: 'broken',
      source: 'clawhub',
      identifier: 'broken-one',
      trust_level: 'community',
      tags: [],
      extra: {},
    },
    // Duplicate identifier from a lower-trust registry — the trusted copy wins.
    {
      name: 'dupe',
      description: 'community copy',
      source: 'clawhub',
      identifier: 'dupe-id',
      trust_level: 'community',
      tags: [],
      extra: {},
    },
    {
      name: 'dupe',
      description: 'trusted copy',
      source: 'github',
      identifier: 'dupe-id',
      trust_level: 'trusted',
      tags: [],
      extra: { provider: 'Acme' },
    },
  ],
};

describe('buildCatalogState', () => {
  const state = buildCatalogState(INDEX);

  it('drops mangled registry rows', () => {
    expect(state.byId.has('broken-one')).toBe(false);
  });

  it('keeps the higher-trust copy of a duplicated identifier', () => {
    expect(state.byId.get('dupe-id')?.description).toBe('trusted copy');
  });

  it('suppresses the skills.sh placeholder description and keeps provenance', () => {
    const rec = state.byId.get('skills-sh/getagentseal/founder-playbook/100m-leads');
    expect(rec?.description).toBeUndefined();
    expect(rec?.provenanceNote).toBe('from getagentseal/founder-playbook');
  });

  it('only keeps https URLs', () => {
    expect(state.byId.get('browse-sh/plugandpay.com/account-management-ic4kjh')?.sourceUrl).toBe(
      'https://example.com/x',
    );
  });

  it('counts sources and github providers', () => {
    expect(state.sourceCounts.get('official')).toBe(1);
    expect(state.providerCounts.get('NVIDIA')).toBe(1);
  });

  it('remembers the on-disk path of official skills only', () => {
    expect(state.byId.get('official/security/1password')?.localPath).toBe(
      'optional-skills/security/1password',
    );
    expect(state.byId.get('NVIDIA/skills/skills/accelerated-computing-cudf')?.localPath).toBeUndefined();
  });
});

describe('registry mangling', () => {
  const state = buildCatalogState({
    skills: [
      // Quote chars that were never YAML-unquoted upstream.
      { name: '"Dictionary"', identifier: 'english-dictionary', source: 'clawhub', trust_level: 'community', tags: ['"dictionary', 'reference"'] },
      // Real punctuation must survive.
      { name: '"What if?" Scenario Builder', identifier: 'what-if', source: 'clawhub', trust_level: 'community', tags: [] },
      // Identifiers the install validator rejects can be neither opened nor
      // installed — they must never reach the grid.
      { name: 'tdd', identifier: 'skills-sh/obra/superpowers-skills/test-driven-development-(tdd)', source: 'skills.sh', trust_level: 'community', tags: [] },
      { name: 'document-skills', identifier: 'anthropics/skills/', source: 'claude-marketplace', trust_level: 'trusted', tags: [] },
      // Hermes truncates at exactly 200 chars and leaves no marker.
      { name: 'cut', identifier: 'clawhub/cut', source: 'clawhub', trust_level: 'community', description: 'x'.repeat(200), tags: [] },
    ],
  });

  it('strips quote characters the registry left in names and tags', () => {
    const rec = state.byId.get('english-dictionary');
    expect(rec?.name).toBe('Dictionary');
    expect(rec?.tags).toEqual(['dictionary', 'reference']);
  });

  it('keeps quotes that are the author’s own punctuation', () => {
    expect(state.byId.get('what-if')?.name).toBe('"What if?" Scenario Builder');
  });

  it('drops rows whose identifier could never be installed', () => {
    expect(state.byId.has('skills-sh/obra/superpowers-skills/test-driven-development-(tdd)')).toBe(false);
    expect(state.byId.has('anthropics/skills/')).toBe(false);
  });

  it('marks a description the registry cut at its 200-char ceiling', () => {
    expect(state.byId.get('clawhub/cut')?.description?.endsWith('…')).toBe(true);
  });
});

describe('official overlay (the agent checkout wins)', () => {
  const disk = [
    {
      id: 'official/security/1password',
      path: 'optional-skills/security/1password',
      name: '1password',
      category: 'security',
      description: 'The real, untruncated sentence from SKILL.md.',
      tags: ['security'],
    },
    {
      id: 'official/finance/polymarket',
      path: 'optional-skills/finance/polymarket',
      name: 'polymarket',
      category: 'finance',
      description: 'Ships on the device but postdates the index.',
      tags: [],
    },
  ];
  const state = buildCatalogState(
    {
      skills: [
        ...INDEX.skills,
        // An index row pointing at a directory this device does not have.
        {
          name: 'cli',
          description: 'gone',
          source: 'official',
          identifier: 'official/devops/cli',
          trust_level: 'builtin',
          path: 'optional-skills/devops/cli',
          tags: [],
        },
      ],
    },
    disk,
  );

  it('prefers the on-disk description over the index copy', () => {
    expect(state.byId.get('official/security/1password')?.description).toBe(
      'The real, untruncated sentence from SKILL.md.',
    );
  });

  it('adds official skills the index has not caught up with', () => {
    const rec = state.byId.get('official/finance/polymarket');
    expect(rec?.source).toBe('official');
    expect(rec?.trust).toBe('builtin');
    expect(rec?.localPath).toBe('optional-skills/finance/polymarket');
  });

  it('drops official rows whose directory is not on this device', () => {
    expect(state.byId.has('official/devops/cli')).toBe(false);
  });

  it('leaves the index alone when there is no agent checkout', () => {
    expect(buildCatalogState(INDEX).byId.has('official/security/1password')).toBe(true);
  });
});

describe('queryCatalog', () => {
  const state = buildCatalogState(INDEX);

  it('matches the `skills-sh` flag spelling against the index `skills.sh`', () => {
    const page = queryCatalog(state, { sources: ['skills-sh'], sort: 'trust', page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.skills[0].id).toBe('skills-sh/getagentseal/founder-playbook/100m-leads');
  });

  it('ranks an exact name hit first', () => {
    const page = queryCatalog(state, { q: '1password', sort: 'relevance', page: 1, pageSize: 10 });
    expect(page.skills[0].name).toBe('1password');
  });

  it('finds skills by tag and by identifier', () => {
    expect(queryCatalog(state, { q: 'secrets', sort: 'relevance', page: 1, pageSize: 10 }).total).toBe(1);
    expect(queryCatalog(state, { q: 'plugandpay', sort: 'relevance', page: 1, pageSize: 10 }).total).toBe(1);
  });

  it('paginates', () => {
    const first = queryCatalog(state, { sort: 'name', page: 1, pageSize: 2 });
    const second = queryCatalog(state, { sort: 'name', page: 2, pageSize: 2 });
    expect(first.skills).toHaveLength(2);
    expect(second.skills[0].id).not.toBe(first.skills[0].id);
    expect(first.total).toBe(second.total);
  });

  it('filters github by provider', () => {
    const page = queryCatalog(state, {
      sources: ['github'],
      providers: ['nvidia'],
      sort: 'trust',
      page: 1,
      pageSize: 10,
    });
    expect(page.total).toBe(1);
    expect(page.skills[0].provider).toBe('NVIDIA');
  });
});

describe('parseBrowseTable (CLI fallback)', () => {
  it('joins wrapped identifier rows and repairs a truncated name', () => {
    const out = [
      '│ # │ Name         │ Description │ Source  │ Trust       │ Identifier            │',
      '│ 1 │ 3-statement… │ Builds a…   │ official│ ★ builtin   │ official/finance/3-st │',
      '│   │              │ model       │         │             │ atement-model         │',
    ].join('\n');
    const skills = parseBrowseTable(out);
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('official/finance/3-statement-model');
    expect(skills[0].name).toBe('3-statement-model');
    expect(skills[0].trust).toBe('builtin');
    expect(skills[0].description).toBe('Builds a… model');
  });
});

/**
 * The facet rail's server half. The counting rule is the interesting part:
 * every group is counted with the OTHER groups' filters applied and its own
 * ignored, so a count says how many skills ticking that box would reach.
 */
describe('queryCatalog facets', () => {
  const FACET_INDEX = {
    version: 1,
    generated_at: '2026-08-01T00:00:00Z',
    skills: [
      { name: 'a', identifier: 'official/a', source: 'official', trust_level: 'builtin', tags: [], extra: { category: 'Developer Tools' } },
      { name: 'b', identifier: 'github/b', source: 'github', trust_level: 'trusted', tags: [], extra: { provider: 'NVIDIA', category: 'developer-tools' } },
      { name: 'c', identifier: 'clawhub/c', source: 'clawhub', trust_level: 'community', tags: [], extra: {} },
      { name: 'd', identifier: 'clawhub/d', source: 'clawhub', trust_level: 'community', tags: [], extra: { category: 'finance' } },
      { name: 'e', identifier: 'skills-sh/e', source: 'skills.sh', trust_level: 'community', tags: [], extra: { category: 'other' } },
    ],
  };
  const state = buildCatalogState(FACET_INDEX);
  const base = { sort: 'name' as const, page: 1, pageSize: 24 };
  const facet = (list: { id: string; count: number }[], id: string) =>
    list.find((f) => f.id === id)?.count;

  it('counts trust buckets, with builtin folded into official', () => {
    const page = queryCatalog(state, base);
    expect(facet(page.trust, 'official')).toBe(1);
    expect(facet(page.trust, 'trusted')).toBe(1);
    expect(facet(page.trust, 'community')).toBe(3);
  });

  it('collapses the two spellings of one category into one bucket', () => {
    const page = queryCatalog(state, base);
    expect(facet(page.categories, 'developer-tools')).toBe(2);
  });

  it('never offers a junk category as a filter', () => {
    const page = queryCatalog(state, base);
    expect(page.categories.some((f) => f.id === 'other')).toBe(false);
  });

  it('reports how much of the result set a category can even speak for', () => {
    // 3 of the 5 rows declare a usable category; the `other` row does not count.
    expect(queryCatalog(state, base).categoryCoverage).toBe(3);
  });

  it('emits source ids in the flag spelling the client sends back', () => {
    expect(facet(queryCatalog(state, base).sources, 'skills-sh')).toBe(1);
    expect(queryCatalog(state, base).sources.some((f) => f.id === 'skills.sh')).toBe(false);
  });

  it('multi-select inside a group is OR', () => {
    expect(queryCatalog(state, { ...base, sources: ['official'] }).total).toBe(1);
    expect(queryCatalog(state, { ...base, sources: ['official', 'clawhub'] }).total).toBe(3);
  });

  it('across groups is AND', () => {
    const page = queryCatalog(state, { ...base, sources: ['clawhub'], categories: ['finance'] });
    expect(page.total).toBe(1);
    expect(page.skills[0].id).toBe('clawhub/d');
  });

  it('counts a group without its own filter, so its siblings never read zero', () => {
    const page = queryCatalog(state, { ...base, trust: ['community'] });
    expect(page.total).toBe(3);
    // Ticking Community leaves the other trust counts standing …
    expect(facet(page.trust, 'official')).toBe(1);
    expect(facet(page.trust, 'trusted')).toBe(1);
    // … while Source narrows to what Community can reach.
    expect(facet(page.sources, 'official')).toBeUndefined();
    expect(facet(page.sources, 'clawhub')).toBe(2);
  });

  it('keeps a ticked value in the list even when nothing matches it', () => {
    // No `official` row is filed under finance, so this pair reaches nothing.
    const page = queryCatalog(state, { ...base, sources: ['official'], categories: ['finance'] });
    expect(page.total).toBe(0);
    // Both boxes stay in the rail so the dead end can be undone — and both say
    // zero rather than showing a count from before the other group narrowed.
    expect(facet(page.categories, 'finance')).toBe(0);
    expect(facet(page.sources, 'official')).toBe(0);
  });

  it('matches the skills-sh flag spelling against the index skills.sh', () => {
    expect(queryCatalog(state, { ...base, sources: ['skills-sh'] }).total).toBe(1);
  });

  it('a text query narrows the counts too', () => {
    const page = queryCatalog(state, { ...base, q: 'd', sort: 'relevance' });
    expect(page.total).toBe(1);
    expect(facet(page.trust, 'community')).toBe(1);
    expect(facet(page.trust, 'official')).toBeUndefined();
  });
});
