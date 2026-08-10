import { describe, expect, it } from 'vitest';
import { extractHeadings, parseSkillFrontmatter } from '@/lib/hermes-skill-frontmatter';

// The shapes below are copied verbatim from SKILL.md files on a real Hermes
// device — the parser exists to read exactly these, so the fixtures must stay
// literal rather than idealised YAML.

describe('parseSkillFrontmatter', () => {
  it('reads a full official skill (flow lists, nested metadata, setup secrets)', () => {
    const md = [
      '---',
      'name: 1password',
      'description: Set up op CLI, sign in, and read or inject secrets.',
      'version: 1.0.0',
      'author: arceus77-7, enhanced by Hermes Agent',
      'license: MIT',
      'platforms: [linux, macos, windows]',
      'metadata:',
      '  hermes:',
      '    tags: [security, secrets, 1password, op, cli]',
      '    category: security',
      '    related_skills: [vault, envchain]',
      'prerequisites:',
      '  commands: [memo]',
      '  env_vars: [OP_TOKEN]',
      'setup:',
      '  help: "Create a service account at https://my.1password.com → Settings"',
      '  collect_secrets:',
      '    - env_var: OP_SERVICE_ACCOUNT_TOKEN',
      '      prompt: "1Password Service Account Token"',
      '      provider_url: "https://developer.1password.com/docs/service-accounts/"',
      '      secret: true',
      '---',
      '',
      '# 1Password CLI',
      '',
      '## Requirements',
      '',
      '- 1Password account',
    ].join('\n');

    const fm = parseSkillFrontmatter(md);
    expect(fm.name).toBe('1password');
    expect(fm.version).toBe('1.0.0');
    expect(fm.author).toBe('arceus77-7, enhanced by Hermes Agent');
    expect(fm.license).toBe('MIT');
    expect(fm.platforms).toEqual(['linux', 'macos', 'windows']);
    expect(fm.tags).toEqual(['security', 'secrets', '1password', 'op', 'cli']);
    expect(fm.category).toBe('security');
    expect(fm.relatedSkills).toEqual(['vault', 'envchain']);
    expect(fm.prerequisiteCommands).toEqual(['memo']);
    expect(fm.prerequisiteEnvVars).toEqual(['OP_TOKEN']);
    expect(fm.setup?.secrets).toEqual([
      {
        label: '1Password Service Account Token',
        envVar: 'OP_SERVICE_ACCOUNT_TOKEN',
        providerUrl: 'https://developer.1password.com/docs/service-accounts/',
        secret: true,
      },
    ]);
    expect(fm.setup?.helpUrl).toBe('https://my.1password.com');
    expect(fm.body.startsWith('# 1Password CLI')).toBe(true);
  });

  it('reads block sequences and credential file maps', () => {
    const md = [
      '---',
      'name: google-workspace',
      'required_credential_files:',
      '  - path: google_token.json',
      '    description: Google OAuth2 token (created by setup script)',
      '  - path: google_client_secret.json',
      '    description: Google OAuth2 client credentials',
      'metadata:',
      '  hermes:',
      '    tags:',
      '      - Google',
      '      - Gmail',
      '    homepage: https://github.com/NousResearch/hermes-agent',
      '---',
      'body text',
    ].join('\n');

    const fm = parseSkillFrontmatter(md);
    expect(fm.credentialFiles).toEqual([
      { path: 'google_token.json', description: 'Google OAuth2 token (created by setup script)' },
      { path: 'google_client_secret.json', description: 'Google OAuth2 client credentials' },
    ]);
    expect(fm.tags).toEqual(['Google', 'Gmail']);
    expect(fm.homepage).toBe('https://github.com/NousResearch/hermes-agent');
    expect(fm.body).toBe('body text');
  });

  it('falls back to metadata-nested scalars (skills.sh shape)', () => {
    const md = ['---', 'name: thing', 'metadata:', '  author: someone', '  version: 2.1.0', '---', 'x'].join('\n');
    const fm = parseSkillFrontmatter(md);
    expect(fm.author).toBe('someone');
    expect(fm.version).toBe('2.1.0');
  });

  it('rejects a non-https homepage rather than linking it', () => {
    const md = ['---', 'metadata:', '  hermes:', '    homepage: javascript:alert(1)', '---', ''].join('\n');
    expect(parseSkillFrontmatter(md).homepage).toBeUndefined();
  });

  it('degrades to a body when there is no frontmatter', () => {
    const fm = parseSkillFrontmatter('# just markdown');
    expect(fm.hasFrontmatter).toBe(false);
    expect(fm.body).toBe('# just markdown');
    expect(fm.platforms).toEqual([]);
  });

  it('handles dependencies with version pins and quoted commands', () => {
    const md = [
      '---',
      'dependencies: [llama-cpp-python>=0.2.0]',
      'prerequisites:',
      '  commands: ["python3"]',
      'compatibility: "Requires ComfyUI (local or Cloud)."',
      '---',
      '',
    ].join('\n');
    const fm = parseSkillFrontmatter(md);
    expect(fm.dependencies).toEqual(['llama-cpp-python>=0.2.0']);
    expect(fm.prerequisiteCommands).toEqual(['python3']);
    expect(fm.compatibility).toBe('Requires ComfyUI (local or Cloud).');
  });
});

describe('multi-value scalars', () => {
  it('joins a flow-sequence author instead of dropping the field', () => {
    // Ships on the device: creative/comfyui/SKILL.md.
    const md = ['---', 'name: comfyui', 'author: [kshitijk4poor, alt-glitch, purzbeats]', '---', 'body'].join(
      '\n',
    );
    expect(parseSkillFrontmatter(md).author).toBe('kshitijk4poor, alt-glitch, purzbeats');
  });

  it('still prefers a plain scalar', () => {
    const md = ['---', 'name: x', 'author: Nous Research', '---', 'body'].join('\n');
    expect(parseSkillFrontmatter(md).author).toBe('Nous Research');
  });
});

describe('extractHeadings', () => {
  it('collects h2/h3 and skips fenced code', () => {
    const body = [
      '# Title',
      '## Requirements',
      '```bash',
      '## not a heading',
      '```',
      '### Service Account',
      '## Requirements',
    ].join('\n');
    expect(extractHeadings(body)).toEqual([
      { level: 2, text: 'Requirements', slug: 'requirements' },
      { level: 3, text: 'Service Account', slug: 'service-account' },
    ]);
  });
});
