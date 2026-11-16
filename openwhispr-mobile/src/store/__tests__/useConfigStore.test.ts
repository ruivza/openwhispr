const mockGetConfig = jest.fn();
const mockSaveConfig = jest.fn();

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@/services/storage/StorageService', () => ({
  StorageService: {
    getConfig: () => mockGetConfig(),
    saveConfig: (config: unknown) => mockSaveConfig(config),
    clearConfig: jest.fn(),
  },
}));
jest.mock('@/store/useProcessingModeStore', () => ({
  useProcessingModeStore: { getState: () => ({ resetToDefault: jest.fn() }) },
}));

import { useConfigStore } from '../useConfigStore';

beforeEach(() => {
  jest.clearAllMocks();
  mockSaveConfig.mockResolvedValue(undefined);
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

// A config from before Local Mode's Cloud defaults must never reach Cloud with them.
it('upgrades a Local Mode config from before the Cloud defaults before anything reads it', async () => {
  mockGetConfig.mockResolvedValue({
    defaultMode: 'private',
    inference: { dictation: { mode: 'local' } },
  });

  await useConfigStore.getState().loadConfig();

  const upgraded = {
    defaultMode: 'private',
    localModeUpgraded: true,
    cloudBackupEnabled: false,
    noteChatSplit: true,
    noteChatEnabled: true,
    notesLocalModeSplit: true,
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: { mode: 'local' },
      notes: { mode: 'local' },
    },
    pinnedInference: ['upload', 'cleanup', 'notes'],
  };
  expect(useConfigStore.getState().config).toEqual(upgraded);
  expect(mockSaveConfig).toHaveBeenCalledWith(upgraded);
});

it('still upgrades the loaded config when saving it fails', async () => {
  mockGetConfig.mockResolvedValue({ defaultMode: 'private' });
  mockSaveConfig.mockRejectedValue(new Error('disk full'));

  await useConfigStore.getState().loadConfig();

  expect(useConfigStore.getState().config).toMatchObject({
    localModeUpgraded: true,
    pinnedInference: ['upload', 'cleanup', 'notes'],
  });
  expect(useConfigStore.getState().error).toBeNull();
});

it('leaves an upgraded config alone', async () => {
  const config = {
    defaultMode: 'private',
    localModeUpgraded: true,
    cloudBackupEnabled: false,
    noteChatSplit: true,
    notesLocalModeSplit: true,
  };
  mockGetConfig.mockResolvedValue(config);

  await useConfigStore.getState().loadConfig();

  expect(useConfigStore.getState().config).toEqual(config);
  expect(mockSaveConfig).not.toHaveBeenCalled();
});

it('starts a new install with local-only defaults and cleanup enabled', async () => {
  mockGetConfig.mockResolvedValue(null);

  await useConfigStore.getState().loadConfig();

  expect(useConfigStore.getState().config).toMatchObject({
    defaultMode: 'private',
    cloudBackupEnabled: false,
    appleLocalIntelligenceEnabled: true,
    localModeUpgraded: true,
    noteChatSplit: true,
    notesLocalModeSplit: true,
  });
  expect(mockSaveConfig).not.toHaveBeenCalled();
});

const savedProvider = {
  mode: 'providers' as const,
  providerId: 'custom',
  modelId: 'saved-model',
  endpoint: 'https://models.example.com/v1',
  credentialRef: 'saved-key',
};

it('migrates hosted routes and upgrades local defaults while preserving every saved BYOK field', async () => {
  const config = {
    defaultMode: 'cloud',
    cloudBackupEnabled: true,
    inference: {
      dictation: { mode: 'openwhispr' },
      cleanup: savedProvider,
      notes: savedProvider,
    },
    rememberedInference: { cleanup: { custom: savedProvider } },
    privateModeReturn: { pinned: { cleanup: savedProvider, upload: { mode: 'openwhispr' } } },
  };
  mockGetConfig.mockResolvedValue(config);

  await useConfigStore.getState().loadConfig();

  expect(useConfigStore.getState().config).toMatchObject({
    defaultMode: 'private',
    cloudBackupEnabled: false,
    localModeUpgraded: true,
    inference: {
      dictation: { mode: 'local' },
      upload: { mode: 'local' },
      cleanup: savedProvider,
      notes: savedProvider,
    },
    pinnedInference: ['upload'],
    rememberedInference: config.rememberedInference,
    privateModeReturn: { pinned: { cleanup: savedProvider, upload: { mode: 'local' } } },
  });
});

it('retains an existing BYOK config and retries migration after a failed persistence write', async () => {
  const config = {
    defaultMode: 'providers',
    inference: { dictation: savedProvider, cleanup: savedProvider },
    rememberedInference: { dictation: { custom: savedProvider } },
  };
  mockGetConfig.mockResolvedValue(config);
  mockSaveConfig.mockRejectedValueOnce(new Error('disk full'));

  await useConfigStore.getState().loadConfig();
  expect(useConfigStore.getState().config).toMatchObject({
    ...config,
    localModeUpgraded: true,
    cloudBackupEnabled: false,
  });
  expect(useConfigStore.getState().error).toBeNull();

  await useConfigStore.getState().loadConfig();
  expect(mockSaveConfig).toHaveBeenCalledTimes(2);
  expect(mockSaveConfig).toHaveBeenLastCalledWith(useConfigStore.getState().config);
});

it('keeps a saved BYOK selection when an update attempts to re-enable official cloud services', async () => {
  useConfigStore.setState({
    config: {
      defaultMode: 'providers',
      inference: { dictation: savedProvider },
      localModeUpgraded: true,
    },
  });

  await useConfigStore.getState().updateConfig({
    defaultMode: 'cloud',
    cloudBackupEnabled: true,
  });

  expect(mockSaveConfig).toHaveBeenCalledWith({
    defaultMode: 'private',
    cloudBackupEnabled: false,
    localModeUpgraded: true,
    inference: { dictation: savedProvider },
  });
});

// Note chat once shared the voice assistant's setting, so it keeps that setting after updating.
it('splits note chat before anything reads the config without restoring hosted services', async () => {
  const config = {
    defaultMode: 'cloud',
    localModeUpgraded: true,
    inference: { agent: savedProvider },
    rememberedInference: { agent: { custom: savedProvider } },
  };
  mockGetConfig.mockResolvedValue(config);

  await useConfigStore.getState().loadConfig();

  const split = {
    ...config,
    defaultMode: 'private',
    cloudBackupEnabled: false,
    noteChatSplit: true,
    noteChatEnabled: true,
    notesLocalModeSplit: true,
    // A config migrated into Local Mode holds note formatting On-Device.
    inference: { agent: savedProvider, noteChat: savedProvider, notes: { mode: 'local' } },
    pinnedInference: ['notes'],
    rememberedInference: { agent: { custom: savedProvider }, noteChat: { custom: savedProvider } },
  };
  expect(useConfigStore.getState().config).toEqual(split);
  expect(mockSaveConfig).toHaveBeenCalledWith(split);
});

it('keeps a separately saved note-chat route and its remembered choices during migration', async () => {
  const noteChatProvider = {
    ...savedProvider,
    modelId: 'note-chat-model',
    credentialRef: 'note-chat-key',
  };
  mockGetConfig.mockResolvedValue({
    defaultMode: 'providers',
    localModeUpgraded: true,
    noteChatEnabled: false,
    dictationAgentEnabled: true,
    inference: { agent: savedProvider, noteChat: noteChatProvider },
    rememberedInference: {
      agent: { custom: savedProvider },
      noteChat: { custom: noteChatProvider },
    },
  });

  await useConfigStore.getState().loadConfig();

  expect(useConfigStore.getState().config).toMatchObject({
    defaultMode: 'providers',
    cloudBackupEnabled: false,
    noteChatSplit: true,
    noteChatEnabled: false,
    inference: { agent: savedProvider, noteChat: noteChatProvider },
    rememberedInference: {
      agent: { custom: savedProvider },
      noteChat: { custom: noteChatProvider },
    },
  });
});

// Local Mode once formatted notes on this iPhone whatever was saved, so the update keeps a Local
// Mode config's note formatting there unless the user chose otherwise.
describe('note formatting leaving Local Mode', () => {
  const upgradedBefore = { localModeUpgraded: true, noteChatSplit: true };

  it('holds note formatting On-Device for a Local Mode config with nothing saved', async () => {
    mockGetConfig.mockResolvedValue({ ...upgradedBefore, defaultMode: 'private' });

    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().config).toMatchObject({
      notesLocalModeSplit: true,
      inference: { notes: { mode: 'local' } },
      pinnedInference: ['notes'],
    });
  });

  it('holds a note formatting Cloud hold On-Device too', async () => {
    mockGetConfig.mockResolvedValue({
      ...upgradedBefore,
      defaultMode: 'private',
      inference: { notes: { mode: 'openwhispr' } },
      pinnedInference: ['notes'],
    });

    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().config).toMatchObject({
      inference: { notes: { mode: 'local' } },
      pinnedInference: ['notes'],
    });
  });

  it("keeps the user's own note formatting choice", async () => {
    const groq = { mode: 'providers', providerId: 'groq', modelId: 'llama' };
    mockGetConfig.mockResolvedValue({
      ...upgradedBefore,
      defaultMode: 'private',
      inference: { notes: groq },
    });

    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().config?.inference?.notes).toEqual(groq);
    expect(useConfigStore.getState().config?.pinnedInference).toBeUndefined();
  });

  it('leaves a config outside Local Mode alone', async () => {
    mockGetConfig.mockResolvedValue({ ...upgradedBefore, defaultMode: 'providers' });

    await useConfigStore.getState().loadConfig();

    expect(useConfigStore.getState().config).toEqual({
      ...upgradedBefore,
      defaultMode: 'providers',
      cloudBackupEnabled: false,
      notesLocalModeSplit: true,
    });
  });
});
