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
    const page = queryCatalog(state, { source: 'skills-sh', sort: 'trust', page: 1, pageSize: 10 });
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
    const page = queryCatalog(state, { source: 'github', provider: 'nvidia', sort: 'trust', page: 1, pageSize: 10 });
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
