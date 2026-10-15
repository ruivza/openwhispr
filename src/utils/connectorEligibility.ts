// import type { UsageState } from "../lib/usageStore";

/**
 * Local connector availability is independent of official account entitlements.
 */
export function canUseLocalConnectors(): boolean {
  return true;
}
// export function hasConnectorPlan(usage: UsageState, isSubscribedFlag: boolean): boolean {
// Connectors are paid-only (subscription or trial, like useUsage's
// hasPaidAccess). Usage data is only loaded while a surface mounts useUsage(),
// so other windows (the voice assistant) pass the persisted isSubscribed flag,
// which the API also sets for trials.
//   if (usage.status === "success") return usage.data.isSubscribed || usage.data.isTrial;
//   return isSubscribedFlag;
// }
