/**
 * A provider sign-in or sign-out task (src/lib/provider-auth-tasks.ts) as
 * GET /setup-api/background-jobs/tasks answers it, for component tests that
 * stand in for the box (TASK-2148).
 */
export function providerTask(id: string, fields: {
  provider: string;
  label: string;
  action?: "sign-in" | "sign-out";
  state: string;
  error?: string | null;
  /** The step running now, for a running task. */
  step?: string;
  status?: string | null;
}) {
  const action = fields.action ?? "sign-out";
  const ids = action === "sign-out" ? ["remove", "restart", "verify"] : ["save", "restart", "verify"];
  return {
    id,
    kind: action === "sign-out" ? "provider-sign-out" : "provider-sign-in",
    group: "provider-auth",
    title: action === "sign-out" ? `Signing out of ${fields.label}` : `Connecting ${fields.label}`,
    meta: { subject: fields.provider, action, label: fields.label },
    state: fields.state,
    steps: ids.map((step) => ({
      id: step,
      label: step,
      weight: 1,
      state: fields.state === "succeeded" ? "done" : fields.step === step ? "running" : "pending",
    })),
    status: fields.status ?? null,
    completed: null,
    total: null,
    startedAt: 1,
    updatedAt: 1,
    stepStartedAt: 1,
    finishedAt: fields.state === "running" ? null : 2,
    error: fields.error ?? null,
    result: (fields.state === "succeeded" ? { signedOut: true, provider: fields.provider } : null) as Record<string, unknown> | null,
    log: [],
    logCount: 0,
    runner: "r",
    dismissed: false,
    cancellable: false,
    cancelRequested: false,
    unit: null,
    adoptedAt: null,
    percent: null,
    etaSeconds: null,
  };
}
