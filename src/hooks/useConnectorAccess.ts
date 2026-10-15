import { canUseLocalConnectors } from "../utils/connectorEligibility";
import { usePolicyStore } from "../stores/policyStore";
import { isConnectorsAllowed, isConnectorsBlockedByOrg } from "../stores/policyRules";
// import { useSyncExternalStore } from "react";
// import { useSettingsStore } from "../stores/settingsStore";
// import { getUsageState, subscribeUsage } from "../lib/usageStore";
// import { readIsSubscribed, subscribeIsSubscribed } from "../lib/subscriptionFlag";
// import { hasConnectorPlan } from "../utils/connectorEligibility";

export interface ConnectorAccess {
  /** Feature availability; this does not claim an official paid entitlement. */
  available: boolean;
  // isPaid: boolean;
  blockedByOrg: boolean;
  /**
   * False while the policy loads, after a failed fetch, or when the org requires
   * a newer app: chat has no connector tools then, so nothing may offer them.
   */
  connectorsAllowed: boolean;
}

export function useConnectorAccess(): ConnectorAccess {
  // These are local third-party connections. Their own OAuth grants determine
  // access; no official account, usage fetch, or subscription is consulted.
  const blockedByOrg = usePolicyStore(isConnectorsBlockedByOrg);
  const connectorsAllowed = usePolicyStore(isConnectorsAllowed);
  return {
    available: canUseLocalConnectors(),
    blockedByOrg,
    connectorsAllowed,
  };
  // const isSignedIn = useSettingsStore((state) => state.isSignedIn);
  // const usage = useSyncExternalStore(subscribeUsage, getUsageState);
  // const isSubscribedFlag = useSyncExternalStore(subscribeIsSubscribed, readIsSubscribed);
  // return {
  //   isPaid: isSignedIn && hasConnectorPlan(usage, isSubscribedFlag),
  //   blockedByOrg,
  //   connectorsAllowed,
  // };
}
