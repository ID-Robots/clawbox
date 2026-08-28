import { describe, expect, it } from 'vitest';
import { sourceUrlParts } from '@/lib/hermes-skills';

/**
 * The store's "Source" link has to identify the SKILL, not the collection.
 *
 * On-device the catalog holds 440 DISTINCT browse.sh source_urls, one per
 * skill — the href was always right. What was wrong was the rendering: the raw
 * URL was painted under a CSS `truncate` (end-clipped ellipsis), and every
 * browse.sh URL shares the same ~48-char prefix
 *   github.com/browserbase/browse.sh/blob/main/skills/…
 * before the segment that tells one skill from the next. The clip ate exactly
 * that segment, so every skill's Source read the same
 * `github.com/browserbase/browse.sh/blob/main/skill…` — the collection, as far
 * as a reviewer could tell.
 *
 * `sourceUrlParts` fixes it by splitting off an identifying `tail` the UI pins
 * (never clips): the shared prefix takes the ellipsis, the per-skill segment
 * stays on screen. These tests pin the contract the rendering leans on.
 */
describe('sourceUrlParts — the identifying tail of a skill source URL', () => {
  const SEATGURU =
    'https://github.com/browserbase/browse.sh/blob/main/skills/seatguru.com/get-seat-map-dog7jd/SKILL.md';
  const KINGSOOPERS =
    'https://github.com/browserbase/browse.sh/blob/main/skills/kingsoopers.com/add-items-to-cart-ljctdp/SKILL.md';

  it('keeps the per-skill directory when the file is a generic SKILL.md', () => {
    const { tail } = sourceUrlParts(SEATGURU);
    // The last segment (SKILL.md) names nothing on its own, so the parent —
    // the unique slug — is what has to survive.
    expect(tail).toBe('get-seat-map-dog7jd/SKILL.md');
  });

  it('gives two browse.sh skills DIFFERENT tails (the whole point)', () => {
    const a = sourceUrlParts(SEATGURU).tail;
    const b = sourceUrlParts(KINGSOOPERS).tail;
    expect(a).not.toBe(b);
    expect(a).toContain('get-seat-map-dog7jd');
    expect(b).toContain('add-items-to-cart-ljctdp');
  });

  it('reproduces the collision the fix removes: the shared prefix is uninformative', () => {
    // What the old rendering showed once the ellipsis had clipped the tail:
    // the first ~48 visible chars of the scheme-stripped URL. Identical for
    // every browse.sh skill — that was the bug.
    const clip = (u: string) => u.replace(/^https:\/\//, '').slice(0, 48);
    expect(clip(SEATGURU)).toBe(clip(KINGSOOPERS));
    // The pinned tail, by contrast, is where the skills diverge.
    expect(sourceUrlParts(SEATGURU).tail).not.toBe(sourceUrlParts(KINGSOOPERS).tail);
  });

  it('head + tail reconstruct the scheme-stripped URL exactly', () => {
    const { head, tail } = sourceUrlParts(SEATGURU);
    expect(head + tail).toBe(SEATGURU.replace(/^https:\/\//, ''));
  });

  it('leaves a short, already-distinct URL whole (nothing to elide)', () => {
    // A derived github repo URL identifies itself; no shared boilerplate.
    const { head, tail } = sourceUrlParts('https://github.com/NousResearch/hermes-agent');
    expect(head).toBe('');
    expect(tail).toBe('github.com/NousResearch/hermes-agent');
  });

  it('returns a bare host untouched', () => {
    const { head, tail } = sourceUrlParts('https://seatguru.com');
    expect(head).toBe('');
    expect(tail).toBe('seatguru.com');
  });

  it('leaves a shallow host/a/b path whole (nothing shared to elide)', () => {
    const { head, tail } = sourceUrlParts('https://clawhub.example/skills/qrcode-decode');
    expect(head).toBe('');
    expect(tail).toBe('clawhub.example/skills/qrcode-decode');
  });

  it('keeps a non-generic final segment as the sole tail on a deep path', () => {
    const { head, tail } = sourceUrlParts('https://clawhub.example/registry/skills/qrcode-decode');
    expect(tail).toBe('qrcode-decode');
    expect(head).toBe('clawhub.example/registry/skills/');
    expect(head + tail).toBe('clawhub.example/registry/skills/qrcode-decode');
  });

  it('carries a query string on the tail, not the head', () => {
    const { head, tail } = sourceUrlParts('https://example.com/a/b/skill.md?ref=main');
    expect(tail).toBe('b/skill.md?ref=main');
    expect(head + tail).toBe('example.com/a/b/skill.md?ref=main');
  });

  it('preserves a trailing slash on a deep path (head + tail stays exact)', () => {
    // Regression: reconstructing head by re-joining Boolean-filtered segments
    // dropped the trailing "/". The offset split keeps it on the tail.
    const { head, tail } = sourceUrlParts('https://example.com/a/b/c/');
    expect(tail).toBe('c/');
    expect(head + tail).toBe('example.com/a/b/c/');
  });

  it('preserves a trailing slash that precedes a query', () => {
    const { head, tail } = sourceUrlParts('https://example.com/a/b/c/?x=1');
    expect(tail).toBe('c/?x=1');
    expect(head + tail).toBe('example.com/a/b/c/?x=1');
  });
});
