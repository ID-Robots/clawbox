import type { Metadata } from "next";
import Image from "next/image";
import {
  FREE_PLAN_FEATURES,
  MAX_PLAN_BONUSES,
  MAX_PLAN_FEATURES,
  PORTAL_LOGIN_URL,
  PRO_PLAN_FEATURES,
  PURCHASE_EMAIL_NOTE,
} from "@/lib/max-subscription";
import { getSiteUrl } from "@/lib/site-url";

const siteUrl = getSiteUrl();

export const metadata: Metadata = {
  title: "ClawBox AI Plans",
  description:
    "Compare ClawBox AI Free, Pro, and Max plans and claim the ClawBox owner Max bonus with the email tied to your device purchase.",
  alternates: {
    canonical: "/portal/subscribe",
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: "ClawBox AI Plans",
    description:
      "Compare ClawBox AI Free, Pro, and Max plans and claim the ClawBox owner Max bonus.",
    url: `${siteUrl}/portal/subscribe`,
    type: "website",
    images: [
      {
        url: "/clawbox-box.png",
        width: 1200,
        height: 630,
        alt: "ClawBox AI subscription plans",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ClawBox AI Plans",
    description:
      "Compare ClawBox AI Free, Pro, and Max plans and claim the ClawBox owner Max bonus.",
    images: ["/clawbox-box.png"],
  },
};

const plans = [
  {
    id: "free",
    name: "Free",
    price: "EUR 0",
    cadence: "/month",
    badge: "Start here",
    summary: "A simple way to get ClawBox AI running right away.",
    features: FREE_PLAN_FEATURES,
    buttonLabel: "Start with Free",
    cardClassName: "border-white/10 bg-[linear-gradient(180deg,rgba(17,24,39,0.94),rgba(17,24,39,0.84))]",
    priceClassName: "text-white/85",
    iconClassName: "bg-white/10 text-white/80",
    buttonClassName: "border border-white/10 bg-white/5 text-white hover:bg-white/10",
  },
  {
    id: "pro",
    name: "Pro",
    price: "EUR 9",
    cadence: "/month",
    badge: "Popular",
    summary: "More usage and faster processing for everyday ClawBox work.",
    features: PRO_PLAN_FEATURES,
    buttonLabel: "See Pro in portal",
    cardClassName: "border-orange-500/25 bg-[linear-gradient(180deg,rgba(249,115,22,0.12),rgba(17,24,39,0.9))]",
    priceClassName: "text-orange-300",
    iconClassName: "bg-orange-500/20 text-orange-200",
    buttonClassName: "border border-orange-400/30 bg-orange-500/10 text-orange-100 hover:bg-orange-500/20",
  },
  {
    id: "max",
    name: "Max",
    price: "EUR 49",
    cadence: "/month",
    badge: "Best value",
    summary: "Maximum usage, top priority, and direct support for the full ClawBox experience.",
    features: MAX_PLAN_FEATURES,
    buttonLabel: "Choose Max in portal",
    cardClassName: "border-fuchsia-400/30 bg-[linear-gradient(180deg,rgba(217,70,239,0.18),rgba(17,24,39,0.9))] shadow-[0_24px_80px_rgba(192,38,211,0.14)]",
    priceClassName: "text-fuchsia-200",
    iconClassName: "bg-fuchsia-400/20 text-fuchsia-100",
    buttonClassName: "bg-[linear-gradient(135deg,#a855f7,#ec4899)] text-white hover:opacity-90",
  },
] as const;

const claimSteps = [
  "Sign in to the portal.",
  "Use the same email address as your ClawBox purchase.",
  "Choose Max to unlock the owner bonus.",
] as const;

export default function PortalSubscribePage() {
  return (
    <main className="min-h-screen overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(236,72,153,0.16),transparent_30%),radial-gradient(circle_at_20%_20%,rgba(249,115,22,0.12),transparent_24%),var(--bg-deep)] text-[var(--text-primary)]">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <a
            href="https://openclawhardware.dev/"
            className="flex items-center gap-3 text-[var(--text-primary)] no-underline"
          >
            <Image
              src="/clawbox-icon.png"
              alt="ClawBox"
              width={44}
              height={44}
              className="h-11 w-11 object-contain"
              priority
            />
            <div className="leading-tight">
              <div className="text-xl font-bold font-display title-gradient">ClawBox</div>
              <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-muted)]">
                Portal subscriptions
              </div>
            </div>
          </a>

          <a
            href={PORTAL_LOGIN_URL}
            className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
          >
            Portal login
            <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>login</span>
          </a>
        </header>

        <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_360px]">
          <div className="card-surface rounded-[28px] border-white/10 p-7 sm:p-9">
            <div className="inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-fuchsia-200">
              ClawBox owner bonus
            </div>
            <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-tight text-white sm:text-5xl">
              Upgrade to ClawBox AI Max with the same email you used to buy your ClawBox.
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-relaxed text-[var(--text-secondary)] sm:text-lg">
              ClawBox AI is powered by DeepSeek. Max is the highest tier, giving you the biggest usage pool, top queue priority, and real human support when you need it.
            </p>

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              <div className="rounded-2xl border border-orange-400/20 bg-orange-500/10 p-5">
                <div className="text-sm font-semibold text-orange-100">Included with eligible ClawBox purchases</div>
                <ul className="mt-4 space-y-3">
                  {MAX_PLAN_BONUSES.map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm text-orange-50/95">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-orange-500/20 text-orange-100">
                        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>workspace_premium</span>
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <div className="text-sm font-semibold text-white">Important before you subscribe</div>
                <p className="mt-4 text-sm leading-relaxed text-[var(--text-secondary)]">
                  {PURCHASE_EMAIL_NOTE}
                </p>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href={PORTAL_LOGIN_URL}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#a855f7,#ec4899)] px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90"
              >
                Sign in to subscribe
                <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>arrow_forward</span>
              </a>
              <a
                href="#plans"
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Compare plans
              </a>
            </div>
          </div>

          <aside className="rounded-[28px] border border-white/10 bg-black/20 p-6 backdrop-blur">
            <div className="text-sm font-semibold uppercase tracking-[0.18em] text-fuchsia-200">
              How to claim the bonus
            </div>
            <ol className="mt-5 space-y-4">
              {claimSteps.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-fuchsia-400/15 text-sm font-semibold text-fuchsia-100">
                    {index + 1}
                  </span>
                  <span className="pt-1 text-sm leading-relaxed text-[var(--text-secondary)]">
                    {step}
                  </span>
                </li>
              ))}
            </ol>

            <div className="mt-6 rounded-2xl border border-fuchsia-400/20 bg-fuchsia-400/10 p-5">
              <div className="text-sm font-semibold text-fuchsia-100">Why Max</div>
              <ul className="mt-4 space-y-3">
                {MAX_PLAN_FEATURES.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm text-white/90">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fuchsia-400/20 text-fuchsia-100">
                      <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>rocket_launch</span>
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </section>

        <section id="plans" className="mt-10 pb-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-200">
                Choose your plan
              </div>
              <h2 className="mt-2 text-3xl font-bold text-white">Subscription tiers for every ClawBox setup</h2>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--text-secondary)]">
                Free gets you started, Pro adds more headroom, and Max unlocks the complete subscription experience.
              </p>
            </div>

            <a
              href={PORTAL_LOGIN_URL}
              className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Open portal
              <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>open_in_new</span>
            </a>
          </div>

          <div className="mt-6 grid gap-5 xl:grid-cols-3">
            {plans.map((plan) => (
              <article
                key={plan.id}
                className={`rounded-[28px] border p-6 ${plan.cardClassName}`}
              >
                <div className="inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/85">
                  {plan.badge}
                </div>
                <h3 className="mt-5 text-3xl font-bold text-white">{plan.name}</h3>
                <div className="mt-4 flex items-end gap-2">
                  <span className={`text-5xl font-bold leading-none ${plan.priceClassName}`}>
                    {plan.price}
                  </span>
                  <span className="pb-1 text-sm text-[var(--text-muted)]">{plan.cadence}</span>
                </div>
                <p className="mt-4 min-h-[48px] text-sm leading-relaxed text-[var(--text-secondary)]">
                  {plan.summary}
                </p>

                <ul className="mt-6 space-y-3">
                  {plan.features.map((item) => (
                    <li key={item} className="flex items-start gap-3 text-sm text-white/90">
                      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${plan.iconClassName}`}>
                        <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>check</span>
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>

                <a
                  href={PORTAL_LOGIN_URL}
                  className={`mt-6 inline-flex w-full items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold transition ${plan.buttonClassName}`}
                >
                  {plan.buttonLabel}
                </a>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
