/**
 * Following the ClawBox AI plan while the box runs.
 *
 * The status poll records the plan the portal answers (`persistClawaiPlanTier`)
 * and this is what it hands a CHANGE to. Before it, a plan that moved while the
 * box was up changed nothing but the stored word: on OpenClaw the cloud voice
 * of a Max plan is armed — and withdrawn — only by `gateway-pre-start.sh`,
 * which runs when the gateway starts. So an account upgraded from Free to Max
 * kept answering "ClawBox cloud — not available" in Settings → Voice, and one
 * moved from Max to Free kept every cloud voice listed and every spoken reply
 * going to a proxy that no longer serves it, until somebody restarted the box.
 *
 * WHAT IT DOES, in the order the link path already does it (the configure
 * route restarts the gateway and then applies the cloud defaults):
 *
 *  1. On OpenClaw, restart the gateway ONCE, so the boot script arms or
 *     withdraws the voice by its own ownership rules: when the new plan covers
 *     the cloud voice and the box cannot call one yet, or when the new plan is
 *     one we were told does not cover it and the box still holds the entry the
 *     boot stamped. Those rules are not restated here — a second opinion about
 *     whose speech route the `openai` slot is would be the kind
 *     `@/lib/clawai-cloud-defaults` refuses to hold. The restart is the
 *     gateway's own unit (`restartGatewayAnsweringEarly`), and it is skipped
 *     while an update owns the box, which restarts the gateway itself.
 *  2. Then, for a paid plan, apply the cloud defaults
 *     (`applyClawaiCloudDefaults`), which put the box on the cloud engines the
 *     plan now covers unless the owner chose otherwise. On Hermes this alone is
 *     the arm: the voice there is read from the plan on every request, and the
 *     applier writes the endpoint when it selects the cloud voice.
 *
 * A DOWNGRADE IS VISIBLE AT ONCE, before the restart is done: the box's voice
 * is read through the plan on record (`openclawVoiceConfigForPlan` in
 * `@/lib/voice-box`), so the panel stops offering the cloud voices and spoken
 * replies fall back to the box's own voice the moment the poll writes the plan.
 * The restart only brings the gateway's own file round to what it already
 * shows. A plan that is not on record withdraws nothing, as at boot.
 *
 * Never throws, and runs one change at a time: two pages polling at once can
 * both hand over the same change, and the second then finds nothing to do.
 */

import type { ClawaiPlanChange, ClawaiPlanTier } from "@/lib/clawai-plan-tier";
import { CLOUD_TTS_ENTITLED_TIER } from "@/lib/clawai-cloud-defaults-state";
import { CLAWBOX_AI_PLAN_UNPAID } from "@/lib/clawbox-ai-models";
import { createSerialLock } from "@/lib/serial-lock";

const withFollow = createSerialLock();
let pending = 0;

/**
 * The plan on record a withdrawal last restarted the gateway for (a recorded
 * change's, or a read's), so reading the voice (`followClawaiPlanOnRecord`)
 * restarts it at most once per plan on record — never in a loop over an entry
 * the boot script declines to remove. Forgotten when the plan moves.
 */
let withdrawTriedFor: ClawaiPlanTier | null = null;

/**
 * A plan change is still being followed UP — the gateway restarting to arm the
 * cloud voice of a new Max plan, or the defaults being applied. The Voice panel
 * reads this to say "setting up" rather than "not available", and to look again
 * shortly. A downgrade is never pending: there is nothing to set up, and the
 * voice it takes away is hidden from the moment the plan is on record.
 */
export function clawaiPlanFollowPending(): boolean {
  return pending > 0;
}

/** Follow one recorded plan change. Never rejects. */
export function followClawaiPlanChange(change: ClawaiPlanChange): Promise<void> {
  const arming = change.next === CLOUD_TTS_ENTITLED_TIER;
  if (arming) pending += 1;
  return withFollow(() => followOnce(change))
    .catch((err: unknown) => {
      console.warn("[clawai-plan-follow] could not follow the plan change:", err instanceof Error ? err.message : err);
    })
    .finally(() => {
      if (arming) pending -= 1;
    });
}

/**
 * Bring the gateway round to a plan ON RECORD that no longer covers the cloud
 * voice, when it still holds the entry the boot stamped — the case no change
 * is left to follow: a follow whose restart was refused, or a store that moved
 * while the box was down. Asked by the Voice panel's read (`GET
 * /setup-api/tts`) for the owner and the box's own agent; at most one restart
 * per plan on record. Never rejects.
 */
export function followClawaiPlanOnRecord(): Promise<void> {
  return withFollow(async () => {
    const { readClawaiPlanOnRecord, clawaiSpeechWithdrawable } = await import("@/lib/clawai-plan-tier");
    const plan = await readClawaiPlanOnRecord();
    if (plan === null || !clawaiSpeechWithdrawable(plan, CLOUD_TTS_ENTITLED_TIER) || withdrawTriedFor === plan) return;
    withdrawTriedFor = plan;
    await withdrawOpenclawCloudVoice();
  }).catch((err: unknown) => {
    console.warn("[clawai-plan-follow] could not follow the plan on record:", err instanceof Error ? err.message : err);
  });
}

async function followOnce(change: ClawaiPlanChange): Promise<void> {
  // An unknown plan is not a downgrade, and covers nothing to promote to.
  if (change.next === null) return;
  console.log(`[clawai-plan-follow] the ClawBox AI plan is now ${change.next} (was ${change.previous ?? "not known"})`);
  withdrawTriedFor = null;
  // The defaults below are worth applying whatever happened here.
  const voice = change.next === CLOUD_TTS_ENTITLED_TIER ? armOpenclawCloudVoice() : withdrawOpenclawCloudVoice();
  const restarted = await voice.catch((err: unknown) => {
    console.warn("[clawai-plan-follow] could not follow the cloud voice:", err instanceof Error ? err.message : err);
    return false;
  });
  // A withdrawal this follow restarted for is not a read's to repeat; one whose
  // restart was refused is, once.
  if (restarted && change.next !== CLOUD_TTS_ENTITLED_TIER) withdrawTriedFor = change.next;
  // An unpaid plan covers nothing to promote to.
  if (change.next === CLAWBOX_AI_PLAN_UNPAID) return;
  const { applyClawaiCloudDefaults } = await import("@/lib/clawai-cloud-defaults");
  await applyClawaiCloudDefaults({ trigger: "plan" });
}

/** OpenClaw is this box's assistant and its gateway is installed. */
async function onOpenclaw(): Promise<boolean> {
  const [{ getActiveHarness }, { gatewayIsAbsent }] = await Promise.all([
    import("@/lib/harness"),
    import("@/lib/openclaw-config"),
  ]);
  return !gatewayIsAbsent() && (await getActiveHarness()) === "openclaw";
}

/**
 * Bring the gateway's boot script round to arm the cloud voice, when OpenClaw
 * is this box's assistant, the box holds a ClawBox AI credential, and the voice
 * it has cannot reach the cloud yet. Answers whether it restarted.
 */
async function armOpenclawCloudVoice(): Promise<boolean> {
  if (!(await onOpenclaw())) return false;
  const [{ resolveClawaiToken }, { readVoiceConfig }, { cloudSpeechTarget }] = await Promise.all([
    import("@/lib/harness/credentials"),
    import("@/lib/voice-box"),
    import("@/lib/voice-output"),
  ]);
  if ((await resolveClawaiToken()) === null) return false;
  if (cloudSpeechTarget(await readVoiceConfig("openclaw")) !== null) return false;
  return await restartGatewayForBootScript("arms the cloud voice of the new plan");
}

/**
 * Bring the gateway's boot script round to withdraw the cloud voice of a plan
 * that no longer covers it, when OpenClaw is this box's assistant and the
 * gateway's file still holds the entry the boot stamped. The FILE, not the
 * voice view: that one already leaves the entry out. Answers whether it
 * restarted.
 */
async function withdrawOpenclawCloudVoice(): Promise<boolean> {
  if (!(await onOpenclaw())) return false;
  const [{ readConfig }, { clawboxAiProxyUrls }, { withoutClawboxCloudVoice }] = await Promise.all([
    import("@/lib/openclaw-config"),
    import("@/lib/voice-box"),
    import("@/lib/voice-output"),
  ]);
  const config = await readConfig();
  if (withoutClawboxCloudVoice(config, clawboxAiProxyUrls()) === config) return false;
  return await restartGatewayForBootScript("withdraws the cloud voice the plan no longer covers");
}

/** Restart the gateway so its boot script does `what`, unless an update owns the box. */
async function restartGatewayForBootScript(what: string): Promise<boolean> {
  const { isUpdateLocked } = await import("@/lib/update-lock");
  if (await isUpdateLocked()) {
    console.log(`[clawai-plan-follow] an update owns the box; its own gateway restart ${what}`);
    return false;
  }
  const { restartGatewayAnsweringEarly } = await import("@/lib/gateway-hot-apply");
  console.log(`[clawai-plan-follow] restarting the gateway so it ${what}`);
  const { back } = await restartGatewayAnsweringEarly();
  if (!(await back)) {
    console.warn(`[clawai-plan-follow] the gateway did not answer after the restart; its next start ${what}`);
  }
  return true;
}
