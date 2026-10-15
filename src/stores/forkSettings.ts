import forkConfig from "../config/fork.json";
import { INFERENCE_SCOPES } from "../config/inferenceScopes";
import modelRegistryData from "../models/modelRegistryData.json";
import type { SettingsState } from "./settingsStore";

/** Runtime migration only: retain saved official preferences for the original build. */
export function getForkSettingsPatch(state: SettingsState): Partial<SettingsState> {
  const patch: Record<string, unknown> = {};
  if (!forkConfig.officialAccountEnabled) patch.isSignedIn = false;
  if (forkConfig.hostedServicesEnabled) return patch;

  for (const [mode, local, cloud] of [
    ["transcriptionMode", "useLocalWhisper", "cloudTranscriptionMode"],
    ["meetingTranscriptionMode", "meetingUseLocalWhisper", "meetingCloudTranscriptionMode"],
    ["uploadTranscriptionMode", "uploadUseLocalWhisper", "uploadCloudTranscriptionMode"],
  ] as const) {
    if (state[mode] === "openwhispr") {
      patch[mode] = "local";
      patch[local] = true;
    }
    if (state[cloud] === "openwhispr") patch[cloud] = "byok";
  }

  // Reuse an explicitly configured local LLM; otherwise leave its picker empty.
  // A cloud model id must never be presented as an installed local model.
  const scopes = Object.values(INFERENCE_SCOPES);
  const hasLocalModel = (provider: unknown, model: unknown) =>
    modelRegistryData.localProviders.some(
      (entry) => entry.id === provider && entry.models.some((candidate) => candidate.id === model)
    );
  const localScope = scopes.find(
    ({ storeKeys }) =>
      state[storeKeys.mode] === "local" &&
      hasLocalModel(state[storeKeys.provider], state[storeKeys.model])
  );
  for (const definition of scopes) {
    const { storeKeys } = definition;
    if (state[storeKeys.mode] === "openwhispr") {
      patch[storeKeys.mode] = "local";
      const fallback =
        "fallbackScope" in definition ? INFERENCE_SCOPES[definition.fallbackScope].storeKeys : null;
      if (fallback && !state[storeKeys.provider] && !state[storeKeys.model]) {
        // Unconfigured note formatting already borrows cleanup's provider and
        // endpoint. Its mode must follow that same local/BYOK/manual route.
        patch[storeKeys.mode] = patch[fallback.mode] ?? state[fallback.mode];
      } else if (!hasLocalModel(state[storeKeys.provider], state[storeKeys.model])) {
        patch[storeKeys.provider] = localScope ? state[localScope.storeKeys.provider] : "";
        patch[storeKeys.model] = localScope ? state[localScope.storeKeys.model] : "";
      }
    }
    if (storeKeys.cloudMode && state[storeKeys.cloudMode] === "openwhispr") {
      patch[storeKeys.cloudMode] = "byok";
    }
  }
  return patch as Partial<SettingsState>;
}
