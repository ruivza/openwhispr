import { create } from 'zustand';
import { ProcessingMode } from '../types';

interface ProcessingModeState {
  activeMode: ProcessingMode;
  isUserOverride: boolean;
  setActiveMode: (mode: ProcessingMode, userInitiated?: boolean) => void;
  resetToDefault: (mode: ProcessingMode) => void;
}

export const useProcessingModeStore = create<ProcessingModeState>((set) => ({
  // activeMode: 'cloud',
  activeMode: 'private',
  isUserOverride: false,
  setActiveMode: (mode, userInitiated = false) =>
    set({
      // activeMode: mode,
      activeMode: mode === 'cloud' ? 'private' : mode,
      isUserOverride: userInitiated,
    }),
  resetToDefault: (mode) =>
    set({
      // activeMode: mode,
      activeMode: mode === 'cloud' ? 'private' : mode,
      isUserOverride: false,
    }),
}));
