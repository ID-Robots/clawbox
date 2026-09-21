/**
 * How ClawBox tells the core CLI who owns the gateway's lifecycle.
 *
 * THE BUG THIS EXISTS FOR. On a box whose gateway is the ClawBox SYSTEM unit
 * `clawbox-gateway.service`, `openclaw doctor --fix` refused to start at all —
 * measured against OpenClaw 2026.9.3 on a Jetson Nano on 2026-09-16, with the
 * sentence in full:
 *
 *     Doctor could not enter maintenance. Error: Gateway service ownership or
 *     shutdown could not be verified. Run `openclaw gateway status --deep` and
 *     stop it through its service owner before retrying.
 *
 * The advice cannot work, and that is the whole defect. `openclaw gateway
 * status --deep` on the same box answers `Service: systemd user (enabled)`
 * while there is NO user unit at all — it lists the real one under "Other
 * gateway-like services detected". So doctor looks for a user-level service it
 * can prove it owns, finds neither an owned one nor an absent one, and refuses.
 * Stopping `clawbox-gateway.service` first does NOT help: the refusal is about
 * the verdict, not about the process. Measured both ways on the same box.
 *
 * WHAT THE CORE ACTUALLY CHECKS. `doctor-maintenance` only runs the ownership
 * inspection when it believes it manages the service:
 *
 *     if (params.root && isDefaultInstallIdentity(env)
 *         && !isServiceRepairExternallyManaged() && await shouldManageGatewayService(env))
 *
 * and `doctor-service-repair-policy` resolves both of those gates from the
 * environment: `OPENCLAW_SERVICE_REPAIR_POLICY=external` sets the first, and
 * `OPENCLAW_SUPERVISOR_MODE=external` (via `isGatewayExternallySupervised`)
 * sets the second AND makes `shouldManageGatewayService` answer false. With the
 * block skipped, doctor never forms a verdict it cannot form, acquires its state
 * coordinators and runs every non-service repair — which is the whole of what
 * either ClawBox caller wants from it.
 *
 * WHY BOTH, when one is provably enough. Measured on the same box, with the
 * gateway stopped: no env exits 1; `OPENCLAW_SERVICE_REPAIR_POLICY=external`
 * alone exits 0; both exit 0. The core's own `docs/cli/gateway.md` draws the
 * distinction and asks for both:
 *
 *     `OPENCLAW_SERVICE_REPAIR_POLICY=external` remains a separate Doctor
 *     repair policy. It does not declare runtime ownership; supervisors that
 *     need both behaviors should set both variables.
 *
 * ClawBox needs both behaviours and that is not a hedge. It owns the runtime —
 * both callers stop `clawbox-gateway.service` through systemd themselves and
 * start it again afterwards — so a doctor that decided to stop or restart a
 * gateway behind the caller's back would be racing the caller for the same
 * unit. The repair policy alone leaves that door open; it is the supervisor
 * mode that shuts it.
 *
 * SCOPED TO DOCTOR, deliberately, and never exported into a general child
 * environment. `OPENCLAW_SUPERVISOR_MODE=external` also disables the core's
 * self-update ("OpenClaw self-update is disabled while gateway lifecycle is
 * managed by an external supervisor") and refuses every `openclaw gateway`
 * mutation. Neither matters to `doctor --fix`; both would matter a great deal
 * to a future caller that inherited this from a shared helper, which is why
 * `updater.ts` wraps its doctor environment rather than `openclawChildEnv`.
 *
 * A MODULE of its own rather than another export on `@/lib/openclaw-config`,
 * for the reason `openclaw-doctor-blocker.ts` gives at length: fifty-nine
 * suites replace that module with a hand-written factory, and an export none of
 * them lists is `undefined` at runtime. Both doctor callers import this one
 * directly and nothing mocks it.
 */

/** The core reads this as "something else owns starting and stopping me". */
export const OPENCLAW_SUPERVISOR_MODE_ENV = "OPENCLAW_SUPERVISOR_MODE";

/** The core reads this as "stay read-only about service lifecycle repairs". */
export const OPENCLAW_SERVICE_REPAIR_POLICY_ENV = "OPENCLAW_SERVICE_REPAIR_POLICY";

/** The value both variables take; the core compares it lowercased and trimmed. */
export const OPENCLAW_EXTERNAL_SUPERVISOR_VALUE = "external";

/**
 * The environment that makes the core accept ClawBox as the gateway's owner.
 *
 * Frozen because it is module-level shared state that three call sites spread
 * into their own environments; a caller that mutated it would change doctor's
 * behaviour for the next one.
 */
export const EXTERNAL_GATEWAY_SUPERVISOR_ENV: Readonly<Record<string, string>> = Object.freeze({
  [OPENCLAW_SUPERVISOR_MODE_ENV]: OPENCLAW_EXTERNAL_SUPERVISOR_VALUE,
  [OPENCLAW_SERVICE_REPAIR_POLICY_ENV]: OPENCLAW_EXTERNAL_SUPERVISOR_VALUE,
});

/**
 * `base` with the ownership declaration applied LAST.
 *
 * Last on purpose: an inherited `OPENCLAW_SUPERVISOR_MODE` from the gateway's
 * own unit file — or from a shell an operator ran the setup server from — must
 * not be able to put doctor back into the refusal this module exists to end.
 * The declaration is a fact about this device, not a default.
 */
export function withExternalGatewaySupervisor(
  base: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  // `NodeJS.ProcessEnv` is augmented with a REQUIRED `NODE_ENV` in this repo,
  // so a merge of two plain objects cannot prove it is one — while every
  // consumer of the result is a child-process `env` option, where an absent
  // `NODE_ENV` is ordinary and both real callers pass a base that has it. The
  // parameter stays loose so a caller can hand over an object literal.
  return { ...base, ...EXTERNAL_GATEWAY_SUPERVISOR_ENV } as NodeJS.ProcessEnv;
}

/**
 * Doctor refusing over WHO OWNS THE SERVICE rather than over anything it found.
 *
 * All three sentences come from `assertDoctorMaintenanceInspection` and its two
 * neighbours in `doctor-maintenance`, and all three are answered by the
 * environment above — so a box that still prints one is a box where that
 * environment did not reach the child, not a box with a broken config. Callers
 * use this to say so instead of repeating the core's unusable advice.
 *
 * Fails SAFE, like every other matcher in this codebase: a reworded upstream
 * sentence stops matching and the caller reverts to its older, stricter and
 * more generic failure message rather than to a wrong classification.
 */
export const DOCTOR_SERVICE_OWNERSHIP_RE =
  /Gateway service ownership or shutdown could not be verified|Doctor and the managed Gateway select different config or state directories|The update parent owns Gateway activation/i;
