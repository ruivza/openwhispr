import { chooseOnboardingMode } from '../onboardingMode';

jest.mock('@/lib/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
const mockUpdateConfig = jest.fn();
const mockChooseMode = jest.fn();
const mockEnsureSession = jest.fn();
const mockResetMode = jest.fn();
let mockError: string | null = null;
let mockUser: { id: string; isAnonymous: boolean } | null = null;
let mockGuest = false;
let mockCurrentStep = 'privacy-mode';
let mockConfig: Record<string, unknown> = { defaultMode: 'private' };
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      config: mockConfig,
      updateConfig: mockUpdateConfig,
      error: mockError,
    }),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ resetToDefault: mockResetMode }) },
}));
jest.mock('@/store/useOnboardingStore', () => ({
  useOnboardingStore: {
    getState: () => ({ currentStep: mockCurrentStep, chooseMode: mockChooseMode }),
  },
}));
let mockAccountHistory = false;
jest.mock('@/sync/syncIdentity', () => ({
  hasRealAccountHistory: () => mockAccountHistory,
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({
      user: mockUser,
      isGuest: mockGuest,
      ensureAnonymousSession: mockEnsureSession,
    }),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockError = null;
  mockUser = null;
  mockGuest = false;
  mockAccountHistory = false;
  mockCurrentStep = 'privacy-mode';
  mockConfig = { defaultMode: 'private' };
  mockUpdateConfig.mockResolvedValue(undefined);
  mockChooseMode.mockResolvedValue(undefined);
  mockEnsureSession.mockResolvedValue(undefined);
});
it('maps a legacy Cloud selection to local setup without opening an account session', async () => {
  await chooseOnboardingMode('cloud', 'privacy-mode');
  expect(mockEnsureSession).not.toHaveBeenCalled();
  expect(mockChooseMode).toHaveBeenCalledWith('private', 'privacy-mode');
  expect(mockUpdateConfig).toHaveBeenCalledWith({
    defaultMode: 'private',
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup'],
  });
});
it('keeps a legacy download fallback local without a session', async () => {
  mockCurrentStep = 'private-download';
  await chooseOnboardingMode('cloud', 'private-download');
  expect(mockEnsureSession).not.toHaveBeenCalled();
  expect(mockChooseMode).toHaveBeenCalledWith('private', 'private-download');
  expect(mockUpdateConfig.mock.calls[0][0].defaultMode).toBe('private');
});
it('does not advance or change the active mode after a failed save', async () => {
  mockUpdateConfig.mockImplementationOnce(async () => {
    mockError = 'Cannot save';
  });
  await expect(chooseOnboardingMode('private', 'privacy-mode')).rejects.toThrow('Cannot save');
  expect(mockChooseMode).not.toHaveBeenCalled();
  expect(mockResetMode).not.toHaveBeenCalled();
});
it('does not change the mode for a stale screen callback', async () => {
  mockCurrentStep = 'language';
  await chooseOnboardingMode('private', 'privacy-mode');
  expect(mockUpdateConfig).not.toHaveBeenCalled();
});

it('restores Local if a legacy choice fails to save onboarding progress', async () => {
  mockUser = { id: 'anon', isAnonymous: true };
  mockCurrentStep = 'private-download';
  mockChooseMode.mockRejectedValueOnce(new Error('Keychain unavailable'));
  await expect(chooseOnboardingMode('cloud', 'private-download')).rejects.toThrow(
    'Keychain unavailable',
  );
  expect(mockUpdateConfig).toHaveBeenLastCalledWith({
    defaultMode: 'private',
    inference: undefined,
    pinnedInference: undefined,
    privateModeReturn: undefined,
  });
  expect(mockResetMode).toHaveBeenLastCalledWith('private');
});

it('lets a guest continue local setup without account access', async () => {
  mockGuest = true;
  await chooseOnboardingMode('cloud', 'privacy-mode');
  expect(mockEnsureSession).not.toHaveBeenCalled();
  expect(mockChooseMode).toHaveBeenCalledWith('private', 'privacy-mode');
});

// Guests can't open a session during setup. Refusing Cloud here too would leave a guest whose
// download failed with no way to finish, so the choice is saved for after sign-in, as before.
// This fork keeps the escape hatch but always continues local setup.
it('lets a guest leave a stuck download while keeping local routing', async () => {
  mockGuest = true;
  mockCurrentStep = 'private-download';
  await chooseOnboardingMode('cloud', 'private-download');
  expect(mockEnsureSession).not.toHaveBeenCalled();
  expect(mockUpdateConfig.mock.calls[0][0]).toMatchObject({
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' } },
  });
  expect(mockChooseMode).toHaveBeenCalledWith('private', 'private-download');
});

// A replayed onboarding pick must also move a Providers dictation route, or the
// screens would show the new mode while dictation kept using the provider.
it('moves the dictation route with the chosen mode and restores both on failure', async () => {
  const providerRoute = { mode: 'providers', providerId: 'groq', modelId: 'whisper-large-v3' };
  const inference = { dictation: providerRoute, upload: { mode: 'openwhispr' } };
  mockConfig = { defaultMode: 'providers', inference, pinnedInference: ['upload'] };
  mockChooseMode.mockRejectedValueOnce(new Error('Keychain unavailable'));
  await expect(chooseOnboardingMode('private', 'privacy-mode')).rejects.toThrow(
    'Keychain unavailable',
  );
  expect(mockUpdateConfig).toHaveBeenNthCalledWith(1, {
    defaultMode: 'private',
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup'],
  });
  expect(mockUpdateConfig).toHaveBeenLastCalledWith({
    defaultMode: 'providers',
    inference,
    pinnedInference: ['upload'],
    privateModeReturn: undefined,
  });
});

// Choosing Local in setup keeps uploads and cleanup on this iPhone, even for a signed-in account,
// whose Local Mode defaults would send them to Cloud. They are automatic pins, not the user's own.
it('keeps uploads and cleanup on this iPhone when setup picks Local', async () => {
  mockUser = { id: 'u', isAnonymous: false };
  mockConfig = {
    defaultMode: 'cloud',
    inference: { dictation: { mode: 'openwhispr' }, cleanup: { mode: 'openwhispr' } },
    rememberedInference: { upload: { local: { mode: 'local', modelId: 'whisper-base' } } },
  };
  await chooseOnboardingMode('private', 'privacy-mode');
  expect(mockUpdateConfig.mock.calls[0][0]).toMatchObject({
    defaultMode: 'private',
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local', modelId: 'whisper-base' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup'],
  });
});

it.each([
  ['On-Device', { mode: 'local', modelId: 'parakeet-v2' }],
  [
    'provider',
    {
      mode: 'providers',
      providerId: 'custom',
      modelId: 'saved-model',
      endpoint: 'https://models.example.com/v1',
      credentialRef: 'saved-key',
    },
  ],
])('keeps a saved %s choice when setup picks Local', async (_label, saved) => {
  mockConfig = { defaultMode: 'cloud', inference: { upload: saved, cleanup: saved } };
  await chooseOnboardingMode('private', 'privacy-mode');
  const { inference, pinnedInference } = mockUpdateConfig.mock.calls[0][0];
  expect(inference.upload).toEqual(saved);
  expect(inference.cleanup).toEqual(saved);
  expect(pinnedInference).toEqual([]);
});

// Going back to Cloud in setup changes the mode, which releases what Local held.
// Legacy Cloud callbacks in this fork leave the local mode and its pins intact.
it('keeps local pins when an old Cloud callback is replayed', async () => {
  mockUser = { id: 'u', isAnonymous: false };
  mockConfig = {
    defaultMode: 'private',
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup'],
  };
  await chooseOnboardingMode('cloud', 'privacy-mode');
  expect(mockUpdateConfig.mock.calls[0][0]).toEqual({
    defaultMode: 'private',
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup'],
  });
});

it('keeps a saved cleanup when a legacy Cloud callback resumes locally', async () => {
  mockUser = { id: 'u', isAnonymous: false };
  const cleanup = { mode: 'local' };
  mockConfig = { defaultMode: 'cloud', inference: { dictation: { mode: 'openwhispr' }, cleanup } };
  await chooseOnboardingMode('cloud', 'privacy-mode');
  expect(mockUpdateConfig.mock.calls[0][0].inference.cleanup).toEqual(cleanup);
});

// A new identity there would read as an account switch and wipe the synced account's notes.
describe('on a device that synced an account, signed out', () => {
  beforeEach(() => {
    mockAccountHistory = true;
  });

  it('continues local setup without opening a new session', async () => {
    await chooseOnboardingMode('cloud', 'privacy-mode');
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockChooseMode).toHaveBeenCalledWith('private', 'privacy-mode');
  });

  it('leaves a stuck download locally without a new identity', async () => {
    mockCurrentStep = 'private-download';
    await chooseOnboardingMode('cloud', 'private-download');
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockChooseMode).toHaveBeenCalledWith('private', 'private-download');
  });
});

// Failed progress persistence must restore the BYOK round-trip state as well as its active route.
it('restores the private-mode return selections after progress persistence fails', async () => {
  const saved = {
    mode: 'providers',
    providerId: 'custom',
    modelId: 'saved-model',
    endpoint: 'https://models.example.com/v1',
    credentialRef: 'saved-key',
  };
  const privateModeReturn = { pinned: { cleanup: saved } };
  mockConfig = { defaultMode: 'private', privateModeReturn };
  mockChooseMode.mockRejectedValueOnce(new Error('Keychain unavailable'));

  await expect(chooseOnboardingMode('private', 'privacy-mode')).rejects.toThrow(
    'Keychain unavailable',
  );

  expect(mockUpdateConfig).toHaveBeenLastCalledWith({
    defaultMode: 'private',
    inference: undefined,
    pinnedInference: undefined,
    privateModeReturn,
  });
});
