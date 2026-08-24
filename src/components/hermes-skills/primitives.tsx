'use client';

import type { ReactNode } from 'react';
import { sourceLabel, trustMeta } from '@/lib/hermes-skills';
import { useCopy } from './copy';

// Shared visual atoms for the Hermes Skills store. Same vocabulary as the
// OpenClaw AppStore (rounded-2xl cards, material-symbols icons, chip rows) but
// painted with the ClawBox theme variables so the two stores read as one product.

/** One focus ring for every interactive element in the store. */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--coral-bright)] ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-deep)]';

const TONE_CLASS: Record<string, string> = {
  brand: 'bg-[var(--coral-bright)]/15 text-[var(--coral-bright)]',
  good: 'bg-emerald-400/10 text-emerald-400',
  warn: 'bg-amber-400/10 text-amber-300',
  muted: 'bg-[var(--surface-card)] text-[var(--text-secondary)]',
};

export function TrustChip({ trust, provider }: { trust?: string; provider?: string }) {
  const meta = trustMeta(trust);
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${TONE_CLASS[meta.tone]}`}
      title={meta.help}
    >
      <span className="material-symbols-rounded shrink-0" style={{ fontSize: 12 }} aria-hidden="true">
        {meta.icon}
      </span>
      <span className="truncate max-w-[10rem]">{provider ? `${meta.label} · ${provider}` : meta.label}</span>
    </span>
  );
}

export function MetaChip({
  icon,
  text,
  title,
  tone = 'muted',
}: {
  icon: string;
  text: string;
  title?: string;
  tone?: keyof typeof TONE_CLASS;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] max-w-full ${TONE_CLASS[tone]}`}
      title={title}
    >
      <span className="material-symbols-rounded shrink-0" style={{ fontSize: 12 }} aria-hidden="true">
        {icon}
      </span>
      <span className="truncate">{text}</span>
    </span>
  );
}

export function SourceChip({ source }: { source?: string }) {
  if (!source) return null;
  return <MetaChip icon="hub" text={sourceLabel(source)} />;
}

export function ScanChip({ verdict, findings }: { verdict?: string; findings?: number }) {
  const COPY = useCopy();
  if (!verdict) return null;
  const clean = verdict.toLowerCase() === 'safe' && !findings;
  return (
    <MetaChip
      icon={clean ? 'shield' : 'gpp_maybe'}
      tone={clean ? 'good' : 'warn'}
      text={clean ? COPY.scanPassed : COPY.scanFlagged(findings || 0)}
    />
  );
}

export function TagPill({ tag }: { tag: string }) {
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] bg-[var(--surface-card)] text-[var(--text-secondary)] max-w-full truncate">
      #{tag}
    </span>
  );
}

// Category/tag → material symbol. Skills have no icons of their own, so the
// tile is derived from what the skill IS; the letter is the last resort.
const TILE_ICONS: [RegExp, string][] = [
  [/secur|password|secret|auth|vault/i, 'shield'],
  [/dev|code|git|program|software|engineer/i, 'code'],
  [/data|analytic|sql|database|ml|ai|model/i, 'database'],
  [/finance|payment|invoice|account|billing/i, 'payments'],
  [/write|note|doc|content|blog|markdown/i, 'edit_note'],
  [/research|search|browse|web|scrap/i, 'travel_explore'],
  [/media|image|video|audio|music|design|creative/i, 'palette'],
  [/mail|email|message|chat|social|communi/i, 'forum'],
  [/home|device|iot|smart/i, 'home_iot_device'],
  [/product|task|calendar|todo|schedul/i, 'checklist'],
  [/agent|automation|workflow|bot/i, 'smart_toy'],
];

function tileIcon(seed: string): string | null {
  for (const [re, icon] of TILE_ICONS) {
    if (re.test(seed)) return icon;
  }
  return null;
}

export function SkillTile({
  name,
  category,
  tags,
  large,
}: {
  name: string;
  category?: string;
  tags?: string[];
  large?: boolean;
}) {
  const seed = [category, ...(tags || []), name].filter(Boolean).join(' ');
  const icon = tileIcon(seed);
  // Deterministic hue from the category/name so a skill always looks the same.
  const hueSeed = category || name || '?';
  let h = 0;
  for (let i = 0; i < hueSeed.length; i++) h = (h * 31 + hueSeed.charCodeAt(i)) % 360;
  return (
    <div
      className={`shrink-0 flex items-center justify-center text-white font-semibold ${
        large ? 'w-14 h-14 rounded-2xl text-2xl' : 'w-11 h-11 rounded-xl text-lg'
      }`}
      style={{ backgroundColor: `hsl(${h} 45% 32%)` }}
      aria-hidden="true"
    >
      {icon ? (
        <span className="material-symbols-rounded" style={{ fontSize: large ? 28 : 22 }}>
          {icon}
        </span>
      ) : (
        (name[0] || '?').toUpperCase()
      )}
    </div>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Alert({
  tone,
  icon,
  children,
}: {
  tone: 'warn' | 'danger' | 'info';
  icon: string;
  children: ReactNode;
}) {
  const cls =
    tone === 'danger'
      ? 'bg-red-500/10 border-red-500/25 text-red-200'
      : tone === 'warn'
        ? 'bg-amber-500/10 border-amber-500/25 text-amber-100'
        : 'bg-[var(--surface-card)] border-[var(--border-subtle)] text-[var(--text-secondary)]';
  return (
    <div className={`rounded-xl border p-3 mb-4 flex gap-2 text-sm ${cls}`}>
      <span className="material-symbols-rounded shrink-0" style={{ fontSize: 18 }} aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** External link — https-only hrefs are guaranteed by the routes. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-sm text-[var(--coral-bright)] hover:underline rounded ${FOCUS_RING}`}
    >
      <span className="material-symbols-rounded shrink-0" style={{ fontSize: 15 }} aria-hidden="true">
        open_in_new
      </span>
      <span className="truncate">{children}</span>
    </a>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
  tone = 'muted',
}: {
  icon: string;
  title: string;
  hint?: string;
  action?: ReactNode;
  tone?: 'muted' | 'danger';
}) {
  return (
    <div className="flex flex-col items-center text-center py-12 gap-2 text-[var(--text-secondary)]">
      <span
        className={`material-symbols-rounded ${tone === 'danger' ? 'text-red-400' : ''}`}
        style={{ fontSize: 40 }}
        aria-hidden="true"
      >
        {icon}
      </span>
      <p className={`text-sm font-medium ${tone === 'danger' ? 'text-red-400' : 'text-[var(--text-primary)]'}`}>
        {title}
      </p>
      {hint && <p className="text-xs max-w-sm">{hint}</p>}
      {action}
    </div>
  );
}

export function PrimaryButton({
  children,
  onClick,
  size = 'sm',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  size?: 'sm' | 'lg';
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      className={`rounded-md font-semibold bg-[var(--coral-bright)] text-white hover:opacity-90 transition-opacity ${FOCUS_RING} ${
        size === 'lg' ? 'px-6 py-2 text-sm' : 'px-4 py-1.5 text-xs'
      }`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  tone = 'neutral',
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'neutral' | 'danger';
  disabled?: boolean;
}) {
  const cls =
    tone === 'danger'
      ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
      : 'bg-[var(--surface-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${cls} ${FOCUS_RING}`}
    >
      {children}
    </button>
  );
}
