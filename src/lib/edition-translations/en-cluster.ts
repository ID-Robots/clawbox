/**
 * Settings → System → Cluster (TASK-2670): a Workstation's Sparks and its
 * inference engine on one page, for the owner.
 *
 * "Spark" and "SSH" are names and stay as they are in every language; "tok/s" is
 * the unit engines print. `n/a` is shown where a figure is not available and
 * never as a zero, which would claim an idle machine.
 */
export const clusterEn: Record<string, string> = {
  "cluster.tab": "Cluster",
  "cluster.loading": "Reading the cluster…",
  "cluster.loadFailed": "The cluster status could not be read.",
  "cluster.updated": "Updated {time}",
  "cluster.refresh": "Refresh now",
  "cluster.thisBox": "This Spark",
  "cluster.online": "Online",
  "cluster.offline": "Offline",
  "cluster.warnOne": "1 Spark is unreachable: {names}. Its figures are not shown.",
  "cluster.warnMany": "{count} Sparks are unreachable: {names}. Their figures are not shown.",
  "cluster.cpu": "CPU",
  "cluster.memory": "Memory",
  "cluster.memoryUnified": "Memory (unified)",
  "cluster.memoryUnifiedHint": "CPU and GPU share this Spark's memory, so this is the GPU's memory too.",
  "cluster.gpu": "GPU",
  "cluster.gpuMemory": "GPU memory",
  "cluster.temperature": "Temperature",
  "cluster.disk": "Disk",
  "cluster.na": "n/a",
  "cluster.failure.unreachable": "Cannot be reached on the cluster network.",
  "cluster.failure.timeout": "Did not answer in time.",
  "cluster.failure.auth": "Refused this box's SSH key.",
  "cluster.failure.hostKey": "Its SSH host key is not trusted by this box.",
  "cluster.failure.failed": "Answered, but its figures could not be read.",
  "cluster.engine": "Engine",
  "cluster.engineGate": "Inference gate",
  "cluster.engineModel": "Model",
  "cluster.engineActive": "Active requests",
  "cluster.engineQueued": "Queued requests",
  "cluster.engineTokens": "Tokens per second",
  "cluster.engineTokensValue": "{value} tok/s",
  "cluster.engineNone": "No AI engine is set up. Add one under Settings → Local AI → External engine.",
  "cluster.engineNoMetrics": "The engine publishes no metrics this page can read, so its load shows n/a.",
  "cluster.engineReason.unreachable": "The gate did not answer.",
  "cluster.engineReason.notLan": "The gate is outside the local network, so it was not contacted.",
  "cluster.engineReason.unauthorized": "The gate refused the API key.",
  "cluster.engineReason.badResponse": "The gate answered with something that is not an engine's reply.",
  "cluster.engineReason.addressRefused": "The gate's address is not allowed.",
  "cluster.engineUnreadable": "This box could not read its AI engine settings, so the engine is not shown.",
  "cluster.engineChanging": "The AI settings are being changed right now, so the engine was not read. Its load shows again once that is done.",
};
