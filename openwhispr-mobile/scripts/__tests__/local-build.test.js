const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');

function createStore(initializer) {
  let state;
  const set = (value) => { state = { ...state, ...(typeof value === 'function' ? value(state) : value) }; };
  const store = (selector) => selector ? selector(state) : state;
  store.getState = () => state;
  store.setState = set;
  store.subscribe = () => () => {};
  state = initializer(set, store.getState);
  return store;
}

function loader(mocks = {}, globals = {}) {
  const cache = new Map();
  const dependencies = [];
  function load(relative) {
    const file = path.resolve(root, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    if (file.endsWith('.json')) return module.exports = JSON.parse(fs.readFileSync(file, 'utf8'));
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    });
    const errors = compiled.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, `${relative}: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')}`);
    vm.runInNewContext(compiled.outputText, {
      module, exports: module.exports, URL, AbortController, console, setTimeout, clearTimeout,
      process: { env: { EXPO_PUBLIC_API_URL: 'https://api.openwhispr.com' } }, __DEV__: false, ...globals,
      require(name) {
        dependencies.push(name);
        if (Object.hasOwn(mocks, name)) return mocks[name];
        assert.ok(name.startsWith('@/') || name.startsWith('.'), `Unexpected external module ${name}`);
        const base = name.startsWith('@/') ? path.join(root, 'src', name.slice(2)) : path.resolve(path.dirname(file), name);
        const candidate = [base, `${base}.ts`, `${base}.tsx`, `${base}.json`, path.join(base, 'index.ts')].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
        assert.ok(candidate, `Missing ${name}`);
        return load(path.relative(root, candidate));
      },
    }, { filename: file });
    return module.exports;
  }
  return { load, dependencies };
}

test('guest initialization never restores/creates an official session or touches secure storage', async () => {
  let network = 0;
  let secureWrites = 0;
  const auth = new Proxy({}, { get: () => async () => { network++; throw new Error('official auth called'); } });
  const client = loader({
    zustand: { create: createStore },
    'expo-secure-store': { getItemAsync: () => { secureWrites++; }, setItemAsync: () => { secureWrites++; }, deleteItemAsync: () => { secureWrites++; } },
    '@/lib/authClient': auth,
    '@/lib/sentry': { Sentry: {} },
    '@/store/useUsageStore': { useUsageStore: { getState: () => ({ reset() {} }) } },
    '@/services/agent/AgentComposerService': { clearAllSessions() {} },
    '@/lib/notes/noteShareTokens': { claimNoteShareTokens() { network++; }, clearNoteShareTokens() { secureWrites++; } },
  });
  const { useAuthStore } = client.load('src/store/useAuthStore.ts');
  useAuthStore.setState({ user: { id: 'old-account' }, sessionCookie: 'old-cookie' });
  await useAuthStore.getState().initialize();
  await useAuthStore.getState().ensureAnonymousSession();
  assert.equal(useAuthStore.getState().isGuest, true);
  assert.equal(useAuthStore.getState().isInitialized, true);
  assert.equal(useAuthStore.getState().user, null);
  assert.equal(useAuthStore.getState().sessionCookie, null);
  assert.equal(network, 0);
  assert.equal(secureWrites, 0);
});

test('auth compatibility calls do not import Better Auth or create a successful login', async () => {
  const client = loader();
  const auth = client.load('src/lib/authClient.ts');
  assert.equal(await auth.getSession(), null);
  assert.equal(await auth.getStoredSession(), null);
  assert.equal((await auth.signInWithEmail('user@example.test', 'synthetic')).user, null);
  assert.equal((await auth.signInAnonymously()).sessionCookie, null);
  assert.equal((await auth.signInWithGoogle()).success, false);
  assert.equal(client.dependencies.some((name) => name.includes('better-auth') || name.includes('secure-store')), false);
});

test('saved BYOK selections, endpoints and credential references survive official-route migration', () => {
  const { migrateHostedConfig } = loader().load('src/lib/fork.ts');
  const provider = { mode: 'providers', providerId: 'custom', modelId: 'my-model', endpoint: 'https://provider.example/v1', credentialRef: 'secure-reference' };
  const original = { defaultMode: 'providers', cloudBackupEnabled: true, languages: ['zh'], inference: { dictation: provider, cleanup: { mode: 'openwhispr', modelId: 'official' }, notes: { mode: 'local', modelId: 'apple' } }, rememberedInference: { dictation: { custom: provider } }, privateModeReturn: { pinned: { upload: provider } } };
  const result = migrateHostedConfig(original);
  assert.equal(result.defaultMode, 'providers');
  assert.equal(result.inference.dictation, provider);
  assert.equal(result.rememberedInference.dictation.custom, provider);
  assert.equal(result.privateModeReturn.pinned.upload, provider);
  assert.equal(result.inference.cleanup.mode, 'local');
  assert.equal(result.inference.cleanup.modelId, undefined);
  assert.equal(result.inference.notes.modelId, 'apple');
  assert.equal(result.cloudBackupEnabled, false);
  assert.equal(original.inference.cleanup.mode, 'openwhispr', 'migration must not mutate the saved input');
  assert.equal(migrateHostedConfig({ ...original, defaultMode: 'cloud' }).defaultMode, 'private');
});

test('config hydration persists migrated routes and never converts a saved providers mode to private', async () => {
  for (const failPersistence of [false, true]) {
  let saved;
  let activeMode;
  const original = { defaultMode: 'providers', inference: { dictation: { mode: 'providers', providerId: 'openai', credentialRef: 'old-key' }, notes: { mode: 'openwhispr' } } };
  const client = loader({
    zustand: { create: createStore },
    'react-native': { Platform: { OS: 'ios' } },
    '../services/storage/StorageService': { StorageService: { getConfig: async () => original, saveConfig: async (value) => { saved = value; if (failPersistence) throw new Error('synthetic write failure'); } } },
    './useProcessingModeStore': { useProcessingModeStore: { getState: () => ({ resetToDefault: (mode) => { activeMode = mode; } }) } },
  });
  const { useConfigStore } = client.load('src/store/useConfigStore.ts');
  await useConfigStore.getState().loadConfig();
  assert.equal(activeMode, 'providers');
  assert.equal(saved.inference.dictation.credentialRef, 'old-key');
  assert.equal(saved.inference.notes.mode, 'local');
  assert.equal(saved.localModeUpgraded, true);
  assert.equal(saved.cloudBackupEnabled, false);
  assert.equal(useConfigStore.getState().config.inference.dictation.credentialRef, 'old-key');
  }
});

test('official API and direct referral transports reject before any network operation', async () => {
  let sends = 0;
  const client = loader({
    'expo/fetch': { fetch: async () => { sends++; throw new Error('network'); } },
    'expo-constants': { __esModule: true, default: { expoConfig: { version: '1.0.0' } } },
    '@/store/useAuthStore': { useAuthStore: { getState: () => ({ sessionCookie: 'stale-official-cookie' }) } },
  });
  const { api } = client.load('src/lib/apiClient.ts');
  await assert.rejects(api.get('/api/workspace-policy'), { code: 'HOSTED_SERVICES_DISABLED' });
  await assert.rejects(api.post('/api/transcribe', { audio: 'synthetic' }), { code: 'HOSTED_SERVICES_DISABLED' });
  const referrals = client.load('src/lib/referralApi.ts');
  await assert.rejects(referrals.fetchReferralStats('stale-cookie'), { code: 'HOSTED_SERVICES_DISABLED' });
  await assert.rejects(referrals.sendReferralInvite('user@example.test', 'stale-cookie'), { code: 'HOSTED_SERVICES_DISABLED' });
  assert.equal(sends, 0);
});

test('legacy account/paywall/ATT progress resumes locally while permissions remain intact', async () => {
  for (const [step, expected] of [['paywall', 'language'], ['create-account', 'graduation'], ['tracking-permission', 'graduation'], ['private-download', 'private-download']]) {
    const progress = { version: 3, step, selectedMode: 'cloud', keyboardInstalled: true, permissionsGranted: { microphone: true, notifications: false } };
    const client = loader({
      zustand: { create: createStore },
      '@/utils/onboarding': { FIRST_ONBOARDING_STEP: 'get-started', ONBOARDING_VERSION: 3, OnboardingService: { isOnboardingComplete: async () => false, hasAttemptedTrackingAuthorizationRequest: async () => false, getProgress: async () => progress } },
      '@/lib/appsflyer': { logTutorialCompletion() {} },
      './useConfigStore': { useConfigStore: { getState: () => ({ config: null }) } },
    });
    const { useOnboardingStore, getOnboardingRoute } = client.load('src/store/useOnboardingStore.ts');
    await useOnboardingStore.getState().hydrate();
    const result = useOnboardingStore.getState();
    assert.equal(result.currentStep, expected);
    assert.equal(result.selectedMode, 'private');
    assert.equal(result.keyboardInstalled, true);
    assert.equal(result.permissionsGranted.microphone, true);
    for (const retired of ['paywall', 'create-account', 'tracking-permission']) assert.equal(getOnboardingRoute('private').includes(retired), false);
    assert.equal(getOnboardingRoute('private').includes('private-download'), true);
  }
});

test('guest BYOK retains a remembered managed organization policy without network or cache erasure', async () => {
  const origin = 'https://api.openwhispr.com';
  const prefix = `openwhispr.provider-policy.v1.${encodeURIComponent(origin)}.`;
  const cache = new Map([
    [prefix + 'signed-out-account', 'old-account'],
    [prefix + 'old-account', JSON.stringify({ version: 1, accountId: 'old-account', apiOrigin: origin, requiresManagedPolicy: false, data: { managed: true, policyUpdatedAt: '2026-01-01T00:00:00Z', policy: { version: 1, transcription: { allowedModes: ['local'], allowedByokProviders: [] }, llm: { allowedModes: ['local'], allowedByokProviders: [] }, features: { agentEnabled: false } } } })],
  ]);
  let network = 0;
  let writes = 0;
  const client = loader({
    'expo-sqlite/localStorage/install': {},
    '@/lib/apiClient': { BASE_URL: origin, api: { get: async () => { network++; } } },
    '@/store/useAuthStore': { useAuthStore: { getState: () => ({ user: null, isGuest: true, sessionCookie: null }) } },
    './ProviderCredentials': { subscribeProviderCredentialChanges: () => () => {} },
  }, { localStorage: { getItem: (key) => cache.get(key) ?? null, setItem: () => { writes++; }, removeItem: () => { writes++; } } });
  const policy = await client.load('src/services/providers/ProviderPolicy.ts').getProviderPolicy();
  assert.equal(policy.status, 'managed');
  assert.equal(policy.agentEnabled, false);
  assert.equal(policy.transcription.allowedModes[0], 'local');
  assert.equal(network, 0);
  assert.equal(writes, 0);
});

test('local and direct BYOK transcription execute while stale official upload jobs are refused', async () => {
  let localCalls = 0;
  let providerCalls = 0;
  let uploads = 0;
  const localResponse = { text: 'local transcript' };
  const byokRoute = { mode: 'providers', scope: 'dictation', providerId: 'openai', modelId: 'whisper-1', credentialRef: 'existing-key' };
  const client = loader({
    'expo-file-system/legacy': { uploadAsync: async () => { uploads++; } },
    './LocalWhisperService': { LocalWhisperService: {} },
    './LocalTranscriptionService': { LocalTranscriptionService: {} },
    '../../store/useAuthStore': { useAuthStore: { getState: () => ({ sessionCookie: 'stale-cookie' }) } },
    '../../lib/apiClient': { getClientVersionHeader: () => ({}) },
    '../../lib/dictationHints': { buildDictationHints: () => [], isDictationContext: () => false },
    '../../lib/transcriptionPromptCap': { trimDictionaryPrompt: (value) => value, dictionaryPromptLimit: () => 1000 },
    '../../../modules/background-uploader/src': { BackgroundUploader: { upload: async () => { uploads++; } } },
    '../../../modules/audio-tools/src': { AudioTools: {} },
    '../../../modules/app-group-storage/src': { AppGroupStorage: {}, APP_GROUP_KEYS: {} },
    '../../lib/cleanupTranscript': { CLEANUP_TIMEOUT_MS: 1000 },
    '../../lib/retry': { withRetry: (run) => run() },
    './wordLimit': {}, './policyErrors': {},
    '@/lib/inferenceRouting': { resolveMobileProviderRoute: async () => byokRoute },
    '@/services/providers/ProviderExecution': { transcribeWithProvider: async ({ route }) => { assert.equal(route, byokRoute); providerCalls++; return { text: 'own key transcript', duration: 1 }; } },
  });
  const { TranscriptionService } = client.load('src/services/transcription/TranscriptionService.ts');
  TranscriptionService.transcribeLocally = async () => { localCalls++; return localResponse; };
  assert.equal(await TranscriptionService.transcribe({ provider: 'local', audioUri: 'file:///synthetic.wav' }), localResponse);
  const ownKey = await TranscriptionService.transcribe({ provider: 'byok', audioUri: 'file:///synthetic.wav', inferenceRoute: byokRoute });
  assert.equal(ownKey.text, 'own key transcript');
  assert.equal(ownKey.provider, 'byok');
  assert.equal(ownKey.inferenceRoute.credentialRef, 'existing-key');
  await assert.rejects(TranscriptionService.transcribe({ provider: 'cloud', audioUri: 'file:///synthetic.wav' }), { code: 'HOSTED_SERVICES_DISABLED' });
  await assert.rejects(TranscriptionService.transcribeWithCloudCleanup({ provider: 'cloud', audioUri: 'file:///synthetic.wav' }), { code: 'HOSTED_SERVICES_DISABLED' });
  assert.equal(localCalls, 1);
  assert.equal(providerCalls, 1);
  assert.equal(uploads, 0);
});

test('agent streaming uses a configured provider while official streaming is refused before fetch', async () => {
  let hostedRequests = 0;
  let providerRequests = 0;
  const route = { mode: 'providers', providerId: 'custom', endpoint: 'https://provider.example/v1' };
  const client = loader({
    'expo/fetch': { fetch: async () => { hostedRequests++; } },
    '@/lib/apiClient': { BASE_URL: 'https://api.openwhispr.com', ApiError: class ApiError extends Error {} },
    '@/lib/retry': { withRetry: (run) => run() },
    '@/services/reasoning/buildProviderPrompt': { stripThinkingTags: (value) => value },
    '@/lib/inferenceRouting': { getInferenceSelection: () => undefined, resolveMobileProviderRoute: async () => route },
    '@/services/providers/ProviderExecution': { processProviderText: async (input) => { assert.equal(input.route, route); providerRequests++; return { text: 'own provider answer' }; } },
  });
  const { streamAgentText } = client.load('src/services/agent/AgentStreamClient.ts');
  const request = { messages: [{ role: 'user', content: 'draft' }], systemPrompt: 'synthetic', inferenceRoute: route };
  assert.equal(await streamAgentText(request), 'own provider answer');
  await assert.rejects(streamAgentText({ ...request, inferenceRoute: { mode: 'openwhispr' } }), { code: 'HOSTED_SERVICES_DISABLED' });
  assert.equal(hostedRequests, 0);
  assert.equal(providerRequests, 1);
});

test('native uploader bridge blocks legacy/official requests while preserving direct provider requests', async () => {
  let uploads = 0;
  let providers = 0;
  const result = { status: 200, body: 'provider result' };
  const client = loader({
    expo: { requireNativeModule: () => ({ upload: async () => { uploads++; }, requestProvider: async () => { providers++; return result; } }) },
    'react-native': { Platform: { OS: 'ios' } },
  });
  const { BackgroundUploader } = client.load('modules/background-uploader/src/index.ts');
  await assert.rejects(BackgroundUploader.upload({ url: 'https://api.openwhispr.com/api/transcribe', fileUri: 'file:///synthetic.wav' }), { code: 'HOSTED_SERVICES_DISABLED' });
  for (const url of ['https://api.openwhispr.com/v1', 'https://API.OpenWhispr.com./v1', 'http://openwhispr.com']) {
    await assert.rejects(BackgroundUploader.requestProvider({ url }), { code: 'HOSTED_SERVICES_DISABLED' });
  }
  assert.equal(await BackgroundUploader.requestProvider({ url: 'https://api.openai.com/v1' }), result);
  assert.equal(uploads, 0);
  assert.equal(providers, 1);
  const { isSecureHttpEndpoint } = client.load('src/lib/providerEndpoints.ts');
  assert.equal(isSecureHttpEndpoint('https://API.OpenWhispr.com./v1'), false);
  assert.equal(isSecureHttpEndpoint('https://api.openai.com/v1'), true);
  assert.equal(isSecureHttpEndpoint('http://127.0.0.1:8080/v1'), true);
});
