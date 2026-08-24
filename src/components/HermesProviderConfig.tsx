"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import AIProviderIcon from "./AIProviderIcon";
import ClawboxAiProviderRow from "./ClawboxAiProviderRow";
import ClawboxAiPlanPicker from "./ClawboxAiPlanPicker";
import ClawboxAiDeviceLogin from "./ClawboxAiDeviceLogin";
import ProviderConnectionLabel from "./ProviderConnectionLabel";
import ProviderDefaultHero from "./ProviderDefaultHero";
import { useClawaiDeviceLogin } from "@/hooks/useClawaiDeviceLogin";
import { useProviderStatus } from "@/hooks/useProviderStatus";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/lib/i18n";
import { notifyHermesModelState, useHermesModelOptions } from "@/hooks/useHermesModelOptions";
import { notifyProvidersChanged, onProvidersChanged } from "@/lib/ui-events";
import {
  HERMES_PANEL_PROVIDERS,
  CLAWAI_PROVIDER,
  hermesProviderLabel,
} from "@/lib/hermes-providers";
import {
  CLAWAI_TIER_INFO,
  CLAWAI_TIER_STORAGE_KEY,
  resolveUiTier,
  uiTierToDeviceTier,
  type ClawaiTier,
} from "@/lib/clawbox-ai-tiers";

// The AI Providers section — Hermes edition. ONE section that answers all three
// provider questions: what is running, what else is connected, and how to
// change either.
//
// IT USED TO BE TWO. A "Connections" chip strip sat above this panel listing
// every provider's state with a star on the default, and this panel listed the
// same providers again as radio rows with none of that state on them. Two lists
// of the same eight vendors, a hand's breadth apart, disagreeing about what
// they were for — and the strip's star meant "make default" while the panel's
// radio meant "configure", which is two different verbs on one noun. The owner
// picked the merge: a HERO card naming the current default (vendor, model,
// connection) over the radio list everyone already knows, each row now honest
// about its own connection. The strip is gone; its data hook is what feeds this.
//
// The radio therefore carries BOTH verbs, resolved by the row's own state:
//   • a CONNECTED provider     → becomes the default (POST /providers/default)
//   • a not-yet-connected one  → opens its sign-in/key flow first, as before
// which is the honest reading of "pick this one" in each case.
//
// Everything below the list is unchanged, and still drives Hermes' OWN native
// switching:
//   • model + provider  → POST /setup-api/hermes/models  (hermes config set)
//   • provider API key  → POST /setup-api/hermes/provider-key (hermes auth add)
//   • ClawBox AI        → POST /setup-api/hermes/clawai (custom provider through Hermes)
// Only ClawBox AI's device-login is ClawBox-specific; everything else is Hermes-native.
//
// The model list is SCOPED to the selected provider (REQ 1). Scoping is done by
// the server — /setup-api/hermes/models?provider=X returns that provider's own
// live ids and blanks `current` when the saved model belongs to someone else —
// so this component never has to know that e.g. OpenRouter spells a model
// "anthropic/claude-opus-4.8" while direct Anthropic spells it "claude-opus-4-8".

interface ClawaiState {
  hasToken: boolean;
  tier: "flash" | "pro";
  tierStored: "flash" | "pro" | null;
  active: boolean;
  model: string;
}

type Status = { kind: "ok" | "err"; msg: string } | null;

// One in-flight provider sign-in, driven entirely from this panel through the
// same-origin /setup-api/hermes/oauth/* routes. The Hermes dashboard's own
// OAuth page sits behind the :8090 auth proxy, which remote access
// (clawbox-tunnel on :80, Cloudflare quick tunnel) does not forward — sending
// the browser there gave tunnel users a blank tab and no credentials.
type OauthSignin =
  | { stage: "starting"; providerId: string }
  | { stage: "pkce"; providerId: string; sessionId: string; authUrl: string; error?: string }
  | {
      stage: "device";
      providerId: string;
      sessionId: string;
      userCode: string;
      verificationUrl: string;
      pollMs: number;
      /** Epoch ms; the poll loop's hard deadline, from the session's expires_in. */
      expiresAt: number;
    }
  | { stage: "failed"; providerId: string; message: string };

/** Only ever open or render a dashboard-supplied URL if it is plain http(s) —
 *  anything else (javascript:, data:, a bare token) must not reach window.open
 *  or an href. */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

interface Props {
  embedded?: boolean;
  onNext?: () => void;
  testId?: string;
  /**
   * Select this provider's row, so a deep-link into Settings lands on the panel
   * that configures it rather than merely on the section.
   */
  requestedProviderId?: string | null;
  /**
   * Bumped by the caller on every request. A counter rather than watching the
   * id, so asking for the SAME provider again re-selects it after the customer
   * has moved to another row in the meantime.
   */
  providerSelectionRequest?: number;
}

// The OpenClaw AI-models step advances the wizard ~900 ms after a successful
// configure (AIModelsStep's handleConfiguringDone), which is long enough for the
// "connected" state to register and short enough not to feel stalled. This panel
// is the SAME step on a Hermes device, so it advances the same way.
const AUTO_ADVANCE_DELAY_MS = 900;

// The provider registry is shared with the server routes (/setup-api/hermes/*
// imports it), so it cannot call `t` — but a row's `description` is copy, not
// data, and this panel is the only place it is rendered. Re-key it here, by
// slug: a slug may carry a hyphen ("openai-codex") and a catalogue key segment
// may not. A provider with no entry keeps the registry's own English rather
// than rendering a raw key.
const PROVIDER_DESCRIPTION_KEYS: Record<string, string> = {
  openrouter: "hermesProvider.row.desc.openrouter",
  anthropic: "hermesProvider.row.desc.anthropic",
  "openai-codex": "hermesProvider.row.desc.openaiCodex",
  gemini: "hermesProvider.row.desc.gemini",
  zai: "hermesProvider.row.desc.zai",
  "kimi-coding": "hermesProvider.row.desc.kimiCoding",
  copilot: "hermesProvider.row.desc.copilot",
  nous: "hermesProvider.row.desc.nous",
};

export default function HermesProviderConfig({
  embedded,
  onNext,
  testId,
  requestedProviderId,
  providerSelectionRequest = 0,
}: Props) {
  const { t } = useT();
  const uid = useId();

  // Seeded from the DEVICE's configured provider by the mount effect below;
  // "openrouter" is only the pre-resolution placeholder. Under REQ 1's scoping
  // an unseeded panel is actively misleading — it would present OpenRouter's
  // scoped list, with OpenRouter's recommended default preselected, for a
  // device running something else, one Save click away from switching it.
  const [selectedProvider, setSelectedProvider] = useState<string>("openrouter");
  // Set as soon as the user touches a radio. The async device reads below must
  // never yank the selection out from under a click that already happened.
  const userPickedProviderRef = useRef(false);
  // Set when we send the user off to the dashboard's OAuth page, so the focus
  // listener knows this tab-return is worth re-checking credentials for.
  const oauthTabOpenedRef = useRef(false);
  // The user's explicit pick, if any. `model` (below) is derived from this
  // plus the live scope, so a pick can never outlive the provider it belongs to.
  const [picked, setPicked] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<Status>(null);

  // ── Auto-advance ───────────────────────────────────────────────────────────
  //
  // Set ONLY once a configure round-trip has actually succeeded — a provider
  // sign-in that happens out of band (the dashboard's own OAuth page, opened in
  // another tab by openHermesOAuth) deliberately does NOT set it: returning from
  // that tab has not configured anything yet, the user still has to save. So a
  // half-finished sign-in can never carry the wizard forward.
  const [configured, setConfigured] = useState(false);
  const advancedRef = useRef(false);
  // `onNext` is an inline arrow from the wizard, so its identity changes on
  // every parent render. Held in a ref so a re-render cannot restart the timer.
  const onNextRef = useRef(onNext);
  useEffect(() => { onNextRef.current = onNext; }, [onNext]);

  useEffect(() => {
    // Settings embeds this panel with nowhere to advance to; only the wizard
    // passes an onNext.
    if (!configured || embedded) return;
    const timer = setTimeout(() => {
      if (advancedRef.current) return;
      advancedRef.current = true;
      onNextRef.current?.();
    }, AUTO_ADVANCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [configured, embedded]);

  // Tell every already-open view — the chat popup's provider picker, and this
  // panel's own scoped model list — that the device's providers/model/tier
  // changed, so they re-read instead of naming the previous provider (and
  // blocking legal turns) until the whole page is reloaded. Mirrors the
  // OpenClaw side's "clawbox:chat-model-state-changed".
  //
  // Emit it from EVERY path that leaves the device configured differently, not
  // just the Save button: a provider connected through the ClawBox AI device
  // login or through Hermes' own OAuth is exactly the case where the user
  // expects to switch straight to it in chat.
  const notifyChatHeader = useCallback(() => {
    // Both names. The Hermes-specific one because listeners predating the
    // shared signal still key on it, and the edition-neutral one so a listener
    // written since — the connection strip, the capability probe — does not
    // have to know which harness it happens to be mounted on.
    notifyHermesModelState();
    notifyProvidersChanged();
  }, []);

  // ── Inline provider OAuth ──────────────────────────────────────────────────
  //
  // Held in a ref as well so unmount cleanup can abandon the dashboard-side
  // session without the cleanup effect re-running on every state change.
  const [signin, setSignin] = useState<OauthSignin | null>(null);
  const signinRef = useRef<OauthSignin | null>(null);
  useEffect(() => { signinRef.current = signin; }, [signin]);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  // Bumped by every reset/unmount so a /start response that lands AFTER the
  // user moved on (switched rows, hit Start over, left the panel) knows it was
  // abandoned and hands its session straight back to the dashboard instead of
  // resurrecting a flow nobody is looking at.
  const signinGenRef = useRef(0);

  const cancelOauthSession = useCallback((sessionId: string) => {
    // Best-effort; keepalive lets the request outlive an unmounting page.
    void fetch("/setup-api/hermes/oauth/cancel", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  const resetSignin = useCallback(() => {
    const s = signinRef.current;
    signinGenRef.current += 1;
    if (s && (s.stage === "pkce" || s.stage === "device")) cancelOauthSession(s.sessionId);
    setSignin(null);
    setOauthCode("");
    setCodeCopied(false);
  }, [cancelOauthSession]);

  useEffect(() => () => {
    // Panel going away mid-flow: don't leave a half-open session on the
    // dashboard until its expiry.
    const s = signinRef.current;
    signinGenRef.current += 1;
    if (s && (s.stage === "pkce" || s.stage === "device")) cancelOauthSession(s.sessionId);
  }, [cancelOauthSession]);

  const pickProvider = useCallback((id: string) => {
    userPickedProviderRef.current = true;
    setSelectedProvider(id);
    setPicked("");
    setSaveStatus(null);
    // A half-finished sign-in belongs to the row being left.
    resetSignin();
  }, [resetSignin]);

  // ── Connection state, for the hero and every row ───────────────────────────
  //
  // The same hook the removed connection strip used, unchanged: one call to
  // /setup-api/providers/status for every provider at once, re-read on the
  // shared providers-changed signal. Owning it here is what lets one section do
  // what two used to.
  const {
    summary,
    error: statusError,
    settingDefault,
    defaultError,
    setDefault,
  } = useProviderStatus();

  const statusById = useMemo(
    () => new Map((summary?.providers ?? []).map((row) => [row.id, row])),
    [summary],
  );
  const defaultRow = useMemo(
    () => summary?.providers.find((row) => row.isDefault) ?? null,
    [summary],
  );

  /**
   * Pick a row.
   *
   * A connected provider is one the box could switch to right now, so choosing
   * it MEANS "make this the default" and is written through immediately — the
   * hero repaints from the server's answer a moment later, never from an
   * assumption that the write landed. Anything else can only be chosen in the
   * aspirational sense: it selects the row and lets the sign-in / API-key
   * controls below do their work first, exactly as this picker always did.
   *
   * Selecting the provider that is ALREADY the default writes nothing — there
   * is nothing to change, and a POST would still cost the box a config write.
   */
  const choose = useCallback((id: string) => {
    pickProvider(id);
    const row = statusById.get(id);
    if (row?.state === "connected" && !row.isDefault) void setDefault(id);
  }, [pickProvider, statusById, setDefault]);

  const isClawaiSelected = selectedProvider === CLAWAI_PROVIDER;

  // ClawBox AI — a managed provider that still runs THROUGH Hermes.
  const [clawai, setClawai] = useState<ClawaiState | null>(null);
  const [uiTier, setUiTier] = useState<ClawaiTier>("flash");
  // The UI tier the device is currently RUNNING (null until we know). Compared
  // against `uiTier` to decide whether "Switch to …" is actionable — comparing
  // device tiers instead collapsed Free and Pro onto the same value, so a Free
  // user could never press "Switch to Pro" and a Pro user could never go back.
  const [appliedUiTier, setAppliedUiTier] = useState<ClawaiTier | null>(null);
  const [applyingClawai, setApplyingClawai] = useState(false);
  const [clawaiStatus, setClawaiStatus] = useState<Status>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  // Hermes native provider-OAuth status (anthropic PKCE, openai-codex device-code, …).
  const [oauth, setOauth] = useState<Record<string, { loggedIn: boolean; flow: string; docsUrl?: string; cliCommand?: string }>>({});

  // ClawBox AI has no model dropdown: its model is derived from the tier and
  // must stay a BARE id (a vendor-prefixed slug gets HTTP 400 "Model not
  // allowed" from the proxy), so it is never fed through the catalogue.
  const { scope, loading, refresh: refreshModels } = useHermesModelOptions(
    isClawaiSelected ? null : selectedProvider,
  );

  // The effective model is DERIVED, not synced by an effect: a pick the newly
  // selected provider doesn't serve is dropped on the spot, so the dropdown can
  // never sit on a foreign vendor's id for even one frame. This is the fix for
  // "select Anthropic, dropdown still shows deepseek/deepseek-v4-flash".
  const model = useMemo(() => {
    if (!scope) return "";
    if (picked && scope.models.some((m) => m.id === picked)) return picked;
    return scope.current || scope.defaultModel;
  }, [scope, picked]);
  const modelInScope = Boolean(model) && Boolean(scope?.models.some((m) => m.id === model));

  const fetchClawai = useCallback(async (): Promise<ClawaiState | null> => {
    try {
      const res = await fetch("/setup-api/hermes/clawai", { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as ClawaiState;
    } catch {
      return null;
    }
  }, []);

  const reloadClawai = useCallback(async () => {
    const data = await fetchClawai();
    if (data) {
      setClawai(data);
      setAppliedUiTier(data.active ? resolveUiTier(data.hasToken, data.tierStored) : null);
    }
  }, [fetchClawai]);

  /**
   * The pairing the DEVICE is configured for, from the unscoped GET.
   *
   * The model half is what the hero names. It cannot come from `scope`, which
   * is deliberately scoped to the SELECTED row — the moment a customer clicks
   * another vendor to look at it, `scope.current` stops describing what the box
   * is running, which is the one thing the hero must never get wrong.
   */
  const fetchDevicePairing = useCallback(async (): Promise<{ provider: string; model: string } | null> => {
    try {
      const res = await fetch("/setup-api/hermes/models", { cache: "no-store" });
      if (!res.ok) return null;
      const data = (await res.json()) as { provider?: unknown; current?: unknown };
      return {
        provider: typeof data.provider === "string" ? data.provider : "",
        model: typeof data.current === "string" ? data.current : "",
      };
    } catch {
      // Null, never a blank pairing. Callers keep the last good answer instead
      // of blanking the hero'''s model line on a transient failure — the same
      // rule the status hook already follows, for the same reason.
      return null;
    }
  }, []);

  /** The model the box's default provider resolves to. "" until we know. */
  const [deviceModel, setDeviceModel] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [data, pairing] = await Promise.all([fetchClawai(), fetchDevicePairing()]);
      if (!alive) return;
      if (data) {
        setClawai(data);
        setUiTier(resolveUiTier(data.hasToken, data.tierStored));
        setAppliedUiTier(data.active ? resolveUiTier(data.hasToken, data.tierStored) : null);
      }
      if (pairing) setDeviceModel(pairing.model);
      // Both reads are async, so a user can already have clicked a row by now —
      // silently bouncing them back would discard their pick and the scoped
      // fetch it started.
      if (userPickedProviderRef.current) return;
      if (data?.active) {
        setSelectedProvider(CLAWAI_PROVIDER);
      } else if (pairing?.provider && HERMES_PANEL_PROVIDERS.some((p) => p.id === pairing.provider)) {
        setSelectedProvider(pairing.provider);
      }
    })();
    return () => { alive = false; };
  }, [fetchClawai, fetchDevicePairing]);

  // The hero's model has to keep up with the same signal its provider does, or
  // choosing a new default would swap the vendor name above a model id that
  // belongs to the vendor just replaced. Deliberately re-reads only the pairing:
  // re-running the mount effect would also re-seed the selection, yanking the
  // row out from under a customer who had moved on.
  useEffect(() => {
    let alive = true;
    const unsubscribe = onProvidersChanged(() => {
      void fetchDevicePairing().then((pairing) => {
        if (alive && pairing) setDeviceModel(pairing.model);
      });
    });
    return () => { alive = false; unsubscribe(); };
  }, [fetchDevicePairing]);

  // ── The hero ───────────────────────────────────────────────────────────────

  /**
   * ClawBox AI is the one provider whose model is not the device pairing: it is
   * derived from the tier and deliberately kept out of the model catalogue (a
   * vendor-prefixed slug gets a 400 from the proxy), so its own read is the
   * authority for it.
   */
  const heroModel = defaultRow?.id === CLAWAI_PROVIDER
    ? (clawai?.model || deviceModel)
    : deviceModel;

  /** True when this panel has a row for the default — see `changeModel`. */
  const defaultHasRow = defaultRow !== null && (
    defaultRow.id === CLAWAI_PROVIDER
    || HERMES_PANEL_PROVIDERS.some((p) => p.id === defaultRow.id)
  );

  // "Change model" sends the customer to the model UI they already know rather
  // than growing a second one in the hero. Bumped as a counter, not a boolean,
  // so pressing it again re-focuses the dropdown after they have clicked away.
  const [focusModelRequest, setFocusModelRequest] = useState(0);
  const modelSelectRef = useRef<HTMLSelectElement>(null);

  const changeModel = useCallback(() => {
    if (!defaultRow) return;
    if (defaultRow.id !== selectedProvider) pickProvider(defaultRow.id);
    setFocusModelRequest((n) => n + 1);
  }, [defaultRow, selectedProvider, pickProvider]);

  useEffect(() => {
    if (!focusModelRequest) return;
    // Re-runs as the row switches and its scope lands, because the dropdown
    // does not exist until both have happened. ClawBox AI has no dropdown at
    // all — its plan picker is the model UI — so there is simply nothing to
    // focus, and scrolling the row into view is the whole gesture.
    const el = modelSelectRef.current;
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  }, [focusModelRequest, selectedProvider, loading]);

  // A chip in the connection strip was clicked. Treated exactly like a click on
  // this panel's own radio row — including setting `userPickedProviderRef`, so
  // the mount seed above (which may still be in flight) cannot bounce the
  // selection back to the device's current provider a beat later.
  //
  // Keyed on the request counter alone: re-running when the id changes as well
  // would re-apply a stale request after the customer had moved on.
  useEffect(() => {
    if (!providerSelectionRequest) return;
    const requested = requestedProviderId?.trim();
    if (!requested) return;
    const known = requested === CLAWAI_PROVIDER
      || HERMES_PANEL_PROVIDERS.some((p) => p.id === requested);
    // A provider this panel has no row for cannot be selected in it. Silently
    // ignored rather than written into state, which would leave the radio group
    // with nothing checked and the scoped model list asking for a provider the
    // customer cannot see.
    if (!known) return;
    userPickedProviderRef.current = true;
    setSelectedProvider(requested);
    // The remembered model belongs to whichever provider was selected before.
    setPicked("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerSelectionRequest]);

  const loadOauth = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/setup-api/hermes/oauth", { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as {
        providers?: { id: string; loggedIn: boolean; flow: string; docsUrl?: string; cliCommand?: string }[];
      };
      const map: Record<string, { loggedIn: boolean; flow: string; docsUrl?: string; cliCommand?: string }> = {};
      for (const p of d.providers ?? [])
        map[p.id] = { loggedIn: p.loggedIn, flow: p.flow, docsUrl: p.docsUrl, cliCommand: p.cliCommand };
      setOauth(map);
    } catch {
      /* OAuth affordances just won't show; non-fatal */
    }
  }, []);

  useEffect(() => {
    void loadOauth();
  }, [loadOauth]);

  // Sign-in happens OUT OF BAND: the user completes PKCE/device-code in the
  // Hermes dashboard, in another tab, on another port. Nothing tells this page
  // (or the server's model cache) that credentials appeared, so a provider the
  // user just connected kept showing as unauthenticated with no models until
  // the cache aged out — it looked like the sign-in hadn't worked.
  // Re-check when the user comes back to this tab, and force a server-side
  // refresh so Hermes re-enumerates that provider's live model list.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => {
      if (!oauthTabOpenedRef.current) return;
      oauthTabOpenedRef.current = false;
      void loadOauth();
      refreshModels();
      // The credential that just appeared can flip a provider from
      // `authenticated: false` to true, which is what decides whether the chat
      // offers it at all — so the chat has to re-read too, not just this panel.
      notifyChatHeader();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadOauth, refreshModels, notifyChatHeader]);

  // A finished sign-in is a credential appearing server-side — the panel, the
  // model cache and the chat header all have to re-read, same as the old
  // return-from-dashboard-tab case. Flip the local flag first so Connected
  // shows immediately instead of after the status round-trip.
  const onOauthConnected = useCallback((providerId: string) => {
    setSignin(null);
    setOauthCode("");
    setCodeCopied(false);
    setOauth((m) => ({ ...m, [providerId]: { ...(m[providerId] ?? { flow: "" }), loggedIn: true } }));
    void loadOauth();
    refreshModels();
    notifyChatHeader();
  }, [loadOauth, refreshModels, notifyChatHeader]);

  async function startOauth(providerId: string) {
    resetSignin();
    const gen = signinGenRef.current;
    setSignin({ stage: "starting", providerId });
    try {
      const res = await fetch("/setup-api/hermes/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(typeof data.error === "string" && data.error ? data.error : `HTTP ${res.status}`);
      }
      const sessionId = typeof data.session_id === "string" ? data.session_id : "";
      if (gen !== signinGenRef.current) {
        // Abandoned mid-start: give the session back instead of leaking it.
        if (sessionId) cancelOauthSession(sessionId);
        return;
      }
      if (data.flow === "pkce" && sessionId && isHttpUrl(data.auth_url)) {
        // The provider's consent page ends by SHOWING a code the user copies
        // back here (Anthropic's redirect_uri is its own console) — nothing
        // ever redirects back to this origin, which is why the flow survives
        // any tunnel.
        window.open(data.auth_url, "_blank", "noopener,noreferrer");
        setSignin({ stage: "pkce", providerId, sessionId, authUrl: data.auth_url });
      } else if (data.flow === "device_code" && sessionId) {
        const interval =
          typeof data.poll_interval === "number" && data.poll_interval > 0 ? data.poll_interval : 5;
        const expiresIn =
          typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 900;
        setSignin({
          stage: "device",
          providerId,
          sessionId,
          userCode: typeof data.user_code === "string" ? data.user_code : "",
          verificationUrl: isHttpUrl(data.verification_url) ? data.verification_url : "",
          pollMs: Math.max(3, interval) * 1000,
          expiresAt: Date.now() + expiresIn * 1000,
        });
      } else {
        throw new Error(t("hermesProvider.oauth.unexpectedResponse"));
      }
    } catch (e) {
      if (gen !== signinGenRef.current) return;
      setSignin({
        stage: "failed",
        providerId,
        message: e instanceof Error ? e.message : t("hermesProvider.oauth.startFailed"),
      });
    }
  }

  async function submitOauthCode() {
    const s = signin;
    if (!s || s.stage !== "pkce") return;
    const code = oauthCode.trim();
    if (!code) return;
    setOauthBusy(true);
    try {
      const res = await fetch("/setup-api/hermes/oauth/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: s.providerId, sessionId: s.sessionId, code }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.ok === false) {
        const msg =
          typeof data.message === "string" && data.message
            ? data.message
            : typeof data.error === "string" && data.error
              ? data.error
              : `HTTP ${res.status}`;
        throw new Error(msg);
      }
      onOauthConnected(s.providerId);
    } catch (e) {
      // Stay on the paste step: a mistyped code must not force a new session.
      setSignin({ ...s, error: e instanceof Error ? e.message : t("hermesProvider.oauth.codeRejected") });
    } finally {
      setOauthBusy(false);
    }
  }

  // Device-code sessions resolve out of band (the user approves on the
  // provider's site), so poll until a terminal status. Recursive timeout, not
  // an interval: a slow relay must never stack requests.
  useEffect(() => {
    if (!signin || signin.stage !== "device") return;
    const { providerId, sessionId, pollMs, expiresAt } = signin;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let terminal = false;
      // Hard deadline from the session's own expires_in: even if every poll
      // errors (relay down, dashboard restarting), the loop cannot outlive the
      // session it is polling for.
      if (Date.now() >= expiresAt) {
        setSignin({
          stage: "failed",
          providerId,
          message: t("hermesProvider.oauth.expired"),
        });
        return;
      }
      try {
        const res = await fetch(
          `/setup-api/hermes/oauth/poll?providerId=${encodeURIComponent(providerId)}&sessionId=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" },
        );
        const data = (await res.json().catch(() => ({}))) as {
          status?: unknown;
          error_message?: unknown;
          error?: unknown;
        };
        if (!alive) return;
        const status = typeof data.status === "string" ? data.status : "";
        // A 4xx is the relay's verdict on THIS session — not found, expired, or
        // minted for another provider — and it answers with `error`, never
        // `status`. Reading `status` alone made those bodies indistinguishable
        // from "keep polling", so a session that was already dead sat behind
        // "Waiting for approval..." until the deadline above. 5xx stays
        // transient (the dashboard may be mid-restart) and the deadline still
        // bounds that case.
        if (!res.ok && res.status < 500) {
          terminal = true;
          setSignin({
            stage: "failed",
            providerId,
            message:
              typeof data.error === "string" && data.error
                ? data.error
                : "Sign-in failed. Try again.",
          });
        } else if (status === "approved") {
          terminal = true;
          onOauthConnected(providerId);
        } else if (status === "error" || status === "expired") {
          terminal = true;
          setSignin({
            stage: "failed",
            providerId,
            message:
              typeof data.error_message === "string" && data.error_message
                ? data.error_message
                : status === "expired"
                  ? t("hermesProvider.oauth.expired")
                  : t("hermesProvider.oauth.failed"),
          });
        }
      } catch {
        // Transient relay error: keep polling until the session itself expires.
      }
      if (alive && !terminal) timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, pollMs);
    return () => { alive = false; clearTimeout(timer); };
  }, [signin, onOauthConnected, t]);

  function copyUserCode(code: string) {
    // copyToClipboard, not navigator.clipboard directly: the device is served
    // over plain http on the LAN, where the async clipboard API doesn't exist.
    void copyToClipboard(code).then((ok) => setCodeCopied(ok));
  }

  const changeUiTier = useCallback((tier: ClawaiTier) => {
    setUiTier(tier);
    setClawaiStatus(null);
    if (typeof window === "undefined") return;
    try {
      window.localStorage?.setItem(CLAWAI_TIER_STORAGE_KEY, tier);
    } catch {
      // Storage may be unavailable (private mode, quota); the in-memory value
      // still drives the connect/apply flow.
    }
  }, []);

  const login = useClawaiDeviceLogin({
    scope: "primary",
    getTier: () => uiTier,
    onStart: () => setClawaiStatus(null),
    onBusyChange: setLoginBusy,
    onConfiguring: () => setClawaiStatus({ kind: "ok", msg: t("hermesProvider.clawai.finishingSetup") }),
    onComplete: () => {
      // Only reached on the poll's terminal `complete` status, i.e. after the
      // device finished configuring — never mid-handshake.
      void reloadClawai();
      setSelectedProvider(CLAWAI_PROVIDER);
      // The device-code handoff configures the provider server-side, so this is
      // a successful configure like any other — the chat picker has to hear it.
      notifyChatHeader();
      setClawaiStatus({ kind: "ok", msg: t("hermesProvider.clawai.nowActive") });
      setConfigured(true);
    },
    onError: (msg) => setClawaiStatus({ kind: "err", msg }),
  });

  // ADVANCED FALLBACK ONLY: the Hermes dashboard's /env page via its auth-gated
  // proxy on :8090. LAN-only — tunnels don't forward that port, which is
  // exactly why the inline flow above exists; nothing depends on this link.
  // The flag is what the focus listener above keys on: we only re-check (and
  // pay for a live provider re-enumeration) when the user actually went off to
  // sign in, not on every incidental tab switch.
  function openHermesOAuth() {
    if (typeof window === "undefined") return;
    const url = `${window.location.protocol}//${window.location.hostname}:8090/env`;
    oauthTabOpenedRef.current = true;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  const selectedDef = useMemo(
    () => HERMES_PANEL_PROVIDERS.find((p) => p.id === selectedProvider),
    [selectedProvider],
  );
  /** A key has been typed for a provider that accepts one — on its own a valid
   *  reason to submit, even with no model selectable yet. */
  const hasPendingKey = Boolean(selectedDef?.keyProvider) && apiKey.trim().length > 0;

  // Compared in UI-tier space (Free/Pro/Max), not device-tier space.
  const clawaiDirty = !clawai?.active || appliedUiTier === null || uiTier !== appliedUiTier;

  /**
   * Apply a token the user pasted from the portal instead of running the
   * device-code handoff. OpenClaw has offered this for ClawBox AI all along (its
   * "API key" auth tab); the Hermes panel only had the code flow, so a device
   * that couldn't complete the handoff had no way in. The route stores the
   * token and configures the provider in one call — errors propagate so the
   * field can show them inline.
   */
  async function applyClawaiToken(token: string): Promise<void> {
    const res = await fetch("/setup-api/hermes/clawai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, tier: uiTierToDeviceTier(uiTier) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    await reloadClawai();
    setSelectedProvider(CLAWAI_PROVIDER);
    notifyChatHeader();
    setClawaiStatus({ kind: "ok", msg: t("hermesProvider.clawai.nowActive") });
    setConfigured(true);
  }

  async function applyClawai() {
    setApplyingClawai(true);
    setClawaiStatus(null);
    try {
      const res = await fetch("/setup-api/hermes/clawai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Send the UI tier the button is LABELLED with. The route accepts the
        // three-tier vocabulary and does the device mapping itself; sending the
        // device tier here made "Switch to Free" post the Pro plan's model.
        body: JSON.stringify({ tier: uiTier }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const applied = uiTierToDeviceTier(uiTier);
      setClawai((c) => (c ? { ...c, active: true, tier: applied, tierStored: applied, model: data.model } : c));
      setAppliedUiTier(uiTier);
      setClawaiStatus({ kind: "ok", msg: t("hermesProvider.clawai.nowActive") });
      notifyChatHeader();
      setConfigured(true);
    } catch (e) {
      setClawaiStatus({ kind: "err", msg: e instanceof Error ? e.message : t("hermesProvider.clawai.switchFailed") });
    } finally {
      setApplyingClawai(false);
    }
  }

  function saveErrorMessage(data: { error?: unknown }, statusCode: number, keySaved: boolean): string {
    const name = selectedDef?.name ?? selectedProvider;
    if (data?.error === "provider_unauthenticated") {
      // The key DID land (its own POST returned 200); Hermes just hasn't
      // published a model list for the provider yet. Saying "no credentials"
      // here would be flatly wrong and send the user back to re-paste it.
      return keySaved
        ? t("hermesProvider.save.keySavedNoCatalog", { provider: name })
        : t("hermesProvider.save.noCredentials", { provider: name });
    }
    if (data?.error === "catalog_unavailable") {
      return t("hermesProvider.save.catalogUnavailable", { provider: name });
    }
    return typeof data?.error === "string" && data.error ? data.error : `HTTP ${statusCode}`;
  }

  async function saveModelProvider() {
    setSaving(true);
    setSaveStatus(null);
    try {
      const key = apiKey.trim();
      const savingKey = Boolean(selectedDef?.keyProvider) && Boolean(key);

      // CREDENTIAL FIRST. `hermes auth add` is what flips a provider's
      // `authenticated` flag and unlocks its model list, so it has to land
      // before the pairing write. The old order POSTed the pairing first, which
      // meant (a) for an unauthenticated provider the pairing 409'd and the key
      // the user had just pasted was thrown away, and (b) when it did succeed
      // but the key write then failed, the device was already switched to a
      // provider it could not authenticate against, with no rollback.
      if (savingKey) {
        const kr = await fetch("/setup-api/hermes/provider-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: selectedProvider, apiKey: key }),
        });
        const kd = await kr.json().catch(() => ({}));
        if (!kr.ok) throw new Error(typeof kd?.error === "string" && kd.error ? kd.error : `Key: HTTP ${kr.status}`);
        setApiKey("");
        // Pull the now-unlocked live list (the server dropped its cache too).
        refreshModels();
      }

      // Omit the model when we hold no in-scope id — typically right after a
      // first key save, while the list was still empty. The server then writes
      // that provider's OWN recommended default; it can never write a foreign
      // vendor's id, so leaving the choice to it is strictly safer than sending
      // whatever the (empty) dropdown had.
      const res = await fetch("/setup-api/hermes/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: selectedProvider, ...(modelInScope ? { model } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(saveErrorMessage(data, res.status, savingKey));

      // Selecting a non-clawai provider means ClawBox AI is no longer active.
      setClawai((c) => (c ? { ...c, active: false } : c));
      setAppliedUiTier(null);
      if (!modelInScope) refreshModels();
      setSaveStatus({
        kind: "ok",
        msg: savingKey ? t("hermesProvider.save.keySavedOk") : t("hermesProvider.save.ok"),
      });
      notifyChatHeader();
      setConfigured(true);
    } catch (e) {
      setSaveStatus({ kind: "err", msg: e instanceof Error ? e.message : t("hermesProvider.save.failed") });
    } finally {
      setSaving(false);
    }
  }

  const selectCls =
    "w-full rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--coral-bright)]";
  const labelCls = "block text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5";
  // The default row's cyan tint OUTRANKS the coral selection wash. They are
  // usually the same row; when they are not — the customer has clicked a
  // provider they have yet to sign into — "what is running" is the more useful
  // of the two to be able to find again.
  const rowCls = (isSelected: boolean, isDefault: boolean) =>
    `flex items-center gap-3 px-4 py-3.5 w-full text-left border-b border-gray-800 last:border-b-0 transition-colors cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--coral-bright)] has-[:focus-visible]:ring-inset ${
      isDefault
        ? "bg-[var(--cyan-veil)]"
        : isSelected
          ? "bg-orange-500/5"
          : "hover:bg-[var(--surface-card)]"
    }`;

  /** A row's connection state, pulsing while its "make default" call is out. */
  const rowStatus = (id: string) => {
    const row = statusById.get(id);
    if (!row) return null;
    return (
      <ProviderConnectionLabel
        state={row.state}
        className={`shrink-0 ${settingDefault === id ? "animate-pulse" : ""}`}
      />
    );
  };

  function statusLine(s: Status) {
    if (!s) return null;
    // Save/connect results were previously silent to a screen reader.
    return (
      <p
        role={s.kind === "err" ? "alert" : "status"}
        aria-live="polite"
        className={`text-xs mt-1.5 ${s.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}
      >
        {s.msg}
      </p>
    );
  }


  return (
    <div className={`w-full ${embedded ? "" : "max-w-[520px]"}`} data-testid={testId}>
      <div className="card-surface rounded-2xl p-5 sm:p-8">
        <h1 className="text-xl sm:text-2xl font-bold font-display mb-1">{t("hermesProvider.title")}</h1>
        <p id={`${uid}-intro`} className="text-[var(--text-secondary)] mb-5 leading-relaxed text-sm">
          {t("hermesProvider.intro")}
        </p>

        {/* THE HERO — what is answering right now. Absent until the box has a
            default at all, which is the honest state during first-run setup. */}
        {defaultRow && (
          <ProviderDefaultHero
            row={defaultRow}
            model={heroModel}
            onChangeModel={defaultHasRow ? changeModel : undefined}
          />
        )}

        {/* Provider radio-cards (OpenClaw-style), now each carrying its own
            connection state on the right. */}
        <div
          role="radiogroup"
          aria-label={t("hermesProvider.radioGroupLabel")}
          aria-describedby={`${uid}-intro`}
          className="border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-deep)]/50 overflow-hidden"
        >
          {/* Identical to the OpenClaw wizard's row — same component, not a lookalike. */}
          <ClawboxAiProviderRow
            radioName="hermes-ai-provider"
            selected={isClawaiSelected}
            isDefault={statusById.get(CLAWAI_PROVIDER)?.isDefault ?? false}
            onSelect={() => choose(CLAWAI_PROVIDER)}
            trailingBadge={clawai?.active ? (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-emerald-500/15 text-emerald-400 leading-none">
                {t("hermesProvider.clawai.activeBadge")}
              </span>
            ) : null}
            statusSlot={rowStatus(CLAWAI_PROVIDER)}
          />
          {HERMES_PANEL_PROVIDERS.map((provider) => {
            const isSelected = selectedProvider === provider.id;
            const descriptionKey = PROVIDER_DESCRIPTION_KEYS[provider.id];
            const isDefault = statusById.get(provider.id)?.isDefault ?? false;
            return (
              <label key={provider.id} className={rowCls(isSelected, isDefault)}>
                <input
                  type="radio"
                  name="hermes-ai-provider"
                  value={provider.id}
                  checked={isSelected}
                  onChange={() => choose(provider.id)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={`flex items-center justify-center w-5 h-5 rounded-full border-2 shrink-0 ${
                    isSelected ? "border-[var(--coral-bright)]" : "border-gray-600"
                  }`}
                >
                  {isSelected && <span className="w-2.5 h-2.5 rounded-full bg-orange-500" />}
                </span>
                <span aria-hidden="true" className="flex items-center justify-center w-8 h-8 rounded-lg bg-white/[0.06] shrink-0">
                  <AIProviderIcon provider={provider.id} size={22} />
                </span>
                <div className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium text-gray-200">
                    {provider.name}
                  </span>
                  <span className="block text-xs text-[var(--text-muted)]">
                    {descriptionKey ? t(descriptionKey) : provider.description}
                  </span>
                </div>
                {rowStatus(provider.id)}
              </label>
            );
          })}
        </div>

        {summary?.degraded && (
          <p className="mt-3 text-[11px] text-[var(--amber-ink)] opacity-80">
            {t("settings.providers.degraded")}
          </p>
        )}
        {statusError && !summary && (
          <p className="mt-3 text-[11px] text-[var(--text-muted)]">
            {t("settings.providers.loadFailed")}
          </p>
        )}
        {defaultError && (
          <output
            aria-live="polite"
            className="mt-3 block rounded-lg border border-[var(--red-edge)] bg-[var(--red-wash)] px-3 py-2 text-xs text-[var(--red-ink)]"
          >
            {t("settings.providers.defaultFailed", { message: defaultError })}
          </output>
        )}

        {/* Contextual controls for the selection. The min-height keeps the card
            from resizing under the cursor while the user arrows down the list. */}
        <div className="mt-5 min-h-[240px]">
          {isClawaiSelected ? (
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-deep)]/70 p-4">
              <ClawboxAiPlanPicker
                tier={uiTier}
                onTierChange={changeUiTier}
                disabled={applyingClawai || loginBusy}
              />
              {clawai?.hasToken ? (
                <>
                  <button
                    type="button"
                    onClick={applyClawai}
                    disabled={applyingClawai || !clawaiDirty}
                    className="mt-4 w-full rounded-xl bg-[var(--coral-bright)] text-white font-semibold py-2.5 hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {applyingClawai
                      ? t("hermesProvider.clawai.switching")
                      : clawaiDirty
                        ? t("hermesProvider.clawai.switchTo", { tier: CLAWAI_TIER_INFO[uiTier].pillLabel })
                        : t("hermesProvider.clawai.inUse")}
                  </button>
                  {clawai.model && (
                    <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                      {t("hermesProvider.clawai.modelLabel")} <span className="font-mono">{clawai.model}</span>
                    </p>
                  )}
                </>
              ) : (
                <ClawboxAiDeviceLogin
                  deviceCode={login.deviceCode}
                  verificationUrl={login.verificationUrl}
                  polling={login.polling}
                  busy={loginBusy}
                  onStart={() => { void login.start(); }}
                  onSubmitToken={applyClawaiToken}
                />
              )}
              {statusLine(clawaiStatus)}
            </div>
          ) : (
            <div className="space-y-4">
              {selectedDef?.oauthId && (() => {
                const oauthId = selectedDef.oauthId;
                const st = oauth[oauthId];
                const connected = st?.loggedIn;
                const external = st?.flow === "external";
                const flow = signin && signin.providerId === oauthId ? signin : null;
                const showSignInButton = !connected && !external && (!flow || flow.stage === "failed");
                return (
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)]/50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-200">
                          {t("hermesProvider.oauth.signInWith", { provider: selectedDef.name })}
                        </p>
                        <p className="text-xs text-[var(--text-muted)]">
                          {connected
                            ? t("hermesProvider.oauth.connectedDesc")
                            : external
                              ? t("hermesProvider.oauth.cliOnlyDesc")
                              : t("hermesProvider.oauth.availableDesc")}
                        </p>
                      </div>
                      {connected && (
                        <span className="shrink-0 flex items-center gap-1 text-xs font-semibold text-emerald-400">
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>
                          {t("hermesProvider.oauth.connectedBadge")}
                        </span>
                      )}
                      {showSignInButton && (
                        <button
                          type="button"
                          onClick={() => { void startOauth(oauthId); }}
                          className="shrink-0 rounded-lg bg-[var(--coral-bright)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
                        >
                          {flow?.stage === "failed"
                            ? t("hermesProvider.oauth.tryAgain")
                            : t("hermesProvider.oauth.signIn")}
                        </button>
                      )}
                    </div>
                    {!connected && external && st?.cliCommand && (
                      <div className="mt-3">
                        <p className="text-xs text-[var(--text-muted)]">
                          {t("hermesProvider.oauth.cliInstructions")}
                        </p>
                        <code className="mt-1.5 block rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] px-3 py-2 text-xs font-mono text-[var(--text-primary)] overflow-x-auto">
                          {st.cliCommand}
                        </code>
                      </div>
                    )}
                    {!connected && flow?.stage === "starting" && (
                      <p className="mt-3 text-xs text-[var(--text-muted)]" role="status" aria-live="polite">
                        {t("hermesProvider.oauth.starting", { provider: selectedDef.name })}
                      </p>
                    )}
                    {!connected && flow?.stage === "pkce" && (
                      <div className="mt-3 space-y-2">
                        <p className="text-xs text-[var(--text-muted)]">
                          {t("hermesProvider.oauth.pkceInstructions", { provider: selectedDef.name })}{" "}
                          <a
                            href={flow.authUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline text-[var(--text-secondary)]"
                          >
                            {t("hermesProvider.oauth.reopenSignInPage")}
                          </a>
                        </p>
                        <label className="sr-only" htmlFor={`${uid}-oauth-code`}>
                          {t("hermesProvider.oauth.codeLabel", { provider: selectedDef.name })}
                        </label>
                        <input
                          id={`${uid}-oauth-code`}
                          type="text"
                          className={selectCls}
                          placeholder={t("hermesProvider.oauth.codeLabel", { provider: selectedDef.name })}
                          value={oauthCode}
                          autoComplete="off"
                          onChange={(e) => setOauthCode(e.target.value)}
                        />
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => { void submitOauthCode(); }}
                            disabled={oauthBusy || !oauthCode.trim()}
                            className="rounded-lg bg-[var(--coral-bright)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                          >
                            {oauthBusy
                              ? t("hermesProvider.oauth.submitting")
                              : t("hermesProvider.oauth.submitCode")}
                          </button>
                          <button
                            type="button"
                            onClick={resetSignin}
                            className="text-xs text-[var(--text-muted)] underline hover:text-[var(--text-secondary)]"
                          >
                            {t("hermesProvider.oauth.startOver")}
                          </button>
                        </div>
                        {flow.error && (
                          <p role="alert" aria-live="polite" className="text-xs text-red-400">{flow.error}</p>
                        )}
                      </div>
                    )}
                    {!connected && flow?.stage === "device" && (
                      <div className="mt-3 space-y-2">
                        <p className="text-xs text-[var(--text-muted)]">
                          {t("hermesProvider.oauth.deviceInstructions", { provider: selectedDef.name })}
                        </p>
                        <div className="flex items-center gap-2">
                          <span
                            data-testid="hermes-oauth-user-code"
                            className="rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] px-3 py-2 text-base font-mono font-semibold tracking-widest text-[var(--text-primary)]"
                          >
                            {flow.userCode}
                          </span>
                          <button
                            type="button"
                            onClick={() => copyUserCode(flow.userCode)}
                            className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-2 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-card)] transition-colors"
                          >
                            {codeCopied ? t("hermesProvider.oauth.copied") : t("hermesProvider.oauth.copyCode")}
                          </button>
                        </div>
                        {flow.verificationUrl && (
                          <a
                            href={flow.verificationUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-block text-xs font-semibold text-[var(--coral-bright)] underline"
                          >
                            {t("hermesProvider.oauth.openVerificationPage")}
                          </a>
                        )}
                        <div className="flex items-center gap-3">
                          <p className="text-xs text-[var(--text-muted)]" role="status" aria-live="polite">
                            {t("hermesProvider.oauth.waitingApproval")}
                          </p>
                          <button
                            type="button"
                            onClick={resetSignin}
                            className="text-xs text-[var(--text-muted)] underline hover:text-[var(--text-secondary)]"
                          >
                            {t("hermesProvider.oauth.startOver")}
                          </button>
                        </div>
                      </div>
                    )}
                    {!connected && flow?.stage === "failed" && (
                      <p role="alert" aria-live="polite" className="mt-2 text-xs text-red-400">{flow.message}</p>
                    )}
                    {selectedDef.keyProvider && (
                      <p className="text-[11px] text-[var(--text-muted)] mt-2">{t("hermesProvider.oauth.orPasteKey")}</p>
                    )}
                    {!connected && !external && (
                      <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                        {t("hermesProvider.oauth.advancedLabel")}{" "}
                        <button
                          type="button"
                          onClick={openHermesOAuth}
                          className="underline hover:text-[var(--text-secondary)]"
                        >
                          {t("hermesProvider.oauth.dashboardLink")}
                        </button>
                      </p>
                    )}
                  </div>
                );
              })()}
              <div>
                <label className={labelCls} htmlFor={`${uid}-model`}>{t("hermesProvider.model.label")}</label>
                <select
                  id={`${uid}-model`}
                  ref={modelSelectRef}
                  className={selectCls}
                  value={model}
                  disabled={loading || !scope?.models.length}
                  aria-busy={loading}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  {loading && <option value="">{t("hermesProvider.model.loading")}</option>}
                  {!loading && !scope?.models.length && (
                    <option value="">
                      {scope?.authenticated === false
                        ? t("hermesProvider.model.noCredentials")
                        : t("hermesProvider.model.noModels")}
                    </option>
                  )}
                  {(scope?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}{m.description ? ` — ${m.description}` : ""}
                    </option>
                  ))}
                </select>
                {scope?.warning && (
                  <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">{scope.warning}</p>
                )}
                {scope?.savedElsewhere && (
                  // The server tells us the device's saved pairing belongs to a
                  // DIFFERENT provider. Say so, so Save is never a surprise.
                  <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                    {t("hermesProvider.model.savedElsewherePrefix")}{" "}
                    <span className="text-[var(--text-secondary)]">
                      {hermesProviderLabel(scope.savedElsewhere.provider)}
                    </span>
                    {scope.savedElsewhere.model ? (
                      <> · <span className="font-mono">{scope.savedElsewhere.model}</span></>
                    ) : null}
                    {t("hermesProvider.model.savedElsewhereSuffix", {
                      provider: selectedDef?.name ?? selectedProvider,
                    })}
                  </p>
                )}
                {scope?.stale && !loading && (
                  <p className="mt-1.5 text-[11px] text-amber-400/80">
                    {scope.source === "cold-start"
                      ? t("hermesProvider.model.staleColdStart")
                      : t("hermesProvider.model.staleCached")}
                  </p>
                )}
              </div>

              {selectedDef?.keyProvider && (
                <div>
                  <label className={labelCls} htmlFor={`${uid}-key`}>
                    {t("hermesProvider.key.label", { provider: selectedDef.name })}
                  </label>
                  <input
                    id={`${uid}-key`}
                    type="password"
                    className={selectCls}
                    placeholder={t("hermesProvider.key.placeholder")}
                    value={apiKey}
                    autoComplete="off"
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </div>
              )}

              <button
                type="button"
                onClick={saveModelProvider}
                // Refuse a provider/model mismatch client-side too — a cheap
                // echo of the server's 400 so the button is never enabled in a
                // state the POST would reject.
                //
                // …but a provider with no credentials yet has an EMPTY model
                // list by definition, so gating on `modelInScope` alone made
                // Save permanently disabled for exactly the providers whose key
                // this field exists to collect. A pending key is its own reason
                // to enable it (the save path stores the key first, then lets
                // the server pick that provider's own default model).
                disabled={saving || loading || (!modelInScope && !hasPendingKey)}
                className="w-full rounded-xl bg-[var(--coral-bright)] text-white font-semibold py-3 hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {saving ? t("hermesProvider.save.saving") : t("hermesProvider.save.button")}
              </button>
              {statusLine(saveStatus)}
            </div>
          )}
        </div>

        {!embedded && (
          <button
            type="button"
            onClick={() => onNext?.()}
            className="mt-7 w-full rounded-xl bg-[var(--surface-card)] text-[var(--text-primary)] font-semibold py-3 hover:opacity-90 transition-opacity"
          >
            {t("hermesProvider.continue")}
          </button>
        )}
      </div>
    </div>
  );
}
