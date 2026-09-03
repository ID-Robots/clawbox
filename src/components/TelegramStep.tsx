"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import StatusMessage from "./StatusMessage";
import TelegramConfiguringOverlay from "./TelegramConfiguringOverlay";
import { useT } from "@/lib/i18n";

interface TelegramStepProps {
  onNext: () => void;
}

/* The ladders in globals.css name a face for body and one for display, but
   none for mono, and this screen is the wizard's only field that holds a
   machine literal long enough to be misread. `l`/`1`/`I` and `O`/`0` are
   the characters a BotFather token is made of; in the body face a customer
   who mistypes one has no way to see it. Same stack the shipped terminal
   surfaces use. */
const MONO =
  'ui-monospace, "Cascadia Mono", "SF Mono", Menlo, Consolas, monospace';

/* Colour moves on --d-2 (a state change on something already on screen);
   the press scale moves on --d-1 (it must land inside the 100ms
   "instantaneous" threshold or it reads as lag, not as touch). Written out
   rather than reached for with `transition-colors`, because those are two
   different durations on one element. */
const CONTROL_TRANSITION =
  "background-color var(--d-2) var(--ease-standard)," +
  " border-color var(--d-2) var(--ease-standard)," +
  " color var(--d-2) var(--ease-standard)," +
  " transform var(--d-1) var(--ease-standard)";

/* The primary's surface. .btn-gradient carries it as an unlayered rule,
   which outranks every Tailwind utility no matter how specific, so the
   disabled state cannot be expressed as a class — it is expressed here.
   Disabled reads as a FACT (the product's own quiet-control recipe, solid)
   rather than as the gradient dimmed: a button that has faded looks broken,
   a button that has gone quiet looks "not yet". */
const PRIMARY_SURFACE = {
  on: {
    backgroundImage:
      "linear-gradient(135deg, var(--coral-bright) 0%, var(--coral-dark) 100%)",
    border: "1px solid transparent",
    boxShadow: "0 4px 20px var(--shadow-coral-mid)",
    color: "#fff",
  },
  off: {
    backgroundImage: "none",
    backgroundColor: "var(--fill-2)",
    border: "1px solid var(--hair-2)",
    boxShadow: "none",
    color: "var(--text-muted)",
  },
} as const;

/* One numbered instruction. The marker is a drawn chip on the fill ladder
   rather than list-style:decimal, so it can hold its own weight beside a
   14px line; it is aria-hidden because the <ol> already numbers the list
   for a screen reader and hearing "1 1. Scan the QR code" is worse than
   hearing neither. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-[var(--s-2)]">
      <span
        aria-hidden="true"
        className="mt-[1px] shrink-0 grid place-items-center w-5 h-5 rounded-[var(--r-full)] bg-[var(--fill-2)] text-[length:var(--t-1)] font-semibold text-[var(--text-secondary)]"
      >
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/* A literal the customer has to recognise on a Telegram screen — a name to
   search for, a label to look under. Body face, not mono: mono means "a
   machine produced this", and these are words in someone else's UI. */
function Lit({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>;
}

export default function TelegramStep({ onNext }: TelegramStepProps) {
  const { t } = useT();
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [configurePromise, setConfigurePromise] = useState<Promise<void> | undefined>(undefined);
  const [status, setStatus] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const saveControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      saveControllerRef.current?.abort();
    };
  }, []);

  const saveTelegram = async () => {
    if (!token.trim()) {
      setStatus({ type: "error", message: t("telegram.enterToken") });
      return;
    }
    saveControllerRef.current?.abort();
    const controller = new AbortController();
    saveControllerRef.current = controller;

    setSaving(true);
    setConfiguring(true);
    setStatus(null);

    // Expose the configure outcome so the overlay only advances the wizard
    // (onDone → onNext) once the save has actually succeeded — gateway
    // health alone must not be read as success. Mirrors SettingsApp's
    // Telegram flow via TelegramConfiguringOverlay's `waitFor` prop.
    const {
      promise: cfgPromise,
      resolve: configureResolve,
      reject: configureReject,
    } = Promise.withResolvers<void>();
    // Swallow the rejection at the promise level so unhandled-rejection
    // doesn't fire; the failed state is surfaced via setStatus below and
    // the overlay is torn down by setConfiguring(false).
    cfgPromise.catch(() => {});
    setConfigurePromise(cfgPromise);

    try {
      const res = await fetch("/setup-api/telegram/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: token.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        configureReject(new Error("aborted"));
        return;
      }
      // 502 = the token was saved but the gateway is not serving it yet; the
      // body says `success: true` and carries the warning. Not a failed save.
      if (!res.ok && res.status !== 502) {
        const data = await res.json().catch(() => ({}));
        configureReject(new Error(data.error || "configure failed"));
        setConfiguring(false);
        setStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
        return;
      }
      const data = await res.json();
      if (controller.signal.aborted) {
        configureReject(new Error("aborted"));
        return;
      }
      if (data.success) {
        configureResolve();
      } else {
        configureReject(new Error(data.error || "configure returned success=false"));
        setConfiguring(false);
        setStatus({
          type: "error",
          message: data.error || "Failed to save",
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        configureReject(err);
        return;
      }
      configureReject(err);
      setConfiguring(false);
      setStatus({
        type: "error",
        message: `Failed: ${err instanceof Error ? err.message : err}`,
      });
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  // Every error this screen can raise is raised BY the token that was just
  // submitted — the empty-field guard above, and the configure route's own
  // reply, which fails on a malformed or rejected token. Binding the field's
  // invalid state to it puts the mark on the thing the customer has to
  // change, so "what is wrong" is answered by position as well as by the
  // sentence underneath. Purely presentational: the gate is still
  // `!token.trim()`, unchanged.
  const invalid = status?.type === "error";

  return (
    <div className="w-full max-w-[520px]" data-testid="setup-step-telegram">
      <div className="card-surface rounded-[var(--r-3)] p-5 sm:p-8 relative overflow-hidden">
        {configuring && (
          <TelegramConfiguringOverlay
            waitFor={configurePromise}
            onDone={onNext}
            onTimeout={() => {
              saveControllerRef.current?.abort();
              setSaving(false);
              setConfiguring(false);
              setConfigurePromise(undefined);
              setStatus({ type: "error", message: t("telegram.readinessTimeout") });
            }}
          />
        )}
        <div className={configuring ? "invisible h-0 overflow-hidden" : ""}>
        {/* font-bold / font-semibold / font-normal below are --w-head /
            --w-label / --w-body — same three numbers, spelled the way the
            rest of the wizard spells them. The display face comes from the
            global h1 rule. */}
        <h1 className="text-[length:var(--t-6)] leading-[1.15] font-bold mb-[var(--s-2)] flex flex-wrap items-center gap-[var(--s-2)]">
          {t("telegram.title")}
          {/* The one place the recommendation is stated on this screen — the
              button position argument that deleted step 1's chip does not
              apply here, because Connect and Skip sit side by side. */}
          <span className="px-[var(--s-2)] py-[var(--s-1)] text-[length:var(--t-1)] font-bold uppercase tracking-[0.06em] leading-[1.1] rounded-[var(--r-1)] bg-[var(--coral-tint)] text-[var(--coral-bright)]">
            {t("recommended")}
          </span>
        </h1>
        <p className="text-[length:var(--t-4)] leading-[1.6] text-[var(--text-secondary)] mb-[var(--s-6)]">
          {t("telegram.description")}
        </p>

        <div className="flex items-start gap-[var(--s-5)] mb-[var(--s-5)]">
          {/* The QR is not decoration here: the wizard is open on whatever
              screen reached the box, and Telegram lives on the customer's
              PHONE. On a laptop the button below cannot open an app that is
              not installed, so the QR is the only path that ends with a
              token in hand — which is why telegram.step1 says "scan the QR
              code or search". It stays hidden below 640px, where the device
              showing this cannot photograph itself and the button is the
              real path.
              White is required for scan contrast. marginSize gives the code
              its quiet zone in MODULES rather than relying on the 8px of
              padding to stand in for it — at 96px that padding was worth
              ~1.7 modules against the 4 the spec asks for, which is the
              difference between a code that reads at arm's length and one
              that needs a second try. */}
          <div className="hidden sm:block shrink-0 p-[var(--s-2)] bg-white rounded-[var(--r-1)]">
            <QRCodeSVG
              value="https://t.me/BotFather"
              size={96}
              level="M"
              marginSize={2}
              bgColor="#ffffff"
              fgColor="#000000"
              title={t("telegram.openBotFather")}
            />
          </div>
          {/* role="list" survives list-style:none in Safari/VoiceOver, which
              drops list semantics when the marker is removed. The markers
              are drawn rather than generated so they can carry the fill
              ladder; the ol still owns the ordering. */}
          <ol
            role="list"
            className="flex-1 min-w-0 list-none flex flex-col gap-[var(--s-3)] text-[length:var(--t-4)] leading-[1.55] text-[var(--text-secondary)]"
          >
            <Step n={1}>
              {t("telegram.step1")}{" "}
              {/* Not a link. The sentence tells the customer to SEARCH for
                  this name in Telegram, and a link that opens Telegram is
                  the full-width button 20px below — two affordances for one
                  action, one of them wearing the coral that belongs to the
                  primary. As a name it now reads as what you type. */}
              <Lit>@BotFather</Lit> {t("telegram.step1Suffix")}
            </Step>
            <Step n={2}>
              {t("telegram.step2")}{" "}
              <code
                className="px-[var(--s-1)] py-[var(--s-0)] rounded-[var(--r-1)] bg-[var(--fill-2)] text-[length:var(--t-2)] text-[var(--text-primary)]"
                style={{ fontFamily: MONO }}
              >
                /newbot
              </code>{" "}
              {t("telegram.step2Suffix")}
            </Step>
            <Step n={3}>
              {t("telegram.step3prefix")} <Lit>{t("telegram.step3bold")}</Lit>{" "}
              {t("telegram.step3suffix")}
            </Step>
          </ol>
        </div>

        {/* Telegram's own blue, kept as literals and unchanged from what
            shipped (#5eb8e6 on rgba(34,158,217,·15/·22/·40)). It is a third
            party's brand, not a ClawBox role colour, so it must not resolve
            through --coral (ACTION) or --cyan (DONE) and must not follow the
            box's own skin. Spelled out here rather than hoisted to a
            constant because Tailwind reads class names as literal text. */}
        <a
          href="https://t.me/BotFather"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-[var(--s-2)] w-full min-h-12 px-[var(--s-4)] mb-[var(--s-5)] rounded-[var(--r-1)] border text-[length:var(--t-4)] font-semibold no-underline active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coral-ring)] bg-[rgba(34,158,217,0.15)] hover:bg-[rgba(34,158,217,0.22)] border-[rgba(34,158,217,0.40)] text-[#5eb8e6]"
          style={{ transition: CONTROL_TRANSITION }}
        >
          {/* Telegram's own paper plane — a brand mark, not an icon from the
              device's glyph set, so it is not swapped for a Material
              Symbol. */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
          {t("telegram.openBotFather")}
        </a>

        <label
          htmlFor="telegram-bot-token"
          className="block text-[length:var(--t-2)] font-semibold text-[var(--text-secondary)] mb-[var(--s-2)]"
        >
          {t("telegram.botToken")}
        </label>
        <div className="relative">
          {/* 48px tall, full measure, mono at --t-4 rather than --t-5: a
              BotFather token is 46 characters, and at 15px mono it overruns
              the 520px card's inner width, so the start of the value the
              customer just pasted scrolls out of sight. At 14px the whole
              token is visible at once on a laptop — which is the only way
              "did that paste land?" gets answered without toggling reveal.
              The placeholder is the same face and size as the value, so the
              paste lands exactly where its ghost was. */}
          <input
            id="telegram-bot-token"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-invalid={invalid}
            className={`w-full min-h-12 py-[var(--s-3)] pl-[var(--s-4)] pr-12 rounded-[var(--r-2)] bg-[var(--fill-2)] text-[length:var(--t-4)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none border focus:bg-[var(--fill-3)] focus:border-[var(--coral-bright)] ${
              invalid ? "border-red-500/60" : "border-[var(--hair-2)]"
            }`}
            style={{
              fontFamily: MONO,
              transition:
                "background-color var(--d-2) var(--ease-standard), border-color var(--d-2) var(--ease-standard)",
            }}
          />
          {/* 40px target rather than a bare 18px glyph. This is the control
              that answers "is what I pasted the thing I copied?", so it has
              to be findable, not merely present. */}
          <button
            type="button"
            onClick={() => setShowToken((v) => !v)}
            aria-label={showToken ? "Hide token" : "Show token"}
            aria-controls="telegram-bot-token"
            className="absolute right-[var(--s-1)] top-1/2 -translate-y-1/2 grid place-items-center w-10 h-10 rounded-[var(--r-1)] bg-transparent border-none cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coral-ring)]"
            style={{ transition: CONTROL_TRANSITION }}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>
              {showToken ? "visibility_off" : "visibility"}
            </span>
          </button>
        </div>
        {status && (
          <StatusMessage type={status.type} message={status.message} />
        )}
        <div className="flex flex-col sm:flex-row sm:items-center gap-[var(--s-3)] mt-[var(--s-6)]">
          {/* Disabled reads as a fact, not as a fade: the gradient is
              replaced by the product's own quiet-control recipe rather than
              being dimmed. Nothing on this screen scales on hover — scale is
              touch feedback only, and it belongs to the press. */}
          <button
            type="button"
            onClick={saveTelegram}
            disabled={saving}
            className="w-full sm:w-auto min-h-12 px-[var(--s-7)] rounded-[var(--r-1)] text-[length:var(--t-5)] font-semibold cursor-pointer active:scale-[0.98] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:active:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coral-ring)]"
            style={{
              ...(saving ? PRIMARY_SURFACE.off : PRIMARY_SURFACE.on),
              transition: CONTROL_TRANSITION,
            }}
          >
            {saving ? t("connecting") : t("settings.connect")}
          </button>
          {/* Skip is a peer of Connect, not a failure and not a hyperlink
              inside a paragraph. It gives up its coral: one coral object per
              screen, and it is the button that does the thing. */}
          <button
            type="button"
            onClick={onNext}
            className="w-full sm:w-auto min-h-10 px-[var(--s-3)] rounded-[var(--r-1)] bg-transparent border-none cursor-pointer text-[length:var(--t-3)] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--fill-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coral-ring)]"
            style={{ transition: CONTROL_TRANSITION }}
          >
            {t("telegram.skipForNow")}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
