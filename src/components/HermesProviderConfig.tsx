"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import AIProviderIcon from "./AIProviderIcon";
import ClawboxAiProviderRow from "./ClawboxAiProviderRow";
import ClawboxAiPlanPicker from "./ClawboxAiPlanPicker";
import ClawboxAiDeviceLogin from "./ClawboxAiDeviceLogin";
import { useClawaiDeviceLogin } from "@/hooks/useClawaiDeviceLogin";
import { useHermesModelOptions } from "@/hooks/useHermesModelOptions";
import {
  HERMES_PANEL_PROVIDERS,
  CLAWAI_PROVIDER,
  hermesProviderLabel,
} from "@/lib/hermes-providers";
import {
  CLAWAI_TIER_INFO,
  CLAWAI_TIER_STORAGE_KEY,
  deviceTierToUiTier,
  normalizeClawaiUiTier,
  uiTierToDeviceTier,
  type ClawaiTier,
} from "@/lib/clawbox-ai-tiers";

// Hermes-edition AI-provider panel. Mirrors the OpenClaw AI-models UI (provider
// radio-cards with logos, and the SAME ClawBox AI card — literally the same
// components, see ClawboxAi*.tsx) but drives Hermes' OWN native switching:
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

interface Props {
  embedded?: boolean;
  onNext?: () => void;
  testId?: string;
}

function readStoredUiTier(): ClawaiTier {
  if (typeof window === "undefined") return "flash";
  try {
    return normalizeClawaiUiTier(window.localStorage?.getItem(CLAWAI_TIER_STORAGE_KEY)) ?? "flash";
  } catch {
    return "flash";
  }
}

/**
 * Which PLAN card to show for a paired device.
 *
 * The device tier cannot represent Free: `uiTierToDeviceTier` maps both "free"
 * and "flash" to the device's "flash" (Free and Pro run the same DeepSeek V4
 * Flash weights), so a stored "flash" means Free OR Pro. Trusting it blindly
 * showed "Pro plan — €9/month" to a Free user, and made this panel disagree
 * with the OpenClaw wizard, which reads the stored UI intent. "pro" (Max) is
 * unambiguous and always wins over local storage.
 */
function resolveUiTier(hasToken: boolean, tierStored: string | null): ClawaiTier {
  if (!hasToken) return readStoredUiTier();
  const device = deviceTierToUiTier(tierStored);
  if (device !== "flash") return device;
  return readStoredUiTier() === "free" ? "free" : "flash";
}

export default function HermesProviderConfig({ embedded, onNext, testId }: Props) {
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

  // Tell an already-open chat popup that this device's provider/model/tier
  // changed, so its header re-seeds instead of naming the previous provider
  // (and blocking legal turns) until the whole page is reloaded. Mirrors the
  // OpenClaw side's "clawbox:chat-model-state-changed".
  const notifyChatHeader = useCallback(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new Event("clawbox:hermes-model-state-changed"));
  }, []);

  const pickProvider = useCallback((id: string) => {
    userPickedProviderRef.current = true;
    setSelectedProvider(id);
    setPicked("");
    setSaveStatus(null);
  }, []);

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
  const [oauth, setOauth] = useState<Record<string, { loggedIn: boolean; flow: string; docsUrl?: string }>>({});

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

  /** The provider the DEVICE is configured for, from the unscoped GET. */
  const fetchDeviceProvider = useCallback(async (): Promise<string> => {
    try {
      const res = await fetch("/setup-api/hermes/models", { cache: "no-store" });
      if (!res.ok) return "";
      const data = (await res.json()) as { provider?: unknown };
      return typeof data.provider === "string" ? data.provider : "";
    } catch {
      return "";
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [data, deviceProvider] = await Promise.all([fetchClawai(), fetchDeviceProvider()]);
      if (!alive) return;
      if (data) {
        setClawai(data);
        setUiTier(resolveUiTier(data.hasToken, data.tierStored));
        setAppliedUiTier(data.active ? resolveUiTier(data.hasToken, data.tierStored) : null);
      }
      // Both reads are async, so a user can already have clicked a row by now —
      // silently bouncing them back would discard their pick and the scoped
      // fetch it started.
      if (userPickedProviderRef.current) return;
      if (data?.active) {
        setSelectedProvider(CLAWAI_PROVIDER);
      } else if (deviceProvider && HERMES_PANEL_PROVIDERS.some((p) => p.id === deviceProvider)) {
        setSelectedProvider(deviceProvider);
      }
    })();
    return () => { alive = false; };
  }, [fetchClawai, fetchDeviceProvider]);

  const loadOauth = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/setup-api/hermes/oauth", { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as {
        providers?: { id: string; loggedIn: boolean; flow: string; docsUrl?: string }[];
      };
      const map: Record<string, { loggedIn: boolean; flow: string; docsUrl?: string }> = {};
      for (const p of d.providers ?? []) map[p.id] = { loggedIn: p.loggedIn, flow: p.flow, docsUrl: p.docsUrl };
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
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadOauth, refreshModels]);

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
    onConfiguring: () => setClawaiStatus({ kind: "ok", msg: "Finishing setup on this device…" }),
    onComplete: () => {
      void reloadClawai();
      setSelectedProvider(CLAWAI_PROVIDER);
      setClawaiStatus({ kind: "ok", msg: "ClawBox AI is now your active model" });
    },
    onError: (msg) => setClawaiStatus({ kind: "err", msg }),
  });

  // Open the Hermes dashboard's /env page (via the auth-gated proxy on :8090),
  // where its native OAuth (PKCE / device-code) runs. Same host, dashboard port.
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
    setClawaiStatus({ kind: "ok", msg: "ClawBox AI is now your active model" });
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
      setClawaiStatus({ kind: "ok", msg: "ClawBox AI is now your active model" });
      notifyChatHeader();
    } catch (e) {
      setClawaiStatus({ kind: "err", msg: e instanceof Error ? e.message : "Couldn't switch to ClawBox AI" });
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
        ? `Key saved for ${name}, but it hasn't published a model list yet — reopen this panel in a moment and pick a model.`
        : `${name} has no credentials yet — sign in or paste an API key first.`;
    }
    if (data?.error === "catalog_unavailable") {
      return `Hermes' model list is unreachable right now, so ${name}'s models can't be checked. Try again in a moment.`;
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
      setSaveStatus({ kind: "ok", msg: savingKey ? "Key saved — provider & model updated" : "Saved" });
      notifyChatHeader();
    } catch (e) {
      setSaveStatus({ kind: "err", msg: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  const selectCls =
    "w-full rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] px-3 py-2.5 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--coral-bright)]";
  const labelCls = "block text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] mb-1.5";
  const rowCls = (isSelected: boolean) =>
    `flex items-center gap-3 px-4 py-3.5 w-full text-left border-b border-gray-800 last:border-b-0 transition-colors cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--coral-bright)] has-[:focus-visible]:ring-inset ${
      isSelected ? "bg-orange-500/5" : "hover:bg-[var(--surface-card)]"
    }`;

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
        <h1 className="text-xl sm:text-2xl font-bold font-display mb-1">Hermes models</h1>
        <p id={`${uid}-intro`} className="text-[var(--text-secondary)] mb-5 leading-relaxed text-sm">
          This device runs on Hermes. Choose an inference provider and default model —
          they switch through Hermes natively, no dashboard needed.
        </p>

        {/* Provider radio-cards (OpenClaw-style) */}
        <div
          role="radiogroup"
          aria-label="AI Provider"
          aria-describedby={`${uid}-intro`}
          className="border border-[var(--border-subtle)] rounded-lg bg-[var(--bg-deep)]/50 overflow-hidden"
        >
          {/* Identical to the OpenClaw wizard's row — same component, not a lookalike. */}
          <ClawboxAiProviderRow
            radioName="hermes-ai-provider"
            selected={isClawaiSelected}
            onSelect={() => pickProvider(CLAWAI_PROVIDER)}
            trailingBadge={clawai?.active ? (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide rounded bg-emerald-500/15 text-emerald-400 leading-none">
                Active
              </span>
            ) : null}
          />
          {HERMES_PANEL_PROVIDERS.map((provider) => {
            const isSelected = selectedProvider === provider.id;
            return (
              <label key={provider.id} className={rowCls(isSelected)}>
                <input
                  type="radio"
                  name="hermes-ai-provider"
                  value={provider.id}
                  checked={isSelected}
                  onChange={() => pickProvider(provider.id)}
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
                  <span className="block text-xs text-[var(--text-muted)]">{provider.description}</span>
                </div>
              </label>
            );
          })}
        </div>

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
                      ? "Switching…"
                      : clawaiDirty
                        ? `Switch to ${CLAWAI_TIER_INFO[uiTier].pillLabel}`
                        : "ClawBox AI in use"}
                  </button>
                  {clawai.model && (
                    <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                      Model: <span className="font-mono">{clawai.model}</span>
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
                const st = oauth[selectedDef.oauthId];
                const connected = st?.loggedIn;
                return (
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-deep)]/50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-200">Sign in with {selectedDef.name}</p>
                        <p className="text-xs text-[var(--text-muted)]">
                          {connected ? "Connected — OAuth credentials active." : "OAuth through Hermes (no API key needed)."}
                        </p>
                      </div>
                      {connected ? (
                        <span className="shrink-0 flex items-center gap-1 text-xs font-semibold text-emerald-400">
                          <span className="material-symbols-rounded" style={{ fontSize: 14 }}>check_circle</span>
                          Connected
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={openHermesOAuth}
                          className="shrink-0 rounded-lg bg-[var(--coral-bright)] px-3 py-2 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
                        >
                          Sign in ↗
                        </button>
                      )}
                    </div>
                    {selectedDef.keyProvider && (
                      <p className="text-[11px] text-[var(--text-muted)] mt-2">…or paste an API key below instead.</p>
                    )}
                  </div>
                );
              })()}
              <div>
                <label className={labelCls} htmlFor={`${uid}-model`}>Default model</label>
                <select
                  id={`${uid}-model`}
                  className={selectCls}
                  value={model}
                  disabled={loading || !scope?.models.length}
                  aria-busy={loading}
                  onChange={(e) => setPicked(e.target.value)}
                >
                  {loading && <option value="">Loading…</option>}
                  {!loading && !scope?.models.length && (
                    <option value="">
                      {scope?.authenticated === false
                        ? "No credentials for this provider yet"
                        : "No models available"}
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
                    This device is currently using{" "}
                    <span className="text-[var(--text-secondary)]">
                      {hermesProviderLabel(scope.savedElsewhere.provider)}
                    </span>
                    {scope.savedElsewhere.model ? (
                      <> · <span className="font-mono">{scope.savedElsewhere.model}</span></>
                    ) : null}
                    . Saving switches it to {selectedDef?.name ?? selectedProvider}.
                  </p>
                )}
                {scope?.stale && !loading && (
                  <p className="mt-1.5 text-[11px] text-amber-400/80">
                    {scope.source === "cold-start"
                      ? "Hermes hasn't published a model list yet — showing a minimal fallback."
                      : "Showing a cached model list; Hermes' live catalogue is unreachable."}
                  </p>
                )}
              </div>

              {selectedDef?.keyProvider && (
                <div>
                  <label className={labelCls} htmlFor={`${uid}-key`}>{selectedDef.name} API key</label>
                  <input
                    id={`${uid}-key`}
                    type="password"
                    className={selectCls}
                    placeholder="Paste API key (optional if already set)"
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
                {saving ? "Saving…" : "Save model & provider"}
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
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
