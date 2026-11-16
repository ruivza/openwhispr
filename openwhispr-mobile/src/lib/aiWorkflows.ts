import { HOSTED_SERVICES_ENABLED, localSelection } from '@/lib/fork';
import type { AuthUser } from '@/lib/authClient';
import { isDictationAgentEnabled, isNoteChatEnabled } from '@/lib/dictationAgent';
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
  noteChat: 'Chat',
  agent: 'Voice Assistant',
};

export const WORKFLOWS = Object.keys(WORKFLOW_LABELS) as MobileInferenceScope[];

// Bring Your Own Key dictation skips these workflows until a selection is saved for them.
export const UNSET_PROVIDER_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  cleanup: 'Not saved yet. Cleanup is skipped until you save a selection.',
  agent:
    // 'Not saved yet. The voice assistant is skipped until you save a selection; note chat uses OpenWhispr Cloud.',
    'Not saved yet. The voice assistant is skipped until you save a selection.',
};

// On-Device cleanup on an iPhone that can never run Apple Intelligence.
export const ON_DEVICE_CLEANUP_UNSUPPORTED_NOTE =
  "This iPhone can't run On-Device cleanup, so it's skipped. Choose Bring Your Own Key to clean up your transcripts.";

// Dictation owns Local Mode: On-Device dictation turns it on, and the other modes turn it off. Note
// formatting and the voice assistant keep their own choices; notes made in Local Mode are private.
export const LOCAL_MODE_DICTATION_NOTES = {
  on: 'Local Mode is on: dictation stays on this iPhone, notes you make stay private, and chat asks before leaving it. Choose Bring Your Own Key to turn it off.',
  off: 'On-Device turns on Local Mode: dictation stays on this iPhone, notes you make stay private, and chat asks before leaving it.',
};

// What Local Mode means for each workflow.
export const ON_DEVICE_MODE_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  upload: 'Local Mode keeps uploads on this iPhone unless you save a Bring Your Own Key selection.',
  cleanup:
    // 'In Private mode, cleanup runs on this iPhone, or sends only the transcript text to your provider with Bring Your Own Key. OpenWhispr Cloud cleanup is skipped until Private mode is off.',
    'Cleanup runs on this iPhone, or sends transcript text to the provider you select with Bring Your Own Key.',
  noteChat: 'In Local Mode chat asks before sending notes off this iPhone.',
};

// Outside Cloud dictation, cleaning with OpenWhispr Cloud is a separate Cloud pass, which needs a
// signed-in account.
export const CLOUD_CLEANUP_NEEDS_ACCOUNT_NOTE =
  'OpenWhispr Cloud cleans transcripts made on this iPhone or with your own key only for a signed-in account, so cleanup is skipped until you sign in.';

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
    activeMode !== 'cloud' &&
    cloudAccess !== 'account' &&
    workflowSelection(config, 'cleanup', activeMode, cloudAccess).mode === 'openwhispr'
  );
}

// Cleanup runs On-Device when saved there or left unset in Local Mode. Legacy hosted selections
// also normalize to this phone; a saved BYOK selection keeps its provider route.
export function cleanupRunsOnDevice(
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess = 'none',
): boolean {
  return workflowSelection(config, 'cleanup', activeMode, cloudAccess).mode === 'local';
}

// What a workflow runs: its saved selection, else the mode's default (unsetSelection). A legacy
// hosted selection, including an automatic pin, stays on this phone in the fork. Explicit BYOK
// selections retain their provider, model, endpoint and credential reference.
export function workflowSelection(
  config: UserConfig | null,
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess = 'none',
): InferenceSelection {
  const saved = config?.inference?.[scope];
  const heldOnCloudInLocalMode =
    activeMode === 'private' &&
    saved?.mode === 'openwhispr' &&
    !!config?.pinnedInference?.includes(scope);
  return localSelection(
    saved && !heldOnCloudInLocalMode ? saved : unsetSelection(scope, activeMode, cloudAccess),
  );
}

// Text Cleanup, Note Chat and the Voice Assistant have switches of their own; switched off, they
// run nothing and use no key.
export function workflowSwitchedOff(
  config: UserConfig | null,
  scope: MobileInferenceScope,
): boolean {
  if (!config) return false;
  if (scope === 'cleanup') return !(config.cleanupEnabled ?? true);
  if (scope === 'noteChat') return !isNoteChatEnabled(config);
  if (scope === 'agent') return !isDictationAgentEnabled(config);
  return false;
}

// The voice assistant runs on its own selection in every mode. It can run on a provider, or on
// OpenWhispr Cloud for a signed-in account, which an anonymous session can't use for it; it has no
// on-device version, and unset under Bring Your Own Key it is skipped.
export function voiceAssistantCanRun(
  config: UserConfig | null,
  activeMode: ProcessingMode,
  cloudAccess: CloudAccess,
): boolean {
  if (!config || workflowSwitchedOff(config, 'agent')) return false;
  const selection = workflowSelection(config, 'agent', activeMode, cloudAccess);
  if (selection.mode === 'providers') return !!selection.providerId;
  return selection.mode === 'openwhispr' && cloudAccess === 'account';
}

export function parseWorkflow(value: unknown): MobileInferenceScope | null {
  return WORKFLOWS.find((scope) => scope === value) ?? null;
}

// What a workflow with no saved selection runs. Local Mode keeps every workflow on this iPhone.
// Bring Your Own Key dictation waits for a provider before cleanup or the voice assistant.
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
  if (workflowSwitchedOff(config, scope)) return 'Off';
  if (scope === 'cleanup') {
    if (cleanupRunsOnDevice(config, activeMode, cloudAccess) && onDeviceUnavailable)
      return `Skipped · ${onDeviceUnavailable}`;
    if (cloudCleanupNeedsAccount(config, activeMode, cloudAccess)) return 'Skipped · Sign in';
  }
  const selection = workflowSelection(config, scope, activeMode, cloudAccess);
  // The voice assistant never runs on this iPhone (voiceAssistantCanRun), so an unset one held
  // On-Device has nothing to run until a provider is saved for it.
  if (scope === 'agent' && selection.mode === 'local') return 'Not set';
  // Local Mode runs dictation, note formatting and note chat on this phone first.
  // Uploads and cleanup run an explicitly saved On-Device or BYOK selection.
  // const chatOnCloud = (config?.inference?.agent?.mode ?? 'openwhispr') === 'openwhispr';
  // if (scope === 'agent' && chatOnCloud) return MODE_LABELS.openwhispr;
  if (selection.mode === 'local' && isLocalModelKey(selection.modelId))
    return LOCAL_MODEL_TITLES[selection.modelId];
  if (activeMode === 'private' && (scope === 'dictation' || scope === 'noteChat'))
    return MODE_LABELS.local;
  if (selection.mode !== 'providers') return MODE_LABELS[selection.mode];
  if (!selection.providerId) return 'Not set';
  const name = providerDisplayName(selection.providerId);
  return keyMissing ? `${name} · Key missing` : name;
}
