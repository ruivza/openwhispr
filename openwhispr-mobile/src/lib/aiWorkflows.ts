import { HOSTED_SERVICES_ENABLED, localSelection } from '@/lib/fork';
import type { AuthUser } from '@/lib/authClient';
import type { InferenceSelection } from '@/lib/mobileProviders';
import { localModeDefault, MODE_LABELS, type CloudAccess } from '@/lib/inferenceModes';
import { isLocalModelKey, LOCAL_MODEL_TITLES } from '@/lib/localModelCatalog';
import { providerDisplayName, type MobileInferenceScope } from '@/lib/mobileProviders';
import type { ProcessingMode, UserConfig } from '@/types';

export const WORKFLOW_LABELS: Record<MobileInferenceScope, string> = {
  dictation: 'Dictation',
  upload: 'Uploads',
  cleanup: 'Text Cleanup',
  notes: 'Note Formatting & Titles',
  agent: 'Chat & Voice Assistant',
};

export const WORKFLOWS = Object.keys(WORKFLOW_LABELS) as MobileInferenceScope[];

// Bring Your Own Key dictation skips these workflows until a selection is saved for them.
export const UNSET_PROVIDER_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  cleanup: 'Not saved yet. Cleanup is skipped until you save a selection.',
  agent:
    // 'Not saved yet. The voice assistant is skipped until you save a selection; note chat uses OpenWhispr Cloud.',
    'Choose a provider for the voice assistant. Note chat uses your saved On-Device or BYOK selection.',
};

// On-Device cleanup on an iPhone that can never run Apple Intelligence.
export const ON_DEVICE_CLEANUP_UNSUPPORTED_NOTE =
  "This iPhone can't run On-Device cleanup, so it's skipped. Choose Bring Your Own Key to clean up your transcripts.";

// Dictation owns Local Mode: On-Device dictation turns it on, and the other modes turn it off.
export const LOCAL_MODE_DICTATION_NOTES = {
  on: 'Local Mode is on: dictation stays on this iPhone and notes ask before leaving it. Choose Bring Your Own Key to turn it off.',
  off: 'On-Device turns on Local Mode: dictation stays on this iPhone and notes ask before leaving it.',
};

// What Local Mode means for note formatting and chat, which run on this iPhone first.
export const ON_DEVICE_MODE_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  upload: 'Local Mode keeps uploads on this iPhone unless you save a Bring Your Own Key selection.',
  notes: 'Local Mode formats notes on this iPhone and asks before sending one to your choice here.',
  cleanup:
    // 'In Private mode, cleanup runs on this iPhone, or sends only the transcript text to your provider with Bring Your Own Key. OpenWhispr Cloud cleanup is skipped until Private mode is off.',
    'Cleanup runs on this iPhone, or sends transcript text to the provider you select with Bring Your Own Key.',

  agent:
    'In Local Mode the voice assistant is off, and note chat asks before sending a note off this iPhone.',
};

export const PRIVATE_MODE_LOCKED_REASON =
  'Off while Local Mode is on. Change Dictation in AI Models to turn it off.';

// Local Mode dictates on this iPhone, so cleaning with OpenWhispr Cloud is a separate Cloud pass,
// which needs a signed-in account.
export const CLOUD_CLEANUP_NEEDS_ACCOUNT_NOTE =
  'In Local Mode, OpenWhispr Cloud cleans transcripts only for a signed-in account, so cleanup is skipped until you sign in.';

export function cloudAccessFor(user: AuthUser | null): CloudAccess {
  if (!user) return 'none';
  return user.isAnonymous ? 'session' : 'account';
}

// OpenWhispr Cloud is saved for cleanup in Local Mode without an account to run it, so it is skipped
// (snapshotTextInference). This fork keeps that hosted workflow disabled.
export function cloudCleanupNeedsAccount(
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): boolean {
  return (
    HOSTED_SERVICES_ENABLED &&
    activeMode === 'private' &&
    config?.inference?.cleanup?.mode === 'openwhispr' &&
    cloudAccess !== 'account'
  );
}

// Cleanup runs On-Device when saved there or left unset in Local Mode. Legacy hosted selections
// also normalize to this phone; a saved BYOK selection keeps its provider route.
export function cleanupRunsOnDevice(
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess = 'none',
): boolean {
  return (
    localSelection(config?.inference?.cleanup ?? unsetSelection('cleanup', activeMode, cloudAccess))
      .mode === 'local'
  );
}

export function parseWorkflow(value: unknown): MobileInferenceScope | null {
  return WORKFLOWS.find((scope) => scope === value) ?? null;
}

// What a workflow with no saved selection runs. Local Mode keeps every workflow on this iPhone.
// Bring Your Own Key dictation waits for a provider before cleanup or the agent.
export function unsetSelection(
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess = 'none',
): InferenceSelection {
  // if (activeMode === 'private') return scope === 'agent' ? { mode: 'openwhispr' } : { mode: 'local' };
  if (activeMode === 'private') return { mode: localModeDefault(scope, cloudAccess) };
  if (activeMode === 'providers' && (scope === 'dictation' || UNSET_PROVIDER_NOTES[scope]))
    return { mode: 'providers' };
  // return { mode: 'openwhispr' };
  return { mode: 'local' };
}

export function workflowSummary(
  config: UserConfig | null,
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
  {
    keyMissing = false,
    onDeviceUnavailable,
    cloudAccess = 'none',
  }: {
    keyMissing?: boolean;
    // Why Apple Intelligence can't run right now, when it can't.
    onDeviceUnavailable?: string;
    cloudAccess?: CloudAccess;
  } = {},
): string {
  if (scope === 'cleanup') {
    if (!(config?.cleanupEnabled ?? true)) return 'Off';
    if (cleanupRunsOnDevice(config, activeMode, cloudAccess) && onDeviceUnavailable)
      return `Skipped · ${onDeviceUnavailable}`;
    if (cloudCleanupNeedsAccount(config, activeMode, cloudAccess)) return 'Skipped · Sign in';
  }
  const selection = localSelection(
    config?.inference?.[scope] ?? unsetSelection(scope, activeMode, cloudAccess),
  );
  // Local Mode runs dictation, note formatting and note chat on this phone first.
  // Uploads and cleanup run an explicitly saved On-Device or BYOK selection.
  // const chatOnCloud = (config?.inference?.agent?.mode ?? 'openwhispr') === 'openwhispr';
  // if (scope === 'agent' && chatOnCloud) return MODE_LABELS.openwhispr;
  if (selection.mode === 'local' && isLocalModelKey(selection.modelId))
    return LOCAL_MODEL_TITLES[selection.modelId];
  if (activeMode === 'private' && scope !== 'upload' && scope !== 'cleanup')
    return MODE_LABELS.local;
  if (selection.mode !== 'providers') return MODE_LABELS[selection.mode];
  if (!selection.providerId) return 'Not set';
  const name = providerDisplayName(selection.providerId);
  return keyMissing ? `${name} · Key missing` : name;
}
