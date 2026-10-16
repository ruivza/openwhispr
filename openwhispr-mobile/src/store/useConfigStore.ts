import { create } from 'zustand';
import { UserConfig } from '../types';
import { StorageService } from '../services/storage/StorageService';
import { localModeUpgradeConfig } from '../lib/inferenceModes';
import { useProcessingModeStore } from './useProcessingModeStore';
import { migrateHostedConfig } from '@/lib/fork';

interface ConfigState {
  config: UserConfig | null;
  isLoading: boolean;
  error: string | null;
  loadConfig: () => Promise<void>;
  updateConfig: (config: Partial<UserConfig>) => Promise<void>;
  resetConfig: () => Promise<void>;
}

const defaultConfig: UserConfig = {
  // defaultMode: 'cloud',
  defaultMode: 'private',
  cloudBackupEnabled: false,
  appleLocalIntelligenceEnabled: true,
  localModeUpgraded: true,
};

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,

  loadConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      const config = await StorageService.getConfig();
      // const resolvedConfig = config || defaultConfig;
      // A config from before Local Mode's Cloud defaults is upgraded before anything reads it, so
      // its uploads and cleanup never reach Cloud. A failed save upgrades it again next launch.
      const localConfig = migrateHostedConfig(config || defaultConfig);
      const resolvedConfig = localConfig.localModeUpgraded
        ? localConfig
        : { ...localConfig, ...localModeUpgradeConfig(localConfig) };
      if (config && JSON.stringify(config) !== JSON.stringify(resolvedConfig)) {
        // A failed migration write must not replace an existing BYOK setup with
        // defaults. Keep its safe in-memory routes and retry on the next launch.
        await StorageService.saveConfig(resolvedConfig).catch(() => undefined);
      }
      useProcessingModeStore.getState().resetToDefault(resolvedConfig.defaultMode);
      set({ config: resolvedConfig, isLoading: false });
    } catch (error) {
      set({
        error: (error as Error).message,
        isLoading: false,
        config: defaultConfig,
      });
      useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
    }
  },

  updateConfig: async (updates: Partial<UserConfig>) => {
    const currentConfig = get().config || defaultConfig;
    // const newConfig = { ...currentConfig, ...updates };
    const newConfig = migrateHostedConfig({ ...currentConfig, ...updates });

    set({ isLoading: true, error: null });
    try {
      await StorageService.saveConfig(newConfig);
      const modeStore = useProcessingModeStore.getState();
      if (!modeStore.isUserOverride) {
        modeStore.resetToDefault(newConfig.defaultMode);
      }
      set({ config: newConfig, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  resetConfig: async () => {
    set({ isLoading: true, error: null });
    try {
      await StorageService.clearConfig();
      useProcessingModeStore.getState().resetToDefault(defaultConfig.defaultMode);
      set({ config: defaultConfig, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },
}));
