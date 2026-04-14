import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  FREE_PLAN_FEATURES,
  MAX_PLAN_BONUSES,
  PORTAL_LOGIN_URL,
  PORTAL_REGISTER_URL,
} from "@/lib/max-subscription";
import { getSiteUrl } from "@/lib/site-url";

const siteUrl = getSiteUrl();

export const metadata: Metadata = {
  title: "ClawBox Portal",
  description:
    "Discover ClawBox, the private local AI assistant OS for Jetson and x64 desktops, and access the public portal for plans, account access, and owner benefits.",
  alternates: {
    canonical: "/portal",
  },
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    title: "ClawBox Portal",
    description:
      "Private local AI assistant OS with browser-based setup, OpenClaw integration, browser automation, and a public portal for plans and owner benefits.",
    url: `${siteUrl}/portal`,
    type: "website",
    images: [
      {
        url: "/clawbox-box.png",
        width: 1200,
        height: 630,
        alt: "ClawBox private AI assistant portal",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ClawBox Portal",
    description:
      "Private local AI assistant OS with browser-based setup, OpenClaw integration, browser automation, and a public portal for plans and owner benefits.",
    images: ["/clawbox-box.png"],
  },
};

const featureCards = [
  {
    title: "Private by default",
    body: "Your setup, files, and on-device workflows stay local instead of routing through a cloud dashboard.",
    icon: "shield_lock",
  },
  {
    title: "Runs beyond chat",
    body: "OpenClaw can operate the desktop, automate a real browser, manage apps, and work through MCP tools.",
    icon: "rocket_launch",
  },
  {
    title: "Hybrid AI stack",
    body: "Use cloud providers when you want them, then keep a local llama.cpp or Ollama fallback ready on the device.",
    icon: "memory",
  },
] as const;

const workflowSteps = [
  "Install on Jetson hardware or an x64 desktop.",
  "Finish setup in the browser: WiFi, updates, security, AI, local fallback, Telegram.",
  "Use the ClawBox desktop, portal account, and owner benefits together.",
] as const;

const installCommands = [
  { label: "Jetson", command: "sudo bash install.sh" },
  { label: "x64 desktop", command: "bash install-x64.sh" },
] as const;

const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "ClawBox",
  applicationCategory: "OperatingSystemApplication",
  operatingSystem: "Linux, NVIDIA Jetson, x64",
  description:
    "ClawBox is a private local AI assistant OS with browser-based setup, OpenClaw integration, browser automation, local AI fallbacks, and a public portal for plans and owner benefits.",
  url: `${siteUrl}/portal`,
  image: `${siteUrl}/clawbox-box.png`,
  brand: {
    "@type": "Brand",
    name: "ClawBox",
  },
  offers: {
    "@type": "Offer",
    url: `${siteUrl}/portal/subscribe`,
    price: "0",
    priceCurrency: "EUR",
    availability: "https://schema.org/InStock",
  },
};

export default function PortalLandingPage() {
  return (
    <main className="min-h-screen overflow-y-auto bg-[radial-gradient(circle_at_top,rgba(249,115,22,0.14),transparent_28%),radial-gradient(circle_at_80%_20%,rgba(0,229,204,0.10),transparent_24%),var(--bg-deep)] text-[var(--text-primary)]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

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
                Public portal
              </div>
            </div>
          </a>

          <div className="flex flex-wrap gap-3">
            <a
              href={PORTAL_LOGIN_URL}
              className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Portal login
              <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>login</span>
            </a>
            <Link
              href="/portal/subscribe"
              className="inline-flex items-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#f97316,#c2410c)] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
            >
              View plans
              <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>arrow_forward</span>
            </Link>
          </div>
        </header>

        <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_380px]">
          <div className="card-surface rounded-[28px] border-white/10 p-7 sm:p-10">
            <div className="inline-flex items-center gap-2 rounded-full border border-orange-400/25 bg-orange-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-200">
              Private local AI assistant OS
            </div>
            <h1 className="mt-4 max-w-4xl text-4xl font-bold leading-tight text-white sm:text-5xl">
              ClawBox brings setup, desktop control, and AI workflows onto your own device.
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-relaxed text-[var(--text-secondary)] sm:text-lg">
              Use ClawBox on NVIDIA Jetson hardware or a desktop install, connect your preferred AI provider, keep a local fallback model ready, and manage everything from a browser-based desktop instead of a cloud control panel.
            </p>

            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {featureCards.map((card) => (
                <article
                  key={card.title}
                  className="rounded-2xl border border-white/10 bg-white/5 p-5"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-orange-500/15 text-orange-200">
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 20 }}>{card.icon}</span>
                  </div>
                  <h2 className="mt-4 text-lg font-semibold text-white">{card.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{card.body}</p>
                </article>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/portal/subscribe"
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#f97316,#c2410c)] px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90"
              >
                Compare plans
                <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 18 }}>arrow_forward</span>
              </Link>
              <a
                href={PORTAL_REGISTER_URL}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                Create portal account
              </a>
            </div>
          </div>

          <aside className="rounded-[28px] border border-white/10 bg-black/20 p-6 backdrop-blur">
            <div className="rounded-3xl border border-white/10 bg-[linear-gradient(180deg,rgba(249,115,22,0.12),rgba(17,24,39,0.86))] p-5">
              <Image
                src="/clawbox-box.png"
                alt="ClawBox device"
                width={520}
                height={520}
                className="mx-auto h-auto w-full max-w-[300px] object-contain"
                priority
              />
            </div>

            <div className="mt-6 text-sm font-semibold uppercase tracking-[0.18em] text-orange-200">
              Start fast
            </div>
            <div className="mt-4 space-y-3">
              {installCommands.map((entry) => (
                <div key={entry.label} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">{entry.label}</div>
                  <code className="mt-2 block text-sm text-white">{entry.command}</code>
                </div>
              ))}
            </div>
          </aside>
        </section>

        <section className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <article className="rounded-[28px] border border-white/10 bg-white/5 p-6">
            <div className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-200">
              Typical workflow
            </div>
            <ol className="mt-5 space-y-4">
              {workflowSteps.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 text-sm font-semibold text-cyan-100">
                    {index + 1}
                  </span>
                  <span className="pt-1 text-sm leading-relaxed text-[var(--text-secondary)]">{step}</span>
                </li>
              ))}
            </ol>
          </article>

          <article className="rounded-[28px] border border-white/10 bg-white/5 p-6">
            <div className="text-sm font-semibold uppercase tracking-[0.18em] text-fuchsia-200">
              Portal highlights
            </div>
            <ul className="mt-5 space-y-3">
              {[...FREE_PLAN_FEATURES, ...MAX_PLAN_BONUSES].map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm text-[var(--text-secondary)]">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-fuchsia-400/20 text-fuchsia-100">
                    <span className="material-symbols-rounded" aria-hidden="true" style={{ fontSize: 14 }}>check</span>
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </article>
        </section>

        <section className="mt-10 pb-8">
          <div className="rounded-[28px] border border-orange-400/20 bg-[linear-gradient(180deg,rgba(249,115,22,0.10),rgba(17,24,39,0.88))] p-6 sm:p-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="max-w-3xl">
                <div className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-200">
                  Ready to continue
                </div>
                <h2 className="mt-2 text-3xl font-bold text-white">Use the public portal for plans, logins, and owner benefits.</h2>
                <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
                  The public portal is the safe crawlable surface. The desktop, setup flow, and device controls stay private behind the local ClawBox runtime.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Link
                  href="/portal/subscribe"
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[linear-gradient(135deg,#f97316,#c2410c)] px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90"
                >
                  Open pricing
                </Link>
                <a
                  href={PORTAL_LOGIN_URL}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
                >
                  Portal login
                </a>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
