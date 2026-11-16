import { byokFileSizeLimit } from "./transcriptionRoute.ts";

export function uploadFileSizeState(
  sizeBytes: number,
  {
    local,
    cloud,
    pro,
    managed,
    provider,
  }: { local: boolean; cloud: boolean; pro: boolean; managed: boolean; provider: string }
) {
  const cloudUpload = cloud && !managed;
  const fileTooLarge = cloudUpload && sizeBytes > 500 * 1024 * 1024;
  const requiresUpgrade = cloudUpload && !pro && sizeBytes > 25 * 1024 * 1024;
  // BYOK/custom/self-hosted caps are per request. Large imports are split,
  // without an account or subscription requirement. Managed audio is prepared
  // and split to its endpoint's cap in main, so it has no limit here either.
  const isLargeFile =
    !managed && !local && sizeBytes > (cloudUpload ? 4 * 1024 * 1024 : byokFileSizeLimit(provider));
  return {
    fileTooLarge,
    requiresUpgrade,
    isLargeFile,
    errorKey: fileTooLarge ? "fileTooLarge" : requiresUpgrade ? "paidPlanRequired" : null,
  };
}
