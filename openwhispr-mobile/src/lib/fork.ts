import type { InferenceSelection } from '@/lib/mobileProviders';
import type { UserConfig } from '@/types';

// This build has no replacement hosted backend. Local execution and direct BYOK
// remain real capabilities; neither requires a fabricated account or entitlement.
export const HOSTED_SERVICES_ENABLED = false;
export const HOSTED_SERVICES_MESSAGE = 'Official cloud services are disabled in this build. Use On-Device or Bring Your Own Key in AI Models.';

export function requireHostedServices(): void {
  throw Object.assign(new Error(HOSTED_SERVICES_MESSAGE), { code: 'HOSTED_SERVICES_DISABLED', retryable: false });
}

export function isOfficialHostedUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.+$/, '');
    return host === 'openwhispr.com' || host.endsWith('.openwhispr.com');
  } catch {
    return false;
  }
}

export function localSelection(selection: InferenceSelection | undefined): InferenceSelection {
  return !selection || selection.mode === 'openwhispr' ? { mode: 'local' } : selection;
}

// Migrate only official routes. Keep provider models/endpoints/credential refs,
// private-mode return choices and all unrelated user preferences intact.
export function migrateHostedConfig(config: UserConfig): UserConfig {
  const selections = <T extends Partial<Record<string, InferenceSelection>>>(value: T): T =>
    Object.fromEntries(Object.entries(value).map(([scope, selection]) => [scope, localSelection(selection)])) as T;
  return {
    ...config,
    defaultMode: config.defaultMode === 'cloud' ? 'private' : config.defaultMode,
    cloudBackupEnabled: false,
    ...(config.inference ? { inference: selections(config.inference) } : {}),
    ...(config.rememberedInference ? { rememberedInference: Object.fromEntries(
      Object.entries(config.rememberedInference).map(([scope, value]) => [scope, selections(value ?? {})]),
    ) } : {}),
    ...(config.privateModeReturn ? { privateModeReturn: { ...config.privateModeReturn, pinned: selections(config.privateModeReturn.pinned) } } : {}),
  };
}
