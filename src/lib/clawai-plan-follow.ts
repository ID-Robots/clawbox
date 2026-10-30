/**
 * Following the ClawBox AI plan while the box runs.
 *
 * The status poll records the plan the portal answers (`persistClawaiPlanTier`)
 * and this is what it hands a CHANGE to. Before it, a plan that moved while the
 * box was up changed nothing but the stored word: on OpenClaw the cloud voice
 * of a Max plan is armed only by `gateway-pre-start.sh`, which runs when the
 * gateway starts, so an account upgraded from Free to Max kept answering
 * "ClawBox cloud — not available" in Settings → Voice, and every cloud voice
 * with it, until somebody restarted the box.
 *
 * WHAT IT DOES, in the order the link path already does it (the configure
 * route restarts the gateway and then applies the cloud defaults):
 *
 *  1. On OpenClaw, when the new plan covers the cloud voice and the box cannot
 *     call one yet, restart the gateway ONCE, so the boot script arms the voice
 *     by its own ownership rules. Those rules are not restated here — a second
 *     opinion about whose speech route the `openai` slot is would be the kind
 *     `@/lib/clawai-cloud-defaults` refuses to hold. The restart is the
 *     gateway's own unit (`restartGatewayAnsweringEarly`), and it is skipped
 *     while an update owns the box, which restarts the gateway itself.
 *  2. Then apply the cloud defaults (`applyClawaiCloudDefaults`), which put the
 *     box on the cloud engines the plan now covers unless the owner chose
 *     otherwise. On Hermes this alone is the arm: the voice there is read from
 *     the plan on every request, and the applier writes the endpoint when it
 *     selects the cloud voice.
 *
 * IT ONLY EVER PROMOTES, like the applier. A plan that stops covering the
 * voice is withdrawn by the boot scripts, gated on the plan alone; nothing here
 * takes anything away.
 *
 * Never throws, and runs one change at a time: two pages polling at once can
 * both hand over the same change, and the second then finds nothing to do.
 */

import type { ClawaiPlanChange } from "@/lib/clawai-plan-tier";
import { CLOUD_TTS_ENTITLED_TIER } from "@/lib/clawai-cloud-defaults-state";
import { CLAWBOX_AI_PLAN_UNPAID } from "@/lib/clawbox-ai-models";
import { createSerialLock } from "@/lib/serial-lock";

const withFollow = createSerialLock();
let pending = 0;

/**
 * A plan change is still being followed — the gateway restarting to arm the
 * cloud voice, or the defaults being applied. The Voice panel reads this to say
 * "setting up" rather than "not available", and to look again shortly.
 */
export function clawaiPlanFollowPending(): boolean {
  return pending > 0;
}

/** Follow one recorded plan change. Never rejects. */
export function followClawaiPlanChange(change: ClawaiPlanChange): Promise<void> {
  pending += 1;
  return withFollow(() => followOnce(change))
    .catch((err: unknown) => {
      console.warn("[clawai-plan-follow] could not follow the plan change:", err instanceof Error ? err.message : err);
    })
    .finally(() => {
      pending -= 1;
    });
}

async function followOnce(change: ClawaiPlanChange): Promise<void> {
  // An unpaid or unknown plan covers nothing to promote to.
  if (change.next === null || change.next === CLAWBOX_AI_PLAN_UNPAID) return;
  console.log(`[clawai-plan-follow] the ClawBox AI plan is now ${change.next} (was ${change.previous ?? "not known"})`);
  if (change.next === CLOUD_TTS_ENTITLED_TIER) {
    // The defaults below are worth applying whatever happened here.
    await armOpenclawCloudVoice().catch((err: unknown) => {
      console.warn("[clawai-plan-follow] could not arm the cloud voice:", err instanceof Error ? err.message : err);
    });
  }
  const { applyClawaiCloudDefaults } = await import("@/lib/clawai-cloud-defaults");
  await applyClawaiCloudDefaults({ trigger: "plan" });
}

/**
 * Bring the gateway's boot script round to arm the cloud voice, when OpenClaw
 * is this box's assistant, the box holds a ClawBox AI credential, and the voice
 * it has cannot reach the cloud yet. Answers whether it restarted.
 */
async function armOpenclawCloudVoice(): Promise<boolean> {
  const [{ getActiveHarness }, { gatewayIsAbsent }] = await Promise.all([
    import("@/lib/harness"),
    import("@/lib/openclaw-config"),
  ]);
  if (gatewayIsAbsent() || (await getActiveHarness()) !== "openclaw") return false;
  const [{ resolveClawaiToken }, { readVoiceConfig }, { cloudSpeechTarget }] = await Promise.all([
    import("@/lib/harness/credentials"),
    import("@/lib/voice-box"),
    import("@/lib/voice-output"),
  ]);
  if ((await resolveClawaiToken()) === null) return false;
  if (cloudSpeechTarget(await readVoiceConfig("openclaw")) !== null) return false;
  const { isUpdateLocked } = await import("@/lib/update-lock");
  if (await isUpdateLocked()) {
    console.log("[clawai-plan-follow] an update owns the box; its own gateway restart arms the cloud voice");
    return false;
  }
  const { restartGatewayAnsweringEarly } = await import("@/lib/gateway-hot-apply");
  console.log("[clawai-plan-follow] restarting the gateway so it arms the cloud voice of the new plan");
  const { back } = await restartGatewayAnsweringEarly();
  if (!(await back)) {
    console.warn("[clawai-plan-follow] the gateway did not answer after the restart; the next start arms the voice");
  }
  return true;
}
